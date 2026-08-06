/**
 * Rule: context pressure (pre-compaction warning). Tracks the peak prompt size
 * across a session's turns (input + cache_read + cache_write for the turn ≈ the
 * tokens the model processed). When that peak approaches the model's context
 * window, the session is one long task away from an auto-compaction.
 *
 * Trigger: peak per-turn prompt tokens ≥ 80% of the model context window, and
 * the session hasn't already compacted (that case is covered by the compaction
 * rule). Preventive — no direct token waste attributed.
 */
import type { Finding, RuleContext } from "./index";
import { primaryModel } from "../model";
import { contextWindowForModel } from "../pricing";

const PRESSURE_FRACTION = 0.8;

export function contextPressureRule(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];

  for (const s of ctx.sessions) {
    if (s.compactions.length > 0) {
      continue; // already compacted — the compaction rule owns this session
    }
    let peak = 0;
    let peakTs: string | undefined;
    for (const turn of s.turns) {
      const promptTokens = turn.usage.input + turn.usage.cacheRead + turn.usage.cacheCreate;
      if (promptTokens > peak) {
        peak = promptTokens;
        peakTs = turn.timestamp;
      }
    }
    const window = contextWindowForModel(primaryModel(s));
    const fraction = window > 0 ? peak / window : 0;
    if (fraction < PRESSURE_FRACTION) {
      continue;
    }
    findings.push({
      ruleId: "context.pressure",
      category: "Context pressure",
      title: `Session reached ${Math.round(fraction * 100)}% of the context window`,
      detail:
        `A turn processed ~${peak.toLocaleString("en-US")} prompt tokens against a ` +
        `${window.toLocaleString("en-US")}-token window. Sessions this full are about to auto-compact, which is ` +
        "lossy and re-primes a cold cache.",
      fix:
        "Wrap up or split this session before it compacts. Start a fresh session for the next task rather than continuing to grow this one.",
      severity: fraction >= 0.95 ? "high" : "medium",
      scope: "one-off",
      sessionId: s.sessionId,
      project: s.project,
      timestamp: peakTs,
      wastedTokens: 0,
    });
  }

  return findings;
}
