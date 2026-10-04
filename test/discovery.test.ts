import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { discoverTranscripts, loadAllSessions, resolveClaudeHome, projectsDir } from "../src/discovery";
import { readTranscript } from "../src/parser";
import { analyze, loadSessionDetail } from "../src/service";
import { DEFAULT_RULE_CONFIG } from "../src/rules/index";
import { assistantLine, bashResultLine, compactBoundaryLine, jsonl } from "./fixtures";

async function makeClaudeHome(): Promise<string> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-opt-"));
  const proj = path.join(projectsDir(home), "-Users-me-app");
  await fsp.mkdir(proj, { recursive: true });
  await fsp.writeFile(
    path.join(proj, "11111111-1111-1111-1111-111111111111.jsonl"),
    jsonl(
      assistantLine({
        usage: { input: 2, output: 216, cacheCreate: 20106, cacheRead: 17645, eph1h: 20106 },
        toolUses: [{ id: "t1", name: "Bash", input: { command: "rg TODO" } }],
      }),
      bashResultLine("t1", "y".repeat(30000)),
      compactBoundaryLine(167661, 11676, 155985)
    )
  );
  // An empty project dir should be ignored gracefully.
  await fsp.mkdir(path.join(projectsDir(home), "-empty-project"), { recursive: true });
  return home;
}

test("resolveClaudeHome honors override and default", () => {
  assert.equal(resolveClaudeHome("/tmp/custom"), "/tmp/custom");
  assert.equal(resolveClaudeHome(""), path.join(os.homedir(), ".claude"));
});

test("discovers transcripts and streams them", async () => {
  const home = await makeClaudeHome();
  try {
    const ts = await discoverTranscripts(home);
    assert.equal(ts.length, 1);
    assert.equal(ts[0].sessionId, "11111111-1111-1111-1111-111111111111");
    assert.equal(ts[0].project, "-Users-me-app");

    let lines = 0;
    for await (const _line of readTranscript(ts[0].filePath)) {
      lines += 1;
    }
    assert.equal(lines, 3);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test("analyze() produces aggregates and findings end-to-end", async () => {
  const home = await makeClaudeHome();
  try {
    const { payload } = await analyze(home, DEFAULT_RULE_CONFIG);
    assert.equal(payload.found, true);
    assert.equal(payload.aggregates.sessionCount, 1);
    assert.equal(payload.aggregates.totals.input, 2);
    assert.equal(payload.aggregates.compactionCount, 1);
    // 30k-char search output exceeds the 20k default threshold => flagged.
    assert.ok(payload.results.findings.some((f) => f.ruleId === "searches"));
    assert.ok(payload.results.findings.some((f) => f.ruleId === "compaction"));
    // sessionFiles maps the session id to its path.
    assert.ok(payload.sessionFiles["11111111-1111-1111-1111-111111111111"].endsWith(".jsonl"));
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test("missing projects dir yields empty result, not an error", async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-opt-empty-"));
  try {
    assert.equal(fs.existsSync(projectsDir(home)), false);
    const sessions = await loadAllSessions(home);
    assert.equal(sessions.length, 0);
    const { payload } = await analyze(home, DEFAULT_RULE_CONFIG);
    assert.equal(payload.found, false);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

const PARENT_ID = "22222222-2222-2222-2222-222222222222";

async function makeClaudeHomeWithSubagent(): Promise<string> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-opt-sub-"));
  const proj = path.join(projectsDir(home), "-Users-me-app");
  const subagents = path.join(proj, PARENT_ID, "subagents");
  await fsp.mkdir(subagents, { recursive: true });
  await fsp.writeFile(
    path.join(proj, `${PARENT_ID}.jsonl`),
    jsonl(assistantLine({ model: "claude-opus-5-5", usage: { input: 1_000_000 } }))
  );
  await fsp.writeFile(
    path.join(subagents, "agent-abc123.jsonl"),
    jsonl(assistantLine({ model: "claude-haiku-4-5", usage: { input: 1_000_000 } }))
  );
  await fsp.writeFile(path.join(subagents, "agent-abc123.meta.json"), JSON.stringify({ agentType: "Explore" }));
  return home;
}

test("discovers subagent transcripts and links them to their parent", async () => {
  const home = await makeClaudeHomeWithSubagent();
  try {
    const ts = await discoverTranscripts(home);
    assert.equal(ts.length, 2);
    const sub = ts.find((t) => t.sessionId === "agent-abc123");
    assert.ok(sub, "subagent transcript discovered");
    assert.equal(sub!.parentSessionId, PARENT_ID);
    assert.equal(sub!.project, "-Users-me-app");
    assert.equal(ts.find((t) => t.sessionId === PARENT_ID)!.parentSessionId, undefined);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test("analyze() includes subagent cost but counts only top-level sessions", async () => {
  const home = await makeClaudeHomeWithSubagent();
  try {
    const { payload } = await analyze(home, DEFAULT_RULE_CONFIG);
    assert.equal(payload.aggregates.sessionCount, 1);
    assert.equal(payload.aggregates.subagentCount, 1);
    // Opus 5.5 $4 + Haiku 4.5 $1.
    assert.equal(payload.aggregates.totalCostUSD, 5);
    const sub = payload.aggregates.sessions.find((s) => s.sessionId === "agent-abc123");
    assert.equal(sub?.parentSessionId, PARENT_ID);
    // Both days' trend buckets count one active session, not two.
    assert.equal(payload.trends.series[0].activeSessions, 1);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test("loadSessionDetail resolves the project for a subagent transcript", async () => {
  const home = await makeClaudeHomeWithSubagent();
  try {
    const file = path.join(projectsDir(home), "-Users-me-app", PARENT_ID, "subagents", "agent-abc123.jsonl");
    const detail = await loadSessionDetail(file);
    assert.equal(detail.project, "-Users-me-app");
    assert.equal(detail.sessionId, "agent-abc123");
    assert.equal(detail.costUSD, 1);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});
