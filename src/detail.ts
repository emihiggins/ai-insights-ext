/**
 * Per-session drill-down model: turn-by-turn token/cost, compaction markers
 * mapped to their position in the turn sequence, and the top-cost tool calls.
 * Pure logic — no vscode.
 */
import type { SessionModel, TokenTotals } from "./model";
import { primaryModel } from "./model";
import { rateForModel, estimateCost, costOfInputTokens } from "./pricing";
import { cacheReadRatio } from "./aggregates";

const CHARS_PER_TOKEN = 4;

export interface TurnDetail {
  index: number;
  timestamp?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  /** Tokens the model processed this turn (input + cacheRead + cacheCreate). */
  promptTokens: number;
  costUSD: number;
}

export interface ToolDetail {
  id: string;
  name: string;
  /** Command (Bash) or file path (Read/Edit/Write), truncated for display. */
  label?: string;
  resultChars: number;
  estTokens: number;
  costUSD: number;
  isError: boolean;
  interrupted: boolean;
  timestamp?: string;
}

export interface CompactionMarker {
  timestamp?: string;
  preTokens: number;
  postTokens: number;
  droppedTokens: number;
  /** Number of turns that occurred at or before this compaction. */
  afterTurn: number;
}

export interface SessionDetail {
  sessionId: string;
  project: string;
  filePath: string;
  model?: string;
  firstTs?: string;
  lastTs?: string;
  totals: TokenTotals;
  costUSD: number;
  cacheReadRatio: number;
  turnCount: number;
  turns: TurnDetail[];
  topTools: ToolDetail[];
  compactions: CompactionMarker[];
  /** Distinct tool call count by name, for a quick mix summary. */
  toolCounts: Record<string, number>;
}

function truncate(s: string | undefined, n = 100): string | undefined {
  if (!s) {
    return undefined;
  }
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function buildSessionDetail(session: SessionModel, topN = 15): SessionDetail {
  const rate = rateForModel(primaryModel(session));

  const turns: TurnDetail[] = session.turns.map((t, i) => ({
    index: i,
    timestamp: t.timestamp,
    input: t.usage.input,
    output: t.usage.output,
    cacheRead: t.usage.cacheRead,
    cacheCreate: t.usage.cacheCreate,
    promptTokens: t.usage.input + t.usage.cacheRead + t.usage.cacheCreate,
    costUSD: estimateCost(t.usage, rate),
  }));

  const tools: ToolDetail[] = session.toolCalls.map((c) => {
    const resultChars = c.resultChars ?? 0;
    const estTokens = Math.round(resultChars / CHARS_PER_TOKEN);
    return {
      id: c.id,
      name: c.name,
      label: truncate(c.command ?? c.filePath),
      resultChars,
      estTokens,
      costUSD: costOfInputTokens(estTokens, rate),
      isError: c.isError === true,
      interrupted: c.interrupted === true,
      timestamp: c.timestamp,
    };
  });

  // Top tools by estimated token footprint; errors/interrupts float up on ties.
  const topTools = [...tools]
    .sort((a, b) => b.estTokens - a.estTokens || Number(b.isError) - Number(a.isError))
    .slice(0, topN);

  const toolCounts: Record<string, number> = {};
  for (const c of session.toolCalls) {
    toolCounts[c.name] = (toolCounts[c.name] ?? 0) + 1;
  }

  const compactions: CompactionMarker[] = session.compactions.map((c) => ({
    timestamp: c.timestamp,
    preTokens: c.preTokens,
    postTokens: c.postTokens,
    droppedTokens: c.droppedTokens,
    afterTurn: c.timestamp
      ? session.turns.filter((t) => (t.timestamp ?? "") <= c.timestamp!).length
      : 0,
  }));

  return {
    sessionId: session.sessionId,
    project: session.project,
    filePath: session.filePath,
    model: primaryModel(session),
    firstTs: session.firstTs,
    lastTs: session.lastTs,
    totals: session.totals,
    costUSD: turns.reduce((sum, t) => sum + t.costUSD, 0),
    cacheReadRatio: cacheReadRatio(session.totals),
    turnCount: session.turns.length,
    turns,
    topTools,
    compactions,
    toolCounts,
  };
}
