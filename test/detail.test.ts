import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscriptString } from "../src/parser";
import { buildSessionModel } from "../src/model";
import { buildSessionDetail } from "../src/detail";
import { assistantLine, bashResultLine, errorResultLine, compactBoundaryLine, jsonl } from "./fixtures";

function detailOf(text: string) {
  const model = buildSessionModel(parseTranscriptString(text), { sessionId: "s", filePath: "/x/s.jsonl", project: "proj" });
  return buildSessionDetail(model);
}

test("per-turn detail carries usage and a positive cost", () => {
  const d = detailOf(
    jsonl(
      assistantLine({ usage: { input: 100, output: 200, cacheCreate: 5000, cacheRead: 10000 } }),
      assistantLine({ usage: { input: 50, output: 30, cacheRead: 8000 } })
    )
  );
  assert.equal(d.turnCount, 2);
  assert.equal(d.turns[0].promptTokens, 100 + 10000 + 5000);
  assert.ok(d.turns[0].costUSD > 0);
  assert.equal(d.turns[1].index, 1);
});

test("top tools are ranked by estimated token footprint and carry error flags", () => {
  const d = detailOf(
    jsonl(
      assistantLine({ usage: { input: 1 }, toolUses: [{ id: "t1", name: "Bash", input: { command: "rg TODO" } }] }),
      bashResultLine("t1", "y".repeat(40000)), // ~10k tokens — biggest
      assistantLine({ usage: { input: 1 }, toolUses: [{ id: "t2", name: "Read", input: { file_path: "/a.ts" } }] }),
      bashResultLine("t2", "z".repeat(400)),
      assistantLine({ usage: { input: 1 }, toolUses: [{ id: "t3", name: "Bash", input: { command: "npm test" } }] }),
      errorResultLine("t3", "boom")
    )
  );
  assert.equal(d.topTools[0].name, "Bash");
  assert.equal(d.topTools[0].label, "rg TODO");
  assert.ok(d.topTools[0].estTokens >= 9000);
  const errTool = d.topTools.find((t) => t.id === "t3");
  assert.ok(errTool && errTool.isError, "error flag propagated");
  assert.equal(d.toolCounts.Bash, 2);
  assert.equal(d.toolCounts.Read, 1);
});

test("compaction markers map to the turn count at their timestamp", () => {
  const d = detailOf(
    jsonl(
      assistantLine({ usage: { input: 1 }, timestamp: "2026-07-29T10:00:00.000Z" }),
      assistantLine({ usage: { input: 1 }, timestamp: "2026-07-29T11:00:00.000Z" }),
      // compaction after the two turns above
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        timestamp: "2026-07-29T12:00:00.000Z",
        compactMetadata: { trigger: "auto", preTokens: 150000, postTokens: 12000, cumulativeDroppedTokens: 138000 },
      }),
      assistantLine({ usage: { input: 1 }, timestamp: "2026-07-29T13:00:00.000Z" })
    )
  );
  assert.equal(d.compactions.length, 1);
  assert.equal(d.compactions[0].afterTurn, 2);
  assert.equal(d.compactions[0].droppedTokens, 138000);
});

test("session cost equals the sum of per-turn costs", () => {
  const d = detailOf(
    jsonl(
      assistantLine({ usage: { input: 1000, output: 100, cacheCreate: 2000, cacheRead: 3000 } }),
      assistantLine({ usage: { input: 500, output: 50, cacheRead: 1000 } })
    )
  );
  const sum = d.turns.reduce((s, t) => s + t.costUSD, 0);
  assert.ok(Math.abs(d.costUSD - sum) < 1e-9);
});
