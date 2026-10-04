/**
 * Rule: oversized or repeated file reads. Re-reading the same file range within
 * a session re-pays its token cost each time; a single huge read pulls a whole
 * file into context when a range would do. Reads of *different* ranges of one
 * file are paging, not repetition, so repeats are grouped by path + range.
 */
import type { Finding, RuleContext } from "./index";
import { estTokensFromChars } from "./index";
import { costOfInputTokens } from "../pricing";
import type { ToolCall } from "../model";

const HUGE_READ_CHARS = 40000; // ~10k+ tokens
const REPEAT_THRESHOLD = 3;

function rangeLabel(call: ToolCall): string {
  if (call.offset === undefined && call.limit === undefined) {
    return "";
  }
  const start = call.offset ?? 1;
  return call.limit !== undefined ? `lines ${start}–${start + call.limit - 1}` : `from line ${start}`;
}

export function readsRule(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];

  for (const s of ctx.sessions) {
    const rate = ctx.rateFor(s);
    const byRange = new Map<
      string,
      { filePath: string; range: string; count: number; totalChars: number; lastUuid?: string; lastTs?: string }
    >();

    for (const call of s.toolCalls) {
      if (call.name !== "Read" || !call.filePath) {
        continue;
      }
      const chars = call.resultChars ?? 0;

      // Single oversized read.
      if (chars >= HUGE_READ_CHARS) {
        const estTokens = estTokensFromChars(chars, s.charsPerToken);
        const ranged = call.limit !== undefined;
        findings.push({
          ruleId: "reads.large",
          key: `reads.large|${s.sessionId}|${call.id}`,
          category: "Large read",
          title: `Large file read (~${estTokens.toLocaleString("en-US")} tokens)`,
          detail: `Reading ${call.filePath}${ranged ? ` (${rangeLabel(call)})` : ""} pulled ${chars.toLocaleString("en-US")} characters into context in a single call.`,
          fix: ranged
            ? "Narrow the range further, or search for the symbol you need and read just the lines around it."
            : "Read a specific line range (offset/limit) when you only need part of a large file, rather than the whole thing.",
          severity: estTokens > 20000 ? "high" : "medium",
          scope: "one-off",
          sessionId: s.sessionId,
          project: s.project,
          evidenceUuid: call.id,
          timestamp: call.timestamp,
          wastedTokens: 0,
        });
      }

      const range = rangeLabel(call);
      const groupKey = `${call.filePath}\u0000${range}`;
      const rec = byRange.get(groupKey) ?? { filePath: call.filePath, range, count: 0, totalChars: 0 };
      rec.count += 1;
      rec.totalChars += chars;
      rec.lastUuid = call.id;
      rec.lastTs = call.timestamp;
      byRange.set(groupKey, rec);
    }

    for (const rec of byRange.values()) {
      if (rec.count < REPEAT_THRESHOLD) {
        continue;
      }
      // Tokens re-paid on the repeat reads (everything past the first read).
      const repaidChars = Math.round(rec.totalChars * ((rec.count - 1) / rec.count));
      const estTokens = estTokensFromChars(repaidChars, s.charsPerToken);
      const what = rec.range ? `${rec.filePath} (${rec.range})` : rec.filePath;
      findings.push({
        ruleId: "reads.repeat",
        key: `reads.repeat|${s.sessionId}|${rec.filePath}|${rec.range}`,
        category: "Repeated read",
        title: `Same file read ${rec.count}× in one session`,
        detail: `${what} was read ${rec.count} times. Each re-read re-pays its token cost — roughly ${estTokens.toLocaleString("en-US")} tokens were spent re-reading content already in context.`,
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
