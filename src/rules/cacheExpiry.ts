/**
 * Rule: cache expired during an idle gap. Prompt-cache entries live 5 minutes
 * (1 hour when written with the 1-hour TTL), refreshed on every read. When a
 * session sits idle longer than that, the next turn finds nothing to read and
 * re-writes the whole context at the write premium instead of reading it back.
 *
 * Trigger: a gap between consecutive turns longer than the TTL in use,
 * followed by a large cache write with almost no cache read, and no
 * compaction in between (compaction rebuilds the prompt anyway).
 * Math: wasted ≈ the re-written tokens priced as a write minus as a read.
 */
import type { Finding, RuleContext } from "./index";
import { rateForModel, CACHE_WRITE_5M_MULTIPLIER, CACHE_WRITE_1H_MULTIPLIER } from "../pricing";

const FIVE_MINUTES_MS = 5 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;
const MIN_REWRITE_TOKENS = 10_000;
const MAX_READ_SHARE = 0.2; // read < 20% of write => the prefix was not served from cache
const HABIT_MIN_SESSIONS = 3;

function ms(ts: string | undefined): number | undefined {
  const t = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

function fmtGap(gapMs: number): string {
  const minutes = Math.round(gapMs / 60_000);
  return minutes >= 90 ? `${(minutes / 60).toFixed(1)} h` : `${minutes} min`;
}

export function cacheExpiryRule(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];
  const sessionsWithExpiry = new Set<string>();
  let totalEvents = 0;
  let totalWastedTokens = 0;
  let totalWastedUSD = 0;

  for (const s of ctx.sessions) {
    let usesLongTtl = false;
    let events = 0;
    let rewritten = 0;
    let wastedUSD = 0;
    let longestGap = 0;
    let lastTs: string | undefined;
    const compactionTimes = s.compactions.map((c) => ms(c.timestamp)).filter((t): t is number => t !== undefined);

    for (let i = 1; i < s.turns.length; i++) {
      const prev = s.turns[i - 1];
      const cur = s.turns[i];
      usesLongTtl ||= prev.usage.ephemeral1h > 0;
      const from = ms(prev.timestamp);
      const to = ms(cur.timestamp);
      if (from === undefined || to === undefined) {
        continue;
      }
      const gap = to - from;
      const ttl = usesLongTtl ? ONE_HOUR_MS : FIVE_MINUTES_MS;
      const u = cur.usage;
      if (gap <= ttl || u.cacheCreate < MIN_REWRITE_TOKENS || u.cacheRead >= u.cacheCreate * MAX_READ_SHARE) {
        continue;
      }
      if (compactionTimes.some((t) => t > from && t <= to)) {
        continue;
      }
      const rate = rateForModel(cur.model, cur.speed);
      const write1h = Math.min(u.ephemeral1h, u.cacheCreate);
      const write5m = u.cacheCreate - write1h;
      const premium =
        (write5m / 1_000_000) * (rate.input * CACHE_WRITE_5M_MULTIPLIER - rate.cacheRead) +
        (write1h / 1_000_000) * (rate.input * CACHE_WRITE_1H_MULTIPLIER - rate.cacheRead);
      events += 1;
      rewritten += u.cacheCreate;
      wastedUSD += premium;
      longestGap = Math.max(longestGap, gap);
      lastTs = cur.timestamp;
    }

    if (events === 0) {
      continue;
    }
    sessionsWithExpiry.add(s.parentSessionId ?? s.sessionId);
    totalEvents += events;
    totalWastedTokens += rewritten;
    totalWastedUSD += wastedUSD;
    findings.push({
      ruleId: "cache.expiry",
      key: `cache.expiry|${s.sessionId}`,
      category: "Cache expired while idle",
      title: `Cache expired ${events}× after idle gaps (re-wrote ${rewritten.toLocaleString("en-US")} tokens)`,
      detail:
        `The session paused longer than the ${usesLongTtl ? "1-hour" : "5-minute"} cache lifetime ${events} time${events === 1 ? "" : "s"} ` +
        `(longest gap ${fmtGap(longestGap)}). Each time, the next turn found the cache gone and re-wrote the whole context at the ` +
        "write premium instead of reading it back at the cache-read price.",
      fix:
        "Avoid leaving a large session idle mid-task. After a long break, if the earlier context isn't essential, " +
        "/clear or start a fresh session — rewriting a small context is far cheaper than rewriting a large one.",
      severity: wastedUSD >= 1 ? "high" : "medium",
      scope: "one-off",
      sessionId: s.sessionId,
      project: s.project,
      timestamp: lastTs,
      wastedTokens: rewritten,
      wastedUSD,
    });
  }

  if (sessionsWithExpiry.size >= HABIT_MIN_SESSIONS) {
    findings.push({
      ruleId: "cache.expiry.habit",
      key: "cache.expiry.habit",
      category: "Cache expired while idle",
      title: `Cache keeps expiring during pauses (${totalEvents} times across ${sessionsWithExpiry.size} sessions)`,
      detail:
        `Idle gaps longer than the cache lifetime forced ${totalWastedTokens.toLocaleString("en-US")} tokens to be re-written ` +
        `(~$${totalWastedUSD.toFixed(2)} in write premium).`,
      fix:
        "Wrap up or /clear before stepping away from a large session, and start fresh afterwards when the old context isn't needed.",
      severity: "medium",
      scope: "habit",
    });
  }

  return findings;
}
