/**
 * Builds a structured SessionModel from a stream of transcript lines.
 *
 * Pure logic — no vscode / fs imports — so it is unit-testable against
 * in-memory fixtures.
 */
import type {
  TranscriptLine,
  AssistantLine,
  UserLine,
  CompactBoundaryLine,
  ContentBlock,
  ToolUseBlock,
  Usage,
} from "./parser";

export const SYNTHETIC_MODEL = "<synthetic>";

export interface TokenTotals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  ephemeral5m: number;
  ephemeral1h: number;
}

export interface Turn {
  uuid?: string;
  timestamp?: string;
  model?: string;
  usage: TokenTotals;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Convenience extractions for common tools. */
  command?: string;
  filePath?: string;
  timestamp?: string;
  /** Character length of the tool's result output, once paired. */
  resultChars?: number;
  /** The paired tool_result was flagged is_error. */
  isError?: boolean;
  /** The tool run was interrupted before completing. */
  interrupted?: boolean;
}

export interface Compaction {
  timestamp?: string;
  trigger?: string;
  preTokens: number;
  postTokens: number;
  droppedTokens: number;
  durationMs?: number;
}

export interface SessionModel {
  sessionId: string;
  filePath: string;
  project: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  firstTs?: string;
  lastTs?: string;
  turns: Turn[];
  toolCalls: ToolCall[];
  compactions: Compaction[];
  compactSummaryCount: number;
  totals: TokenTotals;
  /** model id -> number of assistant turns using it (excludes synthetic). */
  modelTurns: Record<string, number>;
}

function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, ephemeral5m: 0, ephemeral1h: 0 };
}

function usageToTotals(u: Usage | undefined): TokenTotals {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cacheCreate: u?.cache_creation_input_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    ephemeral5m: u?.cache_creation?.ephemeral_5m_input_tokens ?? 0,
    ephemeral1h: u?.cache_creation?.ephemeral_1h_input_tokens ?? 0,
  };
}

function addTotals(a: TokenTotals, b: TokenTotals): void {
  a.input += b.input;
  a.output += b.output;
  a.cacheCreate += b.cacheCreate;
  a.cacheRead += b.cacheRead;
  a.ephemeral5m += b.ephemeral5m;
  a.ephemeral1h += b.ephemeral1h;
}

function contentBlocks(content: ContentBlock[] | string | undefined): ContentBlock[] {
  return Array.isArray(content) ? content : [];
}

/** Estimate the character length of an arbitrary tool-result payload. */
function payloadChars(value: unknown): number {
  if (value == null) {
    return 0;
  }
  if (typeof value === "string") {
    return value.length;
  }
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/**
 * Fold a sequence of transcript lines into a SessionModel. `sessionId`,
 * `filePath`, and `project` are provided by the caller (derived from the path);
 * remaining metadata is filled from the first line that carries it.
 */
export function buildSessionModel(
  lines: Iterable<TranscriptLine>,
  meta: { sessionId: string; filePath: string; project: string }
): SessionModel {
  const model: SessionModel = {
    sessionId: meta.sessionId,
    filePath: meta.filePath,
    project: meta.project,
    turns: [],
    toolCalls: [],
    compactions: [],
    compactSummaryCount: 0,
    totals: emptyTotals(),
    modelTurns: {},
  };

  // Index tool_use blocks by id so the following user line can attach output size.
  const toolCallById = new Map<string, ToolCall>();

  for (const line of lines) {
    const ts = (line as { timestamp?: string }).timestamp;
    if (ts) {
      if (!model.firstTs) {
        model.firstTs = ts;
      }
      model.lastTs = ts;
    }

    switch (line.type) {
      case "assistant": {
        const a = line as AssistantLine;
        model.cwd ??= a.cwd;
        model.version ??= a.version;
        model.gitBranch ??= a.gitBranch;

        const modelId = a.message?.model;
        const usage = usageToTotals(a.message?.usage);
        // Skip synthetic messages for usage/model tallies; they carry no real cost.
        if (modelId && modelId !== SYNTHETIC_MODEL) {
          const turn: Turn = { uuid: a.uuid, timestamp: a.timestamp, model: modelId, usage };
          model.turns.push(turn);
          addTotals(model.totals, usage);
          model.modelTurns[modelId] = (model.modelTurns[modelId] ?? 0) + 1;
        }

        for (const block of contentBlocks(a.message?.content)) {
          if (block.type === "tool_use") {
            const tu = block as ToolUseBlock;
            const input = tu.input ?? {};
            const call: ToolCall = {
              id: tu.id,
              name: tu.name,
              input,
              timestamp: a.timestamp,
              command: typeof input.command === "string" ? input.command : undefined,
              filePath: typeof input.file_path === "string" ? input.file_path : undefined,
            };
            model.toolCalls.push(call);
            if (tu.id) {
              toolCallById.set(tu.id, call);
            }
          }
        }
        break;
      }

      case "user": {
        const u = line as UserLine;
        if (u.isCompactSummary) {
          model.compactSummaryCount += 1;
        }
        // Attach result sizes to the tool calls they answer.
        const blocks = contentBlocks(u.message?.content);
        const resultBlocks = blocks.filter((b) => b.type === "tool_result") as Array<{
          type: "tool_result";
          tool_use_id: string;
          content: unknown;
          is_error?: boolean;
        }>;
        // Prefer the top-level toolUseResult (Bash stdout/stderr) when there is
        // exactly one result on the line — it best reflects real output size.
        const tur = u.toolUseResult;
        for (const rb of resultBlocks) {
          const call = toolCallById.get(rb.tool_use_id);
          if (!call) {
            continue;
          }
          let chars = payloadChars(rb.content);
          if (resultBlocks.length === 1 && tur) {
            const stdout = typeof tur.stdout === "string" ? tur.stdout.length : 0;
            const stderr = typeof tur.stderr === "string" ? tur.stderr.length : 0;
            if (stdout + stderr > 0) {
              chars = stdout + stderr;
            } else if (tur.content !== undefined) {
              chars = payloadChars(tur.content);
            }
            if (tur.interrupted === true) {
              call.interrupted = true;
            }
          }
          call.resultChars = chars;
          if (rb.is_error === true) {
            call.isError = true;
          }
        }
        break;
      }

      case "system": {
        const s = line as CompactBoundaryLine;
        if (s.subtype === "compact_boundary" && s.compactMetadata) {
          const m = s.compactMetadata;
          model.compactions.push({
            timestamp: s.timestamp,
            trigger: m.trigger,
            preTokens: m.preTokens ?? 0,
            postTokens: m.postTokens ?? 0,
            droppedTokens: m.cumulativeDroppedTokens ?? Math.max(0, (m.preTokens ?? 0) - (m.postTokens ?? 0)),
            durationMs: m.durationMs,
          });
        }
        break;
      }

      default:
        break;
    }
  }

  return model;
}

/** The dominant model across a session's assistant turns (for pricing). */
export function primaryModel(session: SessionModel): string | undefined {
  let best: string | undefined;
  let bestCount = -1;
  for (const [id, count] of Object.entries(session.modelTurns)) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}
