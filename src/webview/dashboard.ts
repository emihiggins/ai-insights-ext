/**
 * Webview client. Bundled to dist/webview.js by esbuild (browser platform).
 * Chart.js is bundled in — no CDN, CSP-safe. Type-only imports of host modules
 * are erased at build time; `names` is pure and bundled in.
 */
import { Chart, registerables } from "chart.js";
import type { DashboardPayload, AnalysisFilter } from "../service";
import type { Finding } from "../rules/index";
import type { SessionSummary } from "../aggregates";
import type { SavingsReport } from "../savings";
import type { TrendReport } from "../trends";
import type { SessionDetail, TurnDetail, ToolDetail } from "../detail";
import { modelLabel } from "../names";

Chart.register(...registerables);

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

/** UI state that survives re-renders and the webview being hidden. */
interface UiState {
  /** Finding group id -> explicitly opened (true) or closed (false). */
  groups: Record<string, boolean>;
  /** Finding groups showing all cards instead of the first few. */
  expanded: string[];
}

const vscode = acquireVsCodeApi();
const ui: UiState = { groups: {}, expanded: [], ...((vscode.getState() as Partial<UiState> | undefined) ?? {}) };
const saveUi = (): void => vscode.setState(ui);

const charts = new Map<string, Chart>();
let lastPayload: DashboardPayload | undefined;
/** Set while a session drill-down is open, so live updates don't kick the user out. */
let detailOpen = false;

const CARDS_PER_GROUP = 5;
const SNOOZE_DAYS = 7;

window.addEventListener("message", (event: MessageEvent) => {
  const msg = event.data as {
    command: string;
    payload?: DashboardPayload;
    detail?: SessionDetail;
    message?: string;
  };
  if (msg.command === "data" && msg.payload) {
    lastPayload = msg.payload;
    if (detailOpen) {
      const note = document.getElementById("staleNote");
      if (note) {
        note.textContent = "Overview updated";
      }
    } else {
      render(msg.payload);
    }
  } else if (msg.command === "sessionDetail" && msg.detail) {
    renderDetail(msg.detail);
  } else if (msg.command === "sessionDetailError") {
    detailOpen = true;
    app().innerHTML = `<div class="empty"><h2>Could not load session</h2><p>${esc(msg.message ?? "")}</p>${backButton()}</div>`;
  }
});

// One delegated listener for every button, so re-renders never need re-wiring.
document.addEventListener("click", (event) => {
  const el = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!el) {
    return;
  }
  const { action, file, key, group } = el.dataset;
  switch (action) {
    case "refresh":
      vscode.postMessage({ command: "refresh" });
      break;
    case "open-editor":
      vscode.postMessage({ command: "openInEditor" });
      break;
    case "raw":
      vscode.postMessage({ command: "openTranscript", filePath: file });
      break;
    case "detail":
      vscode.postMessage({ command: "sessionDetail", filePath: file });
      break;
    case "dismiss":
      vscode.postMessage({ command: "dismiss", key });
      break;
    case "snooze":
      vscode.postMessage({ command: "dismiss", key, days: SNOOZE_DAYS });
      break;
    case "restore":
      vscode.postMessage({ command: "restoreDismissed" });
      break;
    case "show-more":
      if (group && !ui.expanded.includes(group)) {
        ui.expanded.push(group);
        saveUi();
        rerender();
      }
      break;
    case "back":
      detailOpen = false;
      rerender();
      break;
  }
});

document.addEventListener("change", (event) => {
  const el = event.target as HTMLSelectElement;
  if (el.id !== "rangeFilter" && el.id !== "projectFilter") {
    return;
  }
  const range = (document.getElementById("rangeFilter") as HTMLSelectElement | null)?.value ?? "";
  const project = (document.getElementById("projectFilter") as HTMLSelectElement | null)?.value ?? "";
  const filter: AnalysisFilter = {
    rangeDays: range ? Number(range) : undefined,
    project: project || undefined,
  };
  vscode.postMessage({ command: "setFilter", filter });
});

