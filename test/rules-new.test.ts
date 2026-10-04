import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscriptString } from "../src/parser";
import { buildSessionModel, calibrateCharsPerToken, applyCharsPerTokenFallback, type SessionModel } from "../src/model";
import { runAllRules, type RuleConfig, type Finding } from "../src/rules/index";
import { hasLimiter } from "../src/rules/largeOutput";
import { classifySearch } from "../src/rules/searches";
import { assistantLine, bashResultLine, readResultLine, compactBoundaryLine, jsonl } from "./fixtures";

const CONFIG: RuleConfig = { largeSearchOutputBytes: 100, lowCacheRatioThreshold: 0.5 };
const NOW = new Date("2026-10-04T12:00:00.000Z");

function session(id: string, text: string, meta: { project?: string; parentSessionId?: string } = {}): SessionModel {
  return buildSessionModel(parseTranscriptString(text), {
    sessionId: id,
    filePath: `/x/${id}.jsonl`,
    project: meta.project ?? "proj",
    parentSessionId: meta.parentSessionId,
  });
}

function run(...sessions: SessionModel[]): Finding[] {
  return runAllRules(sessions, CONFIG, NOW).findings;
}

const find = (fs: Finding[], id: string): Finding | undefined => fs.find((f) => f.ruleId === id);

function call(id: string, name: string, input: Record<string, unknown>, ts?: string): string {
  return assistantLine({ timestamp: ts, usage: { input: 1 }, toolUses: [{ id, name, input }] });
}

// --- read after write ----------------------------------------------------

test("a full Read right after Write is flagged", () => {
  const s = session(
    "w",
    jsonl(
      call("w1", "Write", { file_path: "/app/a.ts", content: "x".repeat(5000) }),
      readResultLine("w1", "ok"),
      call("r1", "Read", { file_path: "/app/a.ts" }),
      readResultLine("r1", "z".repeat(2000))
    )
  );
  const f = find(run(s), "read.afteredit");
  assert.ok(f);
  assert.equal(f!.category, "Read after write");
});

test("Read after Edit, after an intervening Bash, or ranged is not flagged", () => {
  const afterEdit = session(
    "e",
    jsonl(
      call("e1", "Edit", { file_path: "/app/a.ts" }),
      readResultLine("e1", "snippet"),
      call("r1", "Read", { file_path: "/app/a.ts" }),
      readResultLine("r1", "z".repeat(2000))
    )
  );
  const afterBash = session(
    "b",
    jsonl(
      call("w1", "Write", { file_path: "/app/a.ts" }),
      readResultLine("w1", "ok"),
      call("b1", "Bash", { command: "npx prettier --write /app/a.ts" }),
      bashResultLine("b1", "done"),
      call("r1", "Read", { file_path: "/app/a.ts" }),
      readResultLine("r1", "z".repeat(2000))
    )
  );
  const ranged = session(
    "rg",
    jsonl(
      call("w1", "Write", { file_path: "/app/a.ts" }),
      readResultLine("w1", "ok"),
      call("r1", "Read", { file_path: "/app/a.ts", offset: 10, limit: 20 }),
      readResultLine("r1", "z".repeat(2000))
    )
  );
  assert.equal(find(run(afterEdit, afterBash, ranged), "read.afteredit"), undefined);
});

// --- repeated reads ------------------------------------------------------

test("paging through different ranges of a file is not a repeated read", () => {
  const lines = [];
  for (let i = 0; i < 4; i++) {
    lines.push(call(`r${i}`, "Read", { file_path: "/big.ts", offset: i * 100 + 1, limit: 100 }), readResultLine(`r${i}`, "z".repeat(500)));
  }
  assert.equal(find(run(session("page", jsonl(...lines))), "reads.repeat"), undefined);
});

test("reading the same range 3x is a repeated read with a stable key", () => {
  const lines = [];
  for (let i = 0; i < 3; i++) {
    lines.push(call(`r${i}`, "Read", { file_path: "/big.ts", offset: 1, limit: 100 }), readResultLine(`r${i}`, "z".repeat(500)));
  }
  const f = find(run(session("same", jsonl(...lines))), "reads.repeat");
  assert.ok(f);
  assert.match(f!.detail, /lines 1–100/);
  assert.equal(f!.key, "reads.repeat|same|/big.ts|lines 1–100");
});

// --- output limiters -----------------------------------------------------

test("hasLimiter recognizes filters and condensing flags", () => {
  for (const cmd of [
    "cat a.log | head -50",
    "git log --oneline",
    "git diff --stat",
    "npm test 2>&1 | grep FAIL",
    "curl -s api | jq .items",
    "git log -n 5",
    "git log -20",
    "tail -100 app.log",
  ]) {
    assert.equal(hasLimiter(cmd), true, cmd);
  }
  for (const cmd of ["cat a.log", "git diff", "npm test", "git log"]) {
    assert.equal(hasLimiter(cmd), false, cmd);
  }
});

