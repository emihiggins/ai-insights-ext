/**
 * Webview client. Bundled to dist/webview.js by esbuild (browser platform).
 * Chart.js is bundled in — no CDN, CSP-safe. Type-only imports of host modules
 * are erased at build time.
 */
import { Chart, registerables } from "chart.js";
import type { DashboardPayload } from "../service";
import type { Finding } from "../rules/index";
import type { SessionSummary } from "../aggregates";
import type { SavingsReport } from "../savings";
import type { TrendReport } from "../trends";
import type { SessionDetail, TurnDetail, ToolDetail } from "../detail";

Chart.register(...registerables);

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
let toolChart: Chart | undefined;
let savingsChart: Chart | undefined;
let trendChart: Chart | undefined;
let detailChart: Chart | undefined;
let lastPayload: DashboardPayload | undefined;

window.addEventListener("message", (event: MessageEvent) => {
  const msg = event.data as {
    command: string;
    payload?: DashboardPayload;
    detail?: SessionDetail;
    message?: string;
  };
  if (msg.command === "data" && msg.payload) {
    lastPayload = msg.payload;
    render(msg.payload);
  } else if (msg.command === "sessionDetail" && msg.detail) {
    renderDetail(msg.detail);
  } else if (msg.command === "sessionDetailError") {
    const app = document.getElementById("app")!;
    app.innerHTML = `<div class="empty"><h2>Could not load session</h2><p>${esc(msg.message ?? "")}</p>${backButton()}</div>`;
    wireBack();
  }
});

vscode.postMessage({ command: "ready" });

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
function money(n: number): string {
  return "$" + n.toFixed(2);
}
function pct(n: number): string {
  return Math.round(n * 100) + "%";
}
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function render(payload: DashboardPayload): void {
  const app = document.getElementById("app")!;
  if (!payload.found) {
    app.innerHTML = `<div class="empty"><h2>No Claude Code data found</h2>
      <p>Looked in <code>${esc(payload.claudeHome)}/projects</code>. Run a Claude Code session, then Refresh.</p></div>`;
    return;
  }
  const a = payload.aggregates;
  if (a.sessionCount === 0) {
    app.innerHTML = `<div class="empty"><h2>No sessions with usage yet</h2>
      <p>Found <code>${esc(payload.claudeHome)}/projects</code> but no analyzable transcripts.</p></div>`;
    return;
  }

  app.innerHTML = `
    <header>
      <div class="stats">
        ${stat("Sessions", fmt(a.sessionCount))}
        ${stat("Est. cost", money(a.totalCostUSD))}
        ${stat("Cache reuse", pct(a.cacheReadRatio))}
        ${stat("Compactions", fmt(a.compactionCount))}
      </div>
      <div class="tokens">
        <span title="Uncached input">in ${fmt(a.totals.input)}</span>
        <span title="Output">out ${fmt(a.totals.output)}</span>
        <span title="Cache writes (1.25x/2x)">cache-write ${fmt(a.totals.cacheCreate)}</span>
        <span title="Cache reads (0.1x)">cache-read ${fmt(a.totals.cacheRead)}</span>
      </div>
      <div class="refresh"><button id="refreshBtn">Refresh</button>
        <span class="ts">updated ${esc(payload.generatedAt.replace("T", " ").slice(0, 19))}</span></div>
    </header>

    ${regressionBanner(payload.trends)}

    ${savingsSection(payload.savings)}

    ${trendsSection(payload.trends)}

    <section>
      <h3>Recommendations — one-off fixes (${payload.results.oneOffs.length})</h3>
      <div id="oneoffs">${payload.results.oneOffs.map((f) => findingCard(f, payload)).join("") || emptyList("No one-off issues detected.")}</div>
    </section>

    <section>
      <h3>Recommendations — habits (${payload.results.habits.length})</h3>
      <div id="habits">${payload.results.habits.map((f) => findingCard(f, payload)).join("") || emptyList("No recurring habits detected.")}</div>
    </section>

    <section>
      <h3>Tool usage</h3>
      <canvas id="toolChart" height="140"></canvas>
    </section>

    <section>
      <h3>Most expensive sessions</h3>
      <table class="sessions"><thead><tr>
        <th>Project</th><th>Model</th><th>Turns</th><th>Cache</th><th>Compact</th><th>Est. $</th><th></th>
      </tr></thead><tbody>
        ${a.sessions.slice(0, 15).map((s) => sessionRow(s, payload)).join("")}
      </tbody></table>
    </section>`;

  document.getElementById("refreshBtn")?.addEventListener("click", () => vscode.postMessage({ command: "refresh" }));
  wireLinks();

  drawSavingsChart(payload.savings);
  drawTrendChart(payload.trends);
  drawToolChart(a.toolCounts);
}

