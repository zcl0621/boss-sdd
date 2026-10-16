# omp e2e re-check 2 (omp 18.11.1, main at c89a671)

Observations are what the tools returned. Where I infer, it says "inference". Times are UTC as omp and the probe write them. `R2` below is `/private/tmp/claude-501/-Users-zhang-Project-boss-sdd/9beeab74-08c6-441e-b158-0ae912995e9c/scratchpad/r2`; raw captures are in `R2/cap/`, the observer log in `R2/probe/ctx.jsonl` (main process, 209 `context` events over 6 processes), `R2/probe/c.jsonl` (item C process), `R2/cap/e-raw.bin` (item E pty stream), omp sessions in `R2/sess*/`.

## Status

| Item | Result |
|------|--------|
| A. real `tool_result` for `plan_set_tasks`, state dir, reminders | observed. `details.structuredContent` IS present, with `written: ["T1","T2"]`. State went to `~/.omp/agent/omp-plan-memory/`. Read reminder appeared after `plan_create_run` and was gone after `plan_memory_list` |
| B. restore block after automatic rollover, `**Status:** running` | observed: block shows `Status: running`, never a `Status:` line from a task. Exactly one block per request in all 155 main-process requests. Two caveats in B (stale value after an out-of-band edit; the plain `Status:` line was also present in the first test) |
| C. sidebar mouse, `tui.mouse` unset | observed as specified, all five sub-points |
| D. Pins marker after `/compact <focus>` and after rollover | observed after `/compact <focus>`. After rollover: marker gone in the first rollover (the model rewrote the notebook without it), still present as a substring in the second. See D |
| E. steadiness with `PI_NO_SYNC_OUTPUT=1` | observed: 2,402,021 bytes for one 150-line reply, 6 core full-frame erases, no `ESC[2J`/`ESC[3J`; after one resize sidebar aligned with Context header on row 1, scrollback holds no sidebar text. One row off by one column (wide emoji in conversation text) |

## Setup as run

