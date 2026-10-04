/**
 * Rule: large fixed overhead. The first turn of a session carries everything
 * Claude Code sends before any work happens — system prompt, tool definitions
 * (including every MCP server's tools), CLAUDE.md, and the opening prompt. When
 * a project's typical first turn is far above the usual baseline, that excess
 * is paid on every session (written once, then read back on every turn).
 *
 * Trigger: median first-turn prompt across a project's top-level sessions
 * ≥ OVERHEAD_FLAG_TOKENS, with at least MIN_SESSIONS sessions so a single
 * pasted document doesn't trigger it.
 * Math: excess over BASELINE_TOKENS, written once and read on each later turn.
 */
import type { Finding, RuleContext } from "./index";
import type { SessionModel } from "../model";
import { CACHE_WRITE_5M_MULTIPLIER } from "../pricing";

const OVERHEAD_FLAG_TOKENS = 45_000;
/** A typical Claude Code first turn with built-in tools and a modest CLAUDE.md. */
const BASELINE_TOKENS = 30_000;
const MIN_SESSIONS = 2;

function firstPromptTokens(s: SessionModel): number | undefined {
  const t = s.turns[0];
  return t ? t.usage.input + t.usage.cacheRead + t.usage.cacheCreate : undefined;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function overheadRule(ctx: RuleContext): Finding[] {
  const byProject = new Map<string, SessionModel[]>();
  for (const s of ctx.sessions) {
    if (s.parentSessionId || firstPromptTokens(s) === undefined) {
      continue; // subagents start from a different, smaller prompt
    }
    const list = byProject.get(s.project) ?? [];
    list.push(s);
    byProject.set(s.project, list);
  }

  const findings: Finding[] = [];
  for (const [project, sessions] of byProject) {
    if (sessions.length < MIN_SESSIONS) {
      continue;
    }
    const typical = median(sessions.map((s) => firstPromptTokens(s)!));
    if (typical < OVERHEAD_FLAG_TOKENS) {
      continue;
    }
    const excess = typical - BASELINE_TOKENS;
    let wastedUSD = 0;
    let wastedTokens = 0;
    for (const s of sessions) {
      const rate = ctx.rateFor(s);
      const laterTurns = Math.max(0, s.turns.length - 1);
      wastedUSD += (excess / 1_000_000) * (rate.input * CACHE_WRITE_5M_MULTIPLIER + rate.cacheRead * laterTurns);
      wastedTokens += excess * (1 + laterTurns);
    }
    findings.push({
      ruleId: "overhead",
      key: `overhead|${project}`,
      category: "Large fixed overhead",
      title: `Sessions start with ~${Math.round(typical / 1000)}k tokens of context before any work`,
      detail:
        `Across ${sessions.length} sessions in this project, the first turn typically sends ~${Math.round(typical).toLocaleString("en-US")} ` +
        `tokens — about ${Math.round(excess / 1000)}k above a typical Claude Code start. That overhead is re-sent (as cache reads) on every turn of every session.`,
      fix:
        "Check what loads at startup: disable MCP servers this project doesn't use (each adds its tool definitions), " +
        "trim CLAUDE.md to what the agent actually needs, and move rarely-needed reference material into files it can Read on demand.",
      severity: excess >= 40_000 ? "high" : "medium",
      scope: "habit",
      project,
      wastedTokens,
      wastedUSD,
    });
  }
  return findings;
}
