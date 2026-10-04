/**
 * Rule: large, uncapped command output. A Bash command (other than a search —
 * those are handled by the searches rule) that dumps a lot of output into
 * context without a `head`/`tail`/`wc`/`--stat`-style limiter. Think
 * `cat big.log`, `git diff`, `git log`, verbose test runs.
 *
 * Trigger: non-search Bash call with output ≥ threshold and no output limiter.
 * Math: wasted ≈ output tokens above a modest cap (2k tokens).
 */
import type { Finding, RuleContext } from "./index";
import { estTokensFromChars } from "./index";
import { costOfInputTokens } from "../pricing";
import { classifySearch } from "./searches";

const REASONABLE_CAP_TOKENS = 2000;

/**
 * Whether the command already bounds or filters its own output: a pipe into a
 * filter/summarizer, or a flag that limits or condenses what is printed.
 */
const PIPE_LIMITER = /\|\s*(head|tail|grep|egrep|rg|jq|wc|less|more|uniq|cut|awk|sed\s+-n|sort\s+-u)\b/;
const FLAG_LIMITER =
  /(--stat|--shortstat|--numstat|--name-only|--name-status|--oneline|--max-count|--quiet|--silent)\b|(^|\s)(-n|-m)\s*\d+\b|(^|\s)-\d+\b|(^|\s)-q\b/;

export function hasLimiter(command: string): boolean {
  return PIPE_LIMITER.test(command) || FLAG_LIMITER.test(command) || /^\s*(head|tail|wc)\b/.test(command);
}

export function largeOutputRule(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];
  let flagged = 0;

  for (const s of ctx.sessions) {
    const rate = ctx.rateFor(s);
    for (const call of s.toolCalls) {
      if (call.name !== "Bash" || !call.command) {
        continue;
      }
      // Searches are covered by their own rule; skip to avoid double-counting.
      if (classifySearch(call.command).isSearch) {
        continue;
      }
      const chars = call.resultChars ?? 0;
      if (chars < ctx.config.largeSearchOutputBytes || hasLimiter(call.command)) {
        continue;
      }
      const estTokens = estTokensFromChars(chars, s.charsPerToken);
      const excess = Math.max(0, estTokens - REASONABLE_CAP_TOKENS);
      if (excess <= 0) {
        continue;
      }
      flagged += 1;
      const short = call.command.length > 100 ? call.command.slice(0, 97) + "…" : call.command;
      findings.push({
        ruleId: "largeoutput",
        key: `largeoutput|${s.sessionId}|${call.id}`,
        category: "Large command output",
        title: `Command dumped ~${estTokens.toLocaleString("en-US")} tokens into context`,
        detail:
          `\`${short}\`\n\nThis produced ${chars.toLocaleString("en-US")} characters of output with no limiter. ` +
          "Large uncapped output (logs, full diffs, verbose test runs) fills the context window with mostly-unread text.",
        fix:
          "Bound the output: pipe to `head`/`tail`, use `git diff --stat` or a path/range, or `grep` for the lines you actually need.",
        severity: estTokens > 12000 ? "high" : "medium",
        scope: "one-off",
        sessionId: s.sessionId,
        project: s.project,
        evidenceUuid: call.id,
        timestamp: call.timestamp,
        wastedTokens: excess,
        wastedUSD: costOfInputTokens(excess, rate),
      });
    }
  }

  if (flagged >= 5) {
    findings.push({
      ruleId: "largeoutput.habit",
      key: "largeoutput.habit",
      category: "Large command output",
      title: `Frequent uncapped command output (${flagged} flagged)`,
      detail: "Commands routinely dump large output into context without a limiter.",
      fix: "Default to `| head`, `--stat`, or targeted paths so only the relevant output enters context.",
      severity: "low",
      scope: "habit",
    });
  }

  return findings;
}
