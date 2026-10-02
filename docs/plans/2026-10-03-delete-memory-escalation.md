Status: awaiting_confirmation
Run id: f53f044f6df2491284fa3d15507b2819
Base ref: 0eef1b3af90e7ddb38cb69d3157a3c19e1d500c0
Project memory: on
Integration branch: plan/2026-10-03-delete-memory-escalation
Main working tree: /Users/zhang/Project/boss-sdd
Integration worktree: (created on approval — see "Worktrees")
Updated: 2026-10-03

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
so. The classification keeps deciding tier and whether to resume. *Beat:*
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
  - `BoardView` gains a memory case alongside the existing graph and columns
    cases.
- **Risk / rollback.** Adding `notify()` to memory writes wakes every observer on
  every memory write, including the tidy-up's deletes. If a run prunes twenty
  entries, that is twenty reloads. Watch for it in the walkthrough; batching is
  the fallback.

### M2 — the memory pane

- `depends_on`: [`M1`]
- `write_scope`: `Sources/BossSDD/Views/`, `Resources/en.lproj/Localizable.strings`,
  `Resources/zh-Hans.lproj/Localizable.strings`
- `exclusive_resources`: `app:bossSDD`, `port:18888`
- role: `ui-designer`, `qa`
- **Design source.** `design/board-mock.html`, the memory view, approved by the
  user on 2026-10-03. Build what it shows, not a reinterpretation of it.
- **Acceptance.**
  - `swift build -c release --product BossSDD` and `swift test` exit 0.
  - `./Scripts/bundle.sh` exits 0 and produces `.build/BossSDD.app`.
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
    uses round-budget vocabulary (`charged`, `spent`) for a budget that is gone.
  - `grep -rn "three rounds\|3 rounds\|round 3\|third round\|rounds have run out"
    skills/shared/` returns nothing.
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
  - `grep -rn "round 3\|rounds 1 and 2\|round of three" skills/` returns nothing.
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
  `skills/codex/README.md`
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
  - Every "eleven tools" string reads thirteen:
    `grep -rn "[Ee]leven tools" README.md skills/` returns nothing, and the tool
    list in `skills/claude-code/INSTALL.md:150` and `skills/cursor/INSTALL.md:131`
    names both new tools.
  - `memory.md:12`'s *"the board's seven"* reads nine.
  - The counts match reality: the number of `mcp.AddTool` calls in `mcp/main.go`
    equals the number written in the documentation.
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
  a fix round.
- **S1's acceptance is entirely human reading.** There is no Markdown gate in
  this repository. The static reviewer and the spec reviewer are the only checks
  those three tasks get, which is an argument for not letting them batch with
  anything that would compete for attention.
- **The mock is uncommitted.** `design/board-mock.html` has the approved memory
  view in the working tree and not in any commit. It is the design input to M2
  and gets committed before the run starts.
- **Two runs on the live board are tombstoned.** Once D1 lands they can actually
  be deleted. That is a user action on live data, not a task.
- **`Scripts/verify.sh`'s live stage checks that the real board file is
  untouched** (`verify.sh:21-24`, `74-75`, `330-331`) and fails the run if its
  mtime or size changed. Any walkthrough that forgets `BOSS_SDD_HOME` will be
  caught here — but after the damage.

## Decision queue

Empty. Confirm mode; nothing was decided without asking.

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

Not created yet — confirm mode stops at this document. On approval, one worktree
per node cut from the integration branch, plus the integration worktree, under
`/Users/zhang/Project/boss-sdd/.worktrees/`. The user's main working tree at
`/Users/zhang/Project/boss-sdd` is theirs and is not checked out to the
integration branch at any point.

## Delivery steps, after phase 3

Not DAG nodes — they write outside the repository or act on live data, and they
need the merged result:

1. Rebuild and reinstall the app: `./Scripts/bundle.sh --install`.
2. Sync the local skill install from the merged repository, per
   `skills/claude-code/INSTALL.md` (`rm -rf` + `cp -RL`), then `diff -r` to
   confirm it matches.
3. Refresh this project's `.claude/agents/`.
4. Delete the two tombstoned runs from the live board, with the user watching.
