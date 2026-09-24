---
name: plan-sdd
description: >-
  Survey the project, write a spec-backed task DAG (dependencies, write scope,
  exclusive resources), then dispatch independent subagents to implement and
  review the nodes in dependency order while tracking every state change on a
  live local board. Use when the requirement is roughly settled and the change
  spans several steps or several files. Two modes: confirm mode asks when a
  question would change the outcome; goal mode (user says "run it to the end",
  "I'm going away", or passes --goal) drives the whole plan to close-out without
  waiting for replies, parking anything it cannot answer instead of guessing.
  Not for a one-line fix, an explanation, a diagnosis, or a status question.
  Invoke explicitly with /plan-sdd.
---

# Plan SDD on Cursor

**The body of this skill is [shared/PLAYBOOK.md](shared/PLAYBOOK.md). Read it now
and follow it.** It holds the four phases, the non-negotiables, the DAG contract,
the dispatch prompt structure, the review protocol, the gate discipline, and the
role roster. Where this file touches one of its rules, it is to say what Cursor's
behaviour does to that rule. The rule itself lives there.

This file is the Cursor wrapper. It answers only what the shared body leaves to
the platform; the headings below say which questions those are.

Where this file and the shared body disagree about procedure, the shared body
wins. This file adds platform facts; it does not relax any rule.

## The honesty notice that governs everything below

Every Cursor fact in this file was read out of Cursor's own documentation on
2026-09-18. **This packaging itself has still never been installed and run.**
What has since been run in Cursor is a separately evolved copy of the skill, not
this one, so that experience does not transfer line by line to what is written
here — it is worth more than the documentation where the two disagree, and worth
nothing where it never touched the same question.

So two provenances live in this file, and each statement belongs to exactly one.
The default is the documentation of 2026-09-18. Where a statement instead comes
from running the skill in Cursor, the section says so on the spot and names what
was observed; absent that marker, read it as documentation nobody has executed.

The sections marked "Not settled" are not settled. Check them against your own
installation before you rely on them, and when your installation disagrees with
this file, your installation is right.

## Dispatching a subagent

Roles are defined as Cursor subagents, one file per role, at
`.cursor/agents/<name>.md`. Nine files, one per role in
[shared/roles.md](shared/roles.md).

Cursor reads six subagent directories, three project-level and three user-level:
`.cursor/agents/`, `.claude/agents/`, `.codex/agents/`, and the same three under
your home directory. That is documented, not inferred, and so is what happens
when two of them hold the same role name: "Project subagents take precedence when
names conflict. When multiple locations contain subagents with the same name,
`.cursor/` takes precedence over `.claude/` or `.codex/`." See "Two installations
in one project" below for what that does and does not settle.

Cursor also ships three built-in subagents: Explore, Bash and Browser. They are
not substitutes for these nine. A role in this skill is a set of four commitments
plus a model tier, and a built-in agent carries none of them.

**Parallel dispatch works.** The verified source says an agent "sends multiple
Task tool calls in a single message, so subagents run simultaneously". So the
shared body's instruction to dispatch recon lanes, node batches, and review lanes
in parallel, in one message, means on Cursor exactly what it says, and you should
carry it out rather than falling back to serial dispatch.

**Not settled: how you launch one.** The verified source establishes that several
dispatches in one message run simultaneously. It does not give the call an
orchestrator writes to start a subagent, and this wrapper does not supply one.
Use whatever your version exposes, and put several of them in one message. Do not
read a dispatch form out of the skill-invocation syntax: how a *skill* is invoked
is documented and is a different mechanism from how a *subagent* is dispatched,
and the first settles nothing about the second.

**Resuming a subagent works, so use Form A.**
[shared/references/dispatch.md](shared/references/dispatch.md) has two rework
messages: Form A, a short one to the subagent that did the work, and Form B, the
full context bundle to a fresh subagent. Cursor supports resuming: each subagent
execution returns an agent ID, and passing that ID back resumes the subagent with
its context preserved. That is the whole of what the source says. It says nothing
about background execution specifically, so do not hold a node open waiting to
resume an agent you launched in the background.

So keep each node's agent ID with the node, alongside its diff baseline, and send
Form A when a node fails review. Two things that do not change: it still counts
as one round of the three, and the subagent is still told which round it is on.

Form B stays the fallback for the case where you no longer have a usable agent
ID. Then it is the full context bundle to a fresh subagent, counted as the same
round rather than starting the count over. Take the bundle's blocks off the list
in [shared/references/dispatch.md](shared/references/dispatch.md) each time; that
list is the only place the bundle is defined, and no number for it is written
here on purpose. What you must not do is send Form A's three short blocks to a
fresh subagent: it would have no working directory, no goal, no write scope, no
rules and no acceptance commands, and it will improvise all five.

