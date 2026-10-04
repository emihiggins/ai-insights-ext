import * as vscode from "vscode";
import type { AnalysisFilter, DashboardPayload } from "../service";
import { loadSessionDetail } from "../service";
import type { SessionCache } from "../discovery";

/** Messages the webview sends to the host. */
export type WebviewMessage =
  | { command: "ready" }
  | { command: "refresh" }
  | { command: "openInEditor" }
  | { command: "openTranscript"; filePath: string }
  | { command: "sessionDetail"; filePath: string }
  | { command: "setFilter"; filter: AnalysisFilter }
  | { command: "dismiss"; key: string; days?: number }
  | { command: "restoreDismissed" };

export interface DashboardCallbacks {
  refresh(): void;
  setFilter(filter: AnalysisFilter): void;
  /** `days` undefined = dismiss permanently; otherwise snooze. */
  dismiss(key: string, days?: number): void;
  restoreDismissed(): void;
}

/** One rendered dashboard surface: the sidebar view or the editor panel. */
interface Surface {
  webview: vscode.Webview;
  visible(): boolean;
  /** A payload arrived while hidden; send it when the surface is shown. */
  stale: boolean;
}

/**
 * Renders the recommendations dashboard in the sidebar and, on request, as a
 * full editor panel. Both share one renderer and receive the same payloads.
 * Payloads are only posted to visible surfaces; hidden ones catch up when
 * shown, so a busy session doesn't keep re-rendering an unseen view.
 */
export class DashboardProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "ccOptimizer.dashboard";
  private static readonly panelType = "ccOptimizer.dashboardPanel";

  private readonly surfaces = new Set<Surface>();
  private panel?: vscode.WebviewPanel;
  private lastPayload?: DashboardPayload;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly callbacks: DashboardCallbacks,
    private readonly cache: SessionCache
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    const surface = this.attach(webviewView.webview, () => webviewView.visible);
    webviewView.onDidChangeVisibility(() => this.catchUp(surface));
    webviewView.onDidDispose(() => this.surfaces.delete(surface));
  }

  /** Open (or reveal) the dashboard as a full-width editor tab. */
  openInEditor(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      DashboardProvider.panelType,
      "Claude Code Token Optimizer",
      vscode.ViewColumn.Active,
      { retainContextWhenHidden: true }
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "resources", "icon.svg");
    const surface = this.attach(panel.webview, () => panel.visible);
    panel.onDidChangeViewState(() => this.catchUp(surface));
    panel.onDidDispose(() => {
      this.surfaces.delete(surface);
      this.panel = undefined;
    });
    this.panel = panel;
  }

  update(payload: DashboardPayload): void {
    this.lastPayload = payload;
    for (const surface of this.surfaces) {
      if (surface.visible()) {
        this.post(surface, payload);
      } else {
        surface.stale = true;
      }
    }
  }

  private attach(webview: vscode.Webview, visible: () => boolean): Surface {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist"), vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webview.html = this.html(webview);
    const surface: Surface = { webview, visible, stale: false };
    this.surfaces.add(surface);
    webview.onDidReceiveMessage((msg: WebviewMessage) => this.onMessage(surface, msg));
    return surface;
  }

  private onMessage(surface: Surface, msg: WebviewMessage): void {
    switch (msg.command) {
      case "ready":
        if (this.lastPayload) {
          this.post(surface, this.lastPayload);
        } else {
          this.callbacks.refresh();
        }
        break;
      case "refresh":
        this.callbacks.refresh();
        break;
      case "openInEditor":
        this.openInEditor();
        break;
      case "openTranscript":
        void this.openTranscript(String(msg.filePath ?? ""));
        break;
      case "sessionDetail":
        void this.sendSessionDetail(surface, String(msg.filePath ?? ""));
        break;
      case "setFilter":
        this.callbacks.setFilter(msg.filter ?? {});
        break;
      case "dismiss":
        if (msg.key) {
          this.callbacks.dismiss(msg.key, msg.days);
        }
        break;
      case "restoreDismissed":
        this.callbacks.restoreDismissed();
        break;
    }
  }

  private catchUp(surface: Surface): void {
    if (surface.stale && surface.visible() && this.lastPayload) {
      this.post(surface, this.lastPayload);
    }
  }

  private post(surface: Surface, payload: DashboardPayload): void {
    surface.stale = false;
    void surface.webview.postMessage({ command: "data", payload });
  }

  private async sendSessionDetail(surface: Surface, filePath: string): Promise<void> {
    if (!filePath) {
      return;
    }
    try {
      const detail = await loadSessionDetail(filePath, this.cache);
      void surface.webview.postMessage({ command: "sessionDetail", detail });
    } catch (err) {
      void surface.webview.postMessage({ command: "sessionDetailError", message: String(err) });
    }
  }

  private async openTranscript(filePath: string): Promise<void> {
    if (!filePath) {
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      vscode.window.showErrorMessage(`Could not open transcript: ${String(err)}`);
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "dashboard.css"));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Claude Code Token Optimizer</title>
</head>
<body>
  <div id="app">
    <div class="loading">Analyzing Claude Code sessions…</div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
