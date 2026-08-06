/**
 * Locates the Claude home directory and enumerates transcript files, then
 * folds each into a SessionModel. fs/os only — no vscode dependency.
 */
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { readTranscript } from "./parser";
import { buildSessionModel, type SessionModel } from "./model";

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
  /** Session UUID = the file's basename without extension. */
  sessionId: string;
  mtimeMs: number;
  sizeBytes: number;
}

/** List all `.jsonl` transcript files under ~/.claude/projects. */
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
    let files: fs.Dirent[];
    try {
      files = await fsp.readdir(projDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) {
        continue;
      }
      const filePath = path.join(projDir, f.name);
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(filePath);
      } catch {
        continue;
      }
      out.push({
        filePath,
        project: projEntry.name,
        sessionId: f.name.replace(/\.jsonl$/, ""),
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
      });
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
  });
}

/** Discover and parse every transcript. Failed files are skipped. */
export async function loadAllSessions(claudeHome: string): Promise<SessionModel[]> {
  const transcripts = await discoverTranscripts(claudeHome);
  const sessions: SessionModel[] = [];
  for (const t of transcripts) {
    try {
      const s = await loadSession(t);
      // Keep only sessions that actually have assistant usage — empty or
      // aborted transcripts carry no signal.
      if (s.turns.length > 0 || s.compactions.length > 0 || s.toolCalls.length > 0) {
        sessions.push(s);
      }
    } catch {
      // skip unreadable file
    }
  }
  return sessions;
}
