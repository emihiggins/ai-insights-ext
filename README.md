# Claude Code Token Optimizer

A VS Code extension that reads your local Claude Code session transcripts, analyzes token economics (usage, cache hits/misses, prompt length, context compaction, tool/search behavior), and surfaces **concrete recommendations** for reducing token spend and using the agent more efficiently.

Everything runs locally — it only reads the JSONL transcripts Claude Code already writes to `~/.claude/projects/`. No data leaves your machine, and nothing is sent to any service.

> v1 covers **Claude Code only**. GitHub Copilot's local session files don't record token counts (that data lives server-side), so Copilot analysis is intentionally out of scope for now.

## What it detects

The recommendations engine flags, each from a real transcript trigger with an explicit token/cost estimate:

- **Context compactions** — each auto-compaction drops a large chunk of context (lossy) and re-primes a cold cache prefix. Reported per occurrence with the tokens dropped.
- **Context pressure** — a session whose peak prompt size reaches ≥80% of the model's context window is about to auto-compact; flagged as a preventive warning before it happens.
- **Broad / unscoped searches** — `grep`/`rg`/`find` run as Bash commands that dump large output into context, or that search the whole tree (`rg <pattern>` with no path) when a path was likely known.
- **Large command output** — non-search Bash commands (`cat`, `git diff`, `git log`, verbose test runs) that dump uncapped output with no `head`/`tail`/`--stat` limiter.
- **Oversized / repeated reads** — the same file read many times, or a single huge read where a line range would do.
- **Read after edit** — reading a file back immediately after Writing/Editing it, when the edit already returned the current content.
- **Redundant commands** — the exact same read-only inspection command (grep/cat/ls/`git status|log|diff`) re-run in a session (test/build re-runs are deliberately not flagged).
- **Failed / interrupted tool calls** — errored or interrupted calls whose output was billed and then discarded (usually followed by a retry that pays again).
- **Low cache reuse** — sessions that write a lot of cache but read little back, the signature of a volatile prompt prefix invalidating the cache (writes cost 1.25×–2× input; reads cost ~0.1×).
- **Inefficient round-trips** — repeated turns with a large prompt but tiny output.

Findings are grouped into **one-off fixes** (specific to a session, click to open the transcript) and **habits** (patterns worth changing across sessions), each tagged with its mistake category.

### Potential savings dashboard

At the top of the view, a **Potential savings** panel shows the estimated recoverable dollars and tokens, the share of total spend that is recoverable waste, a bar chart of recoverable cost by mistake category, and a **most common mistakes** ranking (by frequency). Below it: token totals, estimated cost, cache-reuse %, tool-usage chart, and your most expensive sessions. A status-bar item shows live token spend and cache reuse for the most recent session.

### Trends & regression alerts

The extension tracks a daily efficiency series (cache-reuse %, cost/day, compactions, active sessions) derived from your transcripts and persisted to VS Code's global storage, so history survives restarts and outlives transcript pruning. An **Efficiency over time** chart plots cache-reuse % against cost/day, and a **regression banner** appears when the most recent 7 days degrade versus the prior 7 — a cache-reuse drop, a cost-per-session rise, or more sessions compacting. Regressions also raise a warning badge on the status-bar item.

To avoid false alarms, regressions only fire when **both** comparison windows have enough data (≥3 active sessions and ≥20k tokens each); sparse or gappy history produces the chart but no alerts.

### Per-session drill-down

Click **details** on any row in the *most expensive sessions* table (or on any finding) to open a drill-down for that one session — parsed on demand, so the main payload stays small. It shows a **tokens-per-turn** stacked bar chart (input / output / cache-read / cache-write) with compaction points marked, a **compaction-events** list, and the **most expensive tool calls** ranked by token footprint with their exact target (the command, or the file path) and error/interrupt badges. This is the "where did this $175 session actually go?" view — it typically points straight at a handful of oversized reads or searches.

> The numbers are honest: on an already-efficient setup (high cache-read ratio), recoverable waste can legitimately be a small fraction of spend even when the behavioral patterns (broad searches, repeated reads) are worth changing.

## Cost model

Costs are **estimates** (Claude Code's local stats report `costUSD: 0`). Rates are per 1M tokens — Opus $5/$25, Sonnet $3/$15, Haiku $1/$5 — with cache reads billed at 0.1× input and cache writes at 1.25× (5-min TTL) / 2× (1-hour TTL). Adjust the rate table in `src/pricing.ts` if your pricing differs.

## Install

Grab the packaged extension and install it into VS Code:

```bash
npm install
npm run package     # produces claude-code-token-optimizer.vsix
code --install-extension claude-code-token-optimizer.vsix
```

Then reload VS Code and open the **CC Token Optimizer** view in the Activity Bar. (You can also install via the Extensions view → "…" menu → *Install from VSIX…*.) The `.vsix` is self-contained — `chokidar` and Chart.js are bundled at build time, so no runtime `node_modules` ship with it.

## Develop / run

```bash
npm install
npm run build       # bundles the extension host + webview (esbuild)
npm test            # typecheck + unit tests (38 tests across parser/model/pricing/rules/trends/detail)
npm run package     # build a .vsix (runs the minified prepublish build)
```

Press **F5** in VS Code to launch the Extension Development Host, then open the **CC Token Optimizer** view in the Activity Bar. The dashboard populates from `~/.claude/projects/` and refreshes automatically as Claude Code appends to transcripts.

> Before publishing to a marketplace, update the `publisher` and `repository` fields in `package.json` to your own — the current values are placeholders for local packaging.

## Settings

- `ccOptimizer.claudeHome` — override the Claude home directory (defaults to `~/.claude`).
- `ccOptimizer.largeSearchOutputBytes` — output size (chars) above which a search is flagged as large (default 20000).
- `ccOptimizer.lowCacheRatioThreshold` — cache-read ratio below which a session is flagged (default 0.5).

## Architecture

```
src/
  parser.ts       streaming JSONL reader + typed line schema
  model.ts        folds lines into a SessionModel (usage, tools, compactions)
  discovery.ts    locate ~/.claude/projects, enumerate + load transcripts
  pricing.ts      model-id -> rates, cost estimation
  aggregates.ts   cross-session/per-session dashboard metrics
  rules/          recommendation engine (one file per rule, 10 rules)
  savings.ts      rolls findings into recoverable tokens/$ by category
  trends.ts       daily efficiency series + windowed regression detection
  trendStore.ts   persists the daily series in globalState (durable history)
  detail.ts       per-session drill-down (turn timeline, top tools, compactions)
  service.ts      analyze() (overview) + loadSessionDetail() (one session)
  watcher.ts      chokidar watch on the Claude home (outside the workspace)
  statusBar.ts    live status-bar item
  webview/        WebviewViewProvider + bundled Chart.js dashboard
```

The data layer (`parser`/`model`/`pricing`/`aggregates`/`rules`/`discovery`/`service`) has no `vscode` dependency and is unit-tested against fixtures and a temp `~/.claude` tree.