## The roles and their models

Valid model identifiers on Cursor: `inherit`, `composer-2`, `composer-2.5`,
`gpt-5.6-sol`, `claude-opus-5`. Bracket parameters are `fast`, `effort`,
`context`, written onto the ID, as in `claude-opus-5[effort=high,context=300k]`
or `composer-2.5[]`. **Cursor's documentation lists these IDs without ranking
them.** The tier mapping in [shared/roles.md](shared/roles.md) is a placement,
not a measurement, and the section there on which axis carries the rung explains
what to re-tune first.

| Role | Tier | `model` | `readonly` |
| --- | --- | --- | --- |
| `recon-rules` | reading | `composer-2` | `true` |
| `recon-code` | reading | `composer-2` | `true` |
| `recon-product` | strong | `claude-opus-5` | `true` |
| `implementer` | reasoning | `composer-2.5` | `false` |
| `ui-designer` | reasoning | `composer-2.5` | `false` |
| `qa` | reasoning | `composer-2.5` | `false` |
| `reviewer` | strong | `claude-opus-5` | `true` |
| `branch-reviewer` | strong | `claude-opus-5` | `true` |
| `adversary` | reasoning | `composer-2.5` | `true` |

`readonly: true` is set on six of the nine. The three recon lanes, `reviewer`,
`branch-reviewer` and `adversary` all say "you change nothing" in their identity
line, and the flag is there to make that a platform constraint rather than a
request. Do not drop it to make a lane "more useful". A reviewer that can edit is
no longer an independent review.

**What `readonly` gates.** It is a boolean, default `false`. Set to `true`, "the
subagent runs with restricted write permissions (no file edits, no state-changing
shell commands)". So reading is not restricted: `adversary` keeps `git log -S` and
`git blame`, `reviewer` keeps its `git diff`, `recon-code` keeps its reading, and
every readonly lane keeps `grep`, `rg` and `find`.

The one consequence worth planning around: a readonly lane cannot run a build or
a test suite, because those change state. No role in the roster is asked to, since
the gates are yours to run under
[shared/references/gates.md](shared/references/gates.md). What it means in
practice is that anything a readonly lane needs from executing state-changing
work has to reach it in its dispatch prompt, produced by you. A lane reporting
that it could not run something is telling you where that evidence has to come
from; it is not a reason to drop the flag.

**`is_background` is left at its default.** It is a boolean, default `false`, and
the nine agent files do not set it. The field is settled, so leaving it alone is
something this packaging chose: the shared
body's phase 2 loop reads a node's diff, runs its gates and reviews its work
while the node is open, so an orchestrator has nothing to do with a node it has
handed off and cannot watch. The documented resume path is by agent ID, and the
source says nothing about resuming specifically in the background, so keeping the
default is also the option that keeps Form A on documented ground.

`qa` is deliberately not `readonly`. It runs the application, and a walkthrough
needs fixtures, seed steps and test accounts, which touch state. Its limits are
in the dispatch prompt, per
[shared/references/review.md](shared/references/review.md).

`inherit` appears in the table only as a value you may set deliberately. It gives
a role the session's model, which collapses that role onto whatever rung the
session happens to be on and defeats the routing.

**Not settled: per-dispatch model override.** A `.cursor/agents/<name>.md` file
carries one `model`. The verified source does not say whether the model can be
overridden when a subagent is launched. Two rows of the roster need that:
`implementer` and `ui-designer` move from `composer-2.5` to `claude-opus-5` on a
`[complexity: high]` task, and the escalation reserve is
`claude-opus-5[effort=high]`. If your version supports an override, use it. If it
does not, the roster's defaults stand, and you must record in the node's status
detail that the node ran one rung below what its complexity called for. Editing
the agent file mid-run to fake the escalation changes the role for every node
still running against it; do not.

Everything else about tiers, stepping down, and the judgment-role floor is in
[shared/roles.md](shared/roles.md).

## The board

Status tracking runs through the `plan-sdd` MCP tools:
`plan_board_status`, `plan_create_run`, `plan_update_run`, `plan_set_task`,
`plan_set_tasks`, `plan_graph`, `plan_get_run`, `plan_memory_list`,
`plan_memory_get`, `plan_memory_add`, `plan_memory_delete`. Check once, at the
start, whether they are in your toolset, and take one of the three paths in
[shared/references/board.md](shared/references/board.md).

The board is optional. The skill runs without it; what you lose and what you do
not is in that file. If the tools are absent, say so once and keep the state in
the plan document. Do not stop, and do not ask the user to install anything
mid-run.

## Goal mode has to bind to Cursor's own Goal

**Source: use, not documentation.** `CreateGoal` and `UpdateGoal` are named here
because a run in Cursor used them, not because the 2026-09-18 documentation
describes them. If your installation spells them differently, the spelling is
what changes; the rule below does not.