// --- Grep / Glob tools ---------------------------------------------------

test("dedicated Grep/Glob tools are checked for scope", () => {
  // 50 chars: above the unscoped minimum (25% of 100) but below "large" (100).
  const out = "a".repeat(50);
  const s = session(
    "tools",
    jsonl(
      call("g1", "Grep", { pattern: "TODO" }),
      readResultLine("g1", out),
      call("g2", "Grep", { pattern: "TODO", path: "src/rules" }),
      readResultLine("g2", out),
      call("g3", "Grep", { pattern: "TODO", glob: "*.ts" }),
      readResultLine("g3", out),
      call("g4", "Glob", { pattern: "**/*.ts" }),
      readResultLine("g4", out),
      call("g5", "Glob", { pattern: "src/*.ts" }),
      readResultLine("g5", out)
    )
  );
  const flagged = run(s)
    .filter((f) => f.ruleId === "searches")
    .map((f) => f.evidenceUuid)
    .sort();
  assert.deepEqual(flagged, ["g1", "g4"]);
  const grepFix = run(s).find((f) => f.evidenceUuid === "g1")!.fix;
  assert.match(grepFix, /head_limit/);
});

test("a large Grep result is flagged even when scoped", () => {
  const s = session("biggrep", jsonl(call("g1", "Grep", { pattern: "x", path: "src" }), readResultLine("g1", "m".repeat(500))));
  assert.ok(run(s).some((f) => f.ruleId === "searches" && /Large search/.test(f.title)));
});

// --- Bash search classification ----------------------------------------

test("classifySearch ignores filters and honors type/glob scoping", () => {
  const c = (cmd: string) => classifySearch(cmd);
  assert.deepEqual(c("npm test 2>&1 | grep FAIL"), { isSearch: false, unscoped: false });
  assert.deepEqual(c("find src -name '*.ts' | xargs grep -n TODO"), { isSearch: true, unscoped: false });
  assert.deepEqual(c("grep -c 32768 *.html"), { isSearch: true, unscoped: false });
  assert.deepEqual(c("grep -rn dryvist . --include='*.md'"), { isSearch: true, unscoped: false });
  assert.deepEqual(c("rg -t ts TODO"), { isSearch: true, unscoped: false });
  assert.deepEqual(c("grep -rn TODO ."), { isSearch: true, unscoped: true });
  assert.deepEqual(c("rg TODO"), { isSearch: true, unscoped: true });
  assert.deepEqual(c("grep -n x a.ts | grep -v y"), { isSearch: true, unscoped: false });
});

test("an unscoped search with tiny output is not flagged", () => {
  const s = session("tiny", jsonl(call("t1", "Bash", { command: "rg TODO" }), bashResultLine("t1", "a.ts:1: TODO")));
  assert.equal(find(run(s), "searches"), undefined);
});

// --- cache TTL split -----------------------------------------------------

test("low-cache waste prices 1-hour writes at 2x input", () => {
  // 5 turns x 200k 1h writes on Opus 4.8 ($5 input, $0.50 read): 1M x ($10 - $0.50) = $9.50.
  const turns = Array.from({ length: 5 }, () =>
    assistantLine({ usage: { input: 500, output: 30, cacheCreate: 200_000, eph1h: 200_000, cacheRead: 1000 } })
  );
  const f = find(run(session("ttl", jsonl(...turns))), "cache.lowratio");
  assert.ok(f);
  assert.ok(Math.abs(f!.wastedUSD! - 9.5) < 1e-9, String(f!.wastedUSD));
});

// --- cache expiry --------------------------------------------------------

test("cache expiry after an idle gap is flagged with the write premium", () => {
  const s = session(
    "idle",
    jsonl(
      assistantLine({ model: "claude-opus-5-5", timestamp: "2026-10-01T10:00:00.000Z", usage: { cacheCreate: 50_000, output: 10 } }),
      assistantLine({ model: "claude-opus-5-5", timestamp: "2026-10-01T10:02:00.000Z", usage: { cacheRead: 50_000, output: 10 } }),
      // 12 minutes idle, then the whole 100k prefix is re-written.
      assistantLine({ model: "claude-opus-5-5", timestamp: "2026-10-01T10:14:00.000Z", usage: { cacheCreate: 100_000, cacheRead: 0 } })
    )
  );
  const f = find(run(s), "cache.expiry");
  assert.ok(f);
  assert.equal(f!.wastedTokens, 100_000);
  // 100k x ($4 x 1.25 - $0.20) / 1M = $0.48
  assert.ok(Math.abs(f!.wastedUSD! - 0.48) < 1e-9, String(f!.wastedUSD));
  assert.match(f!.detail, /12 min/);
});

