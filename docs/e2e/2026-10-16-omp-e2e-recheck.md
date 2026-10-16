# T18 re-check of the four T9 defect items on omp 18.11.1

Observations are what the tools returned; where I infer, it says so. Times are UTC as omp and the probe write them. Raw captures live under `/private/tmp/claude-501/-Users-zhang-Project-boss-sdd/9beeab74-08c6-441e-b158-0ae912995e9c/scratchpad/t18/` (`cap/`, `probe/ctx.jsonl`, `sess/`, `pty-mouse.raw`). In pasted blocks the prefix `/private/tmp/claude-501/-Users-zhang-Project-boss-sdd/9beeab74-08c6-441e-b158-0ae912995e9c/scratchpad/t18` is shortened to `…/t18`; the probe has it in full.

## Status at a glance

| # | Item | Result |
|---|------|--------|
| 3a | restore block after automatic rollover, run started with `/skill:plan-sdd <args>`, notes message at index 0 | observed as specified: 3 automatic rollovers, block present exactly once each time, with the `/skill` args as user words. "Active plan" present from rollover 2; no `Status:` line because the plan docs the model wrote have no `Status:` text (see F1) |
| 3b | `/compact <focus>` | observed as specified: one block, 4 words, `Active plan` and `Status: in progress` (after I had the model put a Status line in the plan doc) |
| 3c | plain `/compact` (rollover) | observed as specified: one block, words, `Active plan`, `Status: in progress` |
| 5 | plan-memory `read` reminder shows after `plan_create_run`, goes after `plan_memory_list`; `write` reminder | observed as specified, both reminders, in a controlled step (run 2 showed the `read` pair by itself) |
| 9 | sidebar mouse opt-in, `tui.mouse` off | observed as specified: click toggles, wheel scrolls, outside click leaves no text, click does not take the keyboard, `mouse_any_flag` goes to 0 on `mouse off`, `/sidebar off`, `/new` and exit. With `tui.mouse: true`, `/sidebar mouse on` prints a warning and writes no mouse-mode bytes |
| 10 | Pins marker visible after `/compact <focus>` and after rollover | observed as specified |

## Setup (as run)

Branch `plan/omp-T18` at `28bfef7`, worktree `/Users/zhang/Project/boss-sdd-worktrees/T18`. Plugins loaded from that tree's `plugins/`.

Fresh test repo `…/t18/repo` (one commit `8093a00`: `src/greet.js`, `test.sh`, `README.md`, same content as T9) with a second worktree `…/t18/repo-wt2` on `feature-wt2`. Project-local `.omp/`: ten agents copied from `skills/omp/agents/` of this tree, `skills/omp/` copied to `.omp/skills/plan-sdd/`, `config.yml` copied from T9 (the twelve `sdd-*` modelRoles aliases, all `kimi-code/kimi-for-coding-highspeed`; `compaction.experimentalContextManagement: true`, `thresholdTokens: 70000`; no `tui:` key), `mcp.json` pointing at port 18999.

Start script `…/t18/start.sh`:
```
#!/bin/sh
cd …/t18/repo
export OMP_PLAN_MEMORY_STATE_DIR=…/t18/pmstate
export T9_PROBE_LOG=…/t18/probe/ctx.jsonl
exec omp --session-dir …/t18/sess --no-extensions -e /Users/zhang/Project/boss-sdd-worktrees/T18/plugins/omp-sidebar -e /Users/zhang/Project/boss-sdd-worktrees/T18/plugins/omp-context -e /Users/zhang/Project/boss-sdd-worktrees/T18/plugins/omp-plan-memory -e …/t18/probe-ext --model kimi-code/kimi-for-coding-highspeed "$@"
```
`probe-ext` is the T9 observer copied unchanged (logs `context` events, restore and `<memory>` block text, `session_compact`, and terminal input; it never returns messages). It is a fourth extension in the process, so the run is not exactly the three-extension setup.

