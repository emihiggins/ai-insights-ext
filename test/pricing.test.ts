import { test } from "node:test";
import assert from "node:assert/strict";
import { rateForModel, estimateCost, costOfInputTokens } from "../src/pricing";

test("rateForModel resolves by prefix with longest match", () => {
  assert.deepEqual(rateForModel("claude-opus-4-8"), { input: 5, output: 25 });
  assert.deepEqual(rateForModel("claude-sonnet-4-6"), { input: 3, output: 15 });
  assert.deepEqual(rateForModel("claude-haiku-4-5"), { input: 1, output: 5 });
  assert.deepEqual(rateForModel(undefined), { input: 5, output: 25 });
});

test("estimateCost applies input/output/cache multipliers", () => {
  const rate = { input: 5, output: 25 };
  // 1M input + 1M output = $5 + $25 = $30
  assert.equal(
    estimateCost({ input: 1_000_000, output: 1_000_000, cacheCreate: 0, cacheRead: 0, ephemeral5m: 0, ephemeral1h: 0 }, rate),
    30
  );
  // 1M cache read at 0.1x input rate = $0.50
  assert.equal(
    estimateCost({ input: 0, output: 0, cacheCreate: 0, cacheRead: 1_000_000, ephemeral5m: 0, ephemeral1h: 0 }, rate),
    0.5
  );
  // 1M cache write (5m) at 1.25x = $6.25
  assert.equal(
    estimateCost({ input: 0, output: 0, cacheCreate: 1_000_000, cacheRead: 0, ephemeral5m: 1_000_000, ephemeral1h: 0 }, rate),
    6.25
  );
  // 1M cache write (1h) at 2x = $10
  assert.equal(
    estimateCost({ input: 0, output: 0, cacheCreate: 1_000_000, cacheRead: 0, ephemeral5m: 0, ephemeral1h: 1_000_000 }, rate),
    10
  );
});

test("costOfInputTokens is linear in the input rate", () => {
  assert.equal(costOfInputTokens(500_000, { input: 5, output: 25 }), 2.5);
});