test("no cache-expiry finding for short gaps, 1-hour TTL, or across a compaction", () => {
  const short = session(
    "short",
    jsonl(
      assistantLine({ timestamp: "2026-10-01T10:00:00.000Z", usage: { cacheCreate: 50_000 } }),
      assistantLine({ timestamp: "2026-10-01T10:04:00.000Z", usage: { cacheCreate: 100_000 } })
    )
  );
  const longTtl = session(
    "long",
    jsonl(
      assistantLine({ timestamp: "2026-10-01T10:00:00.000Z", usage: { cacheCreate: 50_000, eph1h: 50_000 } }),
      assistantLine({ timestamp: "2026-10-01T10:20:00.000Z", usage: { cacheCreate: 100_000, eph1h: 100_000 } })
    )
  );
  const compacted = session(
    "compacted",
    jsonl(
      assistantLine({ timestamp: "2026-07-29T23:20:00.000Z", usage: { cacheCreate: 50_000 } }),
      compactBoundaryLine(900_000, 20_000, 880_000), // at 23:30
      assistantLine({ timestamp: "2026-07-29T23:40:00.000Z", usage: { cacheCreate: 100_000 } })
    )
  );
  assert.equal(find(run(short, longTtl, compacted), "cache.expiry"), undefined);
});

// --- fixed overhead ------------------------------------------------------

test("a project whose sessions start large is flagged; one big start is not", () => {
  const start = (id: string, tokens: number, project: string): SessionModel =>
    session(id, jsonl(assistantLine({ usage: { cacheCreate: tokens } }), assistantLine({ usage: { cacheRead: tokens } })), {
      project,
    });
  const findings = run(start("a1", 70_000, "heavy"), start("a2", 66_000, "heavy"), start("b1", 90_000, "single"));
  const overhead = findings.filter((f) => f.ruleId === "overhead");
  assert.deepEqual(
    overhead.map((f) => f.project),
    ["heavy"]
  );
  assert.match(overhead[0].title, /~68k tokens/);
});

test("subagent sessions don't count toward fixed overhead", () => {
  const sub = (id: string): SessionModel =>
    session(id, jsonl(assistantLine({ usage: { cacheCreate: 80_000 } })), { project: "p2", parentSessionId: "parent" });
  assert.equal(find(run(sub("s1"), sub("s2")), "overhead"), undefined);
});

// --- model fit -----------------------------------------------------------

test("recent sessions on older Opus get a switch recommendation with the saving", () => {
  const recent = session(
    "old-opus",
    jsonl(assistantLine({ model: "claude-opus-4-8", timestamp: "2026-10-01T10:00:00.000Z", usage: { input: 1_000_000 } }))
  );
  const stale = session(
    "stale-opus",
    jsonl(assistantLine({ model: "claude-opus-4-8", timestamp: "2026-06-01T10:00:00.000Z", usage: { input: 1_000_000 } }))
  );
  const f = find(run(recent, stale), "modelfit.olderopus");
  assert.ok(f);
  // $5 at Opus 4.8 vs $4 at Opus 5.5; the stale session is ignored.
  assert.ok(Math.abs(f!.wastedUSD! - 1) < 1e-9, String(f!.wastedUSD));
  assert.match(f!.title, /^1 recent session/);
});

test("older-Opus sessions from before Opus 5.5's first use are not counted", () => {
  const before = session(
    "before",
    jsonl(assistantLine({ model: "claude-opus-5", timestamp: "2026-09-20T10:00:00.000Z", usage: { input: 1_000_000 } }))
  );
  const firstUse = session(
    "first-55",
    jsonl(assistantLine({ model: "claude-opus-5-5", timestamp: "2026-09-25T10:00:00.000Z", usage: { input: 1 } }))
  );
  const after = session(
    "after",
    jsonl(assistantLine({ model: "claude-opus-5", timestamp: "2026-09-28T10:00:00.000Z", usage: { input: 1_000_000 } }))
  );
  const f = find(run(before, firstUse, after), "modelfit.olderopus");
  assert.ok(f);
  assert.match(f!.title, /^1 recent session/);
});

test("Opus 5.5 sessions get no model-fit finding", () => {
  const s = session(
    "current",
    jsonl(assistantLine({ model: "claude-opus-5-5", timestamp: "2026-10-01T10:00:00.000Z", usage: { input: 1_000_000 } }))
  );
  assert.equal(find(run(s), "modelfit.olderopus"), undefined);
});