Board: `BOSS_SDD_HOME=…/t18/board-home BOSS_SDD_PORT=18999 /Applications/BossSDD.app/Contents/MacOS/BossSDD`. Health, the scratch board and the real one at the same moment, before the run:
```
{"ok":true,"version":"0.3.0","port":18999,"runs":0}
{"port":18888,"runs":20,"ok":true,"version":"0.3.0"}
```
tmux: `tmux -L t18` through `…/t18/t.sh`, window 200x50, resized to 200x100 for the Pins captures. Versions: `omp/18.11.1`. No credential was read or printed.

Sequence of the run (one omp process, session `01a14222-5187-7330-a06e-826c67625f48`, 00:35 to 00:59), then fresh processes for item 9:
1. `/skill:plan-sdd Goal mode: run it to the end, I am going away, do not ask me questions. Change: add farewell(name) to src/greet.js returning "bye " + name, export it, and make test.sh check it (greet check must stay). Keep the plan small. Use the board. Write the plan doc to docs/plans/2026-10-16-farewell.md.`
2. `/skill:plan-sdd Goal mode: … New change: add shout(name) to src/greet.js returning name.toUpperCase() + "!" … Write the plan doc to docs/plans/2026-10-16-shout.md. Before you start, read every file under .omp/skills/plan-sdd/references once.` (I added the read-everything sentence only to push the context up; it made the third rollover happen.)
3. A controlled board step (item 5), a controlled edit step (Status line), `/compact keep the codeword and the pinned notes`, a question, a plain question, `/compact`, a question.

## Item 3: restore block after automatic rollover, `/compact <focus>`, plain `/compact`

How observed: the block is added per request through `context` and is not persisted, so I read it from the probe (`probe/ctx.jsonl`, `ev:"block"`). Helper scripts: `pr.py`, `after.py` in the scratch dir. Over the whole log (211 main-process requests) the maximum number of restore blocks in one request was 1 and of `<memory>` blocks was 1.

### 3a. Automatic rollovers (`thresholdTokens: 70000`), run started as `/skill:plan-sdd <args>`

The notebook (`context_notes`) was written before the first rollover. Journal (`sess/…01a14222….jsonl`), calls around it:
```
00:35:50.642 context_notes {"i": "Saving plan-sdd run state before context rollover", "text": "plan-sdd run state\n- User request: add fa…
00:35:50.655 COMPACTION 898f2ec3 experimental-context-rollover
```
Rollover compactions from the probe (`session_compact`, `kind`, `usage after`):
```
00:35:50.693 898f2ec3 experimental-context-rollover tokens=17099
00:42:12.348 3084d8aa experimental-context-rollover tokens=17743
00:50:26.234 24c7923d experimental-context-rollover tokens=30325
```
First request after each rollover (message roles and lengths, from the probe):
```
00:35:50.663 n=7   [0] custom (<experimental-context-notes>, 1827) [1] compactionSummary (519) [2] user (Working set restored…, 674)  [3] custom ([IMPORTANT: User invoked the "plan-sdd" skill…, 18938) [4] custom (<context-window-reminder>, 539)
00:42:12.323 n=7   [0] custom (notes, 2007) [1] compactionSummary (519) [2] user (restore, 1407) [3] custom (skill prompt, 19028)
00:50:26.210 n=15  [0] custom (notes, 1706) [1] compactionSummary (519) [2] user (restore, 1928) [3] custom (skill prompt, 19028) [4] assistant …
```
So the notes custom message is at index 0 and the summary at index 1, and in each case the restore block (a `user` message) sits at index 2, directly after the summary. No `user` message from the person exists in those requests.