The shared body's goal mode is a way of running: you stop asking at reversible
decision points, park what you cannot answer, and report once at the end. Cursor
tracks a goal of its own. These must be one record rather than two that drift.

**A run in goal mode creates a Cursor Goal before its first dispatch and updates
it every time a node reaches `done` or `blocked`.** `CreateGoal` at the start,
`UpdateGoal` at each close. This is required, not encouraged, and the reason is
what goal mode is for: it is the mode where nobody is watching, and the Goal is
the only place a user who walks back in can read where the run got to without
reading the entire transcript. A goal-mode run with no Goal behind it reproduces
exactly the blindness the mode exists to remove.

**If the Goal cannot be created or updated, you are not in goal mode.** A missing
tool or a failed call is not something to note and run past. Say so, drop to
confirm mode, and carry on asking at the decision points goal mode would have
skipped. Confirm mode needs no Goal because the user is present at every one of
them and is the record. What you must not do is keep the autonomy and lose the
record, which is the one combination that leaves nobody able to say what happened.

## Cursor's native reviewer, and whether you can invoke it

Phase 3 of [shared/PLAYBOOK.md](shared/PLAYBOOK.md) runs two branch reviews: the
skill's own six `branch-reviewer` lanes, always, and the platform's native
reviewer on top. Here is the Cursor half of that, split into what is documented
and what is not.

**Documented.** Cursor's native reviewer is `/review-bugbot`, and `/review` is a
synonym. It reviews every change relative to the base branch, committed and
uncommitted. It reads its review rules from `.cursor/BUGBOT.md`. On a pull
request, commenting `bugbot run` or `cursor review` triggers it.

**Not documented, and this is the question the shared body could not settle:**
whether an agent can invoke it, or whether it is user-typed only. The verified
source confirms the command exists and says what it reviews. It says nothing
about an agent-facing entry point. **So this wrapper cannot settle it for you,
and it does not pick the convenient answer.**

Check your own installation, in this order:

1. Look through the skills, commands and tools your session actually exposes for
   a Cursor code-review entry, and match on what it does rather than on its name.
   If you find one you can call, call it, and triage its output like any other
   review.
2. If you find nothing you can call, it is a handoff. Ask the user to type
   `/review-bugbot`, take back what it reports, and triage that. The wording is
   in
   [shared/references/native-review-handoff.md](shared/references/native-review-handoff.md).
3. **Default to the handoff.** An entry point you did not actually see in your
   tool list does not exist.

What a handoff rules out, and what to do in goal mode when nobody is there to
type the command, are both in `native-review-handoff.md`, linked in step 2. They
apply here unchanged and are not restated in this file.

A separate check the user can run in a few seconds: type `/review-bugbot` once
themselves. That confirms the command exists in their Cursor version, which is
not the same question as whether you can invoke it, but it does tell you whether
step 2 is even available.

## Worktrees, and why Cursor's own isolation is not one

The shared body puts every node in its own git worktree and offers no second
mode; see "Where the nodes write" in
[shared/PLAYBOOK.md](shared/PLAYBOOK.md) and
[shared/references/worktree-mode.md](shared/references/worktree-mode.md). That is
a different axis from Cursor's own subagent isolation feature. The two get
confused because both sound like "every agent gets its own copy", and this
section exists to keep them apart, because the answer for Cursor is different for
each.

**Cursor's default is a shared checkout, hazard included.** The verified source:
"Subagents share the parent agent's checkout by default. When several subagents
edit files at once, they can overwrite each other's changes." That is precisely
the premise non-negotiable 5 of the shared body is written on, where `write_scope`
and `exclusive_resources` are the only thing making parallel dispatch safe.

**Cursor's own isolation is something you ask for in the dispatch.** Cursor can
run subagents each in their own environment, and the documented way to get that
is to ask for it in natural language in the dispatch itself, along the lines of
"each in its own environment". The verified source records no named
configuration switch for it: nothing in `.cursor/agents/<name>.md` frontmatter
turns it on, and this skill ships no configuration for it.

A request can go unhonoured, and a dispatch prompt that asked for isolation looks
identical to one whose request landed. So treat isolation as requested, never as
granted, and check it rather than inferring it. Two ways: put in the dispatch's
output contract that the subagent must report `git rev-parse --show-toplevel` and
the full path of one file it wrote, and compare that root with the one you are
sitting in; or, after it returns, run `git status` in your own tree and see
whether the node's changes are sitting there. Until one of those says otherwise,
you are on the shared checkout.

