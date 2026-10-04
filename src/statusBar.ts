import * as vscode from "vscode";
import type { DashboardPayload } from "./service";
import { modelLabel } from "./names";

/**
 * Shows how full the most-recently-active session's context is and what it has
 * cost so far, in the status bar. Updated on each analysis pass (which the
 * watcher triggers). Context fill is the actionable number: it tells you when
 * a session is about to auto-compact.
 */
export class StatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "ccOptimizer.openDashboard";
    this.item.name = "Claude Code Token Optimizer";
  }

  update(payload: DashboardPayload): void {
    // Most recently active top-level session; subagents finish inside their parent.
    const sessions = payload.aggregates.sessions.filter((s) => !s.parentSessionId);
    if (!payload.found || sessions.length === 0) {
      this.item.hide();
      return;
    }
    const latest = [...sessions].sort((a, b) => (b.lastTs ?? "").localeCompare(a.lastTs ?? ""))[0];
    const t = latest.totals;
    const ctxFraction = latest.contextWindow > 0 ? latest.lastPromptTokens / latest.contextWindow : 0;
    const ctxPct = Math.round(ctxFraction * 100);
    const regressions = payload.trends?.regressions ?? [];
    const nearCompaction = ctxFraction >= 0.8;
    const warn = regressions.length > 0 || nearCompaction;
    const icon = warn ? "$(warning)" : "$(zap)";
    const suffix = regressions.length > 0 ? ` · ${regressions.length} regression${regressions.length === 1 ? "" : "s"}` : "";
    this.item.text = `${icon} ${ctxPct}% ctx · $${latest.costUSD.toFixed(2)}${suffix}`;
    this.item.accessibilityInformation = {
      label: `Claude Code: latest session context ${ctxPct}% full, estimated cost ${latest.costUSD.toFixed(2)} dollars${suffix}`,
    };
    this.item.backgroundColor = warn ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    this.item.tooltip = new vscode.MarkdownString(
      [
        `**Claude Code — latest session**`,
        latest.title ? `${latest.title}` : `Project: \`${latest.project}\``,
        `Model: ${modelLabel(latest.model)} · Turns: ${latest.turns.toLocaleString("en-US")}`,
        `Context: ${latest.lastPromptTokens.toLocaleString("en-US")} / ${latest.contextWindow.toLocaleString("en-US")} tokens (${ctxPct}%)` +
          (nearCompaction ? " — close to auto-compaction" : ""),
        `Input: ${t.input.toLocaleString("en-US")} · Output: ${t.output.toLocaleString("en-US")}`,
        `Cache write: ${t.cacheCreate.toLocaleString("en-US")} · Cache read: ${t.cacheRead.toLocaleString("en-US")} (${Math.round(latest.cacheReadRatio * 100)}% reuse)`,
        `API-equivalent cost: $${latest.costUSD.toFixed(2)}`,
        ...(regressions.length ? ["", "**Regressions this week:**", ...regressions.map((r) => `- ${r.title}`)] : []),
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
