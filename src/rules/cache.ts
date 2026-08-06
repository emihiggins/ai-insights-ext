/**
 * Rule: low cache-hit ratio. A session that writes a lot of cache but reads
 * little back — despite many turns — is a strong sign of a silent cache
 * invalidator (volatile content early in the prefix, a changing tool set).
 * Cache writes cost 1.25x input vs 0.1x for reads, so the gap is real money.
 */
import type { Finding, RuleContext } from "./index";
import { cacheReadRatio } from "../aggregates";
import { costOfInputTokens, CACHE_WRITE_5M_MULTIPLIER, CACHE_READ_MULTIPLIER } from "../pricing";

const MIN_TURNS = 5;
const MIN_CACHE_CREATE = 20000; // ignore tiny sessions where the ratio is noise

export function cacheRule(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];

  for (const s of ctx.sessions) {
    if (s.turns.length < MIN_TURNS || s.totals.cacheCreate < MIN_CACHE_CREATE) {
      continue;
    }
    const ratio = cacheReadRatio(s.totals);
    if (ratio >= ctx.config.lowCacheRatioThreshold) {
      continue;
    }
    const rate = ctx.rateFor(s);
    // Extra cost of writing cache that never got read back (write premium over read).
    const premium = CACHE_WRITE_5M_MULTIPLIER - CACHE_READ_MULTIPLIER;
    const wastedUSD = costOfInputTokens(s.totals.cacheCreate, rate) * premium;
    findings.push({
      ruleId: "cache.lowratio",
      category: "Low cache reuse",
      title: `Low cache reuse (${Math.round(ratio * 100)}% read ratio over ${s.turns.length} turns)`,
      detail:
        `This session wrote ${s.totals.cacheCreate.toLocaleString("en-US")} cache tokens but only read ` +
        `${s.totals.cacheRead.toLocaleString("en-US")} back. A healthy long session reads far more than it writes. ` +
        "A low ratio usually means something near the front of the prompt keeps changing, invalidating the cached prefix.",
      fix:
        "Look for volatile content early in context — a timestamp, a per-request id, or a tool set that changes mid-session. " +
        "Keeping the stable preamble byte-identical lets later turns hit the cache (~0.1x) instead of re-writing it (~1.25x).",
      severity: "medium",
      scope: "one-off",
      sessionId: s.sessionId,
      project: s.project,
      timestamp: s.lastTs,
      wastedTokens: s.totals.cacheCreate,
      wastedUSD,
    });
  }

  return findings;
}
