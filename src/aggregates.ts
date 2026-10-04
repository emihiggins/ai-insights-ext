/**
 * Cross-session and per-session aggregate metrics for the dashboard.
 * Pure logic — no vscode.
 */
import type { SessionModel, TokenTotals } from "./model";
import { primaryModel } from "./model";
import { sessionCost, turnCost, contextWindowForModel } from "./pricing";

/** Fraction of billed input served from cache: read / (read + create + input). */
export function cacheReadRatio(t: TokenTotals): number {
  const denom = t.cacheRead + t.cacheCreate + t.input;
  return denom > 0 ? t.cacheRead / denom : 0;
}

export interface DailyPoint {
  date: string; // YYYY-MM-DD (UTC)
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  costUSD: number;
}

export interface SessionSummary {
  sessionId: string;
  project: string;
  model?: string;
  /** Set for subagent transcripts: the session that spawned this agent. */
  parentSessionId?: string;
  title?: string;
  /** Prompt size of the latest turn — how full the context is now. */
  lastPromptTokens: number;
  contextWindow: number;
  turns: number;
  totals: TokenTotals;
  costUSD: number;
  cacheReadRatio: number;
  compactions: number;
  firstTs?: string;
  lastTs?: string;
}

export interface DashboardAggregates {
  /** Top-level sessions; subagent transcripts are counted in subagentCount. */
  sessionCount: number;
  subagentCount: number;
  totals: TokenTotals;
  totalCostUSD: number;
  cacheReadRatio: number;
  compactionCount: number;
  toolCounts: Record<string, number>;
  modelTurns: Record<string, number>;
  perDay: DailyPoint[];
  sessions: SessionSummary[];
}

function dateOf(ts: string | undefined): string | undefined {
  if (!ts) {
    return undefined;
  }
  // ISO-8601 -> YYYY-MM-DD
  const idx = ts.indexOf("T");
  return idx > 0 ? ts.slice(0, idx) : undefined;
}

function lastPromptTokens(session: SessionModel): number {
  const last = session.turns[session.turns.length - 1];
  return last ? last.usage.input + last.usage.cacheRead + last.usage.cacheCreate : 0;
}

export function summarizeSession(session: SessionModel): SessionSummary {
  return {
    sessionId: session.sessionId,
    project: session.project,
    model: primaryModel(session),
    parentSessionId: session.parentSessionId,
    title: session.title,
    lastPromptTokens: lastPromptTokens(session),
    contextWindow: contextWindowForModel(primaryModel(session)),
    turns: session.turns.length,
    totals: session.totals,
    costUSD: sessionCost(session),
    cacheReadRatio: cacheReadRatio(session.totals),
    compactions: session.compactions.length,
    firstTs: session.firstTs,
    lastTs: session.lastTs,
  };
}

export function computeAggregates(sessions: SessionModel[]): DashboardAggregates {
  const totals: TokenTotals = {
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    ephemeral5m: 0,
    ephemeral1h: 0,
  };
  const toolCounts: Record<string, number> = {};
  const modelTurns: Record<string, number> = {};
  const perDayMap = new Map<string, DailyPoint>();
  let totalCostUSD = 0;
  let compactionCount = 0;
  const summaries: SessionSummary[] = [];

  for (const s of sessions) {
    totals.input += s.totals.input;
    totals.output += s.totals.output;
    totals.cacheCreate += s.totals.cacheCreate;
    totals.cacheRead += s.totals.cacheRead;
    totals.ephemeral5m += s.totals.ephemeral5m;
    totals.ephemeral1h += s.totals.ephemeral1h;
    totalCostUSD += sessionCost(s);
    compactionCount += s.compactions.length;

    for (const [m, n] of Object.entries(s.modelTurns)) {
      modelTurns[m] = (modelTurns[m] ?? 0) + n;
    }
    for (const call of s.toolCalls) {
      toolCounts[call.name] = (toolCounts[call.name] ?? 0) + 1;
    }

    for (const turn of s.turns) {
      const day = dateOf(turn.timestamp);
      if (!day) {
        continue;
      }
      let point = perDayMap.get(day);
      if (!point) {
        point = { date: day, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costUSD: 0 };
        perDayMap.set(day, point);
      }
      point.input += turn.usage.input;
      point.output += turn.usage.output;
      point.cacheRead += turn.usage.cacheRead;
      point.cacheCreate += turn.usage.cacheCreate;
      point.costUSD += turnCost(turn);
    }

    summaries.push(summarizeSession(s));
  }

  const perDay = [...perDayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  summaries.sort((a, b) => b.costUSD - a.costUSD);

  return {
    sessionCount: sessions.filter((s) => !s.parentSessionId).length,
    subagentCount: sessions.filter((s) => s.parentSessionId).length,
    totals,
    totalCostUSD,
    cacheReadRatio: cacheReadRatio(totals),
    compactionCount,
    toolCounts,
    modelTurns,
    perDay,
    sessions: summaries,
  };
}
