/** Builders that emit realistic Claude Code transcript JSONL lines for tests. */

export interface UsageInput {
  input?: number;
  output?: number;
  cacheCreate?: number;
  cacheRead?: number;
  eph5m?: number;
  eph1h?: number;
  speed?: string;
}

let seq = 0;
function uid(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq}`;
}

export function assistantLine(opts: {
  model?: string;
  timestamp?: string;
  usage?: UsageInput;
  toolUses?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  /** Reuse an id to emit another content-block line of the same response. */
  messageId?: string;
  requestId?: string;
  /** Omit the leading text block (later block lines carry only their block). */
  noText?: boolean;
}): string {
  const u = opts.usage ?? {};
  const content: unknown[] = opts.noText ? [] : [{ type: "text", text: "ok" }];
  for (const t of opts.toolUses ?? []) {
    content.push({ type: "tool_use", id: t.id, name: t.name, input: t.input });
  }
  return JSON.stringify({
    type: "assistant",
    uuid: uid("a"),
    timestamp: opts.timestamp ?? "2026-07-29T23:21:53.506Z",
    cwd: "/Users/me/app",
    version: "2.1.220",
    gitBranch: "HEAD",
    requestId: opts.requestId ?? uid("req"),
    message: {
      id: opts.messageId ?? uid("msg"),
      role: "assistant",
      model: opts.model ?? "claude-opus-4-8",
      content,
      usage: {
        input_tokens: u.input ?? 0,
        output_tokens: u.output ?? 0,
        cache_creation_input_tokens: u.cacheCreate ?? 0,
        cache_read_input_tokens: u.cacheRead ?? 0,
        cache_creation: {
          ephemeral_5m_input_tokens: u.eph5m ?? 0,
          ephemeral_1h_input_tokens: u.eph1h ?? 0,
        },
        ...(u.speed ? { speed: u.speed } : {}),
      },
    },
  });
}

export function bashResultLine(toolUseId: string, stdout: string): string {
  return JSON.stringify({
    type: "user",
    uuid: uid("u"),
    timestamp: "2026-07-29T23:21:54.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: stdout }] },
    toolUseResult: { stdout, stderr: "", interrupted: false, isImage: false },
  });
}

export function readResultLine(toolUseId: string, content: string): string {
  return JSON.stringify({
    type: "user",
    uuid: uid("u"),
    timestamp: "2026-07-29T23:21:54.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content }] },
    toolUseResult: { type: "text", filePath: "/Users/me/app/a.ts", content },
  });
}

export function errorResultLine(toolUseId: string, content: string): string {
  return JSON.stringify({
    type: "user",
    uuid: uid("u"),
    timestamp: "2026-07-29T23:21:54.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: true }] },
    toolUseResult: { stdout: "", stderr: content, interrupted: false, isImage: false },
  });
}

export function interruptedResultLine(toolUseId: string, stdout: string): string {
  return JSON.stringify({
    type: "user",
    uuid: uid("u"),
    timestamp: "2026-07-29T23:21:54.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: stdout }] },
    toolUseResult: { stdout, stderr: "", interrupted: true, isImage: false },
  });
}

export function compactBoundaryLine(pre: number, post: number, dropped: number): string {
  return JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    uuid: uid("s"),
    timestamp: "2026-07-29T23:30:00.000Z",
    compactMetadata: {
      trigger: "auto",
      preTokens: pre,
      postTokens: post,
      cumulativeDroppedTokens: dropped,
      durationMs: 73043,
    },
  });
}

export function jsonl(...lines: string[]): string {
  return lines.join("\n") + "\n";
}

/** A Bash result Claude Code persisted to disk: the model saw only a preview. */
export function persistedBashResultLine(toolUseId: string, fullStdout: string, preview: string): string {
  return JSON.stringify({
    type: "user",
    uuid: uid("u"),
    timestamp: "2026-07-29T23:21:54.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: `<persisted-output>\n${preview}\n</persisted-output>` }],
    },
    toolUseResult: { stdout: fullStdout, stderr: "", interrupted: false, isImage: false },
  });
}
