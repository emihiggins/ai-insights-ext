/**
 * Rule: fast-mode spend. Fast mode runs the same model faster at premium
 * rates (2x on Opus 5.5). That's a fine trade when you're waiting on the
 * output, but easy to leave on by accident.
 *
 * Trigger: any turn with usage.speed === "fast" on a model with fast pricing.
 * Math: the premium over the same turns at standard rates.
 */
import type { Finding, RuleContext } from "./index";
import { estimateCost, rateForModel, turnCost } from "../pricing";

export function fastModeRule(ctx: RuleContext): Finding[] {
  let fastTurns = 0;
  let premium = 0;
  const sessions = new Set<string>();

  for (const s of ctx.sessions) {
    for (const t of s.turns) {
      if (t.speed !== "fast") {
        continue;
      }
      const extra = turnCost(t) - estimateCost(t.usage, rateForModel(t.model));
      if (extra <= 0) {
        continue; // no fast pricing known for this model
      }
      fastTurns += 1;
      premium += extra;
      sessions.add(s.parentSessionId ?? s.sessionId);
    }
  }

  if (premium < 0.01) {
    return [];
  }
  return [
    {
      ruleId: "fastmode",
      key: "fastmode",
      category: "Fast mode",
      title: `Fast mode added ~$${premium.toFixed(2)} across ${sessions.size} session${sessions.size === 1 ? "" : "s"}`,
      detail:
        `${fastTurns} turn${fastTurns === 1 ? "" : "s"} ran in fast mode, which bills at premium rates for faster output. ` +
        "This is the premium over the same turns at standard speed.",
      fix: "Turn fast mode on (/fast) when you're actively waiting on output, and off for long unattended runs.",
      severity: "info",
      scope: "habit",
      wastedUSD: premium,
    },
  ];
}
