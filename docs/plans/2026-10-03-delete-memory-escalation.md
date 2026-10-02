Status: running
Run id: f53f044f6df2491284fa3d15507b2819
Base ref: 95ac1395eaecec62ef0a83ee233d343bc6659715
Project memory: on
Integration branch: plan/2026-10-03-delete-memory-escalation
Main working tree: /Users/zhang/Project/boss-sdd
Integration worktree: /Users/zhang/Project/boss-sdd-worktrees/integration
Updated: 2026-10-03

`Base ref` is the replacement value, not the phase-0 one. Phase 0 recorded
`0eef1b3`; the approved design mock and this document were then committed as
`95ac139`, and the integration branch is cut from that.

# Board deletion, the app's memory pane, and the escalation rework

## Background

Three unrelated gaps arrived in one request, plus a fourth that is the same body
of text as the third. What is true today, with the paths:

**Nothing can take junk off the board — but less is missing than it looks.**
`mcp/main.go` registers eleven tools and none of them deletes anything. The live
board carries two runs tombstoned by hand, both with the same note: *"board 无删
除接口，以 done+本说明收口"* — a `done` status that is a lie, plus an apology in
a field meant for progress. It has fired twice.

The premise is only half true, though, and the half that is false matters.
`DELETE /api/runs/{id}` already exists (`Sources/BoardKit/API.swift:233-235`),
`Store.deleteRun` already implements it (`Sources/BoardKit/Store.swift:234-242`),
and the schema already cascades — `tasks`, `task_lists` and `events` all carry
`REFERENCES runs(id) ON DELETE CASCADE` (`Store.swift:113`, `:130`, `:134`). So
deleting a run is a plumbing job one layer below where the tombstones were
written. Deleting a **task** is genuinely absent everywhere: no `Store.deleteTask`,
no HTTP route, and `TaskStatus` has no `cancelled` or `void` member.

**Project memory is write-and-forget from the human side.** Four MCP tools read
and write it; the app window shows none of it. `memory.md` puts real weight on a
human looking: the cap is 100 and a write at the cap is *refused outright* with
nothing evicted, `source` exists so an entry is cheap to falsify, and the
tidy-up is supposed to read the whole list every fifth closed node. All of that
assumes someone can see it. Today the only way is to be an agent.

**The escalation rework exists on one machine.** `~/.claude/skills/plan-sdd/` is
a copy, not a symlink. Eight files there carry a week of hand edits replacing the
3-round fix cap with escalation keyed on whether a failing item is *new* or
*persisting*, and removing the `[complexity: high]` → strong-tier route. The
public repository still teaches the 3-round cap, in all three packagings.

That local copy also contradicts itself. `PLAYBOOK.md:114`, inside goal mode's
stop-and-hand-back list, still reads *"A single node has failed three fix/review
rounds"* — in the same file whose lines 59 and 358-375 abolished that cap. Right
now, in goal mode, the all-new path has no written stop at all.

## Goals

1. An agent that created a junk run or a junk task removes it with one MCP call,
   and afterwards `plan_board_status` and `plan_get_run` show no trace — no
   tombstone, no `done` that means void.
2. Opening the board window and switching to the memory view shows, for the
   project the selected run belongs to, every memory entry with its key, its
   value and its `source`, grouped by kind, with a live count against the 100
   cap. The view updates when an agent writes a memory while the window is open.
3. The repository teaches the new/persisting escalation rule; all three
   packagings agree with each other about it; and goal mode terminates on every
   path, including the all-new one.
4. The user's local install and the repository hold the same text.

## Non-goals

- **No write path in the app.** `Sources/BossSDD/BoardModel.swift:8` states the
  invariant: *"Writes only ever arrive over HTTP; the UI is a read-only view of
  the store."* No add, no edit, no delete, and no delete affordance on a run or
  task either. The user asked for delete **on MCP**, by name.
- **No delete-from-the-memory-pane**, tempting as it looks next to a stale entry.
  `memory.md` is explicit that a delete is safe only *after* checking the
  `source`; a one-click delete in a list is precisely a delete without that check.
  The pane's job is to make staleness visible. Acting on it stays the agent's.
- **No soft delete, trash, undo or archive.** The storage already does a hard
  cascading delete. A tombstone layer would re-implement the exact workaround
  this is meant to remove. Guards at the moment of deletion are a different
  thing and are in scope.
- **No search box in the memory pane.** `README.md` and `memory.md` both say
  "there is deliberately no search". A client-side filter by `kind` is in; a
  query box is out.
- **The escalation rule is not re-litigated.** It ships as the user wrote it:
  the classification, the tie-break to persisting, the no-step-down, the
  top-rung stop. Two carve-outs only, both decided by the user: the round
  ceiling (D3 below) and the unsourced model sentence (D4 below).
