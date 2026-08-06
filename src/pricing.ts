/**
 * Cost estimation. Prices are per 1M tokens (USD). Cache reads bill at ~0.1x
 * the base input rate; cache writes at 1.25x (5-min TTL) or 2x (1-hour TTL).
 *
 * These are estimates — the local stats-cache reports costUSD:0, so we compute
 * our own. Keyed by model-id prefix so dated snapshots resolve too.
 */
import type { SessionModel, TokenTotals } from "./model";
import { primaryModel } from "./model";

export interface Rate {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;

/** Longest-prefix match wins, so keep more specific keys first. */
const RATE_TABLE: Array<[prefix: string, rate: Rate]> = [
  ["claude-opus", { input: 5, output: 25 }],
  ["claude-sonnet", { input: 3, output: 15 }],
  ["claude-haiku", { input: 1, output: 5 }],
  ["claude-fable", { input: 10, output: 50 }],
];

const DEFAULT_RATE: Rate = { input: 5, output: 25 };

export function rateForModel(modelId: string | undefined): Rate {
  if (!modelId) {
    return DEFAULT_RATE;
  }
  let best: Rate | undefined;
  let bestLen = -1;
  for (const [prefix, rate] of RATE_TABLE) {
    if (modelId.startsWith(prefix) && prefix.length > bestLen) {
      best = rate;
      bestLen = prefix.length;
    }
  }
  return best ?? DEFAULT_RATE;
}

const PER_TOKEN = 1_000_000;

/**
 * Estimate USD cost for a token breakdown under a given rate. Cache-write cost
 * splits by TTL using the ephemeral breakdown; any remainder falls back to 5m.
 */
export function estimateCost(totals: TokenTotals, rate: Rate): number {
  const knownEphemeral = totals.ephemeral5m + totals.ephemeral1h;
  const write5m = totals.ephemeral5m + Math.max(0, totals.cacheCreate - knownEphemeral);
  const write1h = totals.ephemeral1h;

  const inputCost = (totals.input / PER_TOKEN) * rate.input;
  const outputCost = (totals.output / PER_TOKEN) * rate.output;
  const cacheReadCost = (totals.cacheRead / PER_TOKEN) * rate.input * CACHE_READ_MULTIPLIER;
  const cacheWriteCost =
    (write5m / PER_TOKEN) * rate.input * CACHE_WRITE_5M_MULTIPLIER +
    (write1h / PER_TOKEN) * rate.input * CACHE_WRITE_1H_MULTIPLIER;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

/** Estimate what a raw input-token count would have cost as uncached input. */
export function costOfInputTokens(tokens: number, rate: Rate): number {
  return (tokens / PER_TOKEN) * rate.input;
}

export function sessionCost(session: SessionModel): number {
  return estimateCost(session.totals, rateForModel(primaryModel(session)));
}

/** Context window (tokens) by model-id prefix, longest match wins. */
const CONTEXT_WINDOW: Array<[prefix: string, tokens: number]> = [
  ["claude-haiku", 200_000],
  ["claude-opus", 1_000_000],
  ["claude-sonnet", 1_000_000],
  ["claude-fable", 1_000_000],
];
const DEFAULT_CONTEXT_WINDOW = 200_000;

export function contextWindowForModel(modelId: string | undefined): number {
  if (!modelId) {
    return DEFAULT_CONTEXT_WINDOW;
  }
  let best = DEFAULT_CONTEXT_WINDOW;
  let bestLen = -1;
  for (const [prefix, tokens] of CONTEXT_WINDOW) {
    if (modelId.startsWith(prefix) && prefix.length > bestLen) {
      best = tokens;
      bestLen = prefix.length;
    }
  }
  return best;
}