Restore block of rollover 1 (00:35:50.664), verbatim:
```
Working set restored after a context rollover:

Recent user words (verbatim):
- Goal mode: run it to the end, I am going away, do not ask me questions. Change: add farewell(name) to src/greet.js returning "bye " + name, export it, and make test.sh check it (greet check must stay). Keep the plan small. Use the board. Write the plan doc to docs/plans/2026-10-16-farewell.md.

Git branch: main
Worktrees:
- …/t18/repo     8093a00 [main]
- …/t18/repo-wt2 8093a00 [feature-wt2]
```
Restore block of rollover 2 (00:42:12.324), verbatim (the plan doc `farewell.md` was the first run's plan; whether `shout.md` existed yet at 00:42:12 I did not check):
```
Working set restored after a context rollover:

Recent user words (verbatim):
- Goal mode: run it to the end, I am going away, do not ask me questions. Change: add farewell(name) to src/greet.js returning "bye " + name, export it, and make test.sh check it (greet check must stay). Keep the plan small. Use the board. Write the plan doc to docs/plans/2026-10-16-farewell.md.
- Goal mode: run it to the end, I am going away, do not ask me questions. New change: add shout(name) to src/greet.js returning name.toUpperCase() + "!", export it, and make test.sh check it (keep the existing checks). Keep the plan small. Use the board. Write the plan doc to docs/plans/2026-10-16-shout.md. Before you start, read every file under .omp/skills/plan-sdd/references once.

Active plan: docs/plans/2026-10-16-farewell.md

Git branch: main
Worktrees:
- …/t18/repo         50ce86f [main]
- …/t18/repo-wt-impl eba29e5 (detached HEAD)
- …/t18/repo-wt-spec 136d365 (detached HEAD)
- …/t18/repo-wt2     8093a00 [feature-wt2]
```
Restore block of rollover 3 (00:50:26.210), verbatim:
```
Working set restored after a context rollover:

Recent user words (verbatim):
- Goal mode: run it to the end, I am going away, do not ask me questions. Change: add farewell(name) to src/greet.js returning "bye " + name, export it, and make test.sh check it (greet check must stay). Keep the plan small. Use the board. Write the plan doc to docs/plans/2026-10-16-farewell.md.
- Goal mode: run it to the end, I am going away, do not ask me questions. New change: add shout(name) to src/greet.js returning name.toUpperCase() + "!", export it, and make test.sh check it (keep the existing checks). Keep the plan small. Use the board. Write the plan doc to docs/plans/2026-10-16-shout.md. Before you start, read every file under .omp/skills/plan-sdd/references once.

Active plan: docs/plans/2026-10-16-shout.md

Git branch: main
Worktrees:
- …/t18/repo                      50ce86f [main]
- …/t18/repo-wt-impl              eba29e5 (detached HEAD)
- …/t18/repo-wt-shout-impl        21648c9 [shout/impl]
- …/t18/repo-wt-shout-integration 460aa87 [integration/shout]
- …/t18/repo-wt-shout-spec        39886e3 [shout/spec]
- …/t18/repo-wt-spec              136d365 (detached HEAD)
- …/t18/repo-wt2                  8093a00 [feature-wt2]
```
Between rollovers every main-session request carried one block (`restore 1` in the `pr.py` rows from 00:35:50 on); the request at 00:50:22.230 (n=144, just before rollover 3) still had the rollover 2 block, and the first request after rollover 3 (00:50:26.210) had one block with the new text, not two.

Observed for 3a: present exactly once after each of three rollovers; "Recent user words" present each time and carries the `/skill` args (the text after `/skill:plan-sdd`), from rollover 1 on; "Active plan" is present from rollover 2 (rollover 1 happened before any plan doc was written); no `Status:` line in any of the three, because the plan docs written by the model have no `Status:` text (`grep -n Status docs/plans/*.md` returned nothing). Rollover 2 shows the previous run's plan (`farewell.md`) while the second task was starting, as expected from the code (last plan path read or written).

### 3b. `/compact keep the codeword and the pinned notes`

Before it, as user messages: a controlled step for item 5 (below), then `My codeword is MAGENTA-77. Add the line "Status: in progress" right under the title of docs/plans/2026-10-16-shout.md with the edit tool, then read that file back, then call context_notes to append the single line PIN-T18-1 to the notebook (keep existing lines). Reply in one line.` The Status line was added only so a Status can show; the plan docs the model wrote lacked one.

Compaction `8f75af8f` at 00:56:28.358, no `details.kind` (a summary compaction). First request after it (00:57:06.294): `n=16`, roles `custom (notes, 1499), compactionSummary (3444), user (Working set restored after compaction…, 2851), user (My codeword is MAGENTA-77…, 281), assistant, toolResult…`. Block, verbatim:
```
Working set restored after compaction (the summary may have lost detail):

Recent user words (verbatim):
- Goal mode: run it to the end, I am going away, do not ask me questions. Change: add farewell(name) to src/greet.js returning "bye " + name, export it, and make test.sh check it (greet check must stay). Keep the plan small. Use the board. Write the plan doc to docs/plans/2026-10-16-farewell.md.
- Goal mode: run it to the end, I am going away, do not ask me questions. New change: add shout(name) to src/greet.js returning name.toUpperCase() + "!", export it, and make test.sh check it (keep the existing checks). Keep the plan small. Use the board. Write the plan doc to docs/plans/2026-10-16-shout.md. Before you start, read every file under .omp/skills/plan-sdd/references once.
- Controlled memory-reminder check, do exactly these board steps in order and nothing else, reading each xd:// tool schema first: (1) plan_create_run with title "memcheck" and project the current repo path, no tasks; (2) plan_memory_list for the project; (3) task tool with one recon-code agent, assignment "list the files under src and report their names", no writes; (4) plan_set_tasks with one task id M1 titled "memcheck", status ready; (5) plan_memory_add one entry saying "memcheck gate is ./test.sh" with source "test.sh". Report each tool result in one line.
- My codeword is MAGENTA-77. Add the line "Status: in progress" right under the title of docs/plans/2026-10-16-shout.md with the edit tool, then read that file back, then call context_notes to append the single line PIN-T18-1 to the notebook (keep existing lines). Reply in one line.

Active plan: docs/plans/2026-10-16-shout.md
Status: in progress

Git branch: main
Worktrees:
- …/t18/repo                      50ce86f [main]
- …/t18/repo-wt-impl              eba29e5 (detached HEAD)
- …/t18/repo-wt-shout-impl        21648c9 [shout/impl]
- …/t18/repo-wt-shout-integration 460aa87 [integration/shout]
- …/t18/repo-wt-shout-spec        39886e3 [shout/spec]
- …/t18/repo-wt-spec              136d365 (detached HEAD)
- …/t18/repo-wt2                  8093a00 [feature-wt2]

Loaded skills: plan-sdd
```

### 3c. Plain `/compact` (rollover)

After 3b I sent `What is 2+2? Reply with just the number.`, then `/compact`. Compaction `bc3305e3` at 00:58:14.765, `kind=experimental-context-rollover`, usage after 27216. First request after it (00:59:00.230): `n=15`, roles `custom (notes, 1499), compactionSummary (519), user (Working set restored after a context rollover, 2950), assistant, toolResult…`. Block, verbatim (six words, two of them the `/skill` args, plan and Status):
```
Working set restored after a context rollover:

Recent user words (verbatim):
- Goal mode: run it to the end, I am going away, do not ask me questions. Change: add farewell(name) to src/greet.js returning "bye " + name, export it, and make test.sh check it (greet check must stay). Keep the plan small. Use the board. Write the plan doc to docs/plans/2026-10-16-farewell.md.
- Goal mode: run it to the end, I am going away, do not ask me questions. New change: add shout(name) to src/greet.js returning name.toUpperCase() + "!", export it, and make test.sh check it (keep the existing checks). Keep the plan small. Use the board. Write the plan doc to docs/plans/2026-10-16-shout.md. Before you start, read every file under .omp/skills/plan-sdd/references once.
- Controlled memory-reminder check, do exactly these board steps in order and nothing else, reading each xd:// tool schema first: (1) plan_create_run with title "memcheck" and project the current repo path, no tasks; (2) plan_memory_list for the project; (3) task tool with one recon-code agent, assignment "list the files under src and report their names", no writes; (4) plan_set_tasks with one task id M1 titled "memcheck", status ready; (5) plan_memory_add one entry saying "memcheck gate is ./test.sh" with source "test.sh". Report each tool result in one line.
- My codeword is MAGENTA-77. Add the line "Status: in progress" right under the title of docs/plans/2026-10-16-shout.md with the edit tool, then read that file back, then call context_notes to append the single line PIN-T18-1 to the notebook (keep existing lines). Reply in one line.
- Without calling any tool: quote your pinned note (context notebook) back verbatim, and state my codeword.
- What is 2+2? Reply with just the number.

Active plan: docs/plans/2026-10-16-shout.md
Status: in progress

Git branch: main
Worktrees:
- …/t18/repo                      50ce86f [main]
- …/t18/repo-wt-impl              eba29e5 (detached HEAD)
- …/t18/repo-wt-shout-impl        21648c9 [shout/impl]
- …/t18/repo-wt-shout-integration 460aa87 [integration/shout]
- …/t18/repo-wt-shout-spec        39886e3 [shout/spec]
- …/t18/repo-wt-spec              136d365 (detached HEAD)
- …/t18/repo-wt2                  8093a00 [feature-wt2]
```
The model answered the question that followed (`Without calling any tool: state my codeword and quote the last line of your pinned note.`) with `MAGENTA-77; PIN-T18-1` (read from the pane, not saved to `cap/`).

## Item 5: plan-memory reminders

Method: probe rows (`mem.py`), `<memory>` blocks per request, aligned with the journal's tool calls (`write xd://mcp__plan_sdd_…`). State dir `OMP_PLAN_MEMORY_STATE_DIR=…/t18/pmstate`.

Run 2 (the shout task, nothing instructed by me), block presence by request:
```
00:42:34.184 write xd://mcp__plan_sdd_plan_create_run
00:42:34.199 mem 1  "<memory>Project memory has not been read for this run: call plan_memory_list for the project and hand the entries to recon (references/memory.md, phase 0).</memory>"
  … present in every main request until …
00:49:28.694 write xd://mcp__plan_sdd_plan_memory_list
00:49:28.712 mem 0
```
Run 1 (the farewell task): the same reminder appeared at 00:36:21.490 (after `plan_create_run` at 00:36:21.463) and was gone at 00:37:46.008. The model never called `plan_memory_list` in run 1 (journal); what happened at 00:37:43 to 00:37:46 was two `plan_update_run` calls. From the source (`plugins/omp-plan-memory/index.ts:132`) a `plan_update_run` with `"status":"done"` sets `run=false`, which stops the reminder. That is my reading of the code, not something I changed.

Controlled step for the `write` reminder (the model skipped recon in both goal-mode runs, and the code requires a `recon*` task plus `plan_set_tasks`). User message at 00:53:08, steps (1) `plan_create_run` titled memcheck, (2) `plan_memory_list`, (3) `task` with one `recon-code`, (4) `plan_set_tasks`, (5) `plan_memory_add`. Rows:
```
00:53:19.315 write xd://mcp__plan_sdd_plan_create_run
00:53:19.337 mem 1 ['Project memory has not been read for this run: call …']
00:53:22.912 mem 1 (same)
00:53:24.939 write xd://mcp__plan_sdd_plan_memory_list
00:53:24.947 mem 0
00:53:27.502 task            00:53:29.566 wait
00:53:32.786 read xd://…plan_set_tasks   00:53:36.280 write xd://mcp__plan_sdd_plan_set_tasks
00:53:36.296 mem 1 ['Recon has reported and the task graph is written, bu…']
00:53:40.744 mem 1 (same)
00:53:43.018 write xd://mcp__plan_sdd_plan_memory_add
00:53:43.040 mem 0
```
The `write` text, verbatim from the probe:
```
<memory>Recon has reported and the task graph is written, but nothing was filed in project memory. If recon confirmed a gate command, run recipe, hard rule or exclusive resource that memory lacks or has wrong, file it with plan_memory_add (with its source); if there is nothing new, carry on.</memory>
```
In that step the model's `plan_set_tasks` failed once (`unknown task status 'ready'`), because I told it the status `ready`; that is my instruction's error, not the plugin's. The `tidy` reminder was not looked for. `ls ~/.local/state | grep -i omp-plan` printed nothing.

## Item 9: sidebar mouse

Fresh process, no `tui:` key in any config. Flags read with `tmux -L t18 display -p -t w '…#{mouse_any_flag}…'`, which is the pane's mouse-mode state as tmux tracked it from what omp wrote. Coordinates are SGR, 1-based. Sidebar occupies columns 163-200.

Before omp and right after start:
```
flag before omp: mouse_any_flag=0 mouse_sgr_flag=0 mouse_standard_flag=0
omp started, default: mouse_any_flag=0 mouse_sgr_flag=0 mouse_standard_flag=0
/sidebar status -> "Sidebar on, width 38, mouse off; pure extension, normal OMP"
```
`/sidebar mouse on`:
```
after mouse on: any=1 sgr=1 standard=1 button=0
/sidebar status -> "Sidebar on, width 38, mouse on; pure extension, normal OMP"
```
(The one-off notice line that `/sidebar mouse on` itself prints scrolled away before I captured; I used `/sidebar status` as the record.)

Heading rows (`rows.py`): `row 15 col 165 ▾ Git / Worktree`.

Click on a heading: sent `printf '\033[<0;170;15M\033[<0;170;15m'` through `tmux send-keys -l`. After it `rows.py` reads `row 15 col 165 ▸ Git / Worktree` and the Directory section moved up to row 16 (`cap/i9-click-git.txt`). A second identical click re-expanded it (`cap/i9-wheel-before.txt` shows the Git rows again).

Click did not take the keyboard: right after the first click I typed `/sidebar status` with `send-keys -l` and then `Enter`. Capture before Enter (`cap/i9-after-click-typed.txt`, rows 14-15):
```
╰─ /sidebar status
❯ status                          Show sidebar status
```
After Enter (`cap/i9-after-click-enter.txt` row 11): `Sidebar on, width 38, mouse on; pure extension, normal OMP`. The Git heading stayed collapsed through this.

Wheel inside the sidebar (`printf '\033[<65;180;25M'` x5, then `\033[<64;180;25M` x6). Sidebar column, rows 1-3 and 46-50:
```
BEFORE rows1-3: ['▾ Context ≈3.1%', '█░░░░░░░┃░░░░░░░░░░░░░░░░░░░░░░░░', '8.2K / 262K tokens']
BEFORE rows46-50: ['?? …/config.example.yml +71 −0', '?? …/references/board.md +262 −0', '?? …/dag-contract.md +300 −0', '?? …/references/dispatch.md +419 −0', '⌥⇧S focus  ⌥⇧B toggle']
AFTER 5 wheel-down rows1-3: ['main 50ce86f3', '…/scratchpad/t18/repo', '?? .omp/agents/adversary.md +62 −0']
AFTER 5 wheel-down rows46-50: ['?? …/references/review.md +379 −0', '?? …/worktree-mode.md +1131 −0', '?? …/plan-sdd/roles.md +665 −0', '?? …/test/roles.test.ts +189 −0', '⌥⇧S focus  ⌥⇧B toggle']
AFTER 6 wheel-up rows1-3: ['▾ Context ≈3.1%', '█░░░░░░░┃░░░░░░░░░░░░░░░░░░░░░░░░', '8.2K / 262K tokens']
```
Click outside the sidebar (`printf '\033[<0;50;10M\033[<0;50;10m'`): `grep -n '\[<\|0;50;10' cap/i9-click-outside.txt` returned nothing (rc=1); the editor line reads `╰─` empty. Typing `/sidebar status` and Enter after it ran the command (row 11 status line). The probe's terminal-input log has 0 occurrences of `0;50;10`: the SGR reports were consumed before the probe's listener, and the plain keys and the final `\r` were logged.

Flags after each way out, in one process (commands typed in the editor):
```
before /sidebar mouse off (expect on): any=1 sgr=1 standard=1
after /sidebar mouse off: any=0 sgr=0 standard=0
after /sidebar mouse on again: any=1 sgr=1 standard=1
after /sidebar off: any=0 sgr=0 standard=0
after /sidebar mouse on while sidebar was off: any=1 sgr=1 standard=1      (sidebar reappeared: "Sidebar on, width 38, mouse on")
after /new (session switch): any=0 sgr=0 standard=0
after /sidebar mouse on (post /new): any=1 sgr=1 standard=1
after /exit (mouse was on): any=0 sgr=0 standard=0
```
A second process with mouse on, ended with Ctrl-C, Ctrl-C, Ctrl-D: `second run mouse on: any=1`, then `after ctrl-c x2/ctrl-d: any=0`, shell prompt back.

### 9b. `tui.mouse: true`

Appended `tui:\n  mouse: true` to `repo/.omp/config.yml` (scratch file; restored from `config.yml.orig` afterwards; `grep -c tui` returns 0 again). Fresh process, with `tmux pipe-pane` writing the raw pty stream to `pty-mouse.raw`.
```
tui.mouse true, omp started: any=1 sgr=1
bytes before cmd: 1739963
after /sidebar mouse on: any=1 sgr=1
```
Message on screen (`cap/i9-tuimouse-on.txt`):
```
 Warning: Sidebar mouse: omp's tui.mouse already turns mouse reporting on and consumes every report before extensions see it. Turn tui.mouse off to use /sidebar
 mouse on.
```
Mouse-mode sequences in the pty stream (python regex `\x1b\[\?[0-9;]*[hl]`), whole stream: `?1000h` x1, `?1003h` x1, `?1006h` x1 (omp's own, written before the command); in the 697576 bytes written after the command: none of `?1000`, `?1003`, `?1006` (only `?7`, `?2004`, `?2026`, `?25`). After `/exit`: `any=0`. I did not send clicks in this mode (T9 already covered that they are swallowed by omp).

## Item 10: Pins marker after `/compact <focus>` and after rollover

Marker `PIN-T18-1`, appended by the model to the notebook at 00:55:23 (`context_notes` calls at 00:55:20 and 00:55:23). Window 200x100. Sidebar column, rows 89-99.

After `/compact keep the codeword and the pinned notes` (compaction `8f75af8f`, captured about 45 s after the command, `cap/i10-a-compact-focus.txt`):
```
 ▾ Pins                           10
   plan-sdd run state — shout featu…
   - Board run: 9836e307ea3e487f800…
   - DAG: all 6 nodes done (P, R0, …
   - Commits: S1 39886e3 (shout/spe…
   - Gate: sh test.sh prints ok, ex…
   - Phase 3 branch review: no find…
   - Memory: repo/shout-feature-gat…
  - Deliverable: integration/shout…
   - Plan doc: docs/plans/2026-10-1…
   PIN-T18-1
```
After plain `/compact` (rollover `bc3305e3`, `cap/i10-b-rollover.txt`):
```
 ▾ Pins                           10
   plan-sdd run state — shout featu…
   - Board run: 9836e307ea3e487f800…
   - DAG: all 6 nodes done (P, R0, …
   - Commits: S1 39886e3 (shout/spe…
   - Gate: sh test.sh prints ok, ex…
   - Phase 3 branch review: no find…
   - Memory: repo/shout-feature-gat…
  - Deliverable: integration/shout…
   - Plan doc: docs/plans/2026-10-1…
   PIN-T18-1
```
(The marker row has no indentation in the capture, same as in T9; the Pins header count is 10 in both.) After `/compact keep …` I asked the model to quote the notebook without calling a tool; its reply listed the first line `plan-sdd run state — shout feature DONE`, the other lines and `PIN-T18-1`, then `Codeword: MAGENTA-77` (`cap/i10-a-quote2.txt` lines 78, 93, 95).

## Findings (wrong or surprising behaviour), by impact

None of the four T9 defects reproduced. What I did see:

### F1. `Status:` is absent from the restore block when the plan doc has no `Status:` text (low)
Evidence: all three rollover blocks and no `Status:` line, while `Active plan:` was present from rollover 2. The two plan docs the model wrote (`docs/plans/2026-10-16-farewell.md`, `…-shout.md`) have no `Status:` text; after I had the model add `Status: in progress`, blocks 3b and 3c show it. The plugin only copies a `Status:` line from the doc (`index.ts:214-216`), so this depends on the skill's plan doc template being followed. In this goal-mode run it was not. I did not check whether `skills/omp/references/plan-spec.md` asks for a Status header.

### F2. plan-memory `read` reminder can stop without `plan_memory_list` (low, by design as I read the code)
Evidence: run 1 (00:36:21 to 00:37:46): reminder cleared after `plan_update_run` with status done, no `plan_memory_list` in the journal. The run was marked done at that point, so nothing was lost; it means the reminder is not proof the model read memory.

### F3. `write` reminder needs a recon `task`; a goal-mode plan-sdd run without recon never shows it (low, observation)
Evidence: runs 1 and 2 dispatched no `recon*` agent (journal) and no `write` reminder appeared; with a `recon-code` task added in the controlled step it appeared.

### F4. The one-off notice of `/sidebar mouse on` was not captured (test gap)
I read `/sidebar status` instead; the toggle itself is shown by the flags.

### Not wrong, noted
- Threshold 70000 gave 3 rollovers in about 15 minutes of the plan-sdd runs and no loop warning was on screen at the times I captured. The model called the board through `write xd://…` (journal has no failed `bash plan_*` attempts), which is what T17 documented.
- No Kimi quota message appeared.

## Hygiene

- Kimi only (`kimi-code/kimi-for-coding-highspeed`, `--model` and the aliases); no key, token or credential read, printed or copied.
- `~/.omp/agent/config.yml` mtime `1792096853` and `extensions/sidebar` mtime `1792099460`, before (`baseline-before.txt`) and after (`baseline-after.txt`): identical. Nothing written to `~/.claude`, OpenCode config or `~/.local/state` (`ls ~/.local/state | grep -i omp-plan` empty). omp's own db files under `~/.omp/agent` changed because omp ran.
- Real board 18888: health before `{"port":18888,"runs":20,"ok":true,"version":"0.3.0"}`, after `{"version":"0.3.0","ok":true,"port":18888,"runs":20}`. Scratch board 18999 ended with `runs:3`; I killed it (pid 57209), `lsof -iTCP:18999 -sTCP:LISTEN` empty. The BossSDD process 82388 (started Oct 13) is the real board's listener on 18888 and was not touched.
- tmux server `t18` killed (`no server running on …/t18`). omp processes: `pgrep -x omp` before the run printed `4956` and after the run prints `4956`; that is a pre-existing omp on `s008` that is not mine and was not touched. None of mine remain.
- `~/.omp/agent/custom-session-files/`: 23 entries at the start (28 after my runs counting five new pointers). The five new pointers pointed into `…/t18/sess`. Removed three whose targets no longer existed: `ad13fdc`, `cb32600`, `db7cef4` (empty sessions omp deleted). Left two whose targets exist: `c027a06` (the main session journal) and `d324d96` (`…01a1423a-a983….jsonl`). 25 entries now.
- Tracked files: none edited (`git status --short` in the T18 worktree is empty apart from this report once written). Nothing staged, committed or pushed. The scratch test repo's own `.omp/config.yml` was temporarily changed for 9b and restored.
