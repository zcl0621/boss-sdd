---
name: plan-sdd
description: >-
  Survey the project, write a spec-backed task DAG (dependencies, write scope,
  exclusive resources), then dispatch independent subagents to implement and
  review the nodes in dependency order while tracking every state change on a
  live local board. Use when the requirement is roughly settled and the change
  spans several steps or several files. Every run starts with a short
  discussion the user confirms. Two modes: confirm mode asks when a question
  would change the outcome; goal mode (user says "run it to the end", "I'm
  going away", or passes --goal) drives the whole plan to close-out without
  waiting for replies, parking anything it cannot answer instead of guessing.
  Not for a one-line fix, an explanation, a diagnosis, or a status question.
---

# Plan SDD on omp

The method lives in [PLAYBOOK.md](PLAYBOOK.md). Read it now, in full, before
doing anything else, and follow it. It is the source of truth for the phases,
the DAG contract, the dispatch brief, the review protocol, and the gate
discipline.

This file holds the omp bindings and nothing more: which tool each mechanism the
playbook names is on omp, where the role definitions live, and what is and is
not known about each. **Where this file and the playbook disagree on which
tool, this file wins; on behaviour, the playbook wins.** Nothing here is licence
to soften a non-negotiable.

Citations. `omp's docs/...` is a file in the omp repository
(`https://github.com/can1357/oh-my-pi`), never a path in this one. Source paths
such as `task/types.ts` are under `packages/coding-agent/src/` there, and were
read at omp 18.11.1. Repository files of this project that do not get installed
are cited as plain paths rather than linked.

Load this skill with `/skill:plan-sdd`, or let omp pick it by its description.
omp discovers skills under `~/.omp/agent/skills/<name>/` and
`<project>/.omp/skills/<name>/`, one level below `skills/` (omp's
`docs/skills.md`, "Provider-discovered layout"); [INSTALL.md](INSTALL.md) puts it
in the first.

## The bindings

| Where the playbook says | On omp it means |
| --- | --- |
| "dispatch a subagent" | one `task` call (omp's `docs/tools/task.md`, "Inputs"). Its item fields are `name`, `agent`, `task`, `solutionSpace` (`task/types.ts`, `taskItemSchema`). `agent` is the role name, exactly as the file in `~/.omp/agent/agents/` names it (`plan-reviewer` for the `reviewer` role, see [roles.md](roles.md)); `task` is the brief; `solutionSpace` is one line saying how open the problem is (`one fix: scope and tests given`, `cause open, no repro`). There is no `model` field: the model comes from the agent file, see "the model binding" below. Give each subagent a `name` (CamelCase, at most 32 characters, for example `T3Impl`) so its `agent://<id>` is easy to hold, and record the id the spawn acknowledgement returns, since omp uniquifies a name per session |
| "issue several such calls in one message" | one `task` call in the batch shape, `context` plus a list of `tasks`, with one entry per subagent, each entry with its own `agent` (`task/types.ts`, `taskSchemaBatch`; `task.batch` defaults on, omp's `docs/tools/task.md`). `context` is required and non-empty; it lands in every subagent's system prompt (`CONTEXT` section), so put one line there that is true for all of them (run title, repository root) and keep every per-subagent datum in that entry's `task`. The fan-out is bounded by `task.maxConcurrency`; extra entries queue |
| "where role definitions live" | `~/.omp/agent/agents/<role>.md` (user) or `<project>/.omp/agents/<role>.md` (project): the ten files in [agents/](agents/), loaded as each subagent's system prompt. omp skips `.claude/agents`, so a Claude Code install does not carry over (omp's `docs/task-agent-discovery.md`) |
| "the model binding" ([roles.md](roles.md)) | the one table under "Model bindings" in [roles.md](roles.md). Each row is an alias such as `@sdd-implementer`; the agent file carries it as `model: "@alias"` and `modelRoles` in `~/.omp/agent/config.yml` maps it to a concrete model ([config.example.yml](config.example.yml)). Rows that differ per dispatch (`implementer.high_complexity`, `implementer.obstacle_escalation`) are served by `task.agentModelOverrides`, under the one-at-a-time procedure in [roles.md](roles.md) |
| "resume the subagent" (Form A in [dispatch.md](references/dispatch.md)) | `write` with `path: agent://<id>` and the delta as `content`: omp's follow-up message to a finished subagent. A finished, non-isolated subagent stays registered as `idle`, is parked after `task.agentIdleTtlMs` (default 420000 ms) and is revived by this write (omp's `docs/tools/task.md`, "Flow" steps 15-16, and "Notes" on messaging a parked agent); the revived session is reopened from its transcript file with its full history (`createWarmSubagentReviver`, `task/executor.ts:3880-3939`), so an in-process park keeps the model it started on. The cold path, for an agent from an earlier omp process, rebuilds the session from the persisted contract and re-resolves the model alias (`task/persisted-revive.ts:180-183`), so a cold revive does not guarantee the same model. The reply is an owner-routed job: it arrives like the first return and `wait` blocks on it (`task/executor.ts:3178-3196`). Resumable means: you started it with `isolated` unset, you hold its id, it ended by finishing or by a soft budget stop, and you have the `write` tool (omp's follow-up hint is only shown when peer messaging is enabled). Not resumable, so Form B: one that was aborted by a signal, timeout or hard abort (a kill tombstone, `task/executor.ts:3464-3467`), one omp reports as isolated, one from an earlier omp process (see "Not established"), and one whose id you no longer hold. If the `write` reply is an error, do not retry blindly: make a Form B fresh dispatch with the full bundle. The errors are "Peer messaging is unavailable in this session" (`internal-urls/agent-protocol.ts:183`), "Failed: <id> is not running" or "could not receive the message" (`irc/messaging.ts:92`), and a revive failure (`irc/bus.ts:137-153`) |
| "act on each return as it arrives" | `async.enabled` defaults to true (`tools/settings.ts:892-896`), so `task` returns at once with `Spawned agent <id>` and each result is injected into the conversation when its subagent finishes; act on it then. Call `wait` only when you are completely blocked: it returns on the first settled job or peer message. Never poll (omp's `docs/tools/wait.md`, "Behavior"; "Results auto-deliver; NEVER poll" is `prompts/tools/task-async-contract.md:1`). If `async.enabled` is off, the `task` call blocks until every entry returns; work through all of them |
| "each node's own worktree" ([worktree-mode.md](references/worktree-mode.md)) | trees you create with `git worktree add` and name in each node's `<working_directory>`. Leave the `task` item's `isolated` field unset: it only exists when `task.isolation.enabled` is on, it is not this procedure, and omp reports an isolated run as not resumable (`prompts/tools/task-follow-up.md`) |
| "your platform's todo list" ([PLAYBOOK.md](PLAYBOOK.md), "Todo list") | omp's `todo` tool (omp's `docs/tools/todo.md`). Each call is one op: `init`, `start`, `done`, `drop`, `block` (with a `reason`), `unblock`, `rm`, `append`, `view`. The schema takes a single op per call. omp normalizes the list after every op: it never keeps more than one item `in_progress` (a `start` demotes the current one to `pending`; an `init` that sets two keeps the first, `tools/todo.ts:128`), and whenever no item is `in_progress` and a `pending` one exists it promotes the first `pending` item (`tools/todo.ts:128-141`, `:514`, `:528`). That covers `done`, `block` or `drop` as much as `done` alone. So: (a) write the items in the order you will dispatch them, so the item omp promotes by itself is the next one you will start; (b) for a parallel batch mark the lowest-numbered node `in_progress` and leave its siblings `pending`, and when a sibling is still running `start` it before you `done`, `block` or `drop` the current one; (c) when nothing is running and pending items remain, omp shows the first pending one as `in_progress`: that is a display artefact, the plan and the board are the truth, so start that node next or `start` the one you actually dispatch. There is no rename op, so keep a node's stage (`review`, `rework (E1)`) in the plan and the board and leave the item's text alone; `rm` plus `append` would move the item to the end. A blocked node uses the native `block` op with its reason, and `unblock` when it clears; `drop` is the cancelled state; `view` reads the list back after a compaction |
| "the goal feature" ([goal-mode.md](references/goal-mode.md)) | omp's goal mode: `/goal <objective>`, which the user types, or `omp --goal "<objective>"` at launch (omp's `docs/cli-reference.md`, flag `--goal`; it needs `goal.enabled`). The `goal` tool only joins your toolset once goal mode is on (`tools/index.ts:628-633`), so you cannot start it; see below. Auto-continue is for the interactive and RPC modes: `--goal` is refused in print mode (`cli/args.ts:132`) and a `-p` run does not resume an idle session, so do not rely on goal mode there |
| "the prompt-review skill" (the dispatch preflight) | the `prompt-engineer` skill, loaded once per run with `read skill://prompt-engineer` when it is installed (omp's `docs/skills.md`, "`skill://` URL behavior"). The user may also load it with `/skill:prompt-engineer` |
| "the helper skill for messages to the user" (phase P) | the `shuorenhua` skill, loaded once per run with `read skill://shuorenhua` when it is installed (omp's `docs/skills.md`, "`skill://` URL behavior") |
| phase P renders (P1 before/after, P4 options) | the `show-me` skill, loaded once per run with `read skill://show-me` when it is installed (omp's `docs/skills.md`, "`skill://` URL behavior"); [greenfield-prelude.md](references/greenfield-prelude.md) wins where the two disagree. Not verified on omp: that the page it opens reaches the user's browser from an omp session |
| phase P explorers and architects | explorers: the bundled `scout` agent on a `task` call, with the model `task.agentModelOverrides.scout` names; `scout` is read-only with no `bash` (`tools: read, find, grep, glob, web_search`, `prompts/agents/scout.md`), so it cannot run `git`. Architects: you make the design call yourself, or dispatch the bundled `task` agent, which has full write capability (`task/agents.ts:48-56`). The task item's `tools` field does not restrict it: it only names tools already defined in the parent's eval kernel (omp's `docs/tools/task.md`, "Inputs"). So architects are read-only by instruction only, in their brief and in [greenfield-architect.md](references/greenfield-architect.md); a read of the working tree after P4 catches a write. Two or three architects in one batch share the one binding `general.architect` and one override on `task`, which is fine: the "alone until finished" rule in [roles.md](roles.md) is about dispatching a different binding of the same agent while an override is set |
| "the `plan-sdd` MCP tools" ([board.md](references/board.md)) | the thirteen `plan_*` tools of the board server, registered under the key `plan-sdd` in `~/.omp/agent/mcp.json` per [INSTALL.md](INSTALL.md). omp mints their names as `mcp__plan_sdd_plan_board_status` and so on (`mcp/tool-bridge.ts:416-429`), and mounts them behind `write` as `xd://` devices by default (`tools.xdev`, omp's `docs/settings.md`; omp's `docs/mcp-runtime-lifecycle.md`, "Connected manager tools"), so the check "are the tools in my toolset" is `read xd://` for the list and `read xd://mcp__plan_sdd_plan_board_status` for the schema; you then call a tool with `write` on that URI and one JSON object as `content` (omp's `docs/tools/write.md`). When the top-level function list shows them directly, call them as functions |
| "branch reviewer" (omp's own, phase 3) | omp's `/review` and `/annotate code-review` are slash commands typed by the user, so for you they are a handoff (`extensibility/custom-commands/bundled/review/index.ts:379-384`); the bundled `reviewer` agent can be dispatched with `task` (`task/agents.ts:44-73`). Both are covered, with their caveats, in [references/native-review.md](references/native-review.md) |

## Dispatching a role

One `task` entry per subagent. Three fields carry the contract:

- `agent`: the role name, exactly as the file in `~/.omp/agent/agents/` names
  it. Never invent a role; the roster is fixed at ten in [roles.md](roles.md).
- `task`: the brief, built against
  [references/dispatch.md](references/dispatch.md) and passed through its
  preflight. Data only: the role's standing rules are its agent file, which omp
  loads for you. Do not paste them in.
- `solutionSpace`: one line. omp feeds it to the child's thinking classifier
  and nothing else reads it, so it does not carry the contract; fill it
  honestly, and a missing one is tolerated (omp's `docs/tools/task.md`).

The model is not a field of the call. It is the alias in the role file, resolved
through `modelRoles`; a `task` call cannot override it ([roles.md](roles.md)).
A resume keeps the model the agent started on, which is why a change of binding
is always a fresh dispatch.

To run a batch in parallel, put every entry for that batch in one `task` call.
That is what phase 2 means by dispatching the whole batch at once, what the
review message after green gates means, and what the three recon lanes in
phase 0 require.

Keep each node's agent id alongside its diff baseline in the roster for as long
as the node is active. Which rework message to send, and when you must not
resume at all, belong to [references/dispatch.md](references/dispatch.md).

### Read-only roles are read-only by instruction here

The three recon lanes, `plan-reviewer` (the `reviewer` role), `spec-auditor`,
`branch-reviewer`, and `adversary` must not write to the tree, and their agent
files say so: that instruction is what makes them read-only. The `tools`
allowlist in their frontmatter is only a partial guard: it leaves out `edit`,
`write`, `ast_edit`, `memory_edit` and `lsp` ([roles.md](roles.md)), but `bash`
stays, because the reviewers need `git log -S` and `git blame`, and a shell can
write. Treat a read-only lane that changed a file as a finding about the run,
not as a harmless accident; your diff read is what catches it.

## Goal mode and `/goal`

omp's goal mode is `/goal <objective>` in an interactive session, or
`omp --goal "<objective>"` to start one. While it is on, omp continues the
session after each turn until the objective is complete, and gives the model a
`goal` tool to read it and mark it complete (`goals/tools/goal-tool.ts`,
`prompts/tools/goal.md`; for RPC, omp's `docs/rpc.md`, "`goal` payload"). The
tool is added only after goal mode is on, so you cannot create the goal
yourself; and you do not mark it complete before PLAYBOOK's close-out
conditions hold.

[references/goal-mode.md](references/goal-mode.md) arms goal mode in the plan
document, and offers the user one `/goal` line to type when none is set. In a
`-p` print run nothing resumes an idle session, so goal mode there ends with the
turn: say so in the delivery report and stop at a checkpoint rather than
looping.

## On the tool list

The agent files carry the `tools` allowlists; this skill's frontmatter sets
none. The orchestrator itself needs `task`, `wait`, `write` (for `agent://` and
`xd://`), `todo`, `read` and `bash` for the gates. A session that has
restricted its tools to fewer will lose a mechanism silently, most likely a
gate, which the playbook forbids working around. Check that the gates still run.

## The board

[references/board.md](references/board.md) tells you to check once, at the
start, whether the `plan-sdd` MCP tools are in your toolset, and covers both
outcomes. That check is the whole procedure here; this file adds only where the
tools come from, which is [INSTALL.md](INSTALL.md). The board is optional. A run
without it is a normal run.

## Not established

Each of these was not settled from omp's docs or source, and the skill works
around it:

- Whether an agent from an earlier omp process can still be resumed. omp has a
  cold path: it rebuilds a parked subagent from its transcript when the file has
  a persisted `session_init`, the agent was not isolated, its recorded working
  directory still exists, and no kill tombstone was written
  (`task/persisted-revive.ts:93-131`, `task/executor.ts:3464-3467`). Whether the
  agent's registry entry survives the restart so that its id is still known was
  not established, and the cold path re-resolves the model alias
  (`task/persisted-revive.ts:180-183`). So after a restart use Form B, a fresh
  dispatch with the full bundle, rather than a resume.
- That `show-me` runs in an omp session (see the table).
- Whether the model can run `/review`. `/review` is typed by the user, and omp's
  tool list has no tool for running a slash command, so treat it as a handoff
  ([references/native-review.md](references/native-review.md)); the bundled
  `reviewer` agent is the route you can take yourself.

## Files here

- [PLAYBOOK.md](PLAYBOOK.md): the method. Start here when running the skill.
- [roles.md](roles.md): the ten roles, the model bindings, obstacle episodes.
- [references/](references/): the playbook's reference files, and
  [references/native-review.md](references/native-review.md), what omp offers
  for a branch review.
- [agents/](agents/): the ten role definitions, the subagents' standing rules,
  which install into `~/.omp/agent/agents/`.
- [config.example.yml](config.example.yml): the `modelRoles` the agent files use.
- [INSTALL.md](INSTALL.md): install the skill, the role files, the model roles
  and the board's MCP server.
