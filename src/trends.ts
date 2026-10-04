/**
 * Efficiency trends over time + regression detection.
 *
 * The daily series is derived from transcripts (source of truth), then merged
 * with any persisted history so days whose transcripts have since been pruned
 * still appear. Regressions compare a recent window to the prior window of the
 * same length. Pure logic — no vscode.
 */
import type { SessionModel } from "./model";
import { turnCost } from "./pricing";

export interface DailyMetric {
  date: string; // YYYY-MM-DD (UTC)
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  tokens: number; // input + output + cacheRead + cacheCreate
  costUSD: number;
  cacheReadRatio: number;
  compactions: number;
  activeSessions: number;
}

export type RegressionMetric = "cacheReuse" | "costPerSession" | "compactionsPerSession";

export interface Regression {
  metric: RegressionMetric;
  title: string;
  detail: string;
  severity: "high" | "medium";
  recent: number;
  prior: number;
}

export interface WindowAgg {
  days: number;
  tokens: number;
  costUSD: number;
  cacheReadRatio: number;
  compactions: number;
  activeSessions: number;
  costPerSession: number;
}

export interface TrendReport {
  series: DailyMetric[];
  windowDays: number;
  recent?: WindowAgg;
  prior?: WindowAgg;
  regressions: Regression[];
}

function dateOf(ts: string | undefined): string | undefined {
  if (!ts) {
    return undefined;
  }
  const idx = ts.indexOf("T");
  return idx > 0 ? ts.slice(0, idx) : undefined;
}

function dayNumber(date: string): number {
  return Math.floor(Date.parse(date + "T00:00:00Z") / 86_400_000);
}

interface Bucket {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  costUSD: number;
  compactions: number;
  sessionIds: Set<string>;
}

function emptyBucket(): Bucket {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costUSD: 0, compactions: 0, sessionIds: new Set() };
}

