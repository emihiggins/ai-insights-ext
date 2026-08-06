/**
 * Rule: broad/expensive searches. In this Claude Code version, searches run as
 * Bash commands (grep/rg/find). A search whose output is large — or that is
 * unscoped when a path was likely known — dumps tokens into context that a
 * targeted path or a piped `head` would have avoided.
 */
import type { Finding, RuleContext } from "./index";
import { estTokensFromChars } from "./index";
import { costOfInputTokens } from "../pricing";
import type { ToolCall } from "../model";

interface SearchClass {
  isSearch: boolean;
  unscoped: boolean;
}

const GREP_TOOLS = new Set(["rg", "grep", "egrep", "fgrep", "ag", "ack"]);

/** Positional (non-option) tokens after `tokens[cmdIdx]`, up to a pipe/terminator. */
function positionalsAfter(tokens: string[], cmdIdx: number): string[] {
  const out: string[] = [];
  for (let i = cmdIdx + 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "|" || tok === "||" || tok === "&&" || tok === ";" || tok === ">" || tok === ">>") {
      break;
    }
    if (tok.startsWith("-")) {
      continue; // an option flag (value-taking flags are rare in search calls)
    }
    out.push(tok);
  }
  return out;
}

/** Classify a Bash command as a search and guess whether it was unscoped. */
export function classifySearch(command: string): SearchClass {
  // Whitespace tokenization is a heuristic — good enough for the common shapes.
  const tokens = command.trim().split(/\s+/);
  let isSearch = false;
  let unscoped = false;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (GREP_TOOLS.has(tok)) {
      isSearch = true;
      const positionals = positionalsAfter(tokens, i);
      // First positional is the pattern; anything else is a path/scope.
      const paths = positionals.slice(1);
      if (paths.length === 0 || paths.every((p) => p === ".")) {
        unscoped = true; // searches the whole cwd tree
      }
    } else if (tok === "find") {
      isSearch = true;
      const first = positionalsAfter(tokens, i)[0];
      if (!first || first === "." || first === "/" || first === "~" || first.startsWith("~/")) {
        unscoped = true; // whole-tree walk
      }
    } else if (tok === "ls") {
      const rest = tokens.slice(i + 1);
      if (rest.some((t) => /^-[a-zA-Z]*R/.test(t))) {
        isSearch = true; // recursive listing
      }
    }
  }

  return { isSearch, unscoped };
}

function isSearchCall(call: ToolCall): boolean {
  return call.name === "Bash" && typeof call.command === "string" && classifySearch(call.command).isSearch;
}

export function searchesRule(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];
  let broadCount = 0;

  for (const s of ctx.sessions) {
    const rate = ctx.rateFor(s);
    for (const call of s.toolCalls) {
      if (call.name !== "Bash" || typeof call.command !== "string") {
        continue;
      }
      const cls = classifySearch(call.command);
      if (!cls.isSearch) {
        continue;
      }
      const chars = call.resultChars ?? 0;
      const isLarge = chars >= ctx.config.largeSearchOutputBytes;
      if (!isLarge && !cls.unscoped) {
        continue;
      }
      broadCount += 1;
      const estTokens = estTokensFromChars(chars);
      const wastedUSD = costOfInputTokens(estTokens, rate);
      const short = call.command.length > 120 ? call.command.slice(0, 117) + "…" : call.command;
      findings.push({
        ruleId: "searches",
        category: "Broad search",
        title: isLarge
          ? `Large search returned ~${estTokens.toLocaleString("en-US")} tokens of output`
          : "Unscoped search when a path was likely known",
        detail:
          `\`${short}\`\n\nThis produced ${chars.toLocaleString("en-US")} characters of output that entered the ` +
          "context window. Broad searches are useful for discovery, but when the target file or directory is " +
          "already known, they spend tokens re-finding it.",
        fix:
          "Point the search at the specific relative/absolute path you already know " +
          "(e.g. `rg pattern src/foo.ts` instead of `rg pattern`), and pipe to `head` to cap output. " +
          "When you know the exact file, Read it directly rather than searching for it.",
        severity: isLarge && estTokens > 8000 ? "high" : "medium",
        scope: "one-off",
        sessionId: s.sessionId,
        project: s.project,
        evidenceUuid: call.id,
        timestamp: call.timestamp,
        wastedTokens: estTokens,
        wastedUSD,
      });
    }
  }

  if (broadCount >= 5) {
    findings.push({
      ruleId: "searches.habit",
      category: "Broad search",
      title: `Frequent broad searches (${broadCount} flagged)`,
      detail:
        "Broad grep/rg/find calls recur across sessions. Each dumps discovery output into context that a targeted path would avoid.",
      fix:
        "Once you know where something lives, pass the path explicitly and cap output with `head`. " +
        "Give the agent the relevant paths up front in your prompt so it doesn't have to search for them.",
      severity: "medium",
      scope: "habit",
    });
  }

  return findings;
}

export { isSearchCall };
