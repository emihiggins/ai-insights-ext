import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rateForModel,
  rateForTurn,
  estimateCost,
  costOfInputTokens,
  normalizeModelId,
  sessionCost,
  contextWindowForModel,
} from "../src/pricing";
import { parseTranscriptString } from "../src/parser";
import { buildSessionModel } from "../src/model";
import { assistantLine, jsonl } from "./fixtures";

const ZERO = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, ephemeral5m: 0, ephemeral1h: 0 };

test("rateForModel resolves current models to their own prices", () => {
  assert.deepEqual(rateForModel("claude-fable-5-1"), { input: 10, output: 50, cacheRead: 0.25 });
  assert.deepEqual(rateForModel("claude-mythos-5-1"), { input: 10, output: 50, cacheRead: 0.25 });
  assert.deepEqual(rateForModel("claude-fable-5"), { input: 10, output: 50, cacheRead: 1 });
  assert.deepEqual(rateForModel("claude-opus-5-5"), { input: 4, output: 20, cacheRead: 0.2 });
  assert.deepEqual(rateForModel("claude-opus-5"), { input: 5, output: 25, cacheRead: 0.5 });
  assert.deepEqual(rateForModel("claude-opus-4-8"), { input: 5, output: 25, cacheRead: 0.5 });
  assert.deepEqual(rateForModel("claude-sonnet-5-5"), { input: 2, output: 10, cacheRead: 0.1 });
  assert.deepEqual(rateForModel("claude-sonnet-5"), { input: 2, output: 10, cacheRead: 0.2 });
  assert.deepEqual(rateForModel("claude-sonnet-4-6"), { input: 3, output: 15, cacheRead: 0.3 });
  assert.deepEqual(rateForModel("claude-haiku-5-5"), { input: 0.1, output: 0.5, cacheRead: 0.01 });
  assert.deepEqual(rateForModel("claude-haiku-4-5"), { input: 1, output: 5, cacheRead: 0.1 });
});

test("rateForModel prices legacy snapshots by version, not family", () => {
  assert.equal(rateForModel("claude-opus-4-1-20250805").input, 15);
  assert.equal(rateForModel("claude-opus-4-20250514").input, 15);
  assert.equal(rateForModel("claude-opus-4-5-20251101").input, 5);
  assert.equal(rateForModel("claude-3-5-haiku-20241022").input, 0.8);
});

test("rateForModel falls back to the family, then a default", () => {
  assert.equal(rateForModel("claude-opus-9").input, 4);
  assert.equal(rateForModel("claude-sonnet-9").input, 2);
  assert.deepEqual(rateForModel(undefined), { input: 5, output: 25, cacheRead: 0.5 });
  assert.deepEqual(rateForModel("some-other-model"), { input: 5, output: 25, cacheRead: 0.5 });
});

test("rateForModel applies fast-mode rates only where fast mode is priced", () => {
  assert.deepEqual(rateForModel("claude-opus-5-5", "fast"), { input: 8, output: 40, cacheRead: 0.4 });
  assert.equal(rateForModel("claude-opus-5", "fast").input, 10);
  assert.deepEqual(rateForModel("claude-opus-4-8", "fast"), { input: 10, output: 50, cacheRead: 1 });
  assert.equal(rateForModel("claude-opus-4-7", "fast").input, 5);
  assert.equal(rateForModel("claude-opus-5-5", "standard").input, 4);
  assert.equal(rateForModel("claude-sonnet-5-5", "fast").input, 2);
});

test("normalizeModelId strips Bedrock and Vertex decoration", () => {
  assert.equal(normalizeModelId("us.anthropic.claude-opus-5-5"), "claude-opus-5-5");
  assert.equal(normalizeModelId("claude-opus-4-5@20251101"), "claude-opus-4-5");
  assert.equal(rateForModel("anthropic.claude-sonnet-5-5").input, 2);
});

