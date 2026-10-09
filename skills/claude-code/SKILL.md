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
argument-hint: "[--goal] <what to build>"
---

# Plan SDD on Claude Code

The method lives in [PLAYBOOK.md](PLAYBOOK.md). Read it now, in full, before
doing anything else, and follow it. It is the source of truth for the phases,
the DAG contract, the dispatch brief, the review protocol, and the gate
discipline.

This file holds the Claude Code bindings and nothing more: which tool each
mechanism the playbook names is on this platform, where the role definitions
live, and what is and is not known about each. **Where this file and the
playbook disagree on which tool, this file wins; on behaviour, the playbook
wins.** Nothing here is licence to soften a non-negotiable.

Repository files that do not get installed are cited as plain paths rather than
linked.

## The bindings

| Where the playbook says | On Claude Code it means |
| --- | --- |
| "dispatch a subagent" | one `Agent` tool call: `subagent_type` is the role name, `model` is the model bound in [roles.md](roles.md), `prompt` is the brief |
| "issue several such calls in one message" | several `Agent` calls in a single assistant message; they run concurrently |
| "where role definitions live" | `.claude/agents/<role>.md`, the ten files in [agents/](agents/), loaded as each subagent's system prompt |
| "the model binding" ([roles.md](roles.md)) | the one table under "Model bindings" in [roles.md](roles.md), which maps each binding to `fable`, `opus`, `sonnet` or `haiku` |
| "resume the subagent" (Form A in [dispatch.md](references/dispatch.md)) | `SendMessage`, addressed by the agent id the dispatch returned; a resumed agent keeps its model |
| "act on each return as it arrives" | with `run_in_background` on the `Agent` call (on by default where your build has it), each subagent's completion arrives as its own notification; act on it then. Without it, every call in the message returns before your next step; work through all of them. Either way, do not poll *(observed in this author's tool schema, not from the docs)* |
| "each node's own worktree" ([worktree-mode.md](references/worktree-mode.md)) | trees you create with `git worktree add` and name in each node's `<working_directory>`; leave the `Agent` call's `isolation` unset |
| "your platform's todo list" ([PLAYBOOK.md](PLAYBOOK.md), "Todo list") | Claude Code's built-in task tools: `TaskCreate`, `TaskUpdate` and `TaskList` where your build has them, otherwise `TodoWrite`; if neither is in your toolset, skip the todo list |
| "the goal feature" ([goal-mode.md](references/goal-mode.md)) | Claude Code's built-in `/goal <condition>` command, which the user types; see below |
| "the prompt-review skill" (the dispatch preflight) | the `prompt-engineer` skill, loaded once per run through the `Skill` tool when it is installed |
| "the helper skill for messages to the user" (phase P) | the `shuorenhua` skill, loaded once per run through the `Skill` tool when it is installed |
| phase P explorers and architects | the built-in `Explore` and `Plan` subagent types on the `Agent` call, with the model their binding names |
| "the `plan-sdd` MCP tools" ([board.md](references/board.md)) | the thirteen `plan_*` tools of the board server, registered per [INSTALL.md](INSTALL.md) *(from `mcp/main.go` and `README.md` in the repository)* |
| "Claude Code's own branch reviewer" | [references/native-review.md](references/native-review.md) |

## Dispatching a role

One `Agent` call per subagent. Three fields carry the contract:

- `subagent_type`: the role name, exactly as the file in `.claude/agents/` names
  it. Never invent a role; the roster is fixed at ten in [roles.md](roles.md).
- `model`: the model for the dispatch's binding, from the table in
  [roles.md](roles.md). Pass it on every fresh call. The role file also declares
  a default in frontmatter, but the call decides, so set it explicitly rather
  than trusting the default. A `SendMessage` resume carries no model and keeps
  the one the agent started on, which is why a change of binding is always a
  fresh dispatch.
- `prompt`: the brief, built against
  [references/dispatch.md](references/dispatch.md) and passed through its
  preflight. Data only: the role's standing rules are its agent file, which
  Claude Code loads for you. Do not paste them in.

To run a batch in parallel, put every `Agent` call for that batch in one message.
That is what phase 2 means by dispatching the whole batch at once, what the review
message after green gates means, and what the three recon lanes in phase 0
require.

Keep each node's agent id alongside its diff baseline in the roster for as long
as the node is active. Which rework message to send, and when you must not
resume at all, belong to [references/dispatch.md](references/dispatch.md).

### Read-only roles are read-only by instruction here

The three recon lanes, `reviewer`, `spec-auditor`, `branch-reviewer`, and
`adversary` must not write to the tree, and their agent files say so. Nothing
below the prompt enforces it in this packaging: the role files set no `tools`
allowlist, and even one that left out the edit tools would leave the shell, which
the reviewers need for `git log -S` and `git blame`. Treat a read-only lane that
edited a file as a finding about the run, not as a harmless accident; your diff
read is what catches it.

## Goal mode and `/goal`

Claude Code's goal feature is the `/goal` command (documented at
`https://code.claude.com/docs/en/goal`). The user types `/goal <condition>`; after
each turn a separate model checks whether the condition holds and, until it does,
starts another turn. `/goal` on its own shows the status and `/goal clear` stops
it. The checker does not run commands or read files, so the condition is judged
from what the transcript shows. To run unattended, the user runs it in auto mode,
and it is unavailable when hooks are disabled.

You cannot set it, update it, or mark it complete: there is no tool for that.
So [references/goal-mode.md](references/goal-mode.md) arms goal mode in the plan
document, and offers the user one `/goal` line to type when none is set. Without
it, nothing resumes an idle session, which is why goal mode never ends a turn
while ready work remains.

## On `allowed-tools`

The frontmatter above deliberately does not set it, though Claude Code supports
the field. This skill's orchestrator runs every gate itself through the shell,
dispatches every role through the `Agent` tool, writes the plan document, uses the
todo tools and helper skills, and talks to the board through MCP tools whose
exposed names depend on how the server was registered. A whitelist that misses
one of those does not fail loudly; the tool is simply absent, and the most likely
casualty is a gate, which the playbook forbids working around. Narrow it if you
have a reason to, and then check that the gates still run.

## The board

[references/board.md](references/board.md) tells you to check once, at the
start, whether the `plan-sdd` MCP tools are in your toolset, and covers both
outcomes. That check is the whole procedure here; this file adds only where the
tools come from, which is [INSTALL.md](INSTALL.md). The board is optional. A run
without it is a normal run.

## Files here

- [PLAYBOOK.md](PLAYBOOK.md): the method. Start here when running the skill.
- [roles.md](roles.md): the ten roles, the model bindings, obstacle episodes.
- [references/](references/): the playbook's reference files, and
  [references/native-review.md](references/native-review.md), the Claude Code
  answer on whether `/code-review` is invocable.
- [agents/](agents/): the ten role definitions, the subagents' standing rules,
  which install into a project's `.claude/agents/`.
- [INSTALL.md](INSTALL.md): install the skill, the role files, and the board's
  MCP server.
