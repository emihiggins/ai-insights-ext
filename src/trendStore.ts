import type * as vscode from "vscode";
import type { DailyMetric } from "./trends";

/**
 * Persists the daily trend series in the extension's globalState so history
 * survives across restarts and outlives transcript pruning. Capped to keep the
 * stored blob small.
 */
const KEY = "ccOptimizer.trendHistory.v1";
const MAX_DAYS = 180;

export function loadTrendHistory(context: vscode.ExtensionContext): DailyMetric[] {
  const raw = context.globalState.get<DailyMetric[]>(KEY);
  return Array.isArray(raw) ? raw : [];
}

export async function saveTrendHistory(context: vscode.ExtensionContext, series: DailyMetric[]): Promise<void> {
  const trimmed = series.slice(-MAX_DAYS);
  await context.globalState.update(KEY, trimmed);
}
