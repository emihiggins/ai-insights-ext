/**
 * Rule: reading back a file the session just wrote. A Write sends the full new
 * content, so it is already in context; a following full Read of the same path
 * pulls in tokens that are already present.
 *
 * Edits are deliberately not flagged: an Edit returns only a snippet, so
 * reading the file afterwards can be legitimate. Ranged reads and reads after
 * an intervening Bash command (which may have changed the file — a formatter,
 * a codegen step) are also not flagged.
 *
 * Trigger: a full Read whose file_path was the target of the most recent
 * Write, with no Bash call in between.
 * Math: wasted ≈ the redundant Read's output tokens.
 */
import type { Finding, RuleContext } from "./index";
import { estTokensFromChars } from "./index";
import { costOfInputTokens } from "../pricing";

export function readAfterEditRule(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];

  for (const s of ctx.sessions) {
    const rate = ctx.rateFor(s);
    // Paths written since the last Bash call; Bash may modify files, so it resets this.
    const writtenPaths = new Set<string>();
    let redundantReads = 0;
    let wastedChars = 0;
    let lastId: string | undefined;
    let lastTs: string | undefined;
    let samplePath: string | undefined;

    // Single forward pass preserves ordering: the write must precede the read.
    for (const call of s.toolCalls) {
      if (call.name === "Bash") {
        writtenPaths.clear();
      } else if (call.name === "Write" && call.filePath) {
        writtenPaths.add(call.filePath);
      } else if (call.name === "Edit" && call.filePath) {
        writtenPaths.delete(call.filePath); // context now holds only a snippet of the new content
      } else if (call.name === "Read" && call.filePath && writtenPaths.has(call.filePath)) {
        if (call.offset !== undefined || call.limit !== undefined) {
          continue;
        }
        redundantReads += 1;
        wastedChars += call.resultChars ?? 0;
        lastId = call.id;
        lastTs = call.timestamp;
        samplePath ??= call.filePath;
      }
    }

    if (redundantReads === 0) {
      continue;
    }
    const estTokens = estTokensFromChars(wastedChars, s.charsPerToken);
    const others = redundantReads - 1;
    const subject = others > 0 ? `${samplePath} and ${others} other read${others === 1 ? "" : "s"}` : `${samplePath}`;
    findings.push({
      ruleId: "read.afteredit",
      key: `read.afteredit|${s.sessionId}`,
      category: "Read after write",
      title: `Re-read ${redundantReads} file${redundantReads === 1 ? "" : "s"} just written this session`,
      detail:
        `${subject} was Read in full right after being Written, with nothing in between that could change it. ` +
        `The Write already put the full content in context, so the re-read added ~${estTokens.toLocaleString("en-US")} tokens that were already there.`,
      fix: "Trust the content you just wrote — don't Read a file back immediately after writing it unless something external changed it.",
      severity: estTokens > 6000 ? "high" : "medium",
      scope: "one-off",
      sessionId: s.sessionId,
      project: s.project,
      evidenceUuid: lastId,
      timestamp: lastTs,
      wastedTokens: estTokens,
      wastedUSD: costOfInputTokens(estTokens, rate),
    });
  }

  return findings;
}
