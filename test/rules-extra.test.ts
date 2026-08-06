import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscriptString } from "../src/parser";
import { buildSessionModel, type SessionModel } from "../src/model";
import { runAllRules, type RuleConfig } from "../src/rules/index";
import { computeSavings } from "../src/savings";
import {
  assistantLine,
  bashResultLine,
  readResultLine,
  errorResultLine,
  interruptedResultLine,
  jsonl,
} from "./fixtures";

function session(id: string, text: string): SessionModel {
  return buildSessionModel(parseTranscriptString(text), { sessionId: id, filePath: `/x/${id}.jsonl`, project: "proj" });
}

const CONFIG: RuleConfig = { largeSearchOutputBytes: 100, lowCacheRatioThreshold: 0.5 };
const has = (fs: { ruleId: string }[], id: string): boolean => fs.some((f) => f.ruleId === id);

test("failed/interrupted tool calls are captured and flagged", () => {
  const s = session(
    "fail",
    jsonl(
      assistantLine({ usage: { input: 1 }, toolUses: [{ id: "e1", name: "Bash", input: { command: "npm test" } }] }),
      errorResultLine("e1", "Error: build failed".repeat(20)),
      assistantLine({ usage: { input: 1 }, toolUses: [{ id: "e2", name: "Bash", input: { command: "npm run x" } }] }),
      interruptedResultLine("e2", "partial output".repeat(20))
    )
  );
  assert.equal(s.toolCalls[0].isError, true);
  assert.equal(s.toolCalls[1].interrupted, true);
  const res = runAllRules([s], CONFIG);
  assert.ok(has(res.oneOffs, "failedtools"));
});

test("redundant inspection command repeated 3x is flagged (but test re-runs are not)", () => {
  const gitStatus = (id: string): string =>
    assistantLine({ usage: { input: 1 }, toolUses: [{ id, name: "Bash", input: { command: "git status" } }] });
  const s = session(
    "redundant",
    jsonl(
      gitStatus("g1"),
      bashResultLine("g1", "clean".repeat(50)),
      gitStatus("g2"),
      bashResultLine("g2", "clean".repeat(50)),
      gitStatus("g3"),
      bashResultLine("g3", "clean".repeat(50))
    )
  );
  const res = runAllRules([s], CONFIG);
  assert.ok(has(res.oneOffs, "redundant.command"));

  // npm test repeated is NOT flagged (not an inspection command).
  const npm = (id: string): string =>
    assistantLine({ usage: { input: 1 }, toolUses: [{ id, name: "Bash", input: { command: "npm test" } }] });
  const s2 = session(
    "reruns",
    jsonl(npm("n1"), bashResultLine("n1", "ok"), npm("n2"), bashResultLine("n2", "ok"), npm("n3"), bashResultLine("n3", "ok"))
  );
  assert.equal(has(runAllRules([s2], CONFIG).findings, "redundant.command"), false);
});

test("reading a file after editing it is flagged", () => {
  const s = session(
    "readafteredit",
    jsonl(
      assistantLine({ usage: { input: 1 }, toolUses: [{ id: "w1", name: "Edit", input: { file_path: "/app/a.ts" } }] }),
      readResultLine("w1", "edited"),
      assistantLine({ usage: { input: 1 }, toolUses: [{ id: "r1", name: "Read", input: { file_path: "/app/a.ts" } }] }),
      readResultLine("r1", "z".repeat(2000))
    )
  );
  const res = runAllRules([s], CONFIG);
  assert.ok(has(res.oneOffs, "read.afteredit"));
});

test("read BEFORE edit is not flagged (ordering matters)", () => {
  const s = session(
    "readbeforeedit",
    jsonl(
      assistantLine({ usage: { input: 1 }, toolUses: [{ id: "r1", name: "Read", input: { file_path: "/app/a.ts" } }] }),
      readResultLine("r1", "z".repeat(2000)),
      assistantLine({ usage: { input: 1 }, toolUses: [{ id: "w1", name: "Edit", input: { file_path: "/app/a.ts" } }] }),
      readResultLine("w1", "edited")
    )
  );
  assert.equal(has(runAllRules([s], CONFIG).findings, "read.afteredit"), false);
});

test("large uncapped non-search output is flagged; piped-to-head is not", () => {
  const big = session(
    "bigout",
    jsonl(
      assistantLine({ usage: { input: 1 }, toolUses: [{ id: "c1", name: "Bash", input: { command: "cat huge.log" } }] }),
      bashResultLine("c1", "L".repeat(20000))
    )
  );
  assert.ok(has(runAllRules([big], CONFIG).oneOffs, "largeoutput"));

  const capped = session(
    "capped",
    jsonl(
      assistantLine({ usage: { input: 1 }, toolUses: [{ id: "c2", name: "Bash", input: { command: "cat huge.log | head -50" } }] }),
      bashResultLine("c2", "L".repeat(20000))
    )
  );
  assert.equal(has(runAllRules([capped], CONFIG).findings, "largeoutput"), false);
});

test("context pressure fires when a turn nears the model window", () => {
  // Opus window is 1,000,000; a turn processing 850k prompt tokens => 85%.
  const s = session("pressure", jsonl(assistantLine({ usage: { input: 850_000, output: 100 } })));
  const res = runAllRules([s], CONFIG);
  assert.ok(has(res.oneOffs, "context.pressure"));
});

test("context pressure is suppressed once the session has compacted", () => {
  const s = session(
    "pressure-compacted",
    jsonl(
      assistantLine({ usage: { input: 850_000, output: 100 } }),
      // a compaction boundary present => compaction rule owns it
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        timestamp: "2026-07-29T23:30:00.000Z",
        compactMetadata: { trigger: "auto", preTokens: 900000, postTokens: 12000, cumulativeDroppedTokens: 888000 },
      })
    )
  );
  assert.equal(has(runAllRules([s], CONFIG).findings, "context.pressure"), false);
});

test("savings report aggregates by category and computes waste fraction", () => {
  const s = session(
    "savings",
    jsonl(
      assistantLine({ usage: { input: 1 }, toolUses: [{ id: "c1", name: "Bash", input: { command: "cat huge.log" } }] }),
      bashResultLine("c1", "L".repeat(40000)),
      assistantLine({ usage: { input: 1 }, toolUses: [{ id: "s1", name: "Bash", input: { command: "rg TODO" } }] }),
      bashResultLine("s1", "y".repeat(40000))
    )
  );
  const res = runAllRules([s], CONFIG);
  const report = computeSavings(res.findings, 100);
  assert.ok(report.totalWastedTokens > 0);
  assert.ok(report.totalWastedUSD >= 0);
  assert.ok(report.byCost.length >= 2, "at least two categories");
  // byCost is sorted descending by dollars.
  for (let i = 1; i < report.byCost.length; i++) {
    assert.ok(report.byCost[i - 1].wastedUSD >= report.byCost[i].wastedUSD);
  }
  // mostCommon is sorted descending by count.
  for (let i = 1; i < report.mostCommon.length; i++) {
    assert.ok(report.mostCommon[i - 1].count >= report.mostCommon[i].count);
  }
  assert.equal(report.wasteFractionOfCost, report.totalWastedUSD / 100);
});
