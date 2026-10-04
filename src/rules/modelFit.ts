/**
 * Rule: model fit. Two recent-session checks:
 *  - Older Opus models (Opus 5, Opus 4.x) cost more per token than Opus 5.5,
 *    which is also the newer model — switching is a straight saving.
 *  - Short, low-output sessions run on Fable / Mythos (2.5x Opus 5.5's price)
 *    are usually small tasks the cheaper model handles fine.
 *
 * Only sessions active within RECENT_DAYS are considered — and, once Opus 5.5
 * shows up in the user's own transcripts, only sessions after its first use —
 * so history from before the newer model was available doesn't produce stale
 * advice.
 * Math: what the same tokens would have cost at Opus 5.5 rates. Opus 4.6 and
 * earlier use a different tokenizer, so their savings are approximate.
 */
import type { Finding, RuleContext } from "./index";
import type { SessionModel } from "../model";
import { primaryModel } from "../model";
import { estimateCost, normalizeModelId, rateForModel, turnCost } from "../pricing";

const RECENT_DAYS = 30;
const TARGET_MODEL = "claude-opus-5-5";
const TARGET_LABEL = "Opus 5.5";
const SHORT_SESSION_TURNS = 6;
const SHORT_SESSION_OUTPUT = 8_000;

function isOlderOpus(modelId: string): boolean {
  const id = normalizeModelId(modelId);
  return id.startsWith("claude-opus-4") || (id.startsWith("claude-opus-5") && !id.startsWith("claude-opus-5-5"));
}

function isFableTier(modelId: string): boolean {
  const id = normalizeModelId(modelId);
  return id.startsWith("claude-fable") || id.startsWith("claude-mythos");
}

/** Cost difference if the session's matching turns had run on the target model. */
function savingsAtTarget(s: SessionModel, match: (modelId: string) => boolean): number {
  let saved = 0;
  for (const t of s.turns) {
    if (!t.model || !match(t.model)) {
      continue;
    }
    const target = rateForModel(TARGET_MODEL, t.speed);
    saved += turnCost(t) - estimateCost(t.usage, target);
  }
  return Math.max(0, saved);
}

/** Earliest turn on the target model across all sessions: proof it was available. */
function firstTargetUse(sessions: SessionModel[]): number | undefined {
  let first: number | undefined;
  for (const s of sessions) {
    for (const t of s.turns) {
      if (!t.model || !normalizeModelId(t.model).startsWith(TARGET_MODEL)) {
        continue;
      }
      const ts = t.timestamp ? Date.parse(t.timestamp) : NaN;
      if (Number.isFinite(ts) && (first === undefined || ts < first)) {
        first = ts;
      }
    }
  }
  return first;
}

export function modelFitRule(ctx: RuleContext): Finding[] {
  const cutoff = Math.max(ctx.now.getTime() - RECENT_DAYS * 86_400_000, firstTargetUse(ctx.sessions) ?? -Infinity);
  const recent = ctx.sessions.filter((s) => {
    const last = s.lastTs ? Date.parse(s.lastTs) : NaN;
    return Number.isFinite(last) && last >= cutoff;
  });

  const findings: Finding[] = [];

  // Older Opus.
  let olderSessions = 0;
  let olderSaved = 0;
  const olderModels = new Set<string>();
  for (const s of recent) {
    const saved = savingsAtTarget(s, isOlderOpus);
    if (saved > 0) {
      olderSessions += 1;
      olderSaved += saved;
      for (const m of Object.keys(s.modelTurns)) {
        if (isOlderOpus(m)) {
          olderModels.add(m);
        }
      }
    }
  }
  if (olderSessions > 0 && olderSaved >= 0.01) {
    findings.push({
      ruleId: "modelfit.olderopus",
      key: "modelfit.olderopus",
      category: "Model choice",
      title: `${olderSessions} recent session${olderSessions === 1 ? "" : "s"} used an older Opus model`,
      detail:
        `${[...olderModels].sort().join(", ")} cost more per token than ${TARGET_LABEL} ($4 / $20 per 1M tokens), which is also the newer model. ` +
        `The same work at ${TARGET_LABEL} rates would have cost ~$${olderSaved.toFixed(2)} less.`,
      fix: `Switch to ${TARGET_LABEL} with /model (or update a pinned model in your settings or launch flags).`,
      severity: olderSaved >= 5 ? "high" : "medium",
      scope: "habit",
      wastedUSD: olderSaved,
    });
  }

  // Fable / Mythos on short sessions.
  let shortSessions = 0;
  let shortSaved = 0;
  for (const s of recent) {
    const model = primaryModel(s);
    if (s.parentSessionId || !model || !isFableTier(model)) {
      continue;
    }
    if (s.turns.length > SHORT_SESSION_TURNS || s.totals.output > SHORT_SESSION_OUTPUT) {
      continue;
    }
    shortSessions += 1;
    shortSaved += savingsAtTarget(s, isFableTier);
  }
  if (shortSessions > 0 && shortSaved >= 0.01) {
    findings.push({
      ruleId: "modelfit.fableshort",
      key: "modelfit.fableshort",
      category: "Model choice",
      title: `${shortSessions} short session${shortSessions === 1 ? "" : "s"} ran on Fable`,
      detail:
        `Sessions with ≤${SHORT_SESSION_TURNS} turns and little output are usually small tasks. Fable is priced at 2.5× ${TARGET_LABEL}; ` +
        `running these on ${TARGET_LABEL} would have cost ~$${shortSaved.toFixed(2)} less.`,
      fix: `Keep Fable for long, hard tasks and use ${TARGET_LABEL} for quick questions and small edits (/model to switch).`,
      severity: "low",
      scope: "habit",
      wastedUSD: shortSaved,
    });
  }

  return findings;
}