What it buys when you do get it is narrower than it sounds: a stray write from
one node no longer lands in a sibling's working tree mid-edit, which keeps your
scoped diff read and your staging clean. What it does not buy is a branch, a
merge step, an integration branch, or a post-merge gate. **Isolation obtained
this way is not the worktree the body requires**, and it changes nothing about
scheduling: batch by non-overlapping `write_scope` and honour
`exclusive_resources` exactly as the body says, because a checkout you asked for
politely is not a guarantee and because file isolation never covered ports,
devices or test locks anyway.

**The real thing is available on Cursor, and it needs nothing from that
feature.** The orchestrator runs `git worktree add` itself and hands each node
its tree by filling that node's `<working_directory>` block with the path.
`worktree-mode.md` closes by asking each platform wrapper which of two cases
applies: Cursor is the second one, a subagent run against a directory you created
by hand. So Cursor's shared-checkout default does not rule it out, and nothing
here should be read as ruling it out. What it does mean is that the platform
automates none of it. Creating each tree, cutting it from the integration
branch's current tip, committing, merging, and then running the node's gates
**again on the merged result**, which is the run that decides whether the node is
`done`: all of those are yours, in the order `worktree-mode.md` gives them.

Read that file before you set anything up, and read it there. What it costs, what
it protects, how a node closes, and what happens when a merge goes red are its
rules, not this wrapper's, and a summary of them here would be one more copy to
drift out of date.

**One Cursor-specific thing to settle in phase 0 rather than assume**, because
the body has no fallback and the answer therefore decides whether a run can
start: that a subagent you dispatch actually reads and writes in a worktree path
outside the project root. The verified table has no row on where a Cursor
subagent may work, so this wrapper claims nothing either way. Check it with the
same `git rev-parse --show-toplevel` question as above, on one throwaway
dispatch, before there is a plan to abandon. If it comes back in the project root
instead, say what you ran and what it returned, and stop there.

## Two installations in one project

This repository ships three packagings of the same skill, and Cursor reads the
other two platforms' directories as well as its own: eight skill locations, the
project-level `.cursor/skills/` and `.agents/skills/` plus the compatibility
`.claude/skills/` and `.codex/skills/`, each of those also under your home
directory, and in a monorepo a `.cursor/skills/` anywhere in the repository; six
subagent directories, listed under "Dispatching a subagent" above. So more than
one packaging in one project means Cursor can load the same skill twice, and can
pick up an agent roster whose `model` values are not Cursor model IDs at all.

**For roles, the conflict resolves, and in your favour.** Same-name subagents
have a documented precedence: project over user, and `.cursor/` over `.claude/`
or `.codex/`. A `reviewer` in `.cursor/agents/` therefore wins over a `reviewer`
the Claude Code packaging left in `.claude/agents/`, so a stray copy of that
roster does not silently hand you a role naming a model Cursor has never heard
of. Take that as a resolution and no further: the losing copy is still on disk,
and anyone reading the repository has no way to tell which roster is live.

**For skills, nothing resolves.** No precedence is published for two skills of
the same name in two of those eight locations, and this wrapper will not invent
one from the subagent rule, which is about a different mechanism. So a duplicate
skill install is unresolvable by reasoning: you cannot tell which copy answered.

Install exactly one packaging per project. If you find duplicates, stop and tell
the user which paths hold them rather than guessing which one is authoritative.

The commands that find duplicates are in this packaging's `INSTALL.md`, which
lives in the repository next to the source of this file and is **not** copied
into the installed directory. If you are reading this as an installed skill you
cannot open it, and you do not need it: the three read-only checks it holds are
`find` and `ls` over the eight skill locations and the six subagent directories
named above, and you can write them yourself from that list. Point the user at
the repository copy when it is the user who has to act.

## Facts this wrapper does not have

What this packaging needed and the verified source does not have. Do not fill any
of it from memory or from another platform's column; go to Cursor's own
documentation for your version.

- How Cursor registers an MCP server. That is why this skill ships no Cursor MCP
  configuration, and why absent `plan-sdd` tools are the ordinary no-board path in
  [shared/references/board.md](shared/references/board.md) rather than an error to
  debug mid-run.
- The call an orchestrator writes to dispatch a subagent. That several dispatches
  in one message run simultaneously is settled; the call form is not.
- Whether a model can be overridden per dispatch.
- How to wait on a subagent that is still running.
  [shared/references/dag-contract.md](shared/references/dag-contract.md) tells you
  to wait through the platform's subagent completion mechanism rather than poll in
  a loop; the verified source names no such mechanism for Cursor. It documents an
  agent ID that resumes a finished subagent, which is a different thing. Until you
  find one in your own session, do not build a polling loop to fill the hole and
  do not treat a node as finished because you stopped hearing from it.
- Whether `/review-bugbot` is invocable by an agent, and which copy of a skill
  wins when the same name is installed twice. Both are treated above.
