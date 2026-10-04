# Changelog

## 0.2.0

Accuracy fixes — token and cost figures were overstated by roughly 2x.

- **Usage is counted once per response.** Claude Code writes one transcript line per content block, each repeating the response's usage; these were all summed.
- **Per-model pricing for current models.** Opus 5.5 ($4/$20), Sonnet 5.5 / 5 ($2/$10), Fable 5.1 cache reads ($0.25), Mythos, and legacy Opus 4 / 4.1 and Haiku 3.x now have their own rates instead of a per-family price. Fast-mode turns are billed at fast-mode rates, and Bedrock / Vertex model ids resolve to the same table.
- **Each turn is priced at the model it used**, so sessions that switch models mid-way are no longer priced entirely at the dominant model.
- **Tool output is measured by what entered context.** Large outputs Claude Code saved to disk were counted at full size instead of the short preview the model actually saw.
- **Subagent transcripts are included** (`<session>/subagents/agent-*.jsonl`), shown in the sessions table with a subagent badge and counted separately from top-level sessions.
- Trend history restarts (storage key `v2`), since history saved by earlier versions carries the inflated figures.
- The dashboard shows the date the built-in price table was last checked.

Fewer false positives.

- **Searches:** `… | grep x` filters and `xargs grep` are no longer counted as searches, and `--include` / `-g` / `-t` filters count as scope. Unscoped searches are only flagged when they return meaningful output. The dedicated `Grep` / `Glob` tools are now covered. On real data this cut search findings from 161 to 6.
- **Repeated reads** are grouped by file *and* range, so paging through a file isn't flagged.
- **Read after edit is now read after write.** Edits return only a snippet, so reading afterwards is legitimate. Ranged reads, and reads after a Bash command that may have changed the file, are also excluded.
- **Large-output limiters** recognise `| grep`, `| jq`, `--oneline`, `-n N` and similar.
- **Token estimates** use a per-session chars-per-token ratio calibrated from actual prompt growth, instead of a fixed 4. Current models measure ~2.3, so waste was previously underestimated.
- **Low cache reuse:** the cost estimate splits by cache TTL, and the default threshold rises from 0.5 to 0.8.

New detectors.

- **Cache expired while idle** — pauses longer than the cache lifetime followed by a full context rewrite.
- **Large fixed overhead** — projects whose sessions start with ≥45k tokens of system prompt, tool, MCP and CLAUDE.md context.
- **Model choice** — recent sessions on an older Opus once Opus 5.5 is in use, and short sessions on Fable.
- **Fast mode** — the premium over standard speed.

Dashboard.

- **Filters:** range (today / 7 / 30 days / all) and project, defaulting to the current workspace's project.
- **Grouped findings** by category, collapsible, with *Show more*, plus snooze (7 days) and dismiss with restore-all.
- **Readable names:** project folder names, session titles and short model names.
- **Sessions table fits the sidebar:** click a session's name to open its drill-down, which links to the raw transcript.
- **Open in editor** as a full-width tab.
- **Theme-aware charts**, keyboard-accessible buttons, and a less spammy error popup with an output-channel log.
- **Live updates** keep scroll position and an open drill-down. Hidden views catch up when shown, and only changed transcripts are re-parsed.
- **Status bar** shows the latest session's context fill and cost, and warns near auto-compaction.
- **Lighter memory use:** large tool inputs (file bodies) are no longer kept in memory.

## 0.1.1

- Packaging fix: local `.claude/` settings are no longer included in the `.vsix` (0.1.0 shipped `.claude/settings.local.json` by mistake).

## 0.1.0

Initial release.

- Reads local Claude Code transcripts (`~/.claude/projects/**/*.jsonl`) and analyzes token economics — usage, cache hits/misses, prompt length, context compaction, and tool/search behavior. All local; nothing leaves the machine.
- **Recommendations engine** (10 rules): context compaction, context pressure, broad/unscoped searches, large command output, oversized/repeated reads, read-after-edit, redundant commands, failed/interrupted tool calls, low cache reuse, and inefficient round-trips. Findings are split into one-off fixes and habits, each with an estimated token/cost impact.
- **Potential savings dashboard**: recoverable tokens/dollars, waste as a share of spend, recoverable cost by mistake category, and a most-common-mistakes ranking.
- **Trends & regression alerts**: a daily efficiency series (persisted to global storage) with a cache-reuse/cost chart, plus regression detection comparing the last 7 days to the prior 7 (guarded against sparse-window noise).
- **Per-session drill-down**: turn-by-turn token/cost timeline with compaction markers and the most expensive tool calls for a single session.
- Live status-bar item showing token spend, cache reuse, and a regression badge.