function regressionBanner(t: TrendReport): string {
  if (!t.regressions.length) {
    return "";
  }
  const items = t.regressions
    .map((r) => `<li class="reg-${esc(r.severity)}"><strong>${esc(r.title)}</strong> — ${esc(r.detail)}</li>`)
    .join("");
  return `<section class="regressions">
    <div class="reg-head">⚠ ${t.regressions.length} efficiency regression${t.regressions.length === 1 ? "" : "s"} vs the prior ${t.windowDays} days</div>
    <ul>${items}</ul>
  </section>`;
}

function trendsSection(t: TrendReport): string {
  // Need at least a few days of history for a meaningful line.
  if (t.series.length < 2) {
    return "";
  }
  return `<section>
    <h3>Efficiency over time</h3>
    <canvas id="trendChart" height="150"></canvas>
  </section>`;
}

function savingsSection(sv: SavingsReport): string {
  const topCost = sv.byCost.filter((c) => c.wastedUSD >= 0.005 || c.wastedTokens > 0).slice(0, 8);
  const common = sv.mostCommon.slice(0, 6);
  return `
    <section class="savings">
      <h3>Potential savings</h3>
      <div class="hero">
        <div class="hero-num">
          <div class="big">${money(sv.totalWastedUSD)}</div>
          <div class="lbl">est. recoverable</div>
        </div>
        <div class="hero-num">
          <div class="big">${fmt(sv.totalWastedTokens)}</div>
          <div class="lbl">tokens recoverable</div>
        </div>
        <div class="hero-num">
          <div class="big">${pct(sv.wasteFractionOfCost)}</div>
          <div class="lbl">of estimated spend</div>
        </div>
      </div>
      ${topCost.length ? `<canvas id="savingsChart" height="140"></canvas>` : `<div class="none">No recoverable waste detected — nice.</div>`}
      <div class="mistakes">
        <h4>Most common mistakes</h4>
        ${
          common.length
            ? common
                .map(
                  (c) =>
                    `<div class="mrow"><span class="mcat">${esc(c.category)}</span>` +
                    `<span class="mcount">${c.count}×</span>` +
                    `<span class="mcost">${c.wastedUSD >= 0.005 ? "~" + money(c.wastedUSD) : ""}</span></div>`
                )
                .join("")
            : emptyList("No recurring mistakes detected.")
        }
      </div>
    </section>`;
}

function wireLinks(): void {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-file]"))) {
    el.addEventListener("click", () => vscode.postMessage({ command: "openTranscript", filePath: el.dataset.file }));
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-detail-file]"))) {
    el.addEventListener("click", () => vscode.postMessage({ command: "sessionDetail", filePath: el.dataset.detailFile }));
  }
}

function backButton(): string {
  return `<button id="backBtn" class="back">← Back to overview</button>`;
}

function wireBack(): void {
  document.getElementById("backBtn")?.addEventListener("click", () => {
    if (lastPayload) {
      render(lastPayload);
    }
  });
}