- **Skill-text edits are bounded by contradiction, not adjacency.** A file that
  now states something false changes; a file that merely discusses fix rounds
  does not.
- **Not touching the app's other views**, the dependency graph, or the sidebar
  beyond adding one segment to the existing view switcher.

## Design decisions already made

**D1. Deleting a task refuses rather than repairs.** If other tasks declare it in
`depends_on`, or it is `running`/`review`, the call fails and names what is in
the way. *Beat:* silently stripping the dangling `depends_on` entries. *Why:* the
board's existing two write guards both refuse rather than repair, and stripping
edges mutates tasks the caller did not name — which is how a board stops being
trustworthy. **User decision, 2026-10-03.**

**D2. Deleting a `running` run refuses; every other status deletes and cascades.**
*Beat:* unconditional delete. *Why:* an active run is one an agent is mid-way
through. **User decision, 2026-10-03.**

**D3. A hard ceiling of 6 total rounds, under the escalation rule, not replacing
it.** Whatever the classification, after 6 rounds the node is `blocked` and says
so. **A "round" here is a turn of the fix loop, not the node's first
implementation attempt** — the body already defines it that way at
`PLAYBOOK.md:272-273` ("a round is one turn of the fix loop inside a node"), so
the ceiling is 6 rework rounds and 7 agent turns in all. Pinned 2026-10-03 after
S1's implementer asked; the definition predates this plan, but D3 did not cite
it and "6 total rounds" read both ways on its own. The classification keeps deciding tier and whether to resume. *Beat:*
restoring the 3-round cap; leaving it unbounded. *Why:* the persisting path
already terminates (sonnet→opus→fable→fable, four rounds); the all-new path does
not, and goal mode runs unattended. 6 leaves two rounds of headroom for genuine
found-something-else rounds. **User decision, 2026-10-03.**

**D4. The sentence "With `sonnet` 5.5 the reasoning rung writes that code well
enough…" is deleted, and the tier change keeps its structural justification.**
*Beat:* sourcing it; keeping it as-is. *Why:* the verified platform-facts table
(`docs/plans/2026-09-18-boss-sdd-hardening.md:64`) lists bare aliases
`opus`/`sonnet`/`haiku`/`fable` with no version numbers, so there is nothing for
"sonnet 5.5" to be checked against. And `roles.md:384-385` flags a weaker
unsourced claim in its own margin — the file knows how to mark an unverifiable
assertion and did not here. The remaining argument (strong tier is better spent
on `reviewer` and `spec-reviewer`; `[complexity: high]` still buys a fuller
`<background>`) needs no model version. **User decision, 2026-10-03.**

**D5. The friction on deletion lives in the skill text, not in the tool.** Both
delete tools take plain arguments. The discipline — when an agent may call them —
is prose in `board.md`, following the precedent `memory.md` set for
`plan_memory_delete`. *Beat:* requiring a parameter only a caller who read the
run could supply. *Why:* consistency with the repository's existing choice.
**User decision, 2026-10-03.**

**D6. Memory writes start calling `notify()`.** `Store.swift:360-364` deliberately
skips it today, on the reasoning that memory changes do not affect the board
state observers exist to re-read. Once a memory pane exists, they do. *Beat:* a
manual refresh button; polling. *Why:* the app's entire update model is
store→notify→reload, and a second mechanism for one pane is a second model.

**D7. The memory pane follows the selected run's project, resolved to the
repository.** `memory.md`: *"`project` is the repository, not the directory you
happen to be working in … a node's worktree path is not a project and must never
be sent as one."* The live board has a run whose `project` is
`/Users/zhang/Project/agent-remote/.worktrees/t1-theme`, so this resolution is
load-bearing, not hypothetical. The pane strips a trailing `/.worktrees/<name>`,
shows the repository path in the subtitle, and says so when the run's own
`project` differed. *Beat:* an independent project picker in the pane. *Why:* the
sidebar selection already drives every other view; a second navigation model in
one window is worse than the edge case it solves. **Approved by the user as the
design mock, 2026-10-03.**

**D8. `plan_delete_run` reuses the existing HTTP route; the guard goes in the
store.** Not a new endpoint. The `running` refusal belongs next to the existing
transition guards, so the HTTP API gets it too.

## Tasks

### D1 — `plan_delete_run`, with the `running` guard

- `depends_on`: []
- `write_scope`: `mcp/main.go`, `mcp/tools_test.go`, `Sources/BoardKit/Store.swift`,
  `Tests/BoardKitTests/StoreTests.swift`, `Tests/BoardKitTests/APITests.swift`
