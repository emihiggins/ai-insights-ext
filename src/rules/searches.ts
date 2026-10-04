/**
 * Rule: broad/expensive searches. Depending on the Claude Code build, searches
 * run as Bash commands (grep/rg/find) or through the dedicated Grep/Glob
 * tools. A search whose output is large — or that is unscoped when a path was
 * likely known — dumps tokens into context that a targeted path or an output
 * cap would have avoided.
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
/** grep only walks a tree with -r/-R; without it, and without a file, it reads stdin. */
const GREP_FAMILY = new Set(["grep", "egrep", "fgrep"]);
const SEPARATORS = new Set(["|", "|&", "||", "&&", ";", ">", ">>"]);
const PIPES = new Set(["|", "|&"]);
/** File-type / glob filters scope a search even when it starts at the tree root. */
const SCOPE_FLAG = /^(--include|--glob|--iglob|-g|--type|-t)(=|$)/;

/** Argument tokens after `tokens[cmdIdx]`, up to a pipe/terminator. */
function argsAfter(tokens: string[], cmdIdx: number): string[] {
  const out: string[] = [];
  for (let i = cmdIdx + 1; i < tokens.length && !SEPARATORS.has(tokens[i]); i++) {
    out.push(tokens[i]);
  }
  return out;
}

function isRecursiveFlag(flag: string): boolean {
  return flag === "--recursive" || flag === "--dereference-recursive" || /^-[a-zA-Z]*[rR]/.test(flag);
}

/** Classify a Bash command as a search and guess whether it was unscoped. */
export function classifySearch(command: string): SearchClass {
  // Whitespace tokenization is a heuristic — good enough for the common shapes.
  const tokens = command.trim().split(/\s+/);
  let isSearch = false;
  let unscoped = false;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const prev = tokens[i - 1];
    if (GREP_TOOLS.has(tok)) {
      // `… | grep x` filters another command's output; `… | xargs grep x`
      // searches a file list that was already narrowed. Neither is a broad search.
      if ((prev !== undefined && PIPES.has(prev)) || prev === "xargs") {
        continue;
      }
      const args = argsAfter(tokens, i);
      const flags = args.filter((t) => t.startsWith("-"));
      // Options rarely take values in search calls, so treat non-flags as positionals.
      const positionals = args.filter((t) => !t.startsWith("-"));
      const recursive = !GREP_FAMILY.has(tok) || flags.some(isRecursiveFlag);
      if (!recursive && positionals.length <= 1) {
        continue; // grep reading stdin
      }
      isSearch = true;
      // First positional is the pattern; anything else is a path/scope.
      const paths = positionals.slice(1);
      const filtered = flags.some((f) => SCOPE_FLAG.test(f));
      if (!filtered && (paths.length === 0 || paths.every((p) => p === "." || p === "./"))) {
        unscoped = true; // searches the whole cwd tree
      }
    } else if (tok === "find") {
      isSearch = true;
      const first = argsAfter(tokens, i).find((t) => !t.startsWith("-"));
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

const UNSCOPED_MIN_FRACTION = 0.25;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function isWholeTree(p: string | undefined): boolean {
  return !p || p === "." || p === "./" || p === "/" || p === "~";
}

/** Classify a dedicated Grep/Glob tool call. */
export function classifyToolSearch(call: ToolCall): SearchClass {
  const path = str(call.input.path);
  if (call.name === "Grep") {
    // A glob or file-type filter scopes the search even without a path.
    const filtered = str(call.input.glob) !== undefined || str(call.input.type) !== undefined;
    return { isSearch: true, unscoped: isWholeTree(path) && !filtered };
  }
  if (call.name === "Glob") {
    const pattern = str(call.input.pattern) ?? "";
    return { isSearch: true, unscoped: isWholeTree(path) && pattern.startsWith("**") };
  }
  return { isSearch: false, unscoped: false };
}

/** Classify any tool call as a search, whichever way it was made. */
export function classifyCall(call: ToolCall): SearchClass {
  if (call.name === "Bash") {
    return typeof call.command === "string" ? classifySearch(call.command) : { isSearch: false, unscoped: false };
  }
  return classifyToolSearch(call);
}

function isSearchCall(call: ToolCall): boolean {
  return classifyCall(call).isSearch;
}

/** What to show for a search call: the command, or the tool's pattern and path. */
function describe(call: ToolCall): string {
  if (call.name === "Bash") {
    return call.command ?? "";
  }
  const parts = [`${call.name} ${JSON.stringify(call.input.pattern ?? "")}`];
  if (str(call.input.path)) {
    parts.push(`in ${call.input.path}`);
  }
  if (str(call.input.glob)) {
    parts.push(`glob ${call.input.glob}`);
  }
  return parts.join(" ");
}

export function searchesRule(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];
  let broadCount = 0;

  for (const s of ctx.sessions) {
    const rate = ctx.rateFor(s);
    for (const call of s.toolCalls) {
      const cls = classifyCall(call);
      if (!cls.isSearch) {
        continue;
      }
      const chars = call.resultChars ?? 0;
      const isLarge = chars >= ctx.config.largeSearchOutputBytes;
      // An unscoped search that found little cost little; only flag it once
      // its output is a meaningful fraction of the large-search threshold.
      const isBroad = cls.unscoped && chars >= ctx.config.largeSearchOutputBytes * UNSCOPED_MIN_FRACTION;
      if (!isLarge && !isBroad) {
        continue;
      }
      broadCount += 1;
      const estTokens = estTokensFromChars(chars, s.charsPerToken);
      const wastedUSD = costOfInputTokens(estTokens, rate);
      const label = describe(call);
      const short = label.length > 120 ? label.slice(0, 117) + "…" : label;
      const viaTool = call.name !== "Bash";
      findings.push({
        ruleId: "searches",
        key: `searches|${s.sessionId}|${call.id}`,
        category: "Broad search",
        title: isLarge
          ? `Large search returned ~${estTokens.toLocaleString("en-US")} tokens of output`
          : "Unscoped search when a path was likely known",
        detail:
          `\`${short}\`\n\nThis produced ${chars.toLocaleString("en-US")} characters of output that entered the ` +
          "context window. Broad searches are useful for discovery, but when the target file or directory is " +
          "already known, they spend tokens re-finding it.",
        fix: viaTool
          ? `Pass a \`path\` (or a \`glob\`/\`type\` filter) for the directory you already know, and set \`head_limit\` to cap results. ` +
            "When you know the exact file, Read it directly rather than searching for it."
          : "Point the search at the specific relative/absolute path you already know " +
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
      key: "searches.habit",
      category: "Broad search",
      title: `Frequent broad searches (${broadCount} flagged)`,
      detail:
        "Broad searches (grep/rg/find or Grep/Glob) recur across sessions. Each dumps discovery output into context that a targeted path would avoid.",
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
