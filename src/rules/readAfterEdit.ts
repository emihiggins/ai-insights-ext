/**
 * Rule: reading a file the session just wrote or edited. After a Write/Edit the
 * new file content is already in context (edits echo the updated content), so a
 * subsequent Read of the same path pulls in tokens that are already present.
 *
 * Trigger: a Read whose file_path appeared earlier as a Write/Edit target in the
 * same session.
 * Math: wasted ≈ the redundant Read's output tokens.
 */
import type { Finding, RuleContext } from "./index";
import { estTokensFromChars } from "./index";
import { costOfInputTokens } from "../pricing";

export function readAfterEditRule(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];

  for (const s of ctx.sessions) {
    const rate = ctx.rateFor(s);
    const editedPaths = new Set<string>();
    let redundantReads = 0;
    let wastedChars = 0;
    let lastId: string | undefined;
    let lastTs: string | undefined;
    let samplePath: string | undefined;

    // Single forward pass preserves ordering: an edit must precede the read.
    for (const call of s.toolCalls) {
      if ((call.name === "Write" || call.name === "Edit") && call.filePath) {
        editedPaths.add(call.filePath);
      } else if (call.name === "Read" && call.filePath && editedPaths.has(call.filePath)) {
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
    const estTokens = estTokensFromChars(wastedChars);
    const others = redundantReads - 1;
    const subject =
      others > 0 ? `${samplePath} and ${others} other file${others === 1 ? "" : "s"}` : `${samplePath}`;
    findings.push({
      ruleId: "read.afteredit",
      category: "Read after edit",
      title: `Re-read ${redundantReads} file${redundantReads === 1 ? "" : "s"} already edited this session`,
      detail:
        `${subject} was Read after being Written/Edited in the same session. The edit already returned the current ` +
        `content, so the re-read added ~${estTokens.toLocaleString("en-US")} tokens that were already in context.`,
      fix: "Trust the content returned by the Write/Edit — don't Read a file back immediately after editing it unless something external changed it.",
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