- `exclusive_resources`: []
- role: `implementer`
- **Acceptance.**
  - `cd mcp && go build ./...` exits 0.
  - `cd mcp && go test ./...` exits 0.
  - `swift build -c release --product BossSDD` exits 0.
  - `swift test` exits 0.
  - A new Go test asserts `plan_delete_run` is registered and issues
    `DELETE /api/runs/{id}`.
  - A new store test: deleting a `done` run removes it, and its tasks and events
    are gone from the database (cascade observed, not assumed).
  - A new store test: deleting a `running` run throws, the run is still present
    afterwards, and the error names the status.
  - A new store test: deleting an unknown id throws `notFound`.
  - A new store test: every status **except** `running` is deletable. Added
    2026-10-03 — D2 says "every other status deletes and cascades" and these
    criteria only ever asked about a `done` run, so the plan under-covered its
    own design decision. The gap was in this document, not in the code.
- **Risk / rollback.** The guard sits in `Store.deleteRun`, which the HTTP API
  already calls, so a mistake here changes behaviour for an existing endpoint as
  well as the new tool. Rollback is the node's branch.

### D2 — `plan_delete_task`, full stack, with both refusals

- `depends_on`: [`D1`]
- `write_scope`: `mcp/main.go`, `mcp/tools_test.go`, `Sources/BoardKit/Store.swift`,
  `Sources/BoardKit/API.swift`, `Tests/BoardKitTests/StoreTests.swift`,
  `Tests/BoardKitTests/APITests.swift`
- `exclusive_resources`: []
- role: `implementer`
- **Acceptance.**
  - All four build/test gates exit 0, as in D1.
  - `DELETE /api/runs/{runId}/tasks/{taskId}` exists and is reachable.
  - Deleting a task no other task depends on removes it; the returned graph
    projection is `valid: true` and no longer lists it.
  - Deleting a task that another task lists in `depends_on` fails, the response
    names **every** blocking task id, and the task is still present afterwards.
  - Deleting a `running` task fails and names its status. Same for `review`.
  - Deleting an unknown task id fails with `notFound`.
  - **Every status except `running` and `review` is deletable.** Added mid-run,
    the same correction D1's acceptance needed: the criteria above only ever ask
    about the two refusals, so nothing required coverage of the statuses that
    must still delete. The implementer wrote the test anyway; this makes it
    required rather than volunteered.
  - Its `task_lists` rows are gone from the database after a successful delete.
- **Risk / rollback.** Shares every file with D1, which is why it depends on it
  rather than batching beside it. The dependents check has to read the whole
  run's tasks inside the same transaction as the delete, or a concurrent write
  can slip an edge in between the check and the delete.

### M1 — memory reaches the app, and memory writes notify

- `depends_on`: [`D2`]
- `write_scope`: `Sources/BoardKit/Store.swift`, `Sources/BossSDD/BoardModel.swift`,
  `Tests/BoardKitTests/MemoryTests.swift`
