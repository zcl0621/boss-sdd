# omp-plan-memory

An omp extension that reminds the plan-sdd orchestrator to read, write and tidy the board's project memory.
It is the omp port of `plugins/plan-memory` (OpenCode) and uses the same rules:

- **read**: a run is open and `plan_memory_list` has not been called since the previous run finished.
- **write**: recon was dispatched and the task graph written, but nothing was filed with `plan_memory_add`
  (shown for 3 requests, then dropped).
- **tidy**: 5 tasks reached done/blocked since memory was last listed, or the run moved to `review`.

The reminder is a `<memory>` block added as the last message of each provider request through omp's `context`
event. It is never stored in the session history. It only reminds; what to read, write or delete is the skill's call.

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
Set `OMP_PLAN_MEMORY_STATE_DIR` to use another directory. At start, this plugin's own files (`omp-plan-memory-*.json` and `omp-plan-memory-*.json.<pid>.tmp`) older than 30 days are removed; other files in the directory are left alone.

One limit: omp's `/btw` side turns also run the `context` event on the same session, so they can use up the write
reminder's 3 showings.

## Install and test

Point omp at this directory (`package.json` has `"omp": { "extensions": ["./index.ts"] }`).
The package has no runtime dependency on `@oh-my-pi/*` (type import only).

```
bun test
```

Tests drive a fake `pi`/`ctx` and write only to a temp directory.