test("short Fable sessions are flagged; long ones are not", () => {
  const short = session(
    "fable-short",
    jsonl(assistantLine({ model: "claude-fable-5-1", timestamp: "2026-10-01T10:00:00.000Z", usage: { input: 1_000_000, output: 500 } }))
  );
  const longTurns = Array.from({ length: 10 }, () =>
    assistantLine({ model: "claude-fable-5-1", timestamp: "2026-10-01T10:00:00.000Z", usage: { input: 1000, output: 500 } })
  );
  const long = session("fable-long", jsonl(...longTurns));
  const f = find(run(short, long), "modelfit.fableshort");
  assert.ok(f);
  assert.match(f!.title, /^1 short session/);
  // $10 at Fable 5.1 vs $4 at Opus 5.5 for the input, plus output $0.025 vs $0.01.
  assert.ok(Math.abs(f!.wastedUSD! - 6.015) < 1e-9, String(f!.wastedUSD));
});

// --- fast mode -----------------------------------------------------------

test("fast mode reports the premium over standard speed", () => {
  const s = session(
    "fast",
    jsonl(
      assistantLine({ model: "claude-opus-5-5", usage: { input: 1_000_000, speed: "fast" } }),
      assistantLine({ model: "claude-opus-5-5", usage: { input: 1_000_000 } })
    )
  );
  const f = find(run(s), "fastmode");
  assert.ok(f);
  assert.ok(Math.abs(f!.wastedUSD! - 4) < 1e-9, String(f!.wastedUSD)); // $8 fast vs $4 standard
  assert.equal(f!.severity, "info");
});

// --- finding keys --------------------------------------------------------

test("finding keys stay stable as a session grows", () => {
  const failing = (n: number): SessionModel => {
    const lines = [];
    for (let i = 0; i < n; i++) {
      lines.push(
        call(`e${i}`, "Bash", { command: "npm test" }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: `e${i}`, content: "boom", is_error: true }] },
        })
      );
    }
    return session("grow", jsonl(...lines));
  };
  const before = find(run(failing(2)), "failedtools");
  const after = find(run(failing(5)), "failedtools");
  assert.ok(before && after);
  assert.notEqual(before!.title, after!.title);
  assert.equal(before!.key, after!.key);
});

test("every finding gets a key", () => {
  const s = session("any", jsonl(assistantLine({ usage: { input: 850_000 } })));
  for (const f of run(s)) {
    assert.ok(f.key, f.ruleId);
  }
});

// --- token calibration ---------------------------------------------------

function calibratedSession(id: string, charsPerToken: number, samples: number): SessionModel {
  const lines = [];
  let prompt = 10_000;
  for (let i = 0; i < samples; i++) {
    const chars = 6000;
    lines.push(
      assistantLine({ usage: { cacheRead: prompt, output: 100 }, toolUses: [{ id: `${id}${i}`, name: "Bash", input: { command: "ls" } }] }),
      bashResultLine(`${id}${i}`, "x".repeat(chars))
    );
    prompt += 100 + chars / charsPerToken;
  }
  lines.push(assistantLine({ usage: { cacheRead: prompt, output: 10 } }));
  return session(id, jsonl(...lines));
}

test("chars-per-token is calibrated from prompt growth after tool results", () => {
  const s = calibratedSession("cal", 2.4, 4);
  assert.equal(s.charsPerTokenCalibrated, true);
  assert.ok(Math.abs(s.charsPerToken - 2.4) < 1e-9, String(s.charsPerToken));
  assert.equal(calibrateCharsPerToken(calibratedSession("few", 2.4, 2)), undefined);
});

test("uncalibrated sessions borrow the median of calibrated ones", () => {
  const a = calibratedSession("a", 2.0, 4);
  const b = calibratedSession("b", 3.0, 4);
  const c = calibratedSession("c", 2.5, 4);
  const short = session("short", jsonl(assistantLine({ usage: { input: 1 } })));
  assert.equal(short.charsPerToken, 4);
  applyCharsPerTokenFallback([a, b, c, short]);
  assert.ok(Math.abs(short.charsPerToken - 2.5) < 1e-9);
  assert.equal(short.charsPerTokenCalibrated, false);
});

test("token estimates in findings use the session's calibration", () => {
  const s = calibratedSession("est", 2.0, 4);
  // 4 identical `ls` runs of 6000 chars: 3 repeats x 6000 / 2.0 = 9000 tokens.
  const f = find(run(s), "redundant.command");
  assert.ok(f);
  assert.equal(f!.wastedTokens, 9000);
});
