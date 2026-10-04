import { test } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { projectsDir, SessionCache, loadAllSessions } from "../src/discovery";
import { analyze, isDismissed } from "../src/service";
import { DEFAULT_RULE_CONFIG } from "../src/rules/index";
import { parseTranscriptString } from "../src/parser";
import { buildSessionModel } from "../src/model";
import { assistantLine, jsonl } from "./fixtures";

const NOW = new Date("2026-10-04T12:00:00.000Z");

function withCwd(line: string, cwd: string): string {
  return JSON.stringify({ ...JSON.parse(line), cwd });
}

/** Two projects: "app" (recent, 2 sessions) and "old" (one session, 60 days ago). */
async function makeHome(): Promise<string> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-opt-svc-"));
  const app = path.join(projectsDir(home), "-work-app");
  const old = path.join(projectsDir(home), "-work-old");
  await fsp.mkdir(app, { recursive: true });
  await fsp.mkdir(old, { recursive: true });
  const line = (ts: string, cwd: string, input: number): string =>
    withCwd(assistantLine({ model: "claude-opus-5-5", timestamp: ts, usage: { input } }), cwd);
  await fsp.writeFile(path.join(app, "a1.jsonl"), jsonl(line("2026-10-04T09:00:00.000Z", "/work/app", 1_000_000)));
  await fsp.writeFile(
    path.join(app, "a2.jsonl"),
    jsonl(
      line("2026-09-30T09:00:00.000Z", "/work/app/sub", 500_000),
      JSON.stringify({ type: "ai-title", aiTitle: "Fix the parser", sessionId: "a2" })
    )
  );
  await fsp.writeFile(path.join(old, "o1.jsonl"), jsonl(line("2026-08-05T09:00:00.000Z", "/work/old", 250_000)));
  return home;
}

test("projects are listed with readable labels and workspace membership", async () => {
  const home = await makeHome();
  try {
    const { payload } = await analyze(home, DEFAULT_RULE_CONFIG, { now: NOW, workspacePaths: ["/work/app"] });
    assert.deepEqual(
      payload.projects.map((p) => [p.project, p.label, p.sessionCount, p.inWorkspace]),
      [
        ["-work-app", "app", 2, true],
        ["-work-old", "old", 1, false],
      ]
    );
    const titled = payload.aggregates.sessions.find((s) => s.sessionId === "a2");
    assert.equal(titled?.title, "Fix the parser");
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test("project and range filters narrow sessions, totals, and session files", async () => {
  const home = await makeHome();
  try {
    const byProject = (await analyze(home, DEFAULT_RULE_CONFIG, { now: NOW, filter: { project: "-work-app" } })).payload;
    assert.equal(byProject.aggregates.sessionCount, 2);
    assert.equal(byProject.aggregates.totalCostUSD, 6); // $4 + $2 at Opus 5.5
    assert.deepEqual(Object.keys(byProject.sessionFiles).sort(), ["a1", "a2"]);

    const last7 = (await analyze(home, DEFAULT_RULE_CONFIG, { now: NOW, filter: { rangeDays: 7 } })).payload;
    assert.deepEqual(last7.aggregates.sessions.map((s) => s.sessionId).sort(), ["a1", "a2"]);

    const today = (await analyze(home, DEFAULT_RULE_CONFIG, { now: NOW, filter: { rangeDays: 1 } })).payload;
    assert.deepEqual(today.aggregates.sessions.map((s) => s.sessionId), ["a1"]);
    assert.equal(today.filter.rangeDays, 1);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test("a filter for a project that no longer exists falls back to all projects", async () => {
  const home = await makeHome();
  try {
    const { payload } = await analyze(home, DEFAULT_RULE_CONFIG, { now: NOW, filter: { project: "-gone" } });
    assert.equal(payload.filter.project, undefined);
    assert.equal(payload.aggregates.sessionCount, 3);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test("the persisted trend series always covers all projects", async () => {
  const home = await makeHome();
  try {
    const { payload, seriesToPersist } = await analyze(home, DEFAULT_RULE_CONFIG, {
      now: NOW,
      filter: { project: "-work-old" },
    });
    assert.equal(seriesToPersist.length, 3); // one day per session
    assert.equal(payload.trends.series.length, 1); // displayed trends follow the project
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test("dismissed and snoozed findings are hidden and counted; expired snoozes are not", async () => {
  const home = await makeHome();
  try {
    const base = (await analyze(home, DEFAULT_RULE_CONFIG, { now: NOW })).payload;
    const keys = base.results.findings.map((f) => f.key!);
    assert.ok(keys.length >= 1, "fixture produces at least one finding");
    const target = keys[0];

    const hidden = (await analyze(home, DEFAULT_RULE_CONFIG, { now: NOW, dismissed: { [target]: 0 } })).payload;
    assert.equal(hidden.dismissedCount, 1);
    assert.equal(hidden.results.findings.some((f) => f.key === target), false);

    const expired = (
      await analyze(home, DEFAULT_RULE_CONFIG, { now: NOW, dismissed: { [target]: NOW.getTime() - 1 } })
    ).payload;
    assert.equal(expired.dismissedCount, 0);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test("isDismissed handles permanent, active, and expired entries", () => {
  assert.equal(isDismissed("k", { k: 0 }, NOW), true);
  assert.equal(isDismissed("k", { k: NOW.getTime() + 1000 }, NOW), true);
  assert.equal(isDismissed("k", { k: NOW.getTime() - 1000 }, NOW), false);
  assert.equal(isDismissed("other", { k: 0 }, NOW), false);
  assert.equal(isDismissed(undefined, { k: 0 }, NOW), false);
});

test("SessionCache reuses unchanged files and re-parses changed ones", async () => {
  const home = await makeHome();
  try {
    const cache = new SessionCache();
    const first = await loadAllSessions(home, cache);
    const second = await loadAllSessions(home, cache);
    const byId = (list: typeof first, id: string) => list.find((s) => s.sessionId === id)!;
    assert.equal(byId(second, "a1"), byId(first, "a1"), "unchanged file is reused");

    const file = path.join(projectsDir(home), "-work-app", "a1.jsonl");
    await fsp.appendFile(file, assistantLine({ model: "claude-opus-5-5", usage: { input: 10 } }) + "\n");
    const third = await loadAllSessions(home, cache);
    assert.notEqual(byId(third, "a1"), byId(first, "a1"), "changed file is re-parsed");
    assert.equal(byId(third, "a1").turns.length, 2);

    await fsp.rm(path.join(projectsDir(home), "-work-old"), { recursive: true });
    await loadAllSessions(home, cache);
    assert.equal(cache.size, 2, "deleted files are evicted");
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test("tool inputs keep small fields and drop large bodies", () => {
  const big = "x".repeat(10_000);
  const s = buildSessionModel(
    parseTranscriptString(
      jsonl(
        assistantLine({
          toolUses: [{ id: "w", name: "Write", input: { file_path: "/a.ts", content: big } }],
        })
      )
    ),
    { sessionId: "s", filePath: "/x", project: "p" }
  );
  assert.deepEqual(s.toolCalls[0].input, { file_path: "/a.ts" });
  assert.equal(s.toolCalls[0].filePath, "/a.ts");
});
