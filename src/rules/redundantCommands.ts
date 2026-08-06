/**
 * Rule: redundant inspection commands. Re-running the exact same *read-only*
 * command (grep/rg/find/cat/ls/git status|log|diff) within a session re-dumps
 * identical output into context. Restricted to inspection commands so we don't
 * flag legitimate test/build re-runs.
 *
 * Trigger: identical command string seen ≥3× in one session.
 * Math: wasted ≈ output tokens of the repeat runs (all but the first).
 */
import type { Finding, RuleContext } from "./index";
import { estTokensFromChars } from "./index";
import { costOfInputTokens } from "../pricing";

const INSPECTION = /^(rg|grep|egrep|fgrep|ag|ack|find|cat|ls|head|tail|git\s+(status|log|diff|show|branch))\b/;
const REPEAT_THRESHOLD = 3;

function isInspection(command: string): boolean {
  return INSPECTION.test(command.trim());
}

export function redundantCommandsRule(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];

  for (const s of ctx.sessions) {
    const rate = ctx.rateFor(s);
    const byCommand = new Map<string, { count: number; totalChars: number; lastId?: string; lastTs?: string }>();

    for (const call of s.toolCalls) {
      if (call.name !== "Bash" || !call.command || !isInspection(call.command)) {
        continue;
      }
      const key = call.command.trim();
      const rec = byCommand.get(key) ?? { count: 0, totalChars: 0 };
      rec.count += 1;
      rec.totalChars += call.resultChars ?? 0;
      rec.lastId = call.id;
      rec.lastTs = call.timestamp;
      byCommand.set(key, rec);
    }

    for (const [command, rec] of byCommand) {
      if (rec.count < REPEAT_THRESHOLD) {
        continue;
      }
      const repeatChars = rec.count > 0 ? Math.round(rec.totalChars * ((rec.count - 1) / rec.count)) : 0;
      const estTokens = estTokensFromChars(repeatChars);
      const short = command.length > 100 ? command.slice(0, 97) + "…" : command;
      findings.push({
        ruleId: "redundant.command",
        category: "Redundant command",
        title: `Same inspection command run ${rec.count}× in one session`,
        detail:
          `\`${short}\`\n\nRan ${rec.count} times with identical output. Re-running a read-only command that hasn't ` +
          `changed re-pays its output cost — roughly ${estTokens.toLocaleString("en-US")} tokens on the repeats.`,
        fix: "The result is already in context from the first run — reference it instead of re-running the same command.",
        severity: estTokens > 6000 ? "high" : "medium",
        scope: "one-off",
        sessionId: s.sessionId,
        project: s.project,
        evidenceUuid: rec.lastId,
        timestamp: rec.lastTs,
        wastedTokens: estTokens,
        wastedUSD: costOfInputTokens(estTokens, rate),
      });
    }
  }

  return findings;
}