function renderDetail(d: SessionDetail): void {
  const app = document.getElementById("app")!;
  const duration =
    d.firstTs && d.lastTs ? `${esc(d.firstTs.slice(0, 16).replace("T", " "))} → ${esc(d.lastTs.slice(11, 16))}` : "";
  const toolMix = Object.entries(d.toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([n, k]) => `${esc(n)} ${k}`)
    .join(" · ");

  app.innerHTML = `
    <div class="detail-head">
      ${backButton()}
      <span class="open" data-file="${esc(d.filePath)}">open raw transcript ↗</span>
    </div>
    <h3 class="detail-title">${esc(d.project)}</h3>
    <div class="stats">
      ${stat("Est. cost", money(d.costUSD))}
      ${stat("Turns", fmt(d.turnCount))}
      ${stat("Cache reuse", pct(d.cacheReadRatio))}
      ${stat("Compactions", fmt(d.compactions.length))}
    </div>
    <div class="tokens">
      <span>model ${esc(d.model ?? "—")}</span>
      ${duration ? `<span>${duration}</span>` : ""}
    </div>
    <div class="tokens">${esc(toolMix)}</div>

    ${
      d.compactions.length
        ? `<section><h4>Compaction events</h4>${d.compactions
            .map(
              (c) =>
                `<div class="mrow"><span class="mcat">after turn ${c.afterTurn}</span>` +
                `<span class="mcount">${fmt(c.preTokens)} → ${fmt(c.postTokens)}</span>` +
                `<span class="mcost">-${fmt(c.droppedTokens)}</span></div>`
            )
            .join("")}</section>`
        : ""
    }

    <section>
      <h4>Tokens per turn</h4>
      <canvas id="detailChart" height="150"></canvas>
    </section>

    <section>
      <h4>Most expensive tool calls</h4>
      <table class="sessions"><thead><tr>
        <th>Tool</th><th>Target</th><th>~Tokens</th><th>Est. $</th><th></th>
      </tr></thead><tbody>
        ${d.topTools.map(toolRow).join("") || `<tr><td colspan="5" class="none">No tool output captured.</td></tr>`}
      </tbody></table>
    </section>`;

  wireBack();
  wireLinks();
  drawDetailChart(d.turns, d.compactions.map((c) => c.afterTurn));
}

function toolRow(t: ToolDetail): string {
  const flag = t.isError ? `<span class="badge err">error</span>` : t.interrupted ? `<span class="badge">interrupted</span>` : "";
  return `<tr>
    <td>${esc(t.name)}</td>
    <td class="proj" title="${esc(t.label ?? "")}">${esc(t.label ?? "—")}</td>
    <td>${fmt(t.estTokens)}</td>
    <td>${t.costUSD >= 0.005 ? money(t.costUSD) : "—"}</td>
    <td>${flag}</td>
  </tr>`;
}

function drawDetailChart(turns: TurnDetail[], compactionTurns: number[]): void {
  const canvas = document.getElementById("detailChart") as HTMLCanvasElement | null;
  if (!canvas) {
    return;
  }
  detailChart?.destroy();
  const fg = cssVar("--vscode-foreground");
  const compactionSet = new Set(compactionTurns);
  detailChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: turns.map((t) => String(t.index + 1)),
      datasets: [
        { label: "cache read", data: turns.map((t) => t.cacheRead), backgroundColor: "#3465a4", stack: "s" },
        { label: "cache write", data: turns.map((t) => t.cacheCreate), backgroundColor: "#c17d11", stack: "s" },
        { label: "input", data: turns.map((t) => t.input), backgroundColor: "#75507b", stack: "s" },
        { label: "output", data: turns.map((t) => t.output), backgroundColor: "#4e9a06", stack: "s" },
        // Compaction markers: a thin overlay bar at turns where a compaction occurred.
        {
          label: "compaction",
          type: "bar",
          data: turns.map((t) => (compactionSet.has(t.index + 1) ? Math.max(...turns.map((x) => x.promptTokens), 1) : 0)),
          backgroundColor: "rgba(241,76,76,0.35)",
          stack: "marker",
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: fg } } },
      scales: {
        x: { stacked: true, ticks: { color: fg, maxTicksLimit: 20 }, title: { display: true, text: "turn", color: fg } },
        y: { stacked: true, ticks: { color: fg }, title: { display: true, text: "tokens", color: fg } },
      },
    },
  });
}

function stat(label: string, value: string): string {
  return `<div class="stat"><div class="val">${esc(value)}</div><div class="lbl">${esc(label)}</div></div>`;
}
function emptyList(msg: string): string {
  return `<div class="none">${esc(msg)}</div>`;
}

