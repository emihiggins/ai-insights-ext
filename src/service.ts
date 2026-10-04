/**
 * Orchestrates a full analysis pass: discover transcripts, aggregate metrics,
 * run the recommendation rules. No vscode dependency — the extension host
 * passes in the resolved config, filter, and dismissals.
 */
import * as path from "path";
import { projectsDir, loadAllSessions, type SessionCache } from "./discovery";
import { readTranscript } from "./parser";
import { buildSessionModel, type SessionModel } from "./model";
import { buildSessionDetail, type SessionDetail } from "./detail";
import { computeAggregates, type DashboardAggregates } from "./aggregates";
import { runAllRules, type RuleConfig, type RuleResults } from "./rules/index";
import { computeSavings, type SavingsReport } from "./savings";
import { computeTrends, type TrendReport, type DailyMetric } from "./trends";
import { PRICING_AS_OF } from "./pricing";
import { projectLabels } from "./names";
import * as fsp from "fs/promises";

/** Which sessions the dashboard covers. Empty = everything. */
export interface AnalysisFilter {
  /** 1 = today (since local midnight); N = the last N days; undefined = all time. */
  rangeDays?: number;
  /** Encoded project directory name; undefined = all projects. */
  project?: string;
}

export interface ProjectInfo {
  project: string;
  label: string;
  sessionCount: number;
  /** The project's sessions ran inside one of the open workspace folders. */
  inWorkspace: boolean;
}

/** Dismissed finding keys -> epoch ms the dismissal expires (0 = never). */
export type Dismissals = Record<string, number>;

export interface DashboardPayload {
  generatedAt: string;
  /** Date the built-in price table was last checked. */
  pricingAsOf: string;
  claudeHome: string;
  /** Whether ~/.claude/projects exists at all. */
  found: boolean;
  filter: AnalysisFilter;
  projects: ProjectInfo[];
  aggregates: DashboardAggregates;
  results: RuleResults;
  /** Findings hidden by an active dismissal or snooze. */
  dismissedCount: number;
  savings: SavingsReport;
  /** Trends for the selected project (range filter not applied — it is a time series). */
  trends: TrendReport;
  /** sessionId -> transcript file path, so the webview can request "open". */
  sessionFiles: Record<string, string>;
}

export interface AnalyzeOptions {
  now?: Date;
  /** Persisted daily history, merged with the freshly computed all-projects series. */
  persistedTrends?: DailyMetric[];
  /** Regression comparison window in days. */
  trendWindowDays?: number;
  filter?: AnalysisFilter;
  dismissed?: Dismissals;
  /** Absolute paths of open workspace folders, to mark matching projects. */
  workspacePaths?: string[];
  cache?: SessionCache;
}

export interface AnalyzeResult {
  payload: DashboardPayload;
  /** All-projects daily series to persist (independent of the filter). */
  seriesToPersist: DailyMetric[];
}

function rangeCutoff(rangeDays: number, now: Date): number {
  if (rangeDays <= 1) {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return midnight.getTime();
  }
  return now.getTime() - rangeDays * 86_400_000;
}

