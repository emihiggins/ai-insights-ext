/**
 * Watches ~/.claude/projects for transcript changes. Uses chokidar because
 * vscode.workspace.createFileSystemWatcher only covers the workspace, and the
 * Claude home lives outside it. Refreshes are debounced — Claude Code appends
 * to transcripts in bursts.
 */
import chokidar, { type FSWatcher } from "chokidar";
import * as path from "path";
import { projectsDir } from "./discovery";

export class TranscriptWatcher {
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly claudeHome: string,
    private readonly onChange: () => void,
    private readonly debounceMs = 1500
  ) {}

  start(): void {
    const glob = path.join(projectsDir(this.claudeHome), "**", "*.jsonl");
    this.watcher = chokidar.watch(glob, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 100 },
    });
    const trigger = (): void => this.schedule();
    this.watcher.on("add", trigger).on("change", trigger).on("unlink", trigger);
  }

  private schedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.onChange(), this.debounceMs);
  }

  async dispose(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    await this.watcher?.close();
  }
}