- `exclusive_resources`: []
- role: `implementer`
- **Acceptance.**
  - `swift build -c release --product BossSDD` and `swift test` both exit 0.
  - `upsertMemory` and `deleteMemory` call `notify()`; a new test registers an
    observer, writes a memory, and asserts the observer fired.
  - `BoardModel` exposes the selected run's project memories, with the project
    resolved per D7 (a trailing `/.worktrees/<name>` stripped).
  - A test covers the resolution: a run whose project is
    `/x/repo/.worktrees/t1` reads the memories stored under `/x/repo`.
  - **`deleteMemory`'s existence check moves inside the transaction.** Added
    mid-run. It runs `SELECT 1 …` inside `queue.sync` but outside
    `database.transaction`, then opens the transaction to delete — the same
    shape D1 fixed in `deleteRun` and D2 kept out of `deleteTask`, and the last
    instance of it in the file. M1 is editing that function for the `notify()`
    change anyway. Structural, no happy-path behaviour change, so no race test
    is required or wanted.
  - *(Moved to M2 mid-run.* The criterion used to read "`BoardView` gains a
    memory case alongside the existing graph and columns cases." It cannot be
    met inside M1's write scope: `BoardWindow.swift:28-32` switches
    exhaustively over `model.view`, so adding a case is a compile error until
    that switch grows a branch, and `Sources/BossSDD/Views/` is M2's. M1 would
    have had to fail its own `swift build` criterion or write out of scope.
    M2 now owns the case, the switch and the switcher together.*
- **Risk / rollback.** Adding `notify()` to memory writes wakes every observer on
  every memory write, including the tidy-up's deletes. If a run prunes twenty
  entries, that is twenty reloads. Watch for it in the walkthrough; batching is
  the fallback.

### M2 — the memory pane

- `depends_on`: [`M1`]
- `write_scope`: `Sources/BossSDD/Views/`, `Sources/BossSDD/BoardModel.swift`,
  `Resources/en.lproj/Localizable.strings`,
  `Resources/zh-Hans.lproj/Localizable.strings`
  - `BoardModel.swift` added mid-run, for the `BoardView` enum case only — see
    M1's moved criterion. M1 and M2 both write that file, which is safe because
    they are sequential, the same way D1 and D2 shared `Store.swift` and
    `mcp/main.go`.
- `exclusive_resources`: `app:bossSDD`, `port:18888`
- role: `ui-designer`, `qa`
- **Design source.** `design/board-mock.html`, the memory view, approved by the
  user on 2026-10-03. Build what it shows, not a reinterpretation of it.
- **Acceptance.**
  - `swift build -c release --product BossSDD` and `swift test` exit 0.
  - `./Scripts/bundle.sh` exits 0 and produces `.build/BossSDD.app`.
  - `BoardModel.BoardView` gains a `memory` case, `BoardWindow.swift`'s switch
    gains the matching branch, and the switcher renders three segments. Note
    the trap: `BoardModel.swift:24` builds the label with a ternary,
    `loc(self == .graph ? "board.view.graph" : "board.view.columns")`, so a
    third case silently labels itself "columns" unless that line changes too.
    Both `Localizable.strings` files need the new key.
  - Walkthrough against a throwaway store (`BOSS_SDD_HOME` set to a temp
    directory, seeded over HTTP — **never the real board**): the view switcher
    shows a third segment; selecting it lists the seeded memories grouped by
    kind in the order `gate`, `run_recipe`, `convention`, `hard_rule`,
    `exclusive_resource`, `note`; empty kinds do not appear; each row shows key,
    value and source; selecting a row fills the inspector with the full value and
    the full source.
  - The subtitle shows the repository path, and for a run whose project is a
    worktree path it shows the repository, not the worktree.
  - The cap counter reads `n / 100` and changes colour at 80.
  - Writing a memory over HTTP while the window is open updates the list without
    reopening the window.
  - Every new user-visible string resolves in both `en.lproj` and `zh-Hans.lproj`
    — screenshot in each language.
- **Risk / rollback.** The only task carrying `qa`, and the only one contending
  for the installed app and port 18888. The existing mock is Chinese-only while
  the app is bilingual, so the English strings are new writing, not translation
  of something already reviewed.

### S1 — the shared body: escalation rework, the ceiling, and the defects

- `depends_on`: []
- `write_scope`: `skills/shared/PLAYBOOK.md`, `skills/shared/roles.md`,
  `skills/shared/references/dispatch.md`, `skills/shared/references/dag-contract.md`,
  `skills/shared/references/worktree-mode.md`, `skills/shared/references/review.md`
- `exclusive_resources`: []
- role: `implementer`
- **Acceptance.** No machine gate exists for Markdown (recon lane A: *"Skills are
  pure Markdown… no check mode"*), so every criterion here is a read:
  - The eight files' worth of escalation text from `~/.claude/skills/plan-sdd/`
    is present in `skills/shared/`, by diff: `diff -r` between the repo's
    `skills/shared/` and the install's `shared/` reports no difference in the
    escalation text.
  - `PLAYBOOK.md:114`'s goal-mode stop condition states the 6-round ceiling (D3),
    not "three fix/review rounds".
  - `references/review.md` no longer says "if the rounds have run out".
  - `roles.md` no longer contains the string `5.5`, and the tier paragraph still
    argues the structural case (D4).
  - `roles.md`'s "no `[complexity: high]` variant row for `qa`" paragraph no
    longer explains the absence of a row that no longer exists for anyone.
  - `references/worktree-mode.md`'s "One collision, one round" section no longer
    uses the **old three-round cap's** vocabulary. Amended mid-run: this
    criterion originally read "no round-budget vocabulary (`charged`, `spent`)
    for a budget that is gone", which D3 falsified by putting a budget back. The
    section must carry a count stake keyed to the 6-round ceiling — two other
    files cite it for exactly that ruling — so `spend` is correct there and
    `charged` is not. Overturn by restoring the original wording, which would
    then require the section to stop making the count argument.
  - `grep -rn "three rounds\|3 rounds\|round 3\|third round\|rounds have run out"
    skills/shared/` returns nothing.
  - **And so does the hyphenated form**, which the line above cannot match:
    `grep -rniE "three[- ]round|3[- ]round|three failed|three attempts"
    skills/shared/`. Added mid-run: `worktree-mode.md:11`'s *"three-round
    limit"* — singular and hyphenated — sat in S1's own write scope through two
    rounds while every grep above passed. The greps search the plural
    unhyphenated form only, so they could not see it.
- **Risk / rollback.** The one task where the acceptance is entirely human
  reading. It is also the task most likely to drift from the user's own wording,
  which is explicitly out of scope to change.

### S2 — the three wrappers agree

- `depends_on`: [`S1`]
- `write_scope`: `skills/claude-code/SKILL.md`, `skills/cursor/SKILL.md`,
  `skills/codex/codex-platform.md`, `skills/claude-code/agents/implementer.md`,
  `skills/claude-code/agents/ui-designer.md`, `skills/cursor/agents/implementer.md`,
  `skills/codex/agents/implementer.toml`, `skills/codex/agents/ui-designer.toml`
- `exclusive_resources`: []
- role: `implementer`
- **Acceptance.**
  - `skills/claude-code/SKILL.md:52` no longer says "Form A on rounds 1 and 2,
    Form B on round 3"; it states the new-vs-persisting rule as the body does.
  - `skills/codex/codex-platform.md:67` no longer says "what changes is rounds 1
    and 2 — not round 3".
  - `skills/cursor/SKILL.md` and `skills/cursor/agents/implementer.md` match.
  - The two Codex role TOMLs' `# Raise to high for a task marked
    [complexity: high]` comments are gone or corrected (D4 removed that route).
  - `grep -rn "round 3\|rounds 1 and 2\|round of three" skills/` returns
    nothing, and so does
    `grep -rniE "three[- ]round|3[- ]round" skills/claude-code/ skills/cursor/
    skills/codex/`. The second is not redundant: `skills/cursor/SKILL.md:172`
    says *"reports as an ordinary three-round"*, which the first grep cannot
    match. It is in S2's write scope.
  - Per the README's wrapper contract, no wrapper restates a body rule in its own
    words; each states only its platform fact and points at the body.
- **Risk / rollback.** This is exactly the drift that produced the last cleanup —
  wrappers paraphrasing body rules. The acceptance above is written to catch a
  fix that re-introduces it.

### S3 — the delete discipline, and the tool count

- `depends_on`: [`D2`, `S2`]
- `write_scope`: `skills/shared/references/board.md`,
  `skills/shared/references/memory.md`, `README.md`,
  `skills/claude-code/INSTALL.md`, `skills/cursor/INSTALL.md`,
  `skills/codex/README.md`, `skills/claude-code/SKILL.md`, `.gitignore`
- `exclusive_resources`: []
- role: `implementer`
- **Acceptance.**
  - `board.md` gains a section on when an agent may call `plan_delete_run` and
    `plan_delete_task`, written to the standard `memory.md` sets for
    `plan_memory_delete` — including that a delete is irreversible, that the two
    refusals exist and what they mean, and that in confirm mode this is a
    stop-and-ask (D5).
  - `board.md:148`'s *"this node has stopped: three failed rounds"* is corrected
    to the ceiling.
  - The delete discipline says that a deleted task's **`events` rows stay in the
    run's history**, and that the task list and the graph — not the event log —
    are authoritative for what exists. Added mid-run; see the Decision queue.
  - Every stale tool count reads thirteen. The check is
    `grep -rni "eleven" README.md skills/`, not `"[Ee]leven tools"` — the
    narrower phrase misses three of the seven sites, because two put a
    backticked token inside the phrase (`skills/claude-code/SKILL.md:54`,
    `skills/cursor/INSTALL.md:202`) and one says "eleven tool names"
    (`skills/cursor/INSTALL.md:146`). That grep is allowed exactly one
    surviving hit: `skills/claude-code/INSTALL.md:104`'s *"Do not add an
    eleventh"*, which counts the **ten role files**, not the tools, and is
    correct as it stands. Changing it is the failure this criterion is written
    to prevent. The tool list in `skills/claude-code/INSTALL.md:150` and
    `skills/cursor/INSTALL.md:131` also names both new tools.
  - `memory.md:12`'s *"the board's seven"* reads nine.
  - The counts match reality: the number of `mcp.AddTool` calls in `mcp/main.go`
    equals the number written in the documentation.
  - `.gitignore`'s comment says ten role files, not nine.
- **Risk / rollback.** Depends on D2 because the discipline cannot be written
  before the refusals are settled, and on S2 because it writes
  `skills/claude-code/SKILL.md`'s neighbourhood. Landing last is deliberate.

### Graph

```
layer 1   D1          S1
layer 2   D2          S2
layer 3   M1   S3
layer 4   M2
```

## Run recipe

From recon lane C, with sources.

- **Build and bundle:** `./Scripts/bundle.sh` → `.build/BossSDD.app`.
  `./Scripts/bundle.sh --install` also replaces `/Applications/BossSDD.app` and
  `pkill -x BossSDD` first (`Scripts/bundle.sh:80`). Internally:
  `swift build -c release --product BossSDD` plus a `GOOS=darwin GOARCH=arm64 go
  build` of the MCP binary.
- **Run the app in development:** `swift run BossSDD`.
- **Store:** `~/.claude/plan-sdd/board.sqlite3`. **Override with
  `BOSS_SDD_HOME`** (absolute path) — every walkthrough must do this. The real
  board is live user data.
- **Port:** 18888 by default (`mcp/client.go:19-22`, `defaultPort = 18888`),
  override with `BOSS_SDD_PORT`. Returned by `GET /api/health`.
- **MCP registration:**
  `claude mcp add --scope user plan-sdd /Applications/BossSDD.app/Contents/Resources/plan-sdd-mcp`
- **Environment:** macOS 14+, arm64, Swift 6, Go 1.20+, SQLite3 linked.
- **No service has to be running first.**

## Risks and open items

- **The memory pane is the first thing in this app that reads a table nothing
  watched before.** D6 changes that; if the reload cost shows up in the
  walkthrough, batching the notify is the fallback and it is a design change, not
  a fix round. M1 made the shape of it concrete: the cost is not N
  wakeups, it is N wakeups each carrying M extra queries, because `reload()` asks
  for memories once per distinct run project. Measured on the live board rather
  than guessed — 15 runs over 5 distinct projects — M is 5, and `allRuns()`
  already costs 1 + 15x4 = 61 queries on the same reload, so the memory loop adds
  under a tenth of what was already there. The term that actually scales is the
  reload *count*, not the queries inside one: a prune of N entries is N notifies
  and so N full reloads, each blocking the main thread. So the walkthrough
  watches a burst of memory writes for visible stutter; isolating the loop's own
  cost would be measuring the wrong term, and batching the notify is still the
  fallback if the burst shows a problem.
- **S1's acceptance is entirely human reading.** There is no Markdown gate in
  this repository. The static reviewer and the spec reviewer are the only checks
  those three tasks get, which is an argument for not letting them batch with
  anything that would compete for attention.
- **The mock is uncommitted.** `design/board-mock.html` has the approved memory
  view in the working tree and not in any commit. It is the design input to M2
  and gets committed before the run starts.
- **`.gitignore:22` still says "The skill's nine role files".** Stale since the
  `spec-reviewer` backport made it ten. Folded into S3's scope.
- **Two runs on the live board are tombstoned.** Once D1 lands they can actually
  be deleted. That is a user action on live data, not a task.
- **The legacy import is a second, unguarded path to the same rows, and it is
  live.** `Sources/BossSDD/Views/MenuBarContent.swift:27` wires the menu bar's
  "Import from legacy JSON" button to `BoardModel.importLegacyRuns()`
  (`BoardModel.swift:116`), which has no emptiness check — unlike
  `importLegacyRunsIfEmpty()` at `:109`, which the startup path uses.
  `Store.importRun` then runs an unconditional `DELETE FROM runs WHERE id = ?`
  and the schema cascades. Verified against the live board: both legacy JSON
  files in `~/.claude/plan-sdd/runs/` name ids that exist as runs right now, and
  `fc46951c` has genuinely diverged — the JSON holds `status: running` with an
  in-progress summary while the row holds `status: done` with its closure
  summary. Clicking that menu item today reverts a finished run. D1's guard
  closes the HTTP delete path and does not touch this one. Out of D1's write
  scope and filed as separate work, not folded into this run.
- **Six raw `"/api/runs/"+in.Run` concatenations survive in `mcp/main.go`**
  (`:248, 262, 281, 292, 314, 327`). Pre-existing; D1's new call site is the
  only one using `url.PathEscape`. Not exploitable — the API is loopback-only
  and the caller already holds every tool — but an id containing `/` changes
  the route's shape before `isValidRunID` ever runs, so "validation gates every
  path" is false. D2 and S3 both touch this file; D2 is the natural place to
  close it.
- **`Scripts/verify.sh`'s live stage checks that the real board file is
  untouched** (`verify.sh:21-24`, `74-75`, `330-331`) and fails the run if its
  mtime or size changed. Any walkthrough that forgets `BOSS_SDD_HOME` will be
  caught here — but after the damage.

- **`tasks.position` was a dense `0..n-1` invariant and nothing said so.**
  `writeTask` is its only writer and `applyTaskPatch` calls it with the task's
  index in the in-memory array, which `loadRun` built with `ORDER BY position`.
  `importRun` renumbers densely. So rank, index and position were always equal
  — and `deleteTask` is the first operation in the codebase that can break
  that, because a plain `DELETE FROM tasks` leaves a hole and the next appended
  task is written at `position = count`, which collides with or precedes a
  surviving row. `deriveGraph` orders its layers from that array, so
  `topological_order` and `topological_layers` change shape after a
  delete-then-add, in a projection whose own doc comment calls it
  deterministic. Found by D2's static review, verified here, sent back to D2
  with a renumbering statement inside the same transaction and a
  delete-then-add test. Recorded because the invariant was undocumented: any
  future operation that removes a task row has the same trap waiting.

## Decision queue

- **D1's acceptance gained a criterion mid-run** (every non-`running` status is
  deletable). The spec review found the plan under-covered design decision D2;
  the implementer had already written the test. Adding the criterion corrects the
  document rather than lowering the bar — the code was ahead of the plan, not
  behind it. Overturn by deleting the criterion; the test would then be an
  unrequested addition rather than a required one.
- **D1's refusal message was ruled a change, not a nit.** Both the spec reviewer
  and the adversary left it `unsure` and explicitly to the orchestrator. The old
  wording stopped at "set the run to another status" and named no follow-up, and
  the obvious other status for a finished run is `done` — the exact tombstone
  this plan exists to kill, in the one sentence an agent reads at the moment it
  is refused. Ruled: name the follow-up, do not name `done`. Overturn by
  reverting to the shorter sentence; the acceptance criterion ("the error names
  the status") is met either way, which is why this was a judgement call.
- **S1's "One collision, one round" carve-out was ruled explicit, not
  restructured.** The reviewer traced the mechanics and found them reconcilable:
  a conflict at 8b and the gate failure at 8c are one round. But the ceiling
  makes the count material, and nothing at the ceiling's own sites said so, so
  two agents counting toward 6 could diverge. Ruled: add a clause at the ceiling
  sites, leave the collision section alone. Overturn by deleting the clause and
  accepting the ambiguity.

- **S1 round 2 was ruled *persisting*, so it escalated.** Round 1's F6 asked for
  the collision carve-out and the ceiling to be reconciled by adding a clause at
  the ceiling sites and leaving the collision section alone. The clause landed,
  but the section's justification was rewritten from the round count to the
  model tier, so the two ceiling sites now cite it for a count ruling it no
  longer makes. That is the same seam, moved — which the rule defines as
  persisting, and the rule's own tie-break sends an unsure call the same way. So
  round 2 went up a rung to `opus` on a fresh subagent with the full bundle,
  rather than resuming cheaply. Recorded because the cheap read was available
  and was not taken: calling it *new* would have kept the node on `sonnet`.
- **Defect C and design decision D3 pull against each other, and that is the
  plan's fault rather than the implementer's.** Criterion 4 told S1 to strip the
  round-budget vocabulary from "One collision, one round" because "the budget it
  refers to is gone"; D3 then put a budget back. The implementer followed
  criterion 4 to the letter and produced the contradiction above. Round 2's
  brief states both constraints and asks for both to be satisfied. Overturn by
  dropping criterion 4's requirement for that one section.

- **A deleted task's `events` rows stay. Ruled, after the spec review reframed
  the question.** I had flagged the opposite gap — that `deleteTask` writes no
  event while every other mutation does (`Store.swift:204, 223, 377`). The lane
  argued, and I accept, that an `action: "delete"` row naming a task that no
  longer exists is closer to a tombstone than to history, which is the shape
  this plan exists to remove. The real asymmetry runs the other way: the task's
  *old* `task`-action events survive, because `events` is foreign-keyed only to
  `runs`, so `plan_get_run --include_events` returns rows whose `task_id` names
  nothing. Ruled: keep them and write the rule down rather than purge them. An
  event log is history, not state; deleting a task does not unmake the fact that
  it ran, and a delete that silently rewrites a run's history is a worse
  surprise than a dangling id. Goal 1's "no trace" is about run and task state,
  which is clean. Closed in S3's `board.md` discipline instead of in code.
  Overturn by deleting the task's `events` rows inside the same transaction —
  one statement in `Store.swift` plus one test.
- **A combined `running`-plus-dependents refusal names only the status.**
  `Store.swift:272` throws before the dependents check runs, so a task that is
  both costs two round trips. Accepted as-is: the status refusal is the more
  urgent of the two, and the message tells the caller what to do. Overturn by
  collecting both and naming them together.
- **S1's tie-break citation was swapped, and I am letting it stand.** The user's
  paragraph inverted "this skill's standing *when you cannot decide, it counts*
  bias"; the implementer re-aimed it at the escalation rule's own tie-break
  (`roles.md:385`). The spec review flagged this as the edit closest to the
  do-not-re-litigate line. Ruled: not a re-litigation. The carve-out's output is
  a classification, so the escalation tie-break is the one it actually inverts,
  and the general bias survives untouched at `review.md:295` — verified. The
  user's reasoning shape survives too, re-aimed rather than dropped.
- **Two S1 edits nobody asked for by name, both kept.** `PLAYBOOK.md:228-231`
  (the `[complexity: high]` tier sentence) and the new delegation sentence at
  `worktree-mode.md:11-13`. The first was a named finding from the round-1
  review, which the spec lane could not see; the second is forced, because the
  file now restates the ceiling at six sites and "leaves it alone" could not
  stand. Both fall under the non-goal's "bounded by contradiction, not
  adjacency". Recorded rather than passed over in silence.
- **My S1 dispatch invented an acceptance criterion the plan does not have.**
  The dispatch's criterion 8 ("state the maximum number of rounds and cite every
  file and line") appears nowhere in this document — the spec lane caught the
  drift. It is benign and the answer it forces is useful, but it means the
  dispatch and the plan disagreed about what the bar was. Not folded into the
  plan: it is a reporting instruction, not a property of the deliverable.
- **Nothing records a node's round count, and D3 made the count load-bearing.**
  `roles.md:402` says to record the classification and the tier per round, not
  the number. `worktree-mode.md:798` and `:847` both presume a count exists
  without saying where it lives. Inherited — the same silence existed under the
  old cap — but the ceiling now depends on it, and this run's own S1 rulings
  worried about two agents counting differently. Deferred rather than folded
  into S1, which is on the top rung with one round left; adding non-essential
  work there risks the node for a gap that predates it.

- **`roles.md:385` keeps no "except" clause for the collision carve-out.**
  `roles.md:413` and `PLAYBOOK.md:386-387` cite the carve-out only for the
  count stake; the tier stake lives only in `worktree-mode.md`, whose header now
  settles precedence in its own favour for that one section. Ruled: leave it.
  The carve-out states openly that it inverts the standing tie-break, so a
  reader arriving from either direction is told, and `roles.md:385` is a
  sentence the user wrote — editing it is what the non-goal forbids. Overturn by
  adding the except clause there, which is a small edit but a change to the
  user's own rule text.

## Needs a decision from the user

Empty at the time of writing. The four questions raised at the end of recon were
answered on 2026-10-03 and are recorded as D1–D5 above.

## Gates

Per task, run by the orchestrator, one command at a time, never piped:

```
swift build -c release --product BossSDD
swift test
cd mcp && go build ./...
cd mcp && go test ./...
```

At phase 3, on the integration worktree, additionally:

```
./Scripts/verify.sh
```

Recon lane A found **no formatting gate and no lint gate** in this repository,
for either language, and **no gate of any kind for the Markdown under
`skills/`**. That is a finding, not an omission in this plan: S1, S2 and S3 have
no machine check, and their acceptance criteria above are written as reads
because that is all there is.

Tests may run concurrently: Swift tests build their own UUID-named temp
directories (`Tests/BoardKitTests/StoreTests.swift:1-12`) and Go tests each start
their own `httptest` server (`mcp/client_test.go:14-19`).

## Worktrees

Under `/Users/zhang/Project/boss-sdd-worktrees/` — a **sibling** of the main
working tree, not `.worktrees/` inside it. `.gitignore` does not ignore
`.worktrees/`, so creating them inside would leave `?? .worktrees/` in the user's
`git status` for the length of the run. Adding an ignore rule to make the inner
path legal would be a write to the user's repository for the orchestrator's
convenience, so the trees moved instead.

One worktree per node on its own `node/<id>` branch, cut from the integration
branch's **current tip** at dispatch time (not from the base ref — a node whose
dependencies are `done` needs their merged work in its tree). Plus the
integration worktree, where every merge and every post-merge gate runs. The main
working tree at `/Users/zhang/Project/boss-sdd` stays on `main` and is never
checked out to the integration branch.

## Delivery steps, after phase 3

Not DAG nodes — they write outside the repository or act on live data, and they
need the merged result:

1. Rebuild and reinstall the app: `./Scripts/bundle.sh --install`.
2. Sync the local skill install from the merged repository, per
   `skills/claude-code/INSTALL.md` (`rm -rf` + `cp -RL`), then `diff -r` to
   confirm it matches.
3. Refresh this project's `.claude/agents/`.
4. Delete the two tombstoned runs from the live board, with the user watching.
