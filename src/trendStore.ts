import type * as vscode from "vscode";
import type { DailyMetric } from "./trends";

/**
 * Persists the daily trend series in the extension's globalState so history
 * survives across restarts and outlives transcript pruning. Capped to keep the
 * stored blob small.
 */
// v2: v1 history was computed before per-response usage dedupe and per-model
// pricing, so its token and cost figures are inflated. Start fresh.
const KEY = "ccOptimizer.trendHistory.v2";
const MAX_DAYS = 180;

const LEGACY_KEYS = ["ccOptimizer.trendHistory.v1"];

export function loadTrendHistory(context: vscode.ExtensionContext): DailyMetric[] {
  for (const legacy of LEGACY_KEYS) {
    if (context.globalState.get(legacy) !== undefined) {
      void context.globalState.update(legacy, undefined);
    }
  }
  const raw = context.globalState.get<DailyMetric[]>(KEY);
  return Array.isArray(raw) ? raw : [];
}

export async function saveTrendHistory(context: vscode.ExtensionContext, series: DailyMetric[]): Promise<void> {
  const trimmed = series.slice(-MAX_DAYS);
  await context.globalState.update(KEY, trimmed);
}
