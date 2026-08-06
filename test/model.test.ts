import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscriptString } from "../src/parser";
import { buildSessionModel, primaryModel } from "../src/model";
import { assistantLine, bashResultLine, readResultLine, compactBoundaryLine, jsonl } from "./fixtures";

test("extracts exact usage totals and skips synthetic", () => {
  const text = jsonl(
    assistantLine({ usage: { input: 2, output: 216, cacheCreate: 20106, cacheRead: 17645, eph1h: 20106 } }),
    assistantLine({ model: "<synthetic>", usage: { input: 999, output: 999 } }),
    assistantLine({ usage: { input: 8, output: 40, cacheRead: 5000 } })
  );
  const s = buildSessionModel(parseTranscriptString(text), { sessionId: "s1", filePath: "/x", project: "p" });
  assert.equal(s.turns.length, 2, "synthetic turn excluded");
  assert.equal(s.totals.input, 10);
  assert.equal(s.totals.output, 256);
  assert.equal(s.totals.cacheCreate, 20106);
  assert.equal(s.totals.cacheRead, 22645);
  assert.equal(s.totals.ephemeral1h, 20106);
  assert.equal(primaryModel(s), "claude-opus-4-8");
});

test("pairs tool_use with following result size (Bash stdout wins)", () => {
  const stdout = "x".repeat(1234);
  const text = jsonl(
    assistantLine({ toolUses: [{ id: "toolu_1", name: "Bash", input: { command: "rg TODO" } }] }),
    bashResultLine("toolu_1", stdout)
  );
  const s = buildSessionModel(parseTranscriptString(text), { sessionId: "s2", filePath: "/x", project: "p" });
  assert.equal(s.toolCalls.length, 1);
  assert.equal(s.toolCalls[0].name, "Bash");
  assert.equal(s.toolCalls[0].command, "rg TODO");
  assert.equal(s.toolCalls[0].resultChars, 1234);
});

test("captures Read file_path and compaction metadata", () => {
  const text = jsonl(
    assistantLine({ toolUses: [{ id: "toolu_9", name: "Read", input: { file_path: "/Users/me/app/a.ts" } }] }),
    readResultLine("toolu_9", "content"),
    compactBoundaryLine(167661, 11676, 155985)
  );
  const s = buildSessionModel(parseTranscriptString(text), { sessionId: "s3", filePath: "/x", project: "p" });
  assert.equal(s.toolCalls[0].filePath, "/Users/me/app/a.ts");
  assert.equal(s.compactions.length, 1);
  assert.equal(s.compactions[0].preTokens, 167661);
  assert.equal(s.compactions[0].postTokens, 11676);
  assert.equal(s.compactions[0].droppedTokens, 155985);
});

test("tolerates malformed and empty lines", () => {
  const text = ["{bad json", "", assistantLine({ usage: { input: 1 } }), "   "].join("\n");
  const s = buildSessionModel(parseTranscriptString(text), { sessionId: "s4", filePath: "/x", project: "p" });
  assert.equal(s.turns.length, 1);
});
