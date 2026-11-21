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

The method is [PLAYBOOK.md](PLAYBOOK.md). Read it in full before doing anything
else, and read each reference file when the playbook first sends you to it.
This file only says which Claude Code tool each mechanism is.

## Bindings

| The playbook says | On Claude Code |
| --- | --- |
| dispatch a subagent | one `Agent` call: `subagent_type` is the role, `model` from the table below, `prompt` is the brief |
| dispatch a batch in one message | several `Agent` calls in one assistant message; they run concurrently |
| resume a subagent | `SendMessage` to the agent id the dispatch returned; it keeps its model |
| act on each return as it arrives | background agents notify you one by one; never poll, never predict a return |
| a node's own worktree | a tree you create with `git worktree add` and name in `<working_directory>`; leave the `Agent` call's `isolation` unset, because you need the path, the branch and the branch point |
| the board | the `plan_*` tools of the `plan-sdd` MCP server, when installed ([INSTALL.md](INSTALL.md)) |
| Claude Code's own reviewer | the `code-review` skill, when it is in your skill list ([review.md](references/review.md)) |
| the goal feature | the `/goal <condition>` command, which only the user can type ([goal-mode.md](references/goal-mode.md)) |
| show it instead of describing it (phase P) | the `show-me` skill, loaded through the `Skill` tool when it is installed; without it, phase P stays text |

## Roles and models

Five roles, each a file in [agents/](agents/) installed into the project's
`.claude/agents/`. Claude Code loads that file as the subagent's system prompt,
so a brief carries data only and never restates a role's rules.

| Role | Does | Model |
| --- | --- | --- |
| `recon` | phase 0 survey, read-only | `opus` |
| `implementer` | one task, test first, in its worktree | `sonnet` |
| `reviewer` | node review and branch review, read-only | `opus` |
| `qa` | runs the change in the real system | `sonnet` |
| `adversary` | challenges phase 3 findings, read-only | `opus` |

Pass `model` on every fresh `Agent` call. A model the user names wins over the
table. If the bound model is unavailable, the dispatch waits and you say so; do
not quietly send it on another model.

The read-only roles are read-only by instruction, not by a tool allowlist: the
reviewers need the shell for `git diff` and `git blame`. A read-only role that
edited a file is a finding about the run, and your diff read is what catches
it.

## Files

- [PLAYBOOK.md](PLAYBOOK.md): the method.
- [references/](references/): plan format, dispatch, review, worktrees, board,
  goal mode.
- [agents/](agents/): the five role files.
- [INSTALL.md](INSTALL.md): installing the skill, the roles and the board.
