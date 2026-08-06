import * as vscode from "vscode";
import type { DashboardPayload } from "./service";

/**
 * Shows live token spend and cache reuse for the most-recently-active session
 * in the status bar. Updated on each analysis pass (which the watcher triggers).
 */
export class StatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "ccOptimizer.openDashboard";
  }

  update(payload: DashboardPayload): void {
    const sessions = payload.aggregates.sessions;
    if (!payload.found || sessions.length === 0) {
      this.item.hide();
      return;
    }
    // Most recently active session by lastTs.
    const latest = [...sessions].sort((a, b) => (b.lastTs ?? "").localeCompare(a.lastTs ?? ""))[0];
    const t = latest.totals;
    const total = t.input + t.output + t.cacheCreate + t.cacheRead;
    const cachePct = Math.round(latest.cacheReadRatio * 100);
    const regressions = payload.trends?.regressions ?? [];
    const warn = regressions.length > 0;
    const icon = warn ? "$(warning)" : "$(zap)";
    const suffix = warn ? ` · ${regressions.length} regression${regressions.length === 1 ? "" : "s"}` : "";
    this.item.text = `${icon} ${compact(total)} tok · ${cachePct}% cache${suffix}`;
    this.item.backgroundColor = warn
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    this.item.tooltip = new vscode.MarkdownString(
      [
        `**Claude Code — latest session**`,
        `Project: \`${latest.project}\``,
        `Turns: ${latest.turns.toLocaleString("en-US")}`,
        `Input: ${t.input.toLocaleString("en-US")} · Output: ${t.output.toLocaleString("en-US")}`,
        `Cache write: ${t.cacheCreate.toLocaleString("en-US")} · Cache read: ${t.cacheRead.toLocaleString("en-US")}`,
        `Est. cost: $${latest.costUSD.toFixed(2)}`,
        ...(warn ? ["", "**Regressions this week:**", ...regressions.map((r) => `- ${r.title}`)] : []),
        ``,
        `Click to open recommendations.`,
      ].join("\n\n")
    );
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

function compact(n: number): string {
  if (n >= 1_000_000) {
    return (n / 1_000_000).toFixed(1) + "M";
  }
  if (n >= 1_000) {
    return (n / 1_000).toFixed(1) + "k";
  }
  return String(n);
}
