/**
 * Recommendation engine. Each rule inspects the parsed session models and
 * emits Findings. Findings are split into concrete one-off fixes and recurring
 * habits. Pure logic — no vscode — so rules are unit-testable.
 */
import type { SessionModel } from "../model";
import { primaryModel } from "../model";
import { rateForModel, type Rate } from "../pricing";

export type Severity = "high" | "medium" | "low" | "info";
export type Scope = "one-off" | "habit";

export interface Finding {
  ruleId: string;
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
  lowCacheRatioThreshold: 0.5,
};

export interface RuleContext {
  sessions: SessionModel[];
  config: RuleConfig;
  /** Resolve the billing rate for a session's dominant model. */
  rateFor(session: SessionModel): Rate;
}

export type Rule = (ctx: RuleContext) => Finding[];

/** ≈4 characters per token — a rough but stable estimator for output size. */
export const CHARS_PER_TOKEN = 4;

export function estTokensFromChars(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
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
];

export function runAllRules(sessions: SessionModel[], config: RuleConfig = DEFAULT_RULE_CONFIG): RuleResults {
  const ctx: RuleContext = {
    sessions,
    config,
    rateFor: (s) => rateForModel(primaryModel(s)),
  };

  const findings: Finding[] = [];
  for (const rule of RULES) {
    try {
      findings.push(...rule(ctx));
    } catch {
      // a failing rule must not break the whole run
    }
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
