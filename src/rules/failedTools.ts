/**
 * Rule: failed or interrupted tool calls. A tool_result flagged is_error, or a
 * run marked interrupted, produced output tokens that entered context but had
 * to be discarded (and usually retried). The error text itself is billed.
 *
 * Trigger: real is_error / interrupted flags on the paired tool result.
 * Math: wasted ≈ the failed result's output tokens (chars / 4).
 */
import type { Finding, RuleContext } from "./index";
import { estTokensFromChars } from "./index";
import { costOfInputTokens } from "../pricing";

export function failedToolsRule(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];
  let totalFailures = 0;
  let totalWastedTokens = 0;

  for (const s of ctx.sessions) {
    const rate = ctx.rateFor(s);
    // Aggregate per session — one finding per session, not per failure, to avoid noise.
    const failed = s.toolCalls.filter((c) => c.isError || c.interrupted);
    if (failed.length === 0) {
      continue;
    }
    const chars = failed.reduce((sum, c) => sum + (c.resultChars ?? 0), 0);
    const estTokens = estTokensFromChars(chars, s.charsPerToken);
    totalFailures += failed.length;
    totalWastedTokens += estTokens;

    const byName = new Map<string, number>();
    for (const c of failed) {
      byName.set(c.name, (byName.get(c.name) ?? 0) + 1);
    }
    const breakdown = [...byName.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([n, k]) => `${n} ×${k}`)
      .join(", ");

    findings.push({
      ruleId: "failedtools",
      category: "Failed tool call",
      title: `${failed.length} failed/interrupted tool call${failed.length === 1 ? "" : "s"} in one session`,
      detail:
        `Errored or interrupted calls (${breakdown}) produced ~${estTokens.toLocaleString("en-US")} tokens of output ` +
        "that entered context and then had to be discarded — usually followed by a retry that pays again. " +
        "Error text and stack traces are billed just like any other tool output.",
      fix:
        "Fix the root cause of the failing command (wrong path, missing flag, unescaped shell metachar) before re-running, " +
        "and prefer a quick validating command over repeatedly retrying a heavy one.",
      severity: failed.length >= 4 ? "high" : "medium",
      scope: "one-off",
      sessionId: s.sessionId,
      project: s.project,
      timestamp: failed[failed.length - 1].timestamp,
      wastedTokens: estTokens,
      wastedUSD: costOfInputTokens(estTokens, rate),
    });
  }

  if (totalFailures >= 8) {
    findings.push({
      ruleId: "failedtools.habit",
      category: "Failed tool call",
      title: `Frequent tool failures (${totalFailures} flagged)`,
      detail:
        "Tool calls fail or get interrupted across many sessions, each burning output tokens on discarded results and retries.",
      fix:
        "Give the agent the exact commands/paths it needs up front, and prefer dedicated tools over long shell one-liners that are easy to get wrong.",
      severity: "medium",
      scope: "habit",
      wastedTokens: totalWastedTokens,
    });
  }

  return findings;
}
