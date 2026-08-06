import * as vscode from "vscode";
import { resolveClaudeHome } from "./discovery";
import { analyze, type DashboardPayload } from "./service";
import { DEFAULT_RULE_CONFIG, type RuleConfig } from "./rules/index";
import { DashboardProvider } from "./webview/provider";
import { StatusBar } from "./statusBar";
import { TranscriptWatcher } from "./watcher";
import { loadTrendHistory, saveTrendHistory } from "./trendStore";

let watcher: TranscriptWatcher | undefined;

function readConfig(): { claudeHome: string; rules: RuleConfig } {
  const cfg = vscode.workspace.getConfiguration("ccOptimizer");
  return {
    claudeHome: resolveClaudeHome(cfg.get<string>("claudeHome") ?? ""),
    rules: {
      largeSearchOutputBytes: cfg.get<number>("largeSearchOutputBytes") ?? DEFAULT_RULE_CONFIG.largeSearchOutputBytes,
      lowCacheRatioThreshold: cfg.get<number>("lowCacheRatioThreshold") ?? DEFAULT_RULE_CONFIG.lowCacheRatioThreshold,
    },
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = new StatusBar();
  context.subscriptions.push(statusBar);

  let analyzing = false;
  let queued = false;

  const runAnalysis = async (): Promise<void> => {
    if (analyzing) {
      queued = true;
      return;
    }
    analyzing = true;
    try {
      const { claudeHome, rules } = readConfig();
      const persistedTrends = loadTrendHistory(context);
      const payload: DashboardPayload = await analyze(claudeHome, rules, { persistedTrends });
      await saveTrendHistory(context, payload.trends.series);
      provider.update(payload);
      statusBar.update(payload);
    } catch (err) {
      vscode.window.showErrorMessage(`Claude Code Optimizer: analysis failed — ${String(err)}`);
    } finally {
      analyzing = false;
      if (queued) {
        queued = false;
        void runAnalysis();
      }
    }
  };

  const provider = new DashboardProvider(context.extensionUri, () => void runAnalysis());
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DashboardProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ccOptimizer.refresh", () => void runAnalysis()),
    vscode.commands.registerCommand("ccOptimizer.openDashboard", () => {
      void vscode.commands.executeCommand("ccOptimizer.dashboard.focus");
    })
  );

  // Watch the Claude home for live updates.
  const { claudeHome } = readConfig();
  watcher = new TranscriptWatcher(claudeHome, () => void runAnalysis());
  watcher.start();
  context.subscriptions.push({ dispose: () => void watcher?.dispose() });

  // Re-analyze when relevant settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ccOptimizer")) {
        void runAnalysis();
      }
    })
  );

  // Initial pass.
  void runAnalysis();
}

export function deactivate(): void {
  void watcher?.dispose();
}
