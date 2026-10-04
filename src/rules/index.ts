/**
 * Recommendation engine. Each rule inspects the parsed session models and
 * emits Findings. Findings are split into concrete one-off fixes and recurring
 * habits. Pure logic — no vscode — so rules are unit-testable.
 */
import type { SessionModel } from "../model";
import { primaryModel, DEFAULT_CHARS_PER_TOKEN } from "../model";
import { rateForModel, type Rate } from "../pricing";

export type Severity = "high" | "medium" | "low" | "info";
export type Scope = "one-off" | "habit";

export interface Finding {
  ruleId: string;
  /**
   * Stable identity used to dismiss or snooze a finding. Must not include
   * values that change as a session grows (counts, last timestamps).
   * Filled with a default by runAllRules when a rule leaves it unset.
   */
  key?: string;
  /** Human-readable mistake category, used to group the savings dashboard. */
  category: string;
  title: string;
  /** Why this is happening / what it costs. */
  detail: string;
  /** The concrete action the user can take. */
  fix: string;
  severity: Severity;
  scope: Scope;
  sessionId?: string;
  project?: string;
  evidenceUuid?: string;
  timestamp?: string;
  wastedTokens?: number;
  wastedUSD?: number;
}

export interface RuleConfig {
  largeSearchOutputBytes: number;
  lowCacheRatioThreshold: number;
}

export const DEFAULT_RULE_CONFIG: RuleConfig = {
  largeSearchOutputBytes: 20000,
  // Healthy Claude Code sessions typically serve 90%+ of input from cache.
  lowCacheRatioThreshold: 0.8,
};

export interface RuleContext {
  sessions: SessionModel[];
  config: RuleConfig;
  /** Resolve the billing rate for a session's dominant model. */
  rateFor(session: SessionModel): Rate;
  /** Reference time for recency-based rules. */
  now: Date;
}

export type Rule = (ctx: RuleContext) => Finding[];

/**
 * Estimate tokens from characters. Pass the session's calibrated
 * `charsPerToken`; 4 is only a fallback for callers without a session.
 */
export function estTokensFromChars(chars: number, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
  return Math.round(chars / charsPerToken);
}

const severityRank: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

export interface RuleResults {
  findings: Finding[];
  oneOffs: Finding[];
  habits: Finding[];
}

/** Register rules here. */
import { compactionRule } from "./compaction";
import { searchesRule } from "./searches";
import { readsRule } from "./reads";
import { cacheRule } from "./cache";
import { promptLengthRule } from "./promptLength";
import { failedToolsRule } from "./failedTools";
import { redundantCommandsRule } from "./redundantCommands";
import { readAfterEditRule } from "./readAfterEdit";
import { largeOutputRule } from "./largeOutput";
import { contextPressureRule } from "./contextPressure";
import { cacheExpiryRule } from "./cacheExpiry";
import { overheadRule } from "./overhead";
import { modelFitRule } from "./modelFit";
import { fastModeRule } from "./fastMode";

const RULES: Rule[] = [
  compactionRule,
  searchesRule,
  readsRule,
  cacheRule,
  promptLengthRule,
  failedToolsRule,
  redundantCommandsRule,
  readAfterEditRule,
  largeOutputRule,
  contextPressureRule,
  cacheExpiryRule,
  overheadRule,
  modelFitRule,
  fastModeRule,
];

export function runAllRules(
  sessions: SessionModel[],
  config: RuleConfig = DEFAULT_RULE_CONFIG,
  now: Date = new Date()
): RuleResults {
  const ctx: RuleContext = {
    sessions,
    config,
    rateFor: (s) => rateForModel(primaryModel(s)),
    now,
  };

  const findings: Finding[] = [];
  for (const rule of RULES) {
    try {
      findings.push(...rule(ctx));
    } catch {
      // a failing rule must not break the whole run
    }
  }
  for (const f of findings) {
    f.key ??= [f.ruleId, f.sessionId ?? "", f.evidenceUuid ?? ""].join("|");
  }

  const sortFn = (a: Finding, b: Finding): number => {
    const bySev = severityRank[a.severity] - severityRank[b.severity];
    if (bySev !== 0) {
      return bySev;
    }
    return (b.wastedUSD ?? 0) - (a.wastedUSD ?? 0);
  };
  findings.sort(sortFn);

  return {
    findings,
    oneOffs: findings.filter((f) => f.scope === "one-off"),
    habits: findings.filter((f) => f.scope === "habit"),
  };
}
