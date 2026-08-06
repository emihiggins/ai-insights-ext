import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscriptString } from "../src/parser";
import { buildSessionModel, type SessionModel } from "../src/model";
import { computeDailySeries, mergeSeries, detectRegressions, computeTrends, type DailyMetric } from "../src/trends";
import { assistantLine, jsonl } from "./fixtures";

interface DayUsage {
  input?: number;
  output?: number;
  cacheCreate?: number;
  cacheRead?: number;
}

function daySession(dateISO: string, usage: DayUsage, opts?: { compaction?: boolean; id?: string }): SessionModel {
  const ts = `${dateISO}T12:00:00.000Z`;
  const lines = [assistantLine({ timestamp: ts, usage })];
  if (opts?.compaction) {
    lines.push(
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        timestamp: ts,
        compactMetadata: { trigger: "auto", preTokens: 200000, postTokens: 10000, cumulativeDroppedTokens: 190000 },
      })
    );
  }
  return buildSessionModel(parseTranscriptString(jsonl(...lines)), {
    sessionId: opts?.id ?? dateISO,
    filePath: "/x",
    project: "p",
  });
}

function janDate(day: number): string {
  return `2026-01-${String(day).padStart(2, "0")}`;
}

test("computeDailySeries buckets by date with ratio and active sessions", () => {
  const sessions = [
    daySession(janDate(1), { input: 1000, output: 100, cacheCreate: 1000, cacheRead: 100000 }),
    daySession(janDate(1), { input: 500, output: 50, cacheRead: 50000 }, { id: "day1-b" }), // 2nd session same day
    daySession(janDate(2), { input: 2000, output: 200, cacheRead: 10000 }),
  ];
  const series = computeDailySeries(sessions);
  assert.equal(series.length, 2);
  const day1 = series.find((d) => d.date === janDate(1))!;
  assert.equal(day1.activeSessions, 2);
  assert.ok(day1.cacheReadRatio > 0.9);
  assert.equal(series[0].date, janDate(1)); // sorted ascending
});

test("mergeSeries: computed overrides persisted per date, persisted-only days kept", () => {
  const persisted: DailyMetric[] = [
    { date: janDate(1), input: 1, output: 0, cacheRead: 0, cacheCreate: 0, tokens: 1, costUSD: 0.1, cacheReadRatio: 0, compactions: 0, activeSessions: 1 },
    { date: janDate(2), input: 5, output: 0, cacheRead: 0, cacheCreate: 0, tokens: 5, costUSD: 0.9, cacheReadRatio: 0, compactions: 0, activeSessions: 1 },
  ];
  const computed = computeDailySeries([daySession(janDate(2), { input: 999, output: 1 })]);
  const merged = mergeSeries(persisted, computed);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((d) => d.date === janDate(1))!.costUSD, 0.1); // persisted-only kept
  assert.equal(merged.find((d) => d.date === janDate(2))!.input, 999); // computed wins
});

test("detectRegressions flags cache-reuse drop and cost-per-session rise", () => {
  const sessions: SessionModel[] = [];
  // Prior week (days 1-7): high cache reuse, cheap.
  for (let d = 1; d <= 7; d++) {
    sessions.push(daySession(janDate(d), { input: 1000, output: 100, cacheCreate: 1000, cacheRead: 100000 }));
  }
  // Recent week (days 8-14): low reuse, expensive, compacting.
  for (let d = 8; d <= 14; d++) {
    sessions.push(daySession(janDate(d), { input: 50000, output: 100, cacheCreate: 100000, cacheRead: 1000 }, { compaction: true }));
  }
  const series = computeDailySeries(sessions);
  const { recent, prior, regressions } = detectRegressions(series, 7);
  assert.ok(recent && prior, "both windows populated");
  const metrics = regressions.map((r) => r.metric);
  assert.ok(metrics.includes("cacheReuse"), "cache reuse regression present");
  assert.ok(metrics.includes("costPerSession"), "cost-per-session regression present");
  assert.ok(metrics.includes("compactionsPerSession"), "compaction regression present");
});

test("sparse prior window (too few sessions) does not fire a regression", () => {
  const sessions: SessionModel[] = [];
  // Prior window: a single cheap session (below the min-sessions guard).
  sessions.push(daySession(janDate(1), { input: 100, output: 10, cacheRead: 5000 }, { id: "prior-only" }));
  // Recent window: many expensive sessions — extreme cost/session jump, but the
  // prior window is too sparse to compare against.
  for (let d = 8; d <= 12; d++) {
    sessions.push(daySession(janDate(d), { input: 50000, output: 100, cacheCreate: 100000, cacheRead: 1000 }));
  }
  const { regressions } = detectRegressions(computeDailySeries(sessions), 7);
  assert.equal(regressions.length, 0, "guarded against sparse-window noise");
});

test("no regressions when there is less than two windows of history", () => {
  const sessions = [daySession(janDate(1), { input: 1000, cacheRead: 100000 })];
  const { regressions } = detectRegressions(computeDailySeries(sessions), 7);
  assert.equal(regressions.length, 0);
});

test("stable efficiency produces no regressions", () => {
  const sessions: SessionModel[] = [];
  for (let d = 1; d <= 14; d++) {
    sessions.push(daySession(janDate(d), { input: 1000, output: 100, cacheCreate: 1000, cacheRead: 100000 }));
  }
  const { regressions } = detectRegressions(computeDailySeries(sessions), 7);
  assert.equal(regressions.length, 0);
});

test("computeTrends merges persisted history into the series", () => {
  const persisted: DailyMetric[] = [
    { date: "2025-12-25", input: 1, output: 0, cacheRead: 0, cacheCreate: 0, tokens: 1, costUSD: 0.5, cacheReadRatio: 0, compactions: 0, activeSessions: 1 },
  ];
  const report = computeTrends([daySession(janDate(1), { input: 10, cacheRead: 90 })], persisted, 7);
  assert.equal(report.series.length, 2);
  assert.equal(report.series[0].date, "2025-12-25");
  assert.equal(report.windowDays, 7);
});