// <details> toggle events don't bubble; capture them to remember open groups.
document.addEventListener(
  "toggle",
  (event) => {
    const el = event.target as HTMLDetailsElement;
    if (el.dataset?.group) {
      ui.groups[el.dataset.group] = el.open;
      saveUi();
    }
  },
  true
);

vscode.postMessage({ command: "ready" });

function app(): HTMLElement {
  return document.getElementById("app")!;
}

function rerender(): void {
  if (lastPayload) {
    render(lastPayload);
  }
}

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

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
}

/** Chart colors from the active theme, so charts follow light/dark/high-contrast. */
function palette() {
  return {
    fg: cssVar("--vscode-foreground", "#888"),
    grid: cssVar("--vscode-panel-border", "rgba(128,128,128,0.2)"),
    blue: cssVar("--vscode-charts-blue", "#3794ff"),
    orange: cssVar("--vscode-charts-orange", "#d18616"),
    purple: cssVar("--vscode-charts-purple", "#b180d7"),
    green: cssVar("--vscode-charts-green", "#89d185"),
    red: cssVar("--vscode-charts-red", "#f14c4c"),
  };
}

function projectLabel(payload: DashboardPayload, project: string | undefined): string {
  if (!project) {
    return "";
  }
  return payload.projects.find((p) => p.project === project)?.label ?? project;
}

function render(payload: DashboardPayload): void {
  const root = app();
  const scrollY = window.scrollY;
  for (const chart of charts.values()) {
    chart.destroy();
  }
  charts.clear();

  if (!payload.found) {
    root.innerHTML = `<div class="empty"><h2>No Claude Code data found</h2>
      <p>Looked in <code>${esc(payload.claudeHome)}/projects</code>. Run a Claude Code session, then Refresh.</p></div>`;
    return;
  }
  const a = payload.aggregates;
  const filtered = payload.filter.rangeDays !== undefined || payload.filter.project !== undefined;

  root.innerHTML = `
    <header>
      ${filterBar(payload)}
      ${
        a.sessionCount === 0 && a.subagentCount === 0
          ? ""
          : `<div class="stats">
        ${stat(a.subagentCount ? `Sessions (+${fmt(a.subagentCount)} subagents)` : "Sessions", fmt(a.sessionCount))}
        ${stat("API-equiv. cost", money(a.totalCostUSD), "Estimated at API list prices. Pro/Max subscriptions aren't billed per token — read this as what the usage would cost on the API.")}
        ${stat("Cache reuse", pct(a.cacheReadRatio))}
        ${stat("Compactions", fmt(a.compactionCount))}
      </div>
      <div class="tokens">
        <span title="Uncached input">in ${fmt(a.totals.input)}</span>
        <span title="Output">out ${fmt(a.totals.output)}</span>
        <span title="Cache writes (1.25x input for 5-min TTL, 2x for 1-hour)">cache-write ${fmt(a.totals.cacheCreate)}</span>
        <span title="Cache reads (~0.1x input; less on Fable 5.1 / Opus 5.5)">cache-read ${fmt(a.totals.cacheRead)}</span>
      </div>`
      }
      <div class="refresh">
        <button data-action="refresh">Refresh</button>
        <button class="secondary" data-action="open-editor" title="Open the dashboard in an editor tab">Open in editor</button>
        <span class="ts">updated ${esc(payload.generatedAt.replace("T", " ").slice(0, 19))} · prices as of ${esc(payload.pricingAsOf)}</span>
      </div>
    </header>

    ${
      a.sessionCount === 0 && a.subagentCount === 0
        ? `<div class="empty"><h2>No sessions ${filtered ? "match this filter" : "with usage yet"}</h2>
           <p>${filtered ? "Try a wider time range or all projects." : `Found <code>${esc(payload.claudeHome)}/projects</code> but no analyzable transcripts.`}</p></div>`
        : `
    ${regressionBanner(payload.trends)}
    ${savingsSection(payload.savings)}
    ${trendsSection(payload.trends, payload)}
    ${findingsSection("one-off", "Recommendations — one-off fixes", payload.results.oneOffs, payload, "No one-off issues detected.")}
    ${findingsSection("habit", "Recommendations — habits", payload.results.habits, payload, "No recurring habits detected.")}
    ${
      payload.dismissedCount
        ? `<div class="dismissed">${fmt(payload.dismissedCount)} finding${payload.dismissedCount === 1 ? "" : "s"} hidden · <button class="link" data-action="restore">Restore all</button></div>`
        : ""
    }
    <section>
      <h3>Tool usage</h3>
      <canvas id="toolChart" height="140" role="img" aria-label="Tool calls by tool"></canvas>
    </section>
    <section>
      <h3>Most expensive sessions</h3>
      <table class="sessions"><thead><tr>
        <th scope="col">Session</th><th scope="col">Model</th><th scope="col">Turns</th><th scope="col">Cache</th><th scope="col">Compact</th><th scope="col">Est. $</th><th scope="col"><span class="sr-only">Actions</span></th>
      </tr></thead><tbody>
        ${a.sessions.slice(0, 15).map((s) => sessionRow(s, payload)).join("")}
      </tbody></table>
    </section>`
    }`;

  if (a.sessionCount > 0 || a.subagentCount > 0) {
    drawSavingsChart(payload.savings);
    drawTrendChart(payload.trends);
    drawToolChart(a.toolCounts);
  }
  window.scrollTo(0, scrollY);
}

