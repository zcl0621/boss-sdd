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

The method is [PLAYBOOK.md](PLAYBOOK.md). Read it in full before doing anything
else, and read each reference file when the playbook first sends you to it.
This file only says which omp tool each mechanism is.

Paths here are relative to the skill directory, not to the project. Read them
as `read skill://plan-sdd/PLAYBOOK.md` and
`read skill://plan-sdd/references/<file>`: omp resolves `skill://<name>/<path>`
against the skill's own directory and never prunes those reads at compaction,
so the playbook stays in context. A bare `PLAYBOOK.md` fails with "not found";
the fallback is `~/.omp/agent/skills/plan-sdd/PLAYBOOK.md`.

Source paths cited below (`task/types.ts` and so on) are under
`packages/coding-agent/src/` in the omp repository, read at omp 18.11.1.

## Bindings

| The playbook says | On omp |
| --- | --- |
| dispatch a subagent | one `task` call. The item fields are `name`, `agent`, `task`, `solutionSpace` (`task/types.ts`). `agent` is the role's agent name from the table below, `task` is the brief, `solutionSpace` is one honest line on how open the problem is. There is no `model` field. Give each a CamelCase `name` (`T3Impl`) and record the id the spawn returns |
| dispatch a batch in one message | one `task` call in the batch shape: a non-empty `context` plus a list of `tasks`, one entry per subagent. `context` reaches every subagent, so put only what is true for all of them there (run title, repository root) |
| resume a subagent | `write` with `path: agent://<id>` and the new blocks as `content`. It works for a subagent you started with `isolated` unset, that finished or stopped on a soft budget, in this omp process. If the write returns an error ("Peer messaging is unavailable", "is not running", a revive failure), or the agent is from an earlier omp process, do not retry: dispatch a fresh one with the full brief, as [dispatch.md](references/dispatch.md) describes |
| act on each return as it arrives | `async.enabled` defaults to true: `task` returns at once with `Spawned agent <id>` and each result is injected when its subagent finishes. Call `wait` only when you are completely blocked. Never poll |
| a node's own worktree | a tree you create with `git worktree add` and name in `<working_directory>`. Leave the `task` item's `isolated` field unset: you need the path, the branch and the branch point, and omp reports an isolated run as not resumable |
| the board | the `plan_*` tools of the `plan-sdd` MCP server, registered in `~/.omp/agent/mcp.json` ([INSTALL.md](INSTALL.md)). See "The board on omp" below for how to call them |
| omp's own reviewer | the bundled `reviewer` agent, dispatched with `task`. `/review` is typed by the user, so for you it is a handoff ([review.md](references/review.md)) |
| the goal feature | `/goal <objective>` or `omp --goal`, which only the user can start; the `goal` tool joins your toolset only once goal mode is on. A `-p` print run does not resume ([goal-mode.md](references/goal-mode.md)) |
| show it instead of describing it (phase P) | the `show-me` skill, loaded with `read skill://show-me` when it is installed. Not verified: that the page it opens reaches the user's browser from an omp session. Without it, phase P stays text |

## Roles and models

Five roles, each a file in [agents/](agents/) installed into
`~/.omp/agent/agents/` (or `<project>/.omp/agents/`). omp loads that file as the
subagent's system prompt, so a brief carries data only and never restates a
role's rules. omp does not read `.claude/agents/`, so a Claude Code install does
not carry over.

| Role | Agent name | Does | Model alias |
| --- | --- | --- | --- |
| recon | `recon` | phase 0 survey, read-only | `@sdd-recon` |
| implementer | `implementer` | one task, test first, in its worktree | `@sdd-implementer` |
| reviewer | `plan-reviewer` | node review and branch review, read-only | `@sdd-reviewer` |
| qa | `qa` | runs the change in the real system | `@sdd-qa` |
| adversary | `adversary` | challenges phase 3 findings, read-only | `@sdd-adversary` |

**The reviewer role is the agent `plan-reviewer`.** omp bundles its own agent
named `reviewer` (`task/agents.ts`; the bundled set is `scout`, `reviewer`,
`security-reviewer`, `task`, `sonic`), and a same-named file would shadow it
for the user's everyday omp use.

The model is not a field of the `task` call. Each agent file carries an alias
(`model: "@sdd-implementer"`), and `modelRoles` in `~/.omp/agent/config.yml` or
`<project>/.omp/config.yml` maps it to a concrete model;
[config.example.yml](config.example.yml) defines all five. To retune, change the
alias's entry there. omp passes an undefined alias on as a literal model
pattern instead of failing, so check they are all defined
([INSTALL.md](INSTALL.md)). A model the user names wins. If the bound model is
unavailable, the dispatch waits and you say so; do not quietly send it on
another one.

The read-only roles are read-only by instruction. The `tools` allowlist in
their frontmatter is only a partial guard: it leaves out `edit`, `write`,
`ast_edit`, `memory_edit` and `lsp`, but `bash` stays, because the reviewers
need `git diff` and `git blame`, and a shell can write. A read-only role that
changed a file is a finding about the run, and your diff read is what catches
it.

## The board on omp

omp mounts MCP tools behind `write` as `xd://` devices by default, with names
minted from the server key: `mcp__plan_sdd_plan_board_status` and so on.

- The check "are the tools in my toolset" is `read xd://`. A tool's schema is
  `read xd://mcp__plan_sdd_<tool>`.
- Call one with `write` on `xd://mcp__plan_sdd_<tool>` and one JSON object as
  `content`.
- Your system prompt documents each device under `# xd:// Tool Devices`. That
  section is not your function list: those names cannot be called as functions,
  only through `write`. Call one directly only when a function with exactly
  that name is among your tools (`tools.xdev` off). Never through `bash`.

After the first board call works, keep one line in `context_notes` saying how to
call it, for example `board: write xd://mcp__plan_sdd_<tool> with JSON args as
content; run <run_id>`, and keep it in every later rewrite of the notes: a
context rollover drops your earlier calls from view while the board is still
there. If you are unsure after a rollover whether the tools exist, `read xd://`
answers it. Never use `ask` for a doubt a read can settle.

## Tools you need

The orchestrator needs `task`, `wait`, `write` (for `agent://` and `xd://`),
`read` and `bash` for the gates. A session restricted to fewer loses a
mechanism silently, most likely a gate. With `experimentalContextManagement`
on, rollover also needs `context_notes`, `new_context`, `read` and `grep`.

## Files

- [PLAYBOOK.md](PLAYBOOK.md): the method.
- [references/](references/): plan format, dispatch, review, worktrees, board,
  goal mode.
- [agents/](agents/): the five role files.
- [config.example.yml](config.example.yml): the `modelRoles` the agent files use.
- [INSTALL.md](INSTALL.md): installing the skill, the roles, the model roles and
  the board.
