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
  /** "standard" or "fast", from usage.speed. */
  speed?: string;
  usage: TokenTotals;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Tool input with large string values (file bodies, patches) dropped. */
  input: Record<string, unknown>;
  /** Convenience extractions for common tools. */
  command?: string;
  filePath?: string;
  /** Read range, when the call asked for one. */
  offset?: number;
  limit?: number;
  /** Index into SessionModel.turns of the response that made this call. */
  turnIndex?: number;
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
  /** Set for subagent transcripts: the session that spawned this agent. */
  parentSessionId?: string;
  /** Claude Code's generated session title (`ai-title` lines), if any. */
  title?: string;
  /**
   * Characters per token for tool output in this session, calibrated from how
   * much each tool result grew the next turn's prompt. Defaults to 4.
   */
  charsPerToken: number;
  /** Whether charsPerToken came from this session's own data. */
  charsPerTokenCalibrated: boolean;
}

export const DEFAULT_CHARS_PER_TOKEN = 4;
const MAX_KEPT_INPUT_CHARS = 300;

/** Keep only small scalar inputs; full file bodies would dominate memory. */
function compactInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= MAX_KEPT_INPUT_CHARS)) {
      out[k] = v;
    }
  }
  return out;
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
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

function addTotals(a: TokenTotals, b: TokenTotals, sign = 1): void {
  a.input += sign * b.input;
  a.output += sign * b.output;
  a.cacheCreate += sign * b.cacheCreate;
  a.cacheRead += sign * b.cacheRead;
  a.ephemeral5m += sign * b.ephemeral5m;
  a.ephemeral1h += sign * b.ephemeral1h;
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
  if (Array.isArray(value)) {
    // Content blocks: count the text the model reads, not the JSON wrapping.
    return value.reduce<number>((sum, block) => {
      const text = (block as { type?: unknown; text?: unknown } | null)?.text;
      return sum + (typeof text === "string" ? text.length : payloadChars(block));
    }, 0);
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
  meta: { sessionId: string; filePath: string; project: string; parentSessionId?: string }
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
    parentSessionId: meta.parentSessionId,
    charsPerToken: DEFAULT_CHARS_PER_TOKEN,
    charsPerTokenCalibrated: false,
  };

  // Index tool_use blocks by id so the following user line can attach output size.
  const toolCallById = new Map<string, ToolCall>();
  // Claude Code writes one assistant line per content block, each repeating the
  // response's usage. Count each response once, keyed by message id + request id.
  const turnByResponse = new Map<string, Turn>();

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
        let turnIndex: number | undefined;
        // Skip synthetic messages for usage/model tallies; they carry no real cost.
        if (modelId && modelId !== SYNTHETIC_MODEL) {
          const responseKey = a.message?.id ? `${a.message.id}:${a.requestId ?? ""}` : undefined;
          const seen = responseKey ? turnByResponse.get(responseKey) : undefined;
          if (seen) {
            // Same response, later block: keep the latest usage (it is final).
            addTotals(model.totals, seen.usage, -1);
            seen.usage = usage;
            addTotals(model.totals, usage);
            turnIndex = model.turns.indexOf(seen);
          } else {
            const turn: Turn = {
              uuid: a.uuid,
              timestamp: a.timestamp,
              model: modelId,
              speed: a.message?.usage?.speed,
              usage,
            };
            model.turns.push(turn);
            turnIndex = model.turns.length - 1;
            addTotals(model.totals, usage);
            model.modelTurns[modelId] = (model.modelTurns[modelId] ?? 0) + 1;
            if (responseKey) {
              turnByResponse.set(responseKey, turn);
            }
          }
        }

        for (const block of contentBlocks(a.message?.content)) {
          if (block.type === "tool_use") {
            const tu = block as ToolUseBlock;
            const input = tu.input ?? {};
            const call: ToolCall = {
              id: tu.id,
              name: tu.name,
              input: compactInput(input),
              timestamp: a.timestamp,
              command: typeof input.command === "string" ? input.command : undefined,
              filePath: typeof input.file_path === "string" ? input.file_path : undefined,
              offset: numberOrUndefined(input.offset),
              limit: numberOrUndefined(input.limit),
              turnIndex,
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
        // Measure the tool_result content — what actually entered context. The
        // top-level toolUseResult holds the full raw output, which overstates
        // size when Claude Code persisted a large output to disk and only
        // passed the model a short preview.
        const tur = u.toolUseResult;
        for (const rb of resultBlocks) {
          const call = toolCallById.get(rb.tool_use_id);
          if (!call) {
            continue;
          }
          if (resultBlocks.length === 1 && tur?.interrupted === true) {
            call.interrupted = true;
          }
          call.resultChars = payloadChars(rb.content);
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

      case "ai-title": {
        const title = (line as { aiTitle?: unknown }).aiTitle;
        if (typeof title === "string" && title.trim()) {
          model.title = title.trim(); // latest title wins
        }
        break;
      }

      default:
        break;
    }
  }

  const calibrated = calibrateCharsPerToken(model);
  if (calibrated !== undefined) {
    model.charsPerToken = calibrated;
    model.charsPerTokenCalibrated = true;
  }
  return model;
}

const MIN_CALIBRATION_CHARS = 4000; // small results are dominated by per-turn overhead
const MIN_CALIBRATION_SAMPLES = 3;
const MIN_CHARS_PER_TOKEN = 1.5;
const MAX_CHARS_PER_TOKEN = 6;

function promptTokens(t: Turn): number {
  return t.usage.input + t.usage.cacheRead + t.usage.cacheCreate;
}

/**
 * Estimate characters per token from the session itself: when a turn's tool
 * results are large, the next turn's prompt grows by roughly (this turn's
 * output + the results' tokens). The median over several such turns is robust
 * to the noise from reminders and thinking blocks; clamped to a sane range.
 * Returns undefined when the session has too few usable samples.
 */
export function calibrateCharsPerToken(model: SessionModel): number | undefined {
  const charsByTurn = new Map<number, number>();
  for (const call of model.toolCalls) {
    if (call.turnIndex !== undefined && call.resultChars !== undefined) {
      charsByTurn.set(call.turnIndex, (charsByTurn.get(call.turnIndex) ?? 0) + call.resultChars);
    }
  }
  const compactionTs = model.compactions.map((c) => c.timestamp ?? "");
  const ratios: number[] = [];
  for (const [i, chars] of charsByTurn) {
    const cur = model.turns[i];
    const next = model.turns[i + 1];
    if (!next || chars < MIN_CALIBRATION_CHARS) {
      continue;
    }
    const from = cur.timestamp ?? "";
    const to = next.timestamp ?? "";
    if (compactionTs.some((ts) => ts > from && ts <= to)) {
      continue; // the prompt was rebuilt in between
    }
    const growth = promptTokens(next) - promptTokens(cur) - cur.usage.output;
    if (growth > 0) {
      ratios.push(chars / growth);
    }
  }
  if (ratios.length < MIN_CALIBRATION_SAMPLES) {
    return undefined;
  }
  return Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, median(ratios)));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Sessions too short to calibrate borrow the median of the sessions that
 * could, which tracks the user's actual models better than a fixed 4.
 */
export function applyCharsPerTokenFallback(sessions: SessionModel[]): void {
  const calibrated = sessions.filter((s) => s.charsPerTokenCalibrated).map((s) => s.charsPerToken);
  if (calibrated.length === 0) {
    return;
  }
  const fallback = median(calibrated);
  for (const s of sessions) {
    if (!s.charsPerTokenCalibrated) {
      s.charsPerToken = fallback;
    }
  }
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
