# Post-rollover `ask` about the board tools (recheck2 finding 4)

Times are UTC. `R2` is the recheck2 scratch dir named in [2026-10-16-omp-e2e-recheck2.md](2026-10-16-omp-e2e-recheck2.md). `LIVE` is `/private/tmp/claude-501/-Users-zhang-Project-boss-sdd--claude-worktrees-jolly-mirzakhani-dfa37e/189adbc0-39dd-4fdb-9467-f824ed92b178/scratchpad/live`.

## Cause

1. omp mounts MCP tools as `xd://` devices. They are not in the request's tools array. The system prompt documents each one in a `# xd:// Tool Devices` section with a `## mcp__plan_sdd_<tool>` heading and a `type Args` schema (omp `prompts/system/system-prompt.md:84-88`, `tools/xdev.ts` `renderDocs`). That section is in every request, before and after a rollover.
2. The skill's board row said: "When the top-level function list shows them directly, call them as functions."
3. The rollover at 03:35:32 (`ec31e420`) kept a tail with no `write xd://…` call in it (probe `R2/probe/ctx.jsonl`, first request after it: notes, summary, restore block, skill prompt, then bash/read calls). None of the 13 `context_notes` writes in the run mentioned `xd://`.
4. The model then read the device docs as functions. From the session journal (`R2/sess/2026-10-16T03-29-03-401Z_…jsonl`):
   - line 408, 03:35:47, thinking: "In the tool descriptions, the top-level functions show plan_sdd tools as direct functions. We'll use them."
   - line 413: "at top we have functions including plan_board_status, plan_create_run, … Yes they are in tool list."
   - line 463, 03:41:27: "We can call `plan_set_tasks` as a function."
   
   Every time it meant to call `plan_set_tasks`, it emitted `ask` instead (lines 425, 428, 431, 460, 463). `ask` is one of the tools omp always keeps top-level (`tools/xdev.ts` `XDEV_KEEP_TOP_LEVEL`). Inference: there was no function named `plan_set_tasks` to emit, and `ask` was the nearest real tool. I did not verify this at the provider level.
5. The model recovered at 03:43:11 (`write xd://mcp__plan_sdd_plan_set_tasks`), after re-reading `references/board.md` in a fresh window.

## Fix (commit d88518b)

- `plugins/omp-context`: records every successful `write` whose path is `xd://<tool>`. `write` is wrapped like every tool (`sdk.ts:3603`), so its `tool_result` carries the path. The list holds at most 8 names, most recent first. The restore block lists them along with the route: write tool, path `xd://<name>`, JSON arguments as content. Five new tests in `index.test.ts`.
- `skills/omp/SKILL.md`: the `# xd:// Tool Devices` section is not the function list; call a device directly only when a function with exactly that name exists. The orchestrator keeps one line in `context_notes` saying how the board is called. After a rollover, any doubt is settled with `read xd://`; it never uses `ask` for that, and in goal mode it never uses `ask` for a doubt a read can settle. Two new tests in `skill.test.ts`.

Tests: `skills/omp` 126 pass, `plugins/omp-context` 314 pass, `plugins/omp-plan-memory` 64 pass.

## Live recheck

Setup as in recheck2: omp 18.11.1, Kimi `kimi-code/kimi-for-coding-highspeed`, tmux `-L livefix`, a scratch board on 18999 with `BOSS_SDD_HOME=LIVE/board-home`, `--session-dir LIVE/sess`, `--no-extensions` plus `-e` for the three plugins from this worktree and the recheck2 observer, `OMP_PLAN_MEMORY_STATE_DIR=LIVE/pmstate`. I used the same `/skill:plan-sdd` goal-mode prompt as the recheck2 main run. One attempt with `thresholdTokens: 50000` stalled: omp paused maintenance because the reference reads did not fit. It was discarded (`LIVE/attempt1`). The run reported here uses `thresholdTokens: 70000`.

From `LIVE/timeline.txt`:
```
04:13:05 COMPACT 7e0df17a experimental-context-rollover
04:13:30 CALL write xd://mcp__plan_sdd_plan_board_status
04:13:53 CALL write xd://mcp__plan_sdd_plan_create_run
04:14:15 CALL write xd://mcp__plan_sdd_plan_set_tasks
04:14:21 CALL write xd://mcp__plan_sdd_plan_update_run
04:14:29 CALL write xd://mcp__plan_sdd_plan_set_task
04:15:00 COMPACT aaa254d9 experimental-context-rollover
04:15:28 CALL write xd://mcp__plan_sdd_plan_set_task
04:15:41 CALL write xd://mcp__plan_sdd_plan_set_task
04:16:44 CALL write xd://mcp__plan_sdd_plan_set_task
04:19:16 CALL write xd://mcp__plan_sdd_plan_update_run
asks: 0
```
The first request after `aaa254d9` carried this block section (probe `LIVE/probe/ctx.jsonl`, `ev:"block"`, 04:15:00.987):
```
Tools called as xd:// devices before this point (not in the function list; call each with the write tool, path xd://<name>, the JSON arguments as content):
- xd://mcp__plan_sdd_plan_set_task
- xd://mcp__plan_sdd_plan_update_run
- xd://mcp__plan_sdd_plan_set_tasks
- xd://mcp__plan_sdd_plan_create_run
- xd://mcp__plan_sdd_plan_board_status
```
The run ended with board run `5731000d…` set to done, main fast-forwarded to `dc06010`, and `./test.sh` printing `ok` / `ok farewell`.

Limits:
- This is one run with one rollover after the first board call. Recheck2 had 11. The model's behaviour varies from run to run, so this run shows the fix working once; it does not prove the problem cannot come back.
- Kimi did not follow the new SKILL.md line: neither of its `context_notes` writes (04:13:48, 04:19:21) contained `xd://`. In this run the route reached the model through the omp-context block, not through the notes.

Hygiene: tmux server `livefix` killed. Scratch board pid stopped; `lsof` on 18999 returned 0 lines. `pgrep -x omp` returned 0. I removed the two session pointers omp wrote to `~/.omp/agent/custom-session-files/` (36 entries before and after). `~/.omp/agent/config.yml` and `extensions/` mtimes are unchanged. `~/.omp/agent/omp-plan-memory` does not exist. The real board on 18888 answered `{"ok":true,"version":"0.3.0","port":18888,"runs":20}` before and after; it received GET `/api/health` only.
