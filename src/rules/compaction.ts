/**
 * Rule: context compaction. Each compaction drops a large chunk of context
 * (costing output tokens to summarize) and then re-primes a cold cache prefix
 * on the following turn. Frequent compaction is also a habit signal.
 */
import type { Finding, RuleContext } from "./index";
import { costOfInputTokens, CACHE_WRITE_5M_MULTIPLIER } from "../pricing";

export function compactionRule(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];
  let totalCompactions = 0;
  const sessionsWithCompaction = new Set<string>();

  for (const s of ctx.sessions) {
    const rate = ctx.rateFor(s);
    for (const c of s.compactions) {
      totalCompactions += 1;
      sessionsWithCompaction.add(s.sessionId);
      // Rough re-prime cost: the surviving context must be re-cached (~1.25x input).
      const reprimeUSD = costOfInputTokens(c.postTokens, rate) * CACHE_WRITE_5M_MULTIPLIER;
      findings.push({
        ruleId: "compaction",
        category: "Context compaction",
        title: `Context compaction dropped ${fmt(c.droppedTokens)} tokens`,
        detail:
          `A ${c.trigger ?? "auto"} compaction summarized the conversation from ${fmt(c.preTokens)} ` +
          `to ${fmt(c.postTokens)} tokens. Compaction spends output tokens to write the summary, ` +
          `re-primes a cold cache prefix afterward, and the summary is lossier than the original context.`,
        fix:
          "Start a fresh session (or /clear) for unrelated tasks instead of letting one session grow until it auto-compacts. " +
          "Scope each session to a single task so it never approaches the compaction threshold.",
        severity: c.droppedTokens > 100_000 ? "high" : "medium",
        scope: "one-off",
        sessionId: s.sessionId,
        project: s.project,
        timestamp: c.timestamp,
        wastedTokens: c.droppedTokens,
        wastedUSD: reprimeUSD,
      });
    }
  }

  // Habit: compaction is happening across multiple sessions.
  if (sessionsWithCompaction.size >= 2 || totalCompactions >= 3) {
    findings.push({
      ruleId: "compaction.habit",
      category: "Context compaction",
      title: `Sessions are auto-compacting (${totalCompactions} across ${sessionsWithCompaction.size} sessions)`,
      detail:
        "Recurring compaction means sessions routinely outgrow the context window. Each one loses fidelity and pays to rebuild the cache.",
      fix:
        "Adopt a habit of one session per task. Kick off long jobs with a tight, complete prompt up front so the agent needs fewer exploratory turns, and close sessions when a task is done.",
      severity: "medium",
      scope: "habit",
      wastedTokens: 0,
    });
  }

  return findings;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}
