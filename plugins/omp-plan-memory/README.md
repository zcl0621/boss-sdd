# omp-plan-memory

An omp extension that reminds the plan-sdd orchestrator to read, write and tidy the board's project memory.
It is the omp port of `plugins/plan-memory` (OpenCode) and uses the same rules:

- **read**: a run is open and `plan_memory_list` has not been called since the previous run finished.
- **write**: recon was dispatched and the task graph written, but nothing was filed with `plan_memory_add`
  (counted in agent turns via `turn_start` while it is due; shown while the count is < 3, that is 3 turns counting the
  one in which it became due, then dropped).
- **tidy**: 5 tasks reached done/blocked since memory was last listed, or the run moved to `review`.

The reminder is a `<memory>` block added to each provider request through omp's `context` event. It is never
stored in the session history. Placement: at index 1 when the first message is a `compactionSummary`; otherwise immediately after the first user
message that is not synthetic; if there is neither, no block is added. Never at the tail, and never at index 0 (omp's
date/cwd reminder root, `date-cwd-reminder.ts:66`). Why not the tail: omp's `compact()` builds the summarizer request
with `buildLiveProviderContext` (`session/agent-session.ts:2380-2403`), which converts `history` (giving a prefix
length) and `history + retained` through the `context` handler, then cuts the second result at that length. A tail
block would move the cut one message too far and could split a tool_use/tool_result pair. With this rule the first
`len(handler(history))` messages of `handler(history + retained)` equal `handler(history)` in every case (when
history has neither a summary nor a user message, the block lands in the retained part, after the cut). A "user
message only" rule would hide the reminder when the retained tail after a compaction holds no user message, and
falling back to the summary only in that case would misalign the cut. Known cost: an Anthropic native summary
followed by an assistant turn is no longer merged by the provider (`ai/src/providers/anthropic.ts:6190-6208`); role
alternation stays valid. Whether the block appears and its text depend
only on the plugin state (the `context` event fires once per conversion, so it counts nothing), and its timestamp
is constant, so requests are byte-stable while the state is unchanged. It only reminds; what to read, write or delete is the skill's call.

## Board tool names

Board calls are read from `tool_result` events by the registered tool name: plain `plan_*`, or the name omp mints
for an MCP tool, `mcp__<server>_<tool>`, under any server key (`mcp__plan_sdd_plan_memory_list` for server `plan-sdd`,
`mcp__board_plan_memory_list` for a server named `board`, `mcp__plan_memory_list` for a server named `plan`, where omp
strips the repeated prefix). A name counts when it is one of the board's 13 tools or ends with `_<tool>` (longest tool
name wins). A server key long enough to push the minted name over omp's 64-character cap gets a hash suffix and is
not recognised; use the key `plan-sdd`. A call made through MCP discovery (`write xd://mcp__<server>_<tool>`)
fires an outer `write` event and an inner event with the registered name; only the inner one is counted.
Recon is detected from the `task` tool's `agent` (or `tasks[].agent`) starting with `recon`.

## State

Per-session JSON files (`omp-plan-memory-<session>.json`) under `$XDG_STATE_HOME/omp-plan-memory/` (default `~/.local/state/omp-plan-memory/`).
Saving is best-effort: with an unwritable state directory the reminder state lives only for the omp process (it is kept in memory per session; a failed save is logged once per session through omp's extension logger). Set `OMP_PLAN_MEMORY_STATE_DIR` to use another directory. At start, this plugin's own files (`omp-plan-memory-*.json` and `omp-plan-memory-*.json.<pid>.tmp`) older than 30 days are removed; other files in the directory are left alone.

Note: omp's `/btw` side turns and dumps also run the `context` event on the same session, but the write reminder counts only `turn_start`, so a bare conversion does not use up its showings (whether a `/btw` turn itself emits `turn_start` was not checked).

## Install and test

Install into `~/.omp/agent/extensions/omp-plan-memory/` (or a project's `.omp/extensions/omp-plan-memory/`). Run from the repository root; this is the same command as in the root README:

```bash
mkdir -p ~/.omp/agent/extensions/omp-plan-memory
rsync -a --exclude node_modules --exclude '*.test.ts' --exclude bun.lock --exclude .gitignore plugins/omp-plan-memory/ ~/.omp/agent/extensions/omp-plan-memory/
```

The copy leaves out `node_modules`, `bun.lock`, `.gitignore` and the tests. Run over an existing install it overwrites files in place; files that no longer exist upstream remain.
`package.json` has `"omp": { "extensions": ["./index.ts"] }`, so omp loads `index.ts` from that directory.
The package has no runtime dependency on `@oh-my-pi/*` (type import only).

Test:

```
bun test
```

Tests drive a fake `pi`/`ctx` and write only to a temp directory.
