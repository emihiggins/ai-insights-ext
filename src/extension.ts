import * as vscode from "vscode";
import { resolveClaudeHome, SessionCache } from "./discovery";
import { analyze, type AnalysisFilter, type Dismissals } from "./service";
import { DEFAULT_RULE_CONFIG, type RuleConfig } from "./rules/index";
import { DashboardProvider } from "./webview/provider";
import { StatusBar } from "./statusBar";
import { TranscriptWatcher } from "./watcher";
import { loadTrendHistory, saveTrendHistory } from "./trendStore";

let watcher: TranscriptWatcher | undefined;

/** Per-workspace dashboard filter; undefined until the user picks one. */
const FILTER_KEY = "ccOptimizer.filter.v1";
/** Dismissed / snoozed findings, shared across workspaces. */
const DISMISSED_KEY = "ccOptimizer.dismissed.v1";

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

function workspacePaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = new StatusBar();
  const output = vscode.window.createOutputChannel("Claude Code Token Optimizer");
  const cache = new SessionCache();
  context.subscriptions.push(statusBar, output);

  let analyzing = false;
  let queued = false;
  let lastShownError: string | undefined;
  // First run in a workspace defaults the project filter to this workspace.
  let filterInitialized = context.workspaceState.get<AnalysisFilter>(FILTER_KEY) !== undefined;

  const dismissals = (): Dismissals => {
    const now = Date.now();
    const all = context.globalState.get<Dismissals>(DISMISSED_KEY) ?? {};
    // Drop expired snoozes so the stored map doesn't grow forever.
    return Object.fromEntries(Object.entries(all).filter(([, until]) => until === 0 || until > now));
  };

  const runAnalysis = async (): Promise<void> => {
    if (analyzing) {
      queued = true;
      return;
    }
    analyzing = true;
    try {
      const { claudeHome, rules } = readConfig();
      const persistedTrends = loadTrendHistory(context);
      const filter = context.workspaceState.get<AnalysisFilter>(FILTER_KEY) ?? {};
      const { payload, seriesToPersist } = await analyze(claudeHome, rules, {
        persistedTrends,
        filter,
        dismissed: dismissals(),
        workspacePaths: workspacePaths(),
        cache,
      });
      await saveTrendHistory(context, seriesToPersist);

      if (!filterInitialized) {
        filterInitialized = true;
        const here = payload.projects
          .filter((p) => p.inWorkspace)
          .sort((a, b) => b.sessionCount - a.sessionCount)[0];
        if (here) {
          await context.workspaceState.update(FILTER_KEY, { project: here.project });
          queued = true; // re-run with the workspace filter applied
          return;
        }
        await context.workspaceState.update(FILTER_KEY, {});
      }

      provider.update(payload);
      statusBar.update(payload);
      lastShownError = undefined;
    } catch (err) {
      const message = String(err);
      output.appendLine(`[${new Date().toISOString()}] analysis failed: ${message}`);
      // The watcher re-runs analysis often; only pop up a given error once.
      if (message !== lastShownError) {
        lastShownError = message;
        void vscode.window
          .showErrorMessage(`Claude Code Optimizer: analysis failed — ${message}`, "Show Log")
          .then((choice) => choice && output.show());
      }
    } finally {
      analyzing = false;
      if (queued) {
        queued = false;
        void runAnalysis();
      }
    }
  };

  const provider = new DashboardProvider(
    context.extensionUri,
    {
      refresh: () => void runAnalysis(),
      setFilter: (filter) => {
        filterInitialized = true;
        void context.workspaceState.update(FILTER_KEY, filter).then(() => runAnalysis());
      },
      dismiss: (key, days) => {
        const next = { ...dismissals(), [key]: days ? Date.now() + days * 86_400_000 : 0 };
        void context.globalState.update(DISMISSED_KEY, next).then(() => runAnalysis());
      },
      restoreDismissed: () => {
        void context.globalState.update(DISMISSED_KEY, {}).then(() => runAnalysis());
      },
    },
    cache
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DashboardProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ccOptimizer.refresh", () => void runAnalysis()),
    vscode.commands.registerCommand("ccOptimizer.openDashboard", () => {
      void vscode.commands.executeCommand("ccOptimizer.dashboard.focus");
    }),
    vscode.commands.registerCommand("ccOptimizer.openInEditor", () => provider.openInEditor())
  );

  // Watch the Claude home for live updates.
  const { claudeHome } = readConfig();
  watcher = new TranscriptWatcher(claudeHome, () => void runAnalysis());
  watcher.start();
  context.subscriptions.push({ dispose: () => void watcher?.dispose() });

  // Re-analyze when relevant settings or the open folders change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ccOptimizer")) {
        void runAnalysis();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void runAnalysis())
  );

  // Initial pass.
  void runAnalysis();
}

export function deactivate(): void {
  void watcher?.dispose();
}