function filterBar(payload: DashboardPayload): string {
  const range = payload.filter.rangeDays;
  const ranges: Array<[string, string]> = [
    ["1", "Today"],
    ["7", "Last 7 days"],
    ["30", "Last 30 days"],
    ["", "All time"],
  ];
  const rangeOpts = ranges
    .map(([v, label]) => `<option value="${v}"${String(range ?? "") === v ? " selected" : ""}>${label}</option>`)
    .join("");
  const projectOpts = [
    `<option value=""${payload.filter.project ? "" : " selected"}>All projects</option>`,
    ...payload.projects.map(
      (p) =>
        `<option value="${esc(p.project)}"${payload.filter.project === p.project ? " selected" : ""}>` +
        `${esc(p.label)}${p.inWorkspace ? " (this workspace)" : ""} · ${p.sessionCount}</option>`
    ),
  ].join("");
  return `<div class="filters">
    <label>Range <select id="rangeFilter">${rangeOpts}</select></label>
    <label>Project <select id="projectFilter">${projectOpts}</select></label>
  </div>`;
}

function regressionBanner(t: TrendReport): string {
  if (!t.regressions.length) {
    return "";
  }
  const items = t.regressions
    .map(
      (r) =>
        `<li class="reg-${esc(r.severity)}"><span class="badge${r.severity === "high" ? " err" : ""}">${esc(r.severity)}</span> ` +
        `<strong>${esc(r.title)}</strong> — ${esc(r.detail)}</li>`
    )
    .join("");
  return `<section class="regressions" role="alert">
    <div class="reg-head">⚠ ${t.regressions.length} efficiency regression${t.regressions.length === 1 ? "" : "s"} vs the prior ${t.windowDays} days</div>
    <ul>${items}</ul>
  </section>`;
}