function findingCard(f: Finding, payload: DashboardPayload): string {
  const file = f.sessionId ? payload.sessionFiles[f.sessionId] : undefined;
  const cost = f.wastedUSD && f.wastedUSD >= 0.005 ? `<span class="cost">~${money(f.wastedUSD)}</span>` : "";
  const openHint = file
    ? `<span class="links"><span class="open" data-detail-file="${esc(file)}">details</span> · <span class="open" data-file="${esc(file)}">raw ↗</span></span>`
    : "";
  return `<div class="finding sev-${esc(f.severity)}">
    <div class="fhead"><span class="badge">${esc(f.severity)}</span><span class="fcat">${esc(f.category)}</span><span class="ftitle">${esc(f.title)}</span>${cost}</div>
    <div class="fdetail">${esc(f.detail)}</div>
    <div class="ffix"><strong>Fix:</strong> ${esc(f.fix)}</div>
    ${f.project ? `<div class="fmeta">${esc(f.project)}${openHint}</div>` : openHint ? `<div class="fmeta">${openHint}</div>` : ""}
  </div>`;
}

function sessionRow(s: SessionSummary, payload: DashboardPayload): string {
  const file = payload.sessionFiles[s.sessionId];
  const actions = file
    ? `<span class="open" data-detail-file="${esc(file)}">details</span> · <span class="open" data-file="${esc(file)}">raw ↗</span>`
    : "";
  return `<tr>
    <td class="proj" title="${esc(s.project)}">${esc(s.project)}</td>
    <td>${esc(s.model ?? "—")}</td>
    <td>${fmt(s.turns)}</td>
    <td>${pct(s.cacheReadRatio)}</td>
    <td>${fmt(s.compactions)}</td>
    <td>${money(s.costUSD)}</td>
    <td class="actions">${actions}</td>
  </tr>`;
}

function cssVar(name: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || "#888";
}

function drawSavingsChart(sv: SavingsReport): void {
  const canvas = document.getElementById("savingsChart") as HTMLCanvasElement | null;
  if (!canvas) {
    return;
  }
  savingsChart?.destroy();
  const fg = cssVar("--vscode-foreground");
  const rows = sv.byCost.filter((c) => c.wastedUSD >= 0.005 || c.wastedTokens > 0).slice(0, 8);
  savingsChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: rows.map((r) => r.category),
      datasets: [
        { label: "Est. recoverable $", data: rows.map((r) => Number(r.wastedUSD.toFixed(4))), backgroundColor: "#c17d11" },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      plugins: { legend: { labels: { color: fg } } },
      scales: { x: { ticks: { color: fg } }, y: { ticks: { color: fg } } },
    },
  });
}

function drawTrendChart(t: TrendReport): void {
  const canvas = document.getElementById("trendChart") as HTMLCanvasElement | null;
  if (!canvas) {
    return;
  }
  trendChart?.destroy();
  const fg = cssVar("--vscode-foreground");
  const s = t.series;
  trendChart = new Chart(canvas, {
    data: {
      labels: s.map((d) => d.date),
      datasets: [
        {
          type: "line",
          label: "Cache reuse %",
          yAxisID: "y",
          data: s.map((d) => Number((d.cacheReadRatio * 100).toFixed(1))),
          borderColor: "#3465a4",
          backgroundColor: "#3465a4",
          tension: 0.25,
          pointRadius: 2,
        },
        {
          type: "bar",
          label: "Cost / day ($)",
          yAxisID: "y1",
          data: s.map((d) => Number(d.costUSD.toFixed(4))),
          backgroundColor: "rgba(78,154,6,0.5)",
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: fg } } },
      scales: {
        x: { ticks: { color: fg } },
        y: { position: "left", min: 0, max: 100, title: { display: true, text: "cache %", color: fg }, ticks: { color: fg } },
        y1: { position: "right", min: 0, title: { display: true, text: "$/day", color: fg }, ticks: { color: fg }, grid: { drawOnChartArea: false } },
      },
    },
  });
}

function drawToolChart(toolCounts: Record<string, number>): void {
  const canvas = document.getElementById("toolChart") as HTMLCanvasElement | null;
  if (!canvas) {
    return;
  }
  toolChart?.destroy();
  const fg = cssVar("--vscode-foreground");
  const entries = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
  toolChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: entries.map((e) => e[0]),
      datasets: [{ label: "Tool calls", data: entries.map((e) => e[1]), backgroundColor: "#3465a4" }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      plugins: { legend: { labels: { color: fg } } },
      scales: { x: { ticks: { color: fg } }, y: { ticks: { color: fg } } },
    },
  });
}
