import * as vscode from "vscode";
import type { DashboardPayload } from "../service";
import { loadSessionDetail } from "../service";

/**
 * Renders the recommendations dashboard as a persistent sidebar webview.
 * Loads the bundled webview script/style via asWebviewUri and enforces a strict
 * CSP with a per-render nonce.
 */
export class DashboardProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "ccOptimizer.dashboard";

  private view?: vscode.WebviewView;
  private lastPayload?: DashboardPayload;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onRefreshRequested: () => void
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist"), vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = this.html(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: { command: string; [k: string]: unknown }) => {
      switch (msg.command) {
        case "ready":
          if (this.lastPayload) {
            this.post(this.lastPayload);
          } else {
            this.onRefreshRequested();
          }
          break;
        case "refresh":
          this.onRefreshRequested();
          break;
        case "openTranscript":
          this.openTranscript(String(msg.filePath ?? ""));
          break;
        case "sessionDetail":
          void this.sendSessionDetail(String(msg.filePath ?? ""));
          break;
      }
    });
  }

  update(payload: DashboardPayload): void {
    this.lastPayload = payload;
    this.post(payload);
  }

  private post(payload: DashboardPayload): void {
    this.view?.webview.postMessage({ command: "data", payload });
  }

  private async sendSessionDetail(filePath: string): Promise<void> {
    if (!filePath) {
      return;
    }
    try {
      const detail = await loadSessionDetail(filePath);
      this.view?.webview.postMessage({ command: "sessionDetail", detail });
    } catch (err) {
      this.view?.webview.postMessage({ command: "sessionDetailError", message: String(err) });
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