function trendsSection(t: TrendReport, payload: DashboardPayload): string {
  // Need at least a few days of history for a meaningful line.
  if (t.series.length < 2) {
    return "";
  }
  const scope = payload.filter.project ? projectLabel(payload, payload.filter.project) : "all projects";
  return `<section>
    <h3>Efficiency over time <span class="muted">(${esc(scope)}, all dates)</span></h3>
    <canvas id="trendChart" height="150" role="img" aria-label="Cache reuse percentage and cost per day"></canvas>
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
      ${topCost.length ? `<canvas id="savingsChart" height="140" role="img" aria-label="Recoverable cost by mistake category"></canvas>` : `<div class="none">No recoverable waste detected — nice.</div>`}
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

/** Findings grouped by category, biggest dollar impact first, each group collapsible. */
function findingsSection(scope: string, heading: string, findings: Finding[], payload: DashboardPayload, empty: string): string {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = groups.get(f.category) ?? [];
    list.push(f);
    groups.set(f.category, list);
  }
  const usd = (list: Finding[]): number => list.reduce((sum, f) => sum + (f.wastedUSD ?? 0), 0);
  const ordered = [...groups.entries()].sort((x, y) => usd(y[1]) - usd(x[1]) || y[1].length - x[1].length);

  const body = ordered
    .map(([category, list], idx) => {
      const id = `${scope}:${category}`;
      // Default: the top group starts open; afterwards the user's choice sticks.
      const open = ui.groups[id] ?? idx === 0;
      const showAll = ui.expanded.includes(id);
      const shown = showAll ? list : list.slice(0, CARDS_PER_GROUP);
      const total = usd(list);
      const more =
        list.length > shown.length
          ? `<button class="link more" data-action="show-more" data-group="${esc(id)}">Show ${list.length - shown.length} more</button>`
          : "";
      return `<details class="group" data-group="${esc(id)}"${open ? " open" : ""}>
        <summary><span class="gname">${esc(category)}</span><span class="gcount">${list.length}</span>${total >= 0.005 ? `<span class="cost">~${money(total)}</span>` : ""}</summary>
        ${shown.map((f) => findingCard(f, payload)).join("")}
        ${more}
      </details>`;
    })
    .join("");

  return `<section>
    <h3>${esc(heading)} (${findings.length})</h3>
    ${body || emptyList(empty)}
  </section>`;
}

function findingCard(f: Finding, payload: DashboardPayload): string {
  const file = f.sessionId ? payload.sessionFiles[f.sessionId] : undefined;
  const cost = f.wastedUSD && f.wastedUSD >= 0.005 ? `<span class="cost">~${money(f.wastedUSD)}</span>` : "";
  const links = file
    ? `<button class="link" data-action="detail" data-file="${esc(file)}">Details</button>` +
      `<button class="link" data-action="raw" data-file="${esc(file)}">Raw ↗</button>`
    : "";
  const key = f.key ? esc(f.key) : "";
  const actions = key
    ? `<button class="link" data-action="snooze" data-key="${key}" title="Hide for ${SNOOZE_DAYS} days">Snooze ${SNOOZE_DAYS}d</button>` +
      `<button class="link" data-action="dismiss" data-key="${key}" title="Hide permanently">Dismiss</button>`
    : "";
  return `<div class="finding sev-${esc(f.severity)}">
    <div class="fhead"><span class="badge">${esc(f.severity)}</span><span class="ftitle">${esc(f.title)}</span>${cost}</div>
    <div class="fdetail">${esc(f.detail)}</div>
    <div class="ffix"><strong>Fix:</strong> ${esc(f.fix)}</div>
    <div class="fmeta"><span>${esc(projectLabel(payload, f.project))}</span><span class="links">${links}${actions}</span></div>
  </div>`;
}

function sessionRow(s: SessionSummary, payload: DashboardPayload): string {
  const file = payload.sessionFiles[s.sessionId];
  const actions = file
    ? `<button class="link" data-action="detail" data-file="${esc(file)}">Details</button>` +
      `<button class="link" data-action="raw" data-file="${esc(file)}">Raw ↗</button>`
    : "";
  const project = projectLabel(payload, s.project);
  const name = s.title ?? project;
  return `<tr>
    <td class="proj" title="${esc(name)}">
      <div class="sname">${s.parentSessionId ? `<span class="badge">subagent</span> ` : ""}${esc(name)}</div>
      ${s.title ? `<div class="ssub">${esc(project)}</div>` : ""}
    </td>
    <td title="${esc(s.model ?? "")}">${esc(modelLabel(s.model))}</td>
    <td>${fmt(s.turns)}</td>
    <td>${pct(s.cacheReadRatio)}</td>
    <td>${fmt(s.compactions)}</td>
    <td>${money(s.costUSD)}</td>
    <td class="actions">${actions}</td>
  </tr>`;
}

function backButton(): string {
  return `<button class="back" data-action="back">← Back to overview</button>`;
}

function renderDetail(d: SessionDetail): void {
  detailOpen = true;
  for (const chart of charts.values()) {
    chart.destroy();
  }
  charts.clear();
  const project = lastPayload ? projectLabel(lastPayload, d.project) : d.project;
  const duration =
    d.firstTs && d.lastTs ? `${esc(d.firstTs.slice(0, 16).replace("T", " "))} → ${esc(d.lastTs.slice(11, 16))}` : "";
  const toolMix = Object.entries(d.toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([n, k]) => `${esc(n)} ${k}`)
    .join(" · ");

  app().innerHTML = `
    <div class="detail-head">
      ${backButton()}
      <span class="muted" id="staleNote"></span>
      <button class="link" data-action="raw" data-file="${esc(d.filePath)}">Open raw transcript ↗</button>
    </div>
    <h3 class="detail-title">${d.parentSessionId ? `<span class="badge">subagent</span> ` : ""}${esc(d.title ?? project)}</h3>
    ${d.title ? `<div class="tokens">${esc(project)}</div>` : ""}
    <div class="stats">
      ${stat("API-equiv. cost", money(d.costUSD))}
      ${stat("Turns", fmt(d.turnCount))}
      ${stat("Cache reuse", pct(d.cacheReadRatio))}
      ${stat("Compactions", fmt(d.compactions.length))}
    </div>
    <div class="tokens">
      <span title="${esc(d.model ?? "")}">model ${esc(modelLabel(d.model))}</span>
      ${duration ? `<span>${duration}</span>` : ""}
      <span title="Calibrated from how much each tool result grew the next prompt">~${d.charsPerToken.toFixed(1)} chars/token</span>
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
      <canvas id="detailChart" height="150" role="img" aria-label="Tokens per turn by type"></canvas>
    </section>

    <section>
      <h4>Most expensive tool calls</h4>
      <table class="sessions"><thead><tr>
        <th scope="col">Tool</th><th scope="col">Target</th><th scope="col">~Tokens</th><th scope="col">Est. $</th><th scope="col"><span class="sr-only">Status</span></th>
      </tr></thead><tbody>
        ${d.topTools.map(toolRow).join("") || `<tr><td colspan="5" class="none">No tool output captured.</td></tr>`}
      </tbody></table>
    </section>`;

  window.scrollTo(0, 0);
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

function stat(label: string, value: string, title?: string): string {
  return `<div class="stat"${title ? ` title="${esc(title)}"` : ""}><div class="val">${esc(value)}</div><div class="lbl">${esc(label)}</div></div>`;
}
function emptyList(msg: string): string {
  return `<div class="none">${esc(msg)}</div>`;
}

function axis(c: ReturnType<typeof palette>, extra: Record<string, unknown> = {}) {
  return { ticks: { color: c.fg }, grid: { color: c.grid }, ...extra };
}

function drawDetailChart(turns: TurnDetail[], compactionTurns: number[]): void {
  const canvas = document.getElementById("detailChart") as HTMLCanvasElement | null;
  if (!canvas) {
    return;
  }
  const c = palette();
  const compactionSet = new Set(compactionTurns);
  const peak = Math.max(...turns.map((x) => x.promptTokens), 1);
  charts.set(
    "detail",
    new Chart(canvas, {
      type: "bar",
      data: {
        labels: turns.map((t) => String(t.index + 1)),
        datasets: [
          { label: "cache read", data: turns.map((t) => t.cacheRead), backgroundColor: c.blue, stack: "s" },
          { label: "cache write", data: turns.map((t) => t.cacheCreate), backgroundColor: c.orange, stack: "s" },
          { label: "input", data: turns.map((t) => t.input), backgroundColor: c.purple, stack: "s" },
          { label: "output", data: turns.map((t) => t.output), backgroundColor: c.green, stack: "s" },
          // Compaction markers: a full-height translucent bar at turns where a compaction occurred.
          {
            label: "compaction",
            type: "bar",
            data: turns.map((t) => (compactionSet.has(t.index + 1) ? peak : 0)),
            backgroundColor: withAlpha(c.red, 0.35),
            stack: "marker",
          },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: c.fg } } },
        scales: {
          x: axis(c, { stacked: true, ticks: { color: c.fg, maxTicksLimit: 20 }, title: { display: true, text: "turn", color: c.fg } }),
          y: axis(c, { stacked: true, title: { display: true, text: "tokens", color: c.fg } }),
        },
      },
    })
  );
}

/** Apply alpha to a theme color (hex or rgb[a]) for translucent overlays. */
function withAlpha(color: string, alpha: number): string {
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  return color;
}

function drawSavingsChart(sv: SavingsReport): void {
  const canvas = document.getElementById("savingsChart") as HTMLCanvasElement | null;
  if (!canvas) {
    return;
  }
  const c = palette();
  const rows = sv.byCost.filter((r) => r.wastedUSD >= 0.005 || r.wastedTokens > 0).slice(0, 8);
  charts.set(
    "savings",
    new Chart(canvas, {
      type: "bar",
      data: {
        labels: rows.map((r) => r.category),
        datasets: [{ label: "Est. recoverable $", data: rows.map((r) => Number(r.wastedUSD.toFixed(4))), backgroundColor: c.orange }],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        plugins: { legend: { display: false } },
        // Show every category label; autoskip drops alternate rows in a narrow sidebar.
        scales: { x: axis(c), y: axis(c, { ticks: { color: c.fg, autoSkip: false } }) },
      },
    })
  );
}

function drawTrendChart(t: TrendReport): void {
  const canvas = document.getElementById("trendChart") as HTMLCanvasElement | null;
  if (!canvas) {
    return;
  }
  const c = palette();
  const s = t.series;
  charts.set(
    "trend",
    new Chart(canvas, {
      data: {
        labels: s.map((d) => d.date),
        datasets: [
          {
            type: "line",
            label: "Cache reuse %",
            yAxisID: "y",
            data: s.map((d) => Number((d.cacheReadRatio * 100).toFixed(1))),
            borderColor: c.blue,
            backgroundColor: c.blue,
            tension: 0.25,
            pointRadius: 2,
          },
          {
            type: "bar",
            label: "Cost / day ($)",
            yAxisID: "y1",
            data: s.map((d) => Number(d.costUSD.toFixed(4))),
            backgroundColor: withAlpha(c.green, 0.5),
          },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: c.fg } } },
        scales: {
          x: axis(c),
          y: axis(c, { position: "left", min: 0, max: 100, title: { display: true, text: "cache %", color: c.fg } }),
          y1: axis(c, { position: "right", min: 0, title: { display: true, text: "$/day", color: c.fg }, grid: { drawOnChartArea: false } }),
        },
      },
    })
  );
}

function drawToolChart(toolCounts: Record<string, number>): void {
  const canvas = document.getElementById("toolChart") as HTMLCanvasElement | null;
  if (!canvas) {
    return;
  }
  const c = palette();
  const entries = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
  charts.set(
    "tools",
    new Chart(canvas, {
      type: "bar",
      data: {
        labels: entries.map((e) => e[0]),
        datasets: [{ label: "Tool calls", data: entries.map((e) => e[1]), backgroundColor: c.blue }],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        plugins: { legend: { labels: { color: c.fg } } },
        scales: { x: axis(c), y: axis(c) },
      },
    })
  );
}
