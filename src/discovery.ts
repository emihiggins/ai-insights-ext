/**
 * Locates the Claude home directory and enumerates transcript files, then
 * folds each into a SessionModel. fs/os only — no vscode dependency.
 */
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { readTranscript } from "./parser";
import { buildSessionModel, applyCharsPerTokenFallback, type SessionModel } from "./model";

/** Resolve the Claude home dir, honoring an optional override. */
export function resolveClaudeHome(override?: string): string {
  if (override && override.trim().length > 0) {
    return override.replace(/^~(?=$|\/)/, os.homedir());
  }
  return path.join(os.homedir(), ".claude");
}

export function projectsDir(claudeHome: string): string {
  return path.join(claudeHome, "projects");
}

export interface DiscoveredTranscript {
  filePath: string;
  /** Encoded project directory name (e.g. "-Users-me-Documents-app"). */
  project: string;
  /** Session UUID = the file's basename without extension (`agent-<id>` for subagents). */
  sessionId: string;
  /** Set for subagent transcripts (`<project>/<session>/subagents/agent-*.jsonl`). */
  parentSessionId?: string;
  mtimeMs: number;
  sizeBytes: number;
}

async function listJsonl(
  dir: string,
  project: string,
  parentSessionId?: string
): Promise<DiscoveredTranscript[]> {
  const out: DiscoveredTranscript[] = [];
  let files: fs.Dirent[];
  try {
    files = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.isFile() || !f.name.endsWith(".jsonl")) {
      continue;
    }
    const filePath = path.join(dir, f.name);
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      continue;
    }
    out.push({
      filePath,
      project,
      sessionId: f.name.replace(/\.jsonl$/, ""),
      parentSessionId,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
    });
  }
  return out;
}

/**
 * List all `.jsonl` transcripts under ~/.claude/projects: top-level session
 * files plus subagent transcripts nested under `<session>/subagents/`.
 */
export async function discoverTranscripts(claudeHome: string): Promise<DiscoveredTranscript[]> {
  const root = projectsDir(claudeHome);
  const out: DiscoveredTranscript[] = [];
  let projectEntries: fs.Dirent[];
  try {
    projectEntries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return out; // projects dir missing => nothing to analyze
  }
  for (const projEntry of projectEntries) {
    if (!projEntry.isDirectory()) {
      continue;
    }
    const projDir = path.join(root, projEntry.name);
    out.push(...(await listJsonl(projDir, projEntry.name)));
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(projDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionDir of entries) {
      if (sessionDir.isDirectory()) {
        const subagentsDir = path.join(projDir, sessionDir.name, "subagents");
        out.push(...(await listJsonl(subagentsDir, projEntry.name, sessionDir.name)));
      }
    }
  }
  return out;
}

/** Parse a single transcript file into a SessionModel. */
export async function loadSession(t: DiscoveredTranscript): Promise<SessionModel> {
  const lines = [];
  for await (const line of readTranscript(t.filePath)) {
    lines.push(line);
  }
  return buildSessionModel(lines, {
    sessionId: t.sessionId,
    filePath: t.filePath,
    project: t.project,
    parentSessionId: t.parentSessionId,
  });
}

/**
 * Parsed sessions keyed by file path, reused while a file's mtime and size are
 * unchanged. Claude Code only appends to the active transcript, so on each
 * refresh only that file is re-parsed.
 */
export class SessionCache {
  private readonly entries = new Map<string, { mtimeMs: number; sizeBytes: number; session: SessionModel }>();

  get(t: DiscoveredTranscript): SessionModel | undefined {
    const e = this.entries.get(t.filePath);
    return e && e.mtimeMs === t.mtimeMs && e.sizeBytes === t.sizeBytes ? e.session : undefined;
  }

  set(t: DiscoveredTranscript, session: SessionModel): void {
    this.entries.set(t.filePath, { mtimeMs: t.mtimeMs, sizeBytes: t.sizeBytes, session });
  }

  /** Drop entries for files that no longer exist. */
  retain(filePaths: Set<string>): void {
    for (const key of this.entries.keys()) {
      if (!filePaths.has(key)) {
        this.entries.delete(key);
      }
    }
  }

  /** The cached session for a path regardless of freshness (for drill-downs). */
  peek(filePath: string): SessionModel | undefined {
    return this.entries.get(filePath)?.session;
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Discover and parse every transcript. Failed files are skipped. */
export async function loadAllSessions(claudeHome: string, cache?: SessionCache): Promise<SessionModel[]> {
  const transcripts = await discoverTranscripts(claudeHome);
  const sessions: SessionModel[] = [];
  for (const t of transcripts) {
    try {
      let s = cache?.get(t);
      if (!s) {
        s = await loadSession(t);
        cache?.set(t, s);
      }
      // Keep only sessions that actually have assistant usage — empty or
      // aborted transcripts carry no signal.
      if (s.turns.length > 0 || s.compactions.length > 0 || s.toolCalls.length > 0) {
        sessions.push(s);
      }
    } catch {
      // skip unreadable file
    }
  }
  cache?.retain(new Set(transcripts.map((t) => t.filePath)));
  applyCharsPerTokenFallback(sessions);
  return sessions;
}
