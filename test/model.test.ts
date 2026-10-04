import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscriptString } from "../src/parser";
import { buildSessionModel, primaryModel } from "../src/model";
import {
  assistantLine,
  bashResultLine,
  readResultLine,
  compactBoundaryLine,
  persistedBashResultLine,
  jsonl,
} from "./fixtures";

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

test("counts a response once when Claude Code splits it across block lines", () => {
  const usage = { input: 10, output: 300, cacheCreate: 5000, cacheRead: 20000 };
  const text = jsonl(
    // One response written as three lines (text, then two tool_use blocks).
    assistantLine({ messageId: "msg_A", requestId: "req_A", usage }),
    assistantLine({
      messageId: "msg_A",
      requestId: "req_A",
      noText: true,
      usage,
      toolUses: [{ id: "toolu_a", name: "Read", input: { file_path: "/a.ts" } }],
    }),
    assistantLine({
      messageId: "msg_A",
      requestId: "req_A",
      noText: true,
      usage,
      toolUses: [{ id: "toolu_b", name: "Bash", input: { command: "ls" } }],
    }),
    assistantLine({ messageId: "msg_B", requestId: "req_B", usage: { input: 1, output: 2 } })
  );
  const s = buildSessionModel(parseTranscriptString(text), { sessionId: "d1", filePath: "/x", project: "p" });
  assert.equal(s.turns.length, 2);
  assert.equal(s.totals.input, 11);
  assert.equal(s.totals.output, 302);
  assert.equal(s.totals.cacheCreate, 5000);
  assert.equal(s.totals.cacheRead, 20000);
  assert.equal(s.modelTurns["claude-opus-4-8"], 2);
  // Tool uses from every block line are still collected.
  assert.deepEqual(s.toolCalls.map((c) => c.id), ["toolu_a", "toolu_b"]);
});

test("a repeated response keeps its latest usage", () => {
  const text = jsonl(
    assistantLine({ messageId: "msg_C", requestId: "req_C", usage: { input: 5, output: 1 } }),
    assistantLine({ messageId: "msg_C", requestId: "req_C", noText: true, usage: { input: 5, output: 90 } })
  );
  const s = buildSessionModel(parseTranscriptString(text), { sessionId: "d2", filePath: "/x", project: "p" });
  assert.equal(s.turns.length, 1);
  assert.equal(s.turns[0].usage.output, 90);
  assert.equal(s.totals.output, 90);
  assert.equal(s.totals.input, 5);
});

test("records the speed of each turn", () => {
  const text = jsonl(assistantLine({ usage: { input: 1, speed: "fast" } }));
  const s = buildSessionModel(parseTranscriptString(text), { sessionId: "d3", filePath: "/x", project: "p" });
  assert.equal(s.turns[0].speed, "fast");
});

test("persisted outputs are measured by the preview that entered context", () => {
  const preview = "p".repeat(2000);
  const text = jsonl(
    assistantLine({ toolUses: [{ id: "toolu_p", name: "Bash", input: { command: "cat big.log" } }] }),
    persistedBashResultLine("toolu_p", "x".repeat(30000), preview)
  );
  const s = buildSessionModel(parseTranscriptString(text), { sessionId: "d4", filePath: "/x", project: "p" });
  const chars = s.toolCalls[0].resultChars ?? 0;
  assert.ok(chars >= 2000 && chars < 2100, `expected ~preview size, got ${chars}`);
});

test("content-block results count text, not JSON wrapping", () => {
  const text = jsonl(
    assistantLine({ toolUses: [{ id: "toolu_t", name: "Read", input: { file_path: "/a.ts" } }] }),
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_t", content: [{ type: "text", text: "abcde" }] }],
      },
    })
  );
  const s = buildSessionModel(parseTranscriptString(text), { sessionId: "d5", filePath: "/x", project: "p" });
  assert.equal(s.toolCalls[0].resultChars, 5);
});