test("estimateCost applies input/output/cache rates", () => {
  const rate = { input: 5, output: 25, cacheRead: 0.5 };
  // 1M input + 1M output = $5 + $25 = $30
  assert.equal(estimateCost({ ...ZERO, input: 1_000_000, output: 1_000_000 }, rate), 30);
  // 1M cache read at the model's cache-read price
  assert.equal(estimateCost({ ...ZERO, cacheRead: 1_000_000 }, rate), 0.5);
  assert.equal(estimateCost({ ...ZERO, cacheRead: 1_000_000 }, rateForModel("claude-fable-5-1")), 0.25);
  // 1M cache write (5m) at 1.25x = $6.25
  assert.equal(estimateCost({ ...ZERO, cacheCreate: 1_000_000, ephemeral5m: 1_000_000 }, rate), 6.25);
  // 1M cache write (1h) at 2x = $10
  assert.equal(estimateCost({ ...ZERO, cacheCreate: 1_000_000, ephemeral1h: 1_000_000 }, rate), 10);
});

test("costOfInputTokens is linear in the input rate", () => {
  assert.equal(costOfInputTokens(500_000, { input: 5, output: 25, cacheRead: 0.5 }), 2.5);
});

test("sessionCost prices each turn at the model and speed it used", () => {
  const text = jsonl(
    assistantLine({ model: "claude-opus-5-5", usage: { input: 1_000_000 } }), // $4
    assistantLine({ model: "claude-haiku-4-5", usage: { input: 1_000_000 } }), // $1
    assistantLine({ model: "claude-opus-5-5", usage: { input: 1_000_000, speed: "fast" } }) // $8
  );
  const s = buildSessionModel(parseTranscriptString(text), { sessionId: "s", filePath: "/x", project: "p" });
  assert.equal(sessionCost(s), 13);
});

test("contextWindowForModel distinguishes 1M and 200k models", () => {
  assert.equal(contextWindowForModel("claude-opus-5-5"), 1_000_000);
  assert.equal(contextWindowForModel("claude-opus-4-8"), 1_000_000);
  assert.equal(contextWindowForModel("claude-opus-4-5-20251101"), 200_000);
  assert.equal(contextWindowForModel("claude-sonnet-4-6"), 1_000_000);
  assert.equal(contextWindowForModel("claude-haiku-4-5"), 200_000);
  assert.equal(contextWindowForModel("claude-haiku-5-5"), 1_000_000);
  assert.equal(contextWindowForModel("claude-3-5-haiku-20241022"), 200_000);
});

test("rateForTurn bills Haiku 5.5 prompts over 100k tokens at the long-prompt tier", () => {
  const turn = (usage: Partial<typeof ZERO>, model = "claude-haiku-5-5") => ({ model, usage: { ...ZERO, ...usage } });
  assert.equal(rateForTurn(turn({ input: 100_000 })).input, 0.1);
  // Cache reads and writes count toward prompt length.
  assert.deepEqual(rateForTurn(turn({ input: 1_000, cacheRead: 99_001 })), { input: 0.5, output: 2.5, cacheRead: 0.05 });
  assert.equal(rateForTurn(turn({ cacheCreate: 100_001 })).input, 0.5);
  // Future Haiku snapshots inherit the tier through the family fallback; Haiku 4.5 does not.
  assert.equal(rateForTurn(turn({ input: 200_000 }, "claude-haiku-6")).input, 0.5);
  assert.equal(rateForTurn(turn({ input: 200_000 }, "claude-haiku-4-5")).input, 1);
});

test("rateForTurn applies the 1.1x US-only inference multiplier", () => {
  const usage = { ...ZERO, input: 1_000_000 };
  const r = rateForTurn({ model: "claude-opus-5-5", inferenceGeo: "us", usage });
  assert.ok(Math.abs(r.input - 4.4) < 1e-9 && Math.abs(r.cacheRead - 0.22) < 1e-9);
  assert.equal(rateForTurn({ model: "claude-opus-5-5", inferenceGeo: "global", usage }).input, 4);
  assert.equal(rateForTurn({ model: "claude-opus-5-5", inferenceGeo: "not_available", usage }).input, 4);
});

test("sessionCost picks up inference_geo from transcripts", () => {
  const text = jsonl(assistantLine({ model: "claude-sonnet-5-5", usage: { input: 1_000_000, inferenceGeo: "us" } }));
  const s = buildSessionModel(parseTranscriptString(text), { sessionId: "s", filePath: "/x", project: "p" });
  assert.ok(Math.abs(sessionCost(s) - 2.2) < 1e-9);
});
