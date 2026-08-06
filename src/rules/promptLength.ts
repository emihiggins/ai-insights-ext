/**
 * Rule: inefficient round-trips. Turns with a very large billed input but a
 * tiny output are expensive per unit of useful work — the context is huge but
 * the agent barely acts. Recurring across a session, this is a habit worth
 * flagging (usually: context bloat, or over-narrow single-step turns).
 */
import type { Finding, RuleContext } from "./index";

const BIG_INPUT_TOKENS = 15000; // billed input (uncached) this turn
const TINY_OUTPUT_TOKENS = 40;
const MIN_HITS = 4;

export function promptLengthRule(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];

  for (const s of ctx.sessions) {
    let hits = 0;
    let sampleTs: string | undefined;
    for (const turn of s.turns) {
      const billedInput = turn.usage.input + turn.usage.cacheCreate; // full-price input this turn
      if (billedInput >= BIG_INPUT_TOKENS && turn.usage.output <= TINY_OUTPUT_TOKENS) {
        hits += 1;
        sampleTs ??= turn.timestamp;
      }
    }
    if (hits < MIN_HITS) {
      continue;
    }
    findings.push({
      ruleId: "promptlength.roundtrips",
      category: "Inefficient round-trips",
      title: `${hits} high-input / low-output turns in one session`,
      detail:
        `${hits} turns paid for a large prompt (≥${BIG_INPUT_TOKENS.toLocaleString("en-US")} billed input tokens) ` +
        `while producing almost no output (≤${TINY_OUTPUT_TOKENS} tokens). That is an expensive ratio of context to work.`,
      fix:
        "Batch related actions into a single turn rather than many one-step turns over the same large context, " +
        "and keep the context lean so each round-trip isn't re-paying for tokens the turn doesn't use.",
      severity: "low",
      scope: "habit",
      sessionId: s.sessionId,
      project: s.project,
      timestamp: sampleTs,
    });
  }

  return findings;
}