function isUnder(dir: string, root: string): boolean {
  const rel = path.relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function describeProjects(sessions: SessionModel[], workspacePaths: string[]): ProjectInfo[] {
  const cwds = new Map<string, string[]>();
  const counts = new Map<string, number>();
  const inWorkspace = new Set<string>();
  for (const s of sessions) {
    const list = cwds.get(s.project) ?? [];
    if (s.cwd) {
      list.push(s.cwd);
      if (workspacePaths.some((w) => isUnder(s.cwd!, w))) {
        inWorkspace.add(s.project);
      }
    }
    cwds.set(s.project, list);
    if (!s.parentSessionId) {
      counts.set(s.project, (counts.get(s.project) ?? 0) + 1);
    }
  }
  const labels = projectLabels(cwds);
  return [...cwds.keys()]
    .map((project) => ({
      project,
      label: labels.get(project) ?? project,
      sessionCount: counts.get(project) ?? 0,
      inWorkspace: inWorkspace.has(project),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Whether a dismissal is still in effect. */
export function isDismissed(key: string | undefined, dismissed: Dismissals, now: Date): boolean {
  if (!key || !(key in dismissed)) {
    return false;
  }
  const until = dismissed[key];
  return until === 0 || until > now.getTime();
}

export async function analyze(claudeHome: string, config: RuleConfig, opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const now = opts.now ?? new Date();
  const filter = opts.filter ?? {};
  let found = true;
  try {
    await fsp.access(projectsDir(claudeHome));
  } catch {
    found = false;
  }

  const all = await loadAllSessions(claudeHome, opts.cache);
  const projects = describeProjects(all, opts.workspacePaths ?? []);

  // A stale project filter (project since deleted) falls back to all projects.
  const project = filter.project && projects.some((p) => p.project === filter.project) ? filter.project : undefined;
  const inProject = project ? all.filter((s) => s.project === project) : all;
  const cutoff = filter.rangeDays ? rangeCutoff(filter.rangeDays, now) : undefined;
  const sessions =
    cutoff === undefined
      ? inProject
      : inProject.filter((s) => {
          const last = s.lastTs ? Date.parse(s.lastTs) : NaN;
          return Number.isFinite(last) && last >= cutoff;
        });

  const aggregates = computeAggregates(sessions);
  const ruleResults = runAllRules(sessions, config, now);
  const dismissed = opts.dismissed ?? {};
  const visible = ruleResults.findings.filter((f) => !isDismissed(f.key, dismissed, now));
  const results: RuleResults = {
    findings: visible,
    oneOffs: visible.filter((f) => f.scope === "one-off"),
    habits: visible.filter((f) => f.scope === "habit"),
  };
  const savings = computeSavings(results.findings, aggregates.totalCostUSD);

  const windowDays = opts.trendWindowDays ?? 7;
  const allTrends = computeTrends(all, opts.persistedTrends ?? [], windowDays);
  // Persisted history is all-projects, so only merge it into the unfiltered view.
  const trends = project ? computeTrends(inProject, [], windowDays) : allTrends;

  const sessionFiles: Record<string, string> = {};
  for (const s of sessions) {
    sessionFiles[s.sessionId] = s.filePath;
  }

  return {
    payload: {
      generatedAt: now.toISOString(),
      pricingAsOf: PRICING_AS_OF,
      claudeHome,
      found,
      filter: { rangeDays: filter.rangeDays, project },
      projects,
      aggregates,
      results,
      dismissedCount: ruleResults.findings.length - visible.length,
      savings,
      trends,
      sessionFiles,
    },
    seriesToPersist: allTrends.series,
  };
}

/**
 * Build the drill-down detail for one transcript. Uses the cached session when
 * available (it carries the corpus-calibrated chars-per-token); otherwise
 * parses on demand, deriving sessionId and project from the path: either
 * <projects>/<proj>/<id>.jsonl or <projects>/<proj>/<parent>/subagents/<id>.jsonl.
 */
export async function loadSessionDetail(filePath: string, cache?: SessionCache): Promise<SessionDetail> {
  const cached = cache?.peek(filePath);
  if (cached) {
    return buildSessionDetail(cached);
  }
  const sessionId = path.basename(filePath).replace(/\.jsonl$/, "");
  const dir = path.dirname(filePath);
  const isSubagent = path.basename(dir) === "subagents";
  const parentSessionId = isSubagent ? path.basename(path.dirname(dir)) : undefined;
  const project = path.basename(isSubagent ? path.dirname(path.dirname(dir)) : dir);
  const lines = [];
  for await (const line of readTranscript(filePath)) {
    lines.push(line);
  }
  const model = buildSessionModel(lines, { sessionId, filePath, project, parentSessionId });
  return buildSessionDetail(model);
}