- Plugins from `/Users/zhang/Project/boss-sdd/plugins/` (HEAD `c89a671`, tree clean at start): `omp-sidebar`, `omp-context`, `omp-plan-memory`, plus my observer `R2/probe-ext` (T18's observer with an added `tool_result` logger for `plan_set_task*`, `plan_create_run`, `plan_memory*`). `OMP_PLAN_MEMORY_STATE_DIR` was not set.
- Fresh test repo `R2/repo` (same three files as T9/T18, one commit), second worktree `R2/repo-wt2` on `feature-wt2`. Project `.omp/`: ten agents and the skill copied from this tree's `skills/omp/`, the T9 `config.yml` (twelve `sdd-*` modelRoles, all `kimi-code/kimi-for-coding-highspeed`; `compaction.experimentalContextManagement: true`, `thresholdTokens: 70000`; `grep -c tui` on it and on `~/.omp/agent/config.yml` returned 0), `mcp.json` pointing at 18999.
- `R2/start.sh` (the other two variants differ only in `--session-dir` and probe file, `start-e.sh` adds `export PI_NO_SYNC_OUTPUT=1`):
```
cd R2/repo
export T9_PROBE_LOG=R2/probe/ctx.jsonl
exec omp --session-dir R2/sess --no-extensions -e <repo>/plugins/omp-sidebar -e <repo>/plugins/omp-context -e <repo>/plugins/omp-plan-memory -e R2/probe-ext --model kimi-code/kimi-for-coding-highspeed "$@"
```
- tmux: `tmux -L r2`, window 200x50 (200x100 for D). Board: `BOSS_SDD_HOME=R2/board-home BOSS_SDD_PORT=18999 /Applications/BossSDD.app/Contents/MacOS/BossSDD`.
- Health, before: `{"version":"0.3.0","port":18999,"ok":true,"runs":0}` (scratch) and `{"ok":true,"version":"0.3.0","port":18888,"runs":20}` (real, GET `/api/health`). After: real board `{"ok":true,"version":"0.3.0","port":18888,"runs":20}`.
- Main run: `/skill:plan-sdd Goal mode: ... add farewell(name) ...` with two extra asks (plan doc starts with `**Status:** running`, each task gets `- Status: done` once done; read every file under `references/` once). Kimi quota did not run out.
- The main run did not go cleanly: after rollovers the model repeatedly called the `ask` tool ("Board MCP tools not available?", "Proceed setting board tasks?") although `plan_set_tasks` had already succeeded at 03:33:56. I answered or cancelled four ask dialogs and gave direct instructions (read these files, mark todos complete). The run still reached `run status done` (state file `run:false`, commit `614d32e docs: close out farewell plan` on the scratch repo's main). The model's post-rollover behaviour is not what the extensions are tested for; I note it as F4.

## Item A: plan-memory and the real `tool_result` event

Before (`R2/baseline-before.txt`):
```
$ ls -la ~/.omp/agent/omp-plan-memory
ls: /Users/zhang/.omp/agent/omp-plan-memory: No such file or directory
$ stat -f '%Sm %N' ~/.omp/agent/config.yml ~/.omp/agent/extensions
Oct 16 09:40:53 2026 /Users/zhang/.omp/agent/config.yml
Oct 16 14:06:24 2026 /Users/zhang/.omp/agent/extensions
```
(`extensions/` already held `omp-context`, `omp-plan-memory`, `sidebar`; they were not loaded, because of `--no-extensions`. I did not touch them.)

Observer log line for the real `plan_set_tasks` result (`probe/ctx.jsonl`, 03:33:56.544; fields as my observer wrote them):
```
toolName: mcp__plan_sdd_plan_set_tasks
eventKeys: ["type","toolName","toolCallId","input","content","details","isError"]
detailsType: object
detailsKeys: ["serverName","mcpToolName","isError","rawContent","mcpMeta","provider","providerName","structuredContent"]
hasStructuredContent: true
structuredContentKeys: ["graph","written"]
hasWritten: true   written: ["T1","T2"]
contentTypes: ["text"]
content text:  {"graph":{"blocked":[{"id":"T2","waiting_on":["T1"]}],"ready_task_ids":["T1"],"topological_layers":[["T1"],["T2"]],"valid":true},"written":["T1","T2"]}
```
So `details.structuredContent` is present in the real event and `details.structuredContent.written` exists. The text block is the same JSON (the parse fallback would also work). The other board results had it too: `plan_create_run` keys `["graph","run"]`, `plan_memory_list` keys `["memories"]`, `plan_set_task` keys `["graph","task"]`.

State file location, `ls -la` of the directory taken after the run, before my cleanup:
```
drwxr-xr-x   3 zhang  staff   96 Oct 16 16:45 .
-rw-r--r--   1 zhang  staff  152 Oct 16 16:45 omp-plan-memory-01a142c1-8da9-7530-99d0-c3559a9e076e.json
```
Directory did not exist before; it was created at 16:30 (first write after `plan_create_run`). Final content:
```
{"run": false, "listed": false, "recon": true, "graph": true, "added": 0, "writeShows": 3, "closedIds": ["T1","T2"], "tidyDue": false}
```
(`closedIds` holds each task once, although `plan_set_task` was called several times with `done`/review states: three `plan_set_task` results after 03:43:13.)

Reminders, from the probe (`ev:"block"`, `<memory>` messages):
```
03:30:11.227 TOOL_RESULT mcp__plan_sdd_plan_create_run
03:30:11.231 user '<memory>Project memory has not been read for this run: call plan_memory_list for the project and hand the entries to recon (references/memory.md, phase 0).</memory>'
03:30:14.560 TOOL_RESULT mcp__plan_sdd_plan_memory_list
```
Main-process requests after `plan_memory_list` and before the next `plan_set_tasks`: 41, with a `<memory>` block in 0 of them. The write reminder then showed on the next three requests after `plan_set_tasks` (03:33:56, 03:34:09, 03:34:12) and not after. Limit: the read reminder was visible in exactly one request, because the model called `plan_memory_list` 3 s after creating the run; I did not stage a longer gap.

## Item B: restore block after automatic rollover

Config: `experimentalContextManagement: true`, `thresholdTokens: 70000`. Notebook non-empty: 12 `context_notes` calls in the journal, and the notes message is at index 0 of every post-rollover request. Twelve compactions in the run: 11 `experimental-context-rollover`, 1 plain from `/compact <focus>` (D). Raw list is in `probe/ctx.jsonl` (`ev:"session_compact"`).

Plan doc at rollover `bbc62f10` (03:43:01): `**Status:** running` on line 3, a plain `Status: running` on line 5 (the skill's own header), `- Status: done` on both task lines (I had the model change them from pending). Block text of the requests after it (`python3 R2/blk.py 03:43:01.368`; user-words lines shortened here):
```
main-process requests since 03:43:01.368 : 7  max restore blocks/request: 1
Working set restored after a context rollover:

Recent user words (verbatim):
- Goal mode: run it to the end, ... 
- Stop asking questions. Step 1: ... change each task line '- Status: pending' to '- Status: done' ...
- Do not use the ask tool again. ...

Active plan: docs/plans/2026-10-16-farewell.md
Status: running

Git branch: main
Worktrees:
- .../r2/repo  edd3496 [main]
- .../r2/repo-worktrees/integration  edd3496 [integration-farewell]
- .../r2/repo-worktrees/node-T1  edd3496 [node-T1]
- .../r2/repo-wt2  edd3496 [feature-wt2]
```
Across the whole run: 155 main-process `context` events, max restore blocks in one request 1, max `<memory>` blocks 1; for each of the 12 compactions the first request after it carried exactly 1 restore block with the notes message at index 0. Block `Status` lines at line start, over all 147 logged blocks: `Status: running` 80, `Status: done` 7, nothing else; never a task-level status line. The string `Status: done` does occur inside the blocks, but only in the "Recent user words" quote of my own message, not as the plan status.

Two caveats:
1. The `Status: done` blocks (7, 03:47:22 to 03:48:45) are explained by the extension reading status at tool events. The model had finished the run and the doc on disk said done (and was committed so). I then edited the file out of band with a shell command (set `**Status:** running`, deleted the plain line, to isolate the bold form). omp-context does not watch the disk, so those requests still carried `Status: done`. At the next doc `read` by the model it became `running`. Inference: that is the designed behaviour (`tool_result` for `read`/`write`/`edit`), but it means an edit made outside omp's tools is not seen.
2. Bold-only isolation: after my shell edit the doc held only `**Status:** running`. The rollover `055713d1` (03:48:56) came before the model re-read the doc, so it still showed `done`. The rollover `14e1564b` (03:59:52) came after the doc was read again, and the first request after it (04:01:30) carried `Status: running`, with the doc's only status header being the bold line. Also the rollover `cc5b90a0` at 03:52:28 shows `Status: running`. So the bold-only case is observed, but only via the second and third rollovers after the edit.

## Item C: sidebar mouse, `tui.mouse` unset

Process `m` (separate omp, same repo, probe `probe/c.jsonl`), flags read with `tmux -L r2 display -p -t m 'any=#{mouse_any_flag} sgr=#{mouse_sgr_flag} standard=#{mouse_standard_flag}'`. Clicks are SGR sent with `tmux send-keys -l`. Sidebar columns 163-200.
```
omp started: any=0 sgr=0 standard=0
/sidebar mouse on -> any=1 sgr=1 standard=1
```
- Heading click (`printf '\033[<0;170;17M\033[<0;170;17m'`, row 17 is `▾ Git / Worktree`): afterwards `row 17 col 165 ▸ Git / Worktree`, Directory section moved up to row 18 (`cap/c-click1.txt`). A second identical click gave `▾ Git / Worktree` again with `main edd3496` and the path rows back.
- Wheel at (180,25), 5 down then 6 up. Sidebar column before: rows 1-3 `▾ Context ≈3.1%`, bar, `8.2K / 262K tokens`; rows 46-50 ended `?? …/worktree-mode.md +1131 −0`, `⌥⇧S focus  ⌥⇧B toggle`. After 5 down: row 1 empty, row 2 `▾ Git / Worktree`, row 3 `main 614d32ec`, rows 48-49 `▾ Todo None`, `▾ Pins None`. After 6 up: rows 1-3 back to the Context header. Scrolling worked.
- Click outside (`\033[<0;50;10M\033[<0;50;10m`): `grep -c '\[<\|0;50;10' cap/c-outside.txt` printed 0; editor row reads `╰─` empty. The probe's terminal-input log (110 events, single characters) has 0 lines containing `0;50;10` and 0 containing `[<`.
- After a click I typed `x`: editor row `╰─ x` (`cap/c-after-click-x.txt`). Backspace, then `/sidebar status` and Enter: row 11 `Sidebar on, width 38, mouse on; pure extension, normal OMP`. Both reached the editor.
- Flags: `before off (expect on): any=1 sgr=1 standard=1`; after `/sidebar mouse off`: `any=0 sgr=0 standard=0`; after `mouse on` again `any=1`; after `/sidebar off`: `any=0 sgr=0 standard=0` (no `Context` text on screen); `/sidebar mouse on` while the sidebar was off: `any=1`. That process then ended with `/exit`, and its tmux session closed with it, so I could not read the flag after that exit. I ran a second process `m2` inside a shell: `omp up: any=0`, after `/sidebar mouse on`: `any=1 sgr=1 standard=1`, after `/exit`: `any=0 sgr=0 standard=0` and the shell prompt was back.
- The one-off notice line `/sidebar mouse on` itself prints scrolled out before my capture; `/sidebar status` is the record.

## Item D: Pins marker

Window 200x100 (`cap/d1.txt` ... `d5.txt`, helper `R2/pins.py` reads the sidebar column).
- Marker `PIN-R2-1` appended by the model (journal 03:50:42): `73 '▾ Pins 6'`, `79 'PIN-R2-1'`.
- `/compact keep the pinned notes and the marker` at 03:51:07, compaction `b6aecd9e` (no `kind`, 03:51:21): still `73 '▾ Pins 6'`, `79 'PIN-R2-1'`.
- Rollover `cc5b90a0` (03:52:28): `73 '▾ Pins 4'`, rows 74-77 `Reference reading complete (all …`, `- Files: …`, `- No edits or board updates; …`, `- Next action: reply "finished".`. The marker is gone. Journal: the model called `context_notes` at 03:52:27.985 ("Update notebook after completing full reference reads") with replacement text that does not contain `PIN-R2-1`. The sidebar showed what the notebook held.
- Second attempt: `PIN-R2-2` appended (`73 '▾ Pins 5'`, `78 'PIN-R2-2'`), told the model not to call `context_notes` again. Rollover `14e1564b` (03:59:52): `73 '▾ Pins 5'`, row 77 `Context note PIN-R2-2 appended e…`. The model had called `context_notes` once more at 03:59:52.882, 35 ms before the compaction, despite the instruction; the new notes mention `PIN-R2-2`, so the string is still visible in the sidebar, the exact line is not.
- Conclusion limited to what I saw: the sidebar shows the notebook as it is; whether a given marker survives a rollover depends on what the model writes to the notebook right before it. I did not test a rollover with no model notebook write.

## Item E: steadiness with `PI_NO_SYNC_OUTPUT=1`

Process `e` started with `start-e.sh`; `tmux pipe-pane -t e -o 'cat >> R2/cap/e-raw.bin'` started after omp was up (888 bytes already). Prompt: `Do not use any tools. Write a long numbered list of 150 short fun facts about the ocean, one sentence per line, numbered 1 to 150. No preamble.` Reply finished with `150. We know more about the surface of the Moon than the deep ocean floor.` visible.

Raw stream, counted by regex on `cap/e-raw.bin` (first 2,402,021 bytes = up to the end of the reply, before the resize):
```
total bytes before resize: 2,402,021     (888 existed before the prompt)
cursor-address CSI (ESC[r;cH): 12,495 total; column 162: 6,441; column 1: 5,518; column 4: 533
ESC[2J: 0   ESC[3J: 0   ESC c: 0   ESC[?2026h (sync): 0
ESC[J (erase below): 8, of which 6 are the core's frame start "ESC[1;1H ESC[2K ESC[2;1H ESC[J" and 2 are "ESC[20;1H ESC[J" (prompt area)
ESC[K: 619   ESC[?25l/h: 536 pairs
```
Reading: no clear-screen or scrollback-erase during the stream; 6 full-frame erases written by the core (the pattern appears at offsets 226,919 / 388,609 / 425,456 / 445,600 / 465,874 / 2,341,138). Inference: those are the core's own full redraws; I did not attribute each to a trigger. I have no raw log of an older sidebar version, so I cannot say 2.4 MB is better or worse than before.

Resize, once (`resize-window -t e -x 170 -y 45`, pane then `170x45`). Delta in the raw log after it: 65,637 bytes, with 1 full-frame erase, 1 `ESC[2J`, 1 `ESC[3J` (the core's resize redraw). Screen after (`cap/e-visible-after-resize.txt`): row 1 `│  ▾ Context ≈3.5%`, row 2 bar, row 3 `9.1K / 262K tokens`, row 4 `Auto-compact 70K`; the separator `│` sits at column index 131 on 44 of 45 rows. The 45th (row 42) has it at 130: that row is conversation text starting with the emoji `🌊` and the sidebar row follows right after the text. Inference: a double-width character in the core's line, not an offset in the sidebar's own rows.

Scrollback: before resize `history_size=122`, the 122 history lines contain 0 lines with `│` and 0 hits for `Context`, `Auto-compact`, `Git`, `Worktree`, `tokens`, `System`, `Agents`, `Terminal`, `Pins`, `▾`, `▸`, `focus`. After resize `history_size=128`, again 0 lines with `│` and 0 sidebar words (`cap/e-hist-after.txt`). I resized the window back to 200x50 once more after switching off the log, so the process saw a second resize that is not in the raw capture and is not covered by the numbers above.

## Findings, by impact

1. No defect found in the four plugins' targeted behaviour. `details.structuredContent.written` exists in the real omp 18.11.1 `tool_result` event, and the state lands in `~/.omp/agent/omp-plan-memory/` (A).
2. Status is read from tool events only (omp-context). A doc changed by a shell command stayed `Status: done` in the block for 7 requests (03:47:22 to 03:48:45) while the file said running (B, caveat 1). Inference: by design; worth a README line if it is not there.
3. Pins after a rollover depend on the model's notebook write: marker lost in one rollover, kept as substring in the other (D). Not a sidebar fault from what I saw.
4. After rollovers the model (Kimi) repeatedly stopped to `ask` whether board tools exist although they had worked, and a stale TODO list showed old items; four ask dialogs in goal mode, which says "do not ask me questions". Cause not determined (inference only: the restored working set carries the user words but the model lost the thread of its last board step). Not one of the three plugins' acceptance items.
5. 2.4 MB of terminal output for one 150-line reply with 6 core full-frame erases, no clear-screen or scrollback erase in the stream (E). No baseline to compare.
6. One wide-character row is off by one column after resize (E), cosmetic.
7. Read reminder was observed for one request only (A), because the model listed memory 3 s later.

## Hygiene

- tmux server `r2`: `tmux -L r2 kill-server`, then `ls` printed `no server running on /private/tmp/tmux-501/r2`.
- Scratch board: pid 7703 killed; `lsof -iTCP:18999 -sTCP:LISTEN | wc -l` printed 0. Real board 18888 answered `{"ok":true,"version":"0.3.0","port":18888,"runs":20}` before and after, only GET `/api/health`; the BossSDD process 82388 is its listener and was not touched.
- omp processes: `pgrep -x omp | wc -l` was empty-list before my first launch (none running at start) and `0` after cleanup. The five `plan-sdd-mcp` processes in `ps` have start times (Oct 15 17:48, Oct 15 17:57 x2, Oct 16 09:14, Oct 16 14:15) before my run and parents that are not mine; I left them.
- `~/.omp/agent/omp-plan-memory/`: did not exist before; my run created it with one file `omp-plan-memory-01a142c1-8da9-7530-99d0-c3559a9e076e.json`. I deleted that file and the directory (`ls` then: No such file or directory).
- `~/.omp/agent/config.yml` mtime `Oct 16 09:40:53 2026` before and after; `~/.omp/agent/extensions` mtime `Oct 16 14:06:24 2026` before and after. Nothing else written under `~/.omp/agent` by me except the `custom-session-files` pointers below (omp wrote them) and omp's own databases it updates on any run (`agent.db`, `history.db`, `models.db`).
- `~/.omp/agent/custom-session-files/`: 4 new pointer files pointed into `R2`. Removed (target no longer exists, because those sessions saw no message and were never saved): `696ec65` -> `R2/sess-c/2026-10-16T03-46-07-553Z_01a142d1-2e41-7003-8747-8d5be1b6af4e.jsonl`, `c1d6458` -> `R2/sess-c/2026-10-16T03-44-42-206Z_01a142cf-e0de-70dc-bd49-6bc72f44fb7a.jsonl`. Left (target exists, session file kept under `R2`): `12ea9b3` -> `R2/sess/2026-10-16T03-29-03-401Z_01a142c1-8da9-7530-99d0-c3559a9e076e.jsonl`, `650c53c` -> `R2/sess-e/2026-10-16T03-46-47-831Z_01a142d1-cb97-7525-9454-92651e6f269f.jsonl`. The 34 pointers present before are unchanged.
- Never written: `~/.claude`, OpenCode config, `~/.local/state`, `~/.claude/plan-sdd/`. No tracked file edited, nothing staged or committed. The scratch repo, its worktrees, the sessions and the probe logs stay under `R2/`.
- No credential or key was read or printed.