/** Build the per-day metric series from parsed sessions. */
export function computeDailySeries(sessions: SessionModel[]): DailyMetric[] {
  const buckets = new Map<string, Bucket>();
  const bucket = (date: string): Bucket => {
    let b = buckets.get(date);
    if (!b) {
      b = emptyBucket();
      buckets.set(date, b);
    }
    return b;
  };

  for (const s of sessions) {
    // Subagent work counts toward its parent session, not as a new session.
    const countedSessionId = s.parentSessionId ?? s.sessionId;
    for (const turn of s.turns) {
      const date = dateOf(turn.timestamp);
      if (!date) {
        continue;
      }
      const b = bucket(date);
      b.input += turn.usage.input;
      b.output += turn.usage.output;
      b.cacheRead += turn.usage.cacheRead;
      b.cacheCreate += turn.usage.cacheCreate;
      b.costUSD += turnCost(turn);
      b.sessionIds.add(countedSessionId);
    }
    for (const c of s.compactions) {
      const date = dateOf(c.timestamp);
      if (date) {
        bucket(date).compactions += 1;
      }
    }
  }

  const out: DailyMetric[] = [];
  for (const [date, b] of buckets) {
    const denom = b.cacheRead + b.cacheCreate + b.input;
    out.push({
      date,
      input: b.input,
      output: b.output,
      cacheRead: b.cacheRead,
      cacheCreate: b.cacheCreate,
      tokens: b.input + b.output + b.cacheRead + b.cacheCreate,
      costUSD: b.costUSD,
      cacheReadRatio: denom > 0 ? b.cacheRead / denom : 0,
      compactions: b.compactions,
      activeSessions: b.sessionIds.size,
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/** Merge persisted history with a freshly computed series; computed wins per date. */
export function mergeSeries(persisted: DailyMetric[], computed: DailyMetric[]): DailyMetric[] {
  const byDate = new Map<string, DailyMetric>();
  for (const d of persisted) {
    byDate.set(d.date, d);
  }
  for (const d of computed) {
    byDate.set(d.date, d);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function aggregate(entries: DailyMetric[], windowDays: number): WindowAgg {
  let input = 0;
  let cacheRead = 0;
  let cacheCreate = 0;
  let tokens = 0;
  let costUSD = 0;
  let compactions = 0;
  let activeSessions = 0;
  for (const e of entries) {
    input += e.input;
    cacheRead += e.cacheRead;
    cacheCreate += e.cacheCreate;
    tokens += e.tokens;
    costUSD += e.costUSD;
    compactions += e.compactions;
    activeSessions += e.activeSessions; // per-day counts; approximate across days
  }
  const denom = cacheRead + cacheCreate + input;
  return {
    days: windowDays,
    tokens,
    costUSD,
    cacheReadRatio: denom > 0 ? cacheRead / denom : 0,
    compactions,
    activeSessions,
    costPerSession: activeSessions > 0 ? costUSD / activeSessions : 0,
  };
}

const CACHE_DROP_POINTS = 0.08; // 8 percentage points
const COST_UP_FACTOR = 1.25;
const COMPACTION_UP_DELTA = 0.2;
const COMPACTION_UP_FACTOR = 1.5;
// Guards against sparse-window noise: comparing 1 session to 11, or a near-empty
// window, produces meaningless ratios. Require enough signal in BOTH windows.
const MIN_SESSIONS_PER_WINDOW = 3;
const MIN_TOKENS_PER_WINDOW = 20_000;

/**
 * Compare the most recent `windowDays` to the preceding `windowDays`. Requires
 * at least one full prior window of data; otherwise returns no regressions.
 */
export function detectRegressions(
  series: DailyMetric[],
  windowDays: number
): { recent?: WindowAgg; prior?: WindowAgg; regressions: Regression[] } {
  if (series.length === 0) {
    return { regressions: [] };
  }
  const anchor = dayNumber(series[series.length - 1].date);
  const recentEntries = series.filter((e) => {
    const d = anchor - dayNumber(e.date);
    return d >= 0 && d < windowDays;
  });
  const priorEntries = series.filter((e) => {
    const d = anchor - dayNumber(e.date);
    return d >= windowDays && d < windowDays * 2;
  });

  const recent = recentEntries.length > 0 ? aggregate(recentEntries, windowDays) : undefined;
  if (priorEntries.length === 0 || !recent) {
    return { recent, regressions: [] };
  }
  const prior = aggregate(priorEntries, windowDays);
  const regressions: Regression[] = [];
  const pctPts = (n: number): string => (n * 100).toFixed(0) + "%";
  const usd = (n: number): string => "$" + n.toFixed(2);

  const enoughSessions = recent.activeSessions >= MIN_SESSIONS_PER_WINDOW && prior.activeSessions >= MIN_SESSIONS_PER_WINDOW;
  const enoughTokens = recent.tokens >= MIN_TOKENS_PER_WINDOW && prior.tokens >= MIN_TOKENS_PER_WINDOW;
  // Too little data in either window to compare fairly.
  if (!enoughSessions || !enoughTokens) {
    return { recent, prior, regressions: [] };
  }

  // 1. Cache reuse dropped.
  if (prior.cacheReadRatio - recent.cacheReadRatio >= CACHE_DROP_POINTS) {
    const drop = prior.cacheReadRatio - recent.cacheReadRatio;
    regressions.push({
      metric: "cacheReuse",
      title: `Cache reuse dropped ${(drop * 100).toFixed(0)} points`,
      detail:
        `Cache-read ratio fell from ${pctPts(prior.cacheReadRatio)} to ${pctPts(recent.cacheReadRatio)} over the last ` +
        `${windowDays} days. Lower reuse means more full-price cache writes — check for a newly volatile prompt prefix.`,
      severity: drop >= 0.15 ? "high" : "medium",
      recent: recent.cacheReadRatio,
      prior: prior.cacheReadRatio,
    });
  }

  // 2. Cost per active session up.
  if (prior.costPerSession > 0 && recent.costPerSession >= prior.costPerSession * COST_UP_FACTOR) {
    const factor = recent.costPerSession / prior.costPerSession;
    regressions.push({
      metric: "costPerSession",
      title: `Cost per session up ${((factor - 1) * 100).toFixed(0)}%`,
      detail:
        `Estimated cost per active session rose from ${usd(prior.costPerSession)} to ${usd(recent.costPerSession)} ` +
        `over the last ${windowDays} days.`,
      severity: factor >= 1.75 ? "high" : "medium",
      recent: recent.costPerSession,
      prior: prior.costPerSession,
    });
  }

  // 3. Compactions per session up.
  const recentCPS = recent.activeSessions > 0 ? recent.compactions / recent.activeSessions : 0;
  const priorCPS = prior.activeSessions > 0 ? prior.compactions / prior.activeSessions : 0;
  if (recentCPS - priorCPS >= COMPACTION_UP_DELTA && recentCPS >= priorCPS * COMPACTION_UP_FACTOR) {
    regressions.push({
      metric: "compactionsPerSession",
      title: "More sessions are compacting",
      detail:
        `Compactions per session rose from ${priorCPS.toFixed(2)} to ${recentCPS.toFixed(2)} over the last ` +
        `${windowDays} days — sessions are outgrowing the context window more often.`,
      severity: "medium",
      recent: recentCPS,
      prior: priorCPS,
    });
  }

  return { recent, prior, regressions };
}

export function computeTrends(
  sessions: SessionModel[],
  persisted: DailyMetric[] = [],
  windowDays = 7
): TrendReport {
  const computed = computeDailySeries(sessions);
  const series = mergeSeries(persisted, computed);
  const { recent, prior, regressions } = detectRegressions(series, windowDays);
  return { series, windowDays, recent, prior, regressions };
}
