/**
 * Streaming parser for Claude Code transcript files.
 *
 * Each transcript is JSONL: one JSON object per line. The line kind is the
 * top-level `type` field (NOT `message.role`). We tolerate malformed lines by
 * skipping them, since files may be mid-append or contain the occasional
 * truncated write.
 */
import * as fs from "fs";
import * as readline from "readline";

/** Token usage as recorded on assistant lines (snake_case, matches the wire). */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  /** "standard" or "fast" — fast mode bills at premium rates. */
  speed?: string;
  // `iterations[]` intentionally ignored — it restates the same totals.
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}

export type ContentBlock =
  | ToolUseBlock
  | TextBlock
  | ThinkingBlock
  | ToolResultBlock
  | { type: string; [k: string]: unknown };

export interface AssistantLine {
  type: "assistant";
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isSidechain?: boolean;
  /** API request id; with `message.id`, identifies one billed response. */
  requestId?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    stop_reason?: string;
    content?: ContentBlock[] | string;
    usage?: Usage;
  };
}

export interface UserLine {
  type: "user";
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  isCompactSummary?: boolean;
  sourceToolAssistantUUID?: string;
  message?: {
    role?: string;
    content?: ContentBlock[] | string;
  };
  /** Tool-specific result payload attached to the following user line. */
  toolUseResult?: {
    stdout?: string;
    stderr?: string;
    content?: unknown;
    interrupted?: boolean;
    [k: string]: unknown;
  };
}

export interface CompactBoundaryLine {
  type: "system";
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  compactMetadata?: {
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
    cumulativeDroppedTokens?: number;
    durationMs?: number;
  };
}

export type TranscriptLine =
  | AssistantLine
  | UserLine
  | CompactBoundaryLine
  | { type: string; [k: string]: unknown };

/**
 * Stream-parse a JSONL transcript, yielding one parsed object per valid line.
 * Malformed lines are skipped. Reads incrementally so large files never fully
 * load into memory.
 */
export async function* readTranscript(filePath: string): AsyncGenerator<TranscriptLine> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // skip malformed / partial lines
      }
      if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
        yield parsed as TranscriptLine;
      }
    }
  } finally {
    rl.close();
    stream.close();
  }
}

/** Parse an in-memory JSONL string (used by tests against fixtures). */
export function parseTranscriptString(text: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
        out.push(parsed as TranscriptLine);
      }
    } catch {
      // skip
    }
  }
  return out;
}
