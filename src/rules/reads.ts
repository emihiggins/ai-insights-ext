/**
 * Rule: oversized or repeated file reads. Re-reading the same file within a
 * session re-pays its token cost each time; a single huge read pulls a whole
 * file into context when a range would do.
 */
import type { Finding, RuleContext } from "./index";
import { estTokensFromChars } from "./index";
import { costOfInputTokens } from "../pricing";

const HUGE_READ_CHARS = 40000; // ~10k tokens
const REPEAT_THRESHOLD = 3;

export function readsRule(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];

  for (const s of ctx.sessions) {
    const rate = ctx.rateFor(s);
    const byPath = new Map<string, { count: number; totalChars: number; lastUuid?: string; lastTs?: string }>();

    for (const call of s.toolCalls) {
      if (call.name !== "Read" || !call.filePath) {
        continue;
      }
      const chars = call.resultChars ?? 0;

      // Single oversized read.
      if (chars >= HUGE_READ_CHARS) {
        const estTokens = estTokensFromChars(chars);
        findings.push({
          ruleId: "reads.large",
          category: "Large read",
          title: `Large file read (~${estTokens.toLocaleString("en-US")} tokens)`,
          detail: `Reading ${call.filePath} pulled ${chars.toLocaleString("en-US")} characters into context in a single call.`,
          fix: "Read a specific line range (offset/limit) when you only need part of a large file, rather than the whole thing.",
          severity: estTokens > 20000 ? "high" : "medium",
          scope: "one-off",
          sessionId: s.sessionId,
          project: s.project,
          evidenceUuid: call.id,
          timestamp: call.timestamp,
          wastedTokens: 0,
        });
      }

      const rec = byPath.get(call.filePath) ?? { count: 0, totalChars: 0 };
      rec.count += 1;
      rec.totalChars += chars;
      rec.lastUuid = call.id;
      rec.lastTs = call.timestamp;
      byPath.set(call.filePath, rec);
    }

    for (const [filePath, rec] of byPath) {
      if (rec.count < REPEAT_THRESHOLD) {
        continue;
      }
      // Tokens re-paid on the repeat reads (everything past the first read).
      const repaidChars = rec.count > 0 ? Math.round(rec.totalChars * ((rec.count - 1) / rec.count)) : 0;
      const estTokens = estTokensFromChars(repaidChars);
      findings.push({
        ruleId: "reads.repeat",
        category: "Repeated read",
        title: `Same file read ${rec.count}× in one session`,
        detail: `${filePath} was read ${rec.count} times. Each re-read re-pays its token cost — roughly ${estTokens.toLocaleString("en-US")} tokens were spent re-reading content already in context.`,
        fix: "Read a file once and rely on it staying in context, or read a targeted range. Avoid re-reading a file you already have.",
        severity: estTokens > 8000 ? "high" : "medium",
        scope: "one-off",
        sessionId: s.sessionId,
        project: s.project,
        evidenceUuid: rec.lastUuid,
        timestamp: rec.lastTs,
        wastedTokens: estTokens,
        wastedUSD: costOfInputTokens(estTokens, rate),
      });
    }
  }

  return findings;
}
