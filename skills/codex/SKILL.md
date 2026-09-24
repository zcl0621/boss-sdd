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
---

# Plan SDD, Codex packaging

This file is the Codex entry point and holds no procedure. The procedure is the
portable body shipped underneath it. What this wrapper adds is the per-platform
layer that body defers to, and on Codex the layer answers some of it and cannot
answer the rest. Answered: where roles are declared, which model and reasoning
effort each one runs on, and what is known about reaching the board's MCP
server. Open: how a subagent is dispatched, how you wait on one that is running,
whether one can be resumed, whether a subagent can be given its own worktree,
and whether Codex's own reviewer is something an agent can launch. Each open one
is marked as open where it comes up, with what to do meanwhile. Read those as
gaps in the source, not as things settled somewhere else in the file.

One of them has no "meanwhile": the body puts every node in its own worktree and
offers no fallback, so if the check in `codex-platform.md` comes back saying a
subagent cannot work in one, the run stops in phase 0 rather than continuing some
other way.

Invoke it explicitly with `$plan-sdd`.

Paths below are relative to this skill's installed directory,
`.agents/skills/plan-sdd/` in a project or `$HOME/.agents/skills/plan-sdd/` for
a personal install.

## Read these two, in this order

1. [codex-platform.md](codex-platform.md). Short. It answers the platform
   questions the body defers, and it marks the ones still open on Codex so you
   do not fill them in from memory.
2. [shared/PLAYBOOK.md](shared/PLAYBOOK.md). The body. Phases, the DAG contract,
   the dispatch contract, the review protocol, gate discipline, the
   prohibitions. Follow it as written.

The role roster and the model matrix are [shared/roles.md](shared/roles.md). The
body's own reference files sit beside it under
[shared/references/](shared/references/), and its internal links resolve because
the shared directory was copied in whole.

Where this layer and the body appear to disagree about a procedure, the body
wins. This layer is authoritative about Codex only.
