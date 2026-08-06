# Changelog

## 0.1.0

Initial release.

- Reads local Claude Code transcripts (`~/.claude/projects/**/*.jsonl`) and analyzes token economics — usage, cache hits/misses, prompt length, context compaction, and tool/search behavior. All local; nothing leaves the machine.
- **Recommendations engine** (10 rules): context compaction, context pressure, broad/unscoped searches, large command output, oversized/repeated reads, read-after-edit, redundant commands, failed/interrupted tool calls, low cache reuse, and inefficient round-trips. Findings are split into one-off fixes and habits, each with an estimated token/cost impact.
- **Potential savings dashboard**: recoverable tokens/dollars, waste as a share of spend, recoverable cost by mistake category, and a most-common-mistakes ranking.
- **Trends & regression alerts**: a daily efficiency series (persisted to global storage) with a cache-reuse/cost chart, plus regression detection comparing the last 7 days to the prior 7 (guarded against sparse-window noise).
- **Per-session drill-down**: turn-by-turn token/cost timeline with compaction markers and the most expensive tool calls for a single session.
- Live status-bar item showing token spend, cache reuse, and a regression badge.
