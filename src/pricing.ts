/**
 * Cost estimation. Prices are per 1M tokens (USD), first-party API rates.
 * Cache reads have their own per-model price (0.1x input on most models, lower
 * on Fable 5.1 / Opus 5.5); cache writes bill at 1.25x input (5-min TTL) or
 * 2x input (1-hour TTL) on every model.
 *
 * These are estimates — the local stats-cache reports costUSD:0, so we compute
 * our own. Keyed by model-id prefix so dated snapshots resolve too.
 */
import type { SessionModel, TokenTotals, Turn } from "./model";

export interface Rate {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-read tokens. */
  cacheRead: number;
}

/** Date the rate table below was last checked against published pricing. */
export const PRICING_AS_OF = "2026-09-25";

export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;

function rate(input: number, output: number, cacheRead = input / 10): Rate {
  return { input, output, cacheRead };
}

/**
 * Longest-prefix match wins, so a specific version (`claude-opus-5-5`) beats
 * its family fallback (`claude-opus`). Family fallbacks cover unknown future
 * snapshots at the current generation's price.
 */
const RATE_TABLE: Array<[prefix: string, rate: Rate]> = [
  // Fable / Mythos
  ["claude-fable-5-1", rate(10, 50, 0.25)],
  ["claude-mythos-5-1", rate(10, 50, 0.25)],
  ["claude-fable-5", rate(10, 50)],
  ["claude-mythos-5", rate(10, 50)],
  ["claude-fable", rate(10, 50)],
  ["claude-mythos", rate(10, 50)],
  // Opus
  ["claude-opus-5-5", rate(4, 20, 0.2)],
  ["claude-opus-5", rate(5, 25)],
  ["claude-opus-4-8", rate(5, 25)],
  ["claude-opus-4-7", rate(5, 25)],
  ["claude-opus-4-6", rate(5, 25)],
  ["claude-opus-4-5", rate(5, 25)],
  ["claude-opus-4", rate(15, 75)], // Opus 4 / 4.1
  ["claude-3-opus", rate(15, 75)],
  ["claude-opus", rate(4, 20, 0.2)],
  // Sonnet
  ["claude-sonnet-5-5", rate(2, 10)],
  ["claude-sonnet-5", rate(2, 10)],
  ["claude-sonnet-4", rate(3, 15)], // Sonnet 4 / 4.5 / 4.6
  ["claude-3-7-sonnet", rate(3, 15)],
  ["claude-3-5-sonnet", rate(3, 15)],
  ["claude-sonnet", rate(2, 10)],
  // Haiku
  ["claude-haiku-4-5", rate(1, 5)],
  ["claude-3-5-haiku", rate(0.8, 4)],
  ["claude-3-haiku", rate(0.25, 1.25)],
  ["claude-haiku", rate(1, 5)],
];

/** Fast mode (`usage.speed === "fast"`) runs the same model at premium rates. */
const FAST_RATE_TABLE: Array<[prefix: string, rate: Rate]> = [
  ["claude-opus-5-5", rate(8, 40, 0.4)],
  ["claude-opus-5", rate(10, 50)],
];

const DEFAULT_RATE: Rate = rate(5, 25);

/**
 * Strip provider decoration so Bedrock (`us.anthropic.claude-…-v1:0`) and
 * Vertex (`claude-…@20250805`) ids match the first-party table.
 */
export function normalizeModelId(modelId: string): string {
  const idx = modelId.indexOf("claude-");
  const bare = idx >= 0 ? modelId.slice(idx) : modelId;
  return bare.split("@")[0];
}

function longestPrefix<T>(table: Array<[string, T]>, modelId: string): T | undefined {
  let best: T | undefined;
  let bestLen = -1;
  for (const [prefix, value] of table) {
    if (modelId.startsWith(prefix) && prefix.length > bestLen) {
      best = value;
      bestLen = prefix.length;
    }
  }
  return best;
}

export function rateForModel(modelId: string | undefined, speed?: string): Rate {
  if (!modelId) {
    return DEFAULT_RATE;
  }
  const id = normalizeModelId(modelId);
  if (speed === "fast") {
    const fast = longestPrefix(FAST_RATE_TABLE, id);
    if (fast) {
      return fast;
    }
  }
  return longestPrefix(RATE_TABLE, id) ?? DEFAULT_RATE;
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
  const cacheReadCost = (totals.cacheRead / PER_TOKEN) * rate.cacheRead;
  const cacheWriteCost =
    (write5m / PER_TOKEN) * rate.input * CACHE_WRITE_5M_MULTIPLIER +
    (write1h / PER_TOKEN) * rate.input * CACHE_WRITE_1H_MULTIPLIER;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

/** Estimate what a raw input-token count would have cost as uncached input. */
export function costOfInputTokens(tokens: number, rate: Rate): number {
  return (tokens / PER_TOKEN) * rate.input;
}

/** Cost of one turn, priced at the model and speed that turn actually used. */
export function turnCost(turn: Turn): number {
  return estimateCost(turn.usage, rateForModel(turn.model, turn.speed));
}

/** Session cost as the sum of per-turn costs, so mid-session model switches price correctly. */
export function sessionCost(session: SessionModel): number {
  return session.turns.reduce((sum, t) => sum + turnCost(t), 0);
}

/** Context window (tokens) by model-id prefix, longest match wins. */
const CONTEXT_WINDOW: Array<[prefix: string, tokens: number]> = [
  ["claude-haiku", 200_000],
  ["claude-opus", 1_000_000],
  ["claude-opus-4", 200_000],
  ["claude-opus-4-6", 1_000_000],
  ["claude-opus-4-7", 1_000_000],
  ["claude-opus-4-8", 1_000_000],
  ["claude-sonnet", 1_000_000],
  ["claude-sonnet-4", 200_000],
  ["claude-sonnet-4-6", 1_000_000],
  ["claude-fable", 1_000_000],
  ["claude-mythos", 1_000_000],
];
const DEFAULT_CONTEXT_WINDOW = 200_000;

export function contextWindowForModel(modelId: string | undefined): number {
  if (!modelId) {
    return DEFAULT_CONTEXT_WINDOW;
  }
  return longestPrefix(CONTEXT_WINDOW, normalizeModelId(modelId)) ?? DEFAULT_CONTEXT_WINDOW;
}
