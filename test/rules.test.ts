import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscriptString } from "../src/parser";
import { buildSessionModel, type SessionModel } from "../src/model";
import { runAllRules, type RuleConfig } from "../src/rules/index";
import { assistantLine, bashResultLine, readResultLine, compactBoundaryLine, jsonl } from "./fixtures";

function session(id: string, text: string): SessionModel {
  return buildSessionModel(parseTranscriptString(text), { sessionId: id, filePath: `/x/${id}.jsonl`, project: "proj" });
}

const CONFIG: RuleConfig = { largeSearchOutputBytes: 100, lowCacheRatioThreshold: 0.5 };

function has(findings: { ruleId: string }[], ruleId: string): boolean {
  return findings.some((f) => f.ruleId === ruleId);
}

test("compaction rule fires a one-off with dropped tokens", () => {
  const s = session(
    "compact",
    jsonl(assistantLine({ usage: { input: 10, output: 20 } }), compactBoundaryLine(167661, 11676, 155985))
  );
  const res = runAllRules([s], CONFIG);
  const f = res.oneOffs.find((x) => x.ruleId === "compaction");
  assert.ok(f, "compaction one-off present");
  assert.equal(f!.wastedTokens, 155985);
  assert.equal(f!.severity, "high");
});

test("broad search rule flags an unscoped rg with sizeable output", () => {
  const s = session(
    "search",
    jsonl(
      assistantLine({ usage: { input: 1 }, toolUses: [{ id: "t1", name: "Bash", input: { command: "rg TODO" } }] }),
      bashResultLine("t1", "y".repeat(300))
    )
  );
  const res = runAllRules([s], CONFIG);
  assert.ok(has(res.oneOffs, "searches"), "searches finding present");
});

test("scoped search with small output is not flagged", () => {
  const s = session(
    "scoped",
    jsonl(
      assistantLine({ usage: { input: 1 }, toolUses: [{ id: "t1", name: "Bash", input: { command: "rg TODO src/app.ts" } }] }),
      bashResultLine("t1", "y".repeat(20))
    )
  );
  const res = runAllRules([s], CONFIG);
  assert.equal(has(res.findings, "searches"), false);
});

test("repeated read rule fires after 3 reads of the same file", () => {
  const read = (id: string): string =>
    assistantLine({ usage: { input: 1 }, toolUses: [{ id, name: "Read", input: { file_path: "/Users/me/app/a.ts" } }] });
  const s = session(
    "reads",
    jsonl(
      read("r1"),
      readResultLine("r1", "z".repeat(500)),
      read("r2"),
      readResultLine("r2", "z".repeat(500)),
      read("r3"),
      readResultLine("r3", "z".repeat(500))
    )
  );
  const res = runAllRules([s], CONFIG);
  assert.ok(has(res.oneOffs, "reads.repeat"), "repeat-read finding present");
});

test("low cache ratio rule fires on a many-turn session with poor reuse", () => {
  const turns = Array.from({ length: 5 }, () =>
    assistantLine({ usage: { input: 500, output: 30, cacheCreate: 10000, cacheRead: 1000 } })
  );
  const s = session("cache", jsonl(...turns));
  const res = runAllRules([s], CONFIG);
  assert.ok(has(res.oneOffs, "cache.lowratio"), "low-cache finding present");
});

test("prompt-length habit fires on repeated high-input / low-output turns", () => {
  const turns = Array.from({ length: 4 }, () => assistantLine({ usage: { input: 20000, output: 10 } }));
  const s = session("roundtrips", jsonl(...turns));
  const res = runAllRules([s], CONFIG);
  assert.ok(has(res.habits, "promptlength.roundtrips"), "round-trip habit present");
});

test("compaction habit fires across multiple sessions", () => {
  const mk = (id: string): SessionModel =>
    session(id, jsonl(assistantLine({ usage: { input: 5 } }), compactBoundaryLine(100000, 8000, 92000)));
  const res = runAllRules([mk("a"), mk("b")], CONFIG);
  assert.ok(has(res.habits, "compaction.habit"), "compaction habit present");
});

test("findings are sorted with high severity first", () => {
  const s = session(
    "mix",
    jsonl(assistantLine({ usage: { input: 5 } }), compactBoundaryLine(167661, 11676, 155985))
  );
  const res = runAllRules([s], CONFIG);
  assert.equal(res.findings[0].severity, "high");
});
