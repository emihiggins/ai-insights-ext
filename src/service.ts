/**
 * Orchestrates a full analysis pass: discover transcripts, aggregate metrics,
 * run the recommendation rules. No vscode dependency — the extension host
 * passes in the resolved config.
 */
import * as path from "path";
import { projectsDir } from "./discovery";
import { loadAllSessions } from "./discovery";
import { readTranscript } from "./parser";
import { buildSessionModel } from "./model";
import { buildSessionDetail, type SessionDetail } from "./detail";
import { computeAggregates, type DashboardAggregates } from "./aggregates";
import { runAllRules, type RuleConfig, type RuleResults } from "./rules/index";
import { computeSavings, type SavingsReport } from "./savings";
import { computeTrends, type TrendReport, type DailyMetric } from "./trends";
import * as fsp from "fs/promises";

export interface DashboardPayload {
  generatedAt: string;
  claudeHome: string;
  /** Whether ~/.claude/projects exists at all. */
  found: boolean;
  aggregates: DashboardAggregates;
  results: RuleResults;
  savings: SavingsReport;
  trends: TrendReport;
  /** sessionId -> transcript file path, so the webview can request "open". */
  sessionFiles: Record<string, string>;
}

export interface AnalyzeOptions {
  now?: Date;
  /** Persisted daily history, merged with the freshly computed series. */
  persistedTrends?: DailyMetric[];
  /** Regression comparison window in days. */
  trendWindowDays?: number;
}

export async function analyze(
  claudeHome: string,
  config: RuleConfig,
  opts: AnalyzeOptions = {}
): Promise<DashboardPayload> {
  const now = opts.now ?? new Date();
  let found = true;
  try {
    await fsp.access(projectsDir(claudeHome));
  } catch {
    found = false;
  }

  const sessions = await loadAllSessions(claudeHome);
  const aggregates = computeAggregates(sessions);
  const results = runAllRules(sessions, config);
  const savings = computeSavings(results.findings, aggregates.totalCostUSD);
  const trends = computeTrends(sessions, opts.persistedTrends ?? [], opts.trendWindowDays ?? 7);

  const sessionFiles: Record<string, string> = {};
  for (const s of sessions) {
    sessionFiles[s.sessionId] = s.filePath;
  }

  return {
    generatedAt: now.toISOString(),
    claudeHome,
    found,
    aggregates,
    results,
    savings,
    trends,
    sessionFiles,
  };
}

/**
 * Parse a single transcript on demand and build its drill-down detail. The
 * sessionId and project are derived from the file path (<projects>/<proj>/<id>.jsonl).
 */
export async function loadSessionDetail(filePath: string): Promise<SessionDetail> {
  const sessionId = path.basename(filePath).replace(/\.jsonl$/, "");
  const project = path.basename(path.dirname(filePath));
  const lines = [];
  for await (const line of readTranscript(filePath)) {
    lines.push(line);
  }
  const model = buildSessionModel(lines, { sessionId, filePath, project });
  return buildSessionDetail(model);
}
