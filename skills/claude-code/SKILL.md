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
argument-hint: "[--goal] <what to build>"
---

# Plan SDD, packaged for Claude Code

The method lives in [shared/PLAYBOOK.md](shared/PLAYBOOK.md). Read it now, in
full, before doing anything else, and follow it. It is the source of truth for
the phases, the DAG contract, the dispatch prompt, the review protocol, and the
gate discipline.

This file is the platform layer and nothing more. It answers the questions the
portable body deliberately leaves to a wrapper: what "dispatch a subagent" means
here, where role definitions live, which model identifiers are valid, whether a
subagent can be resumed, whether nodes can run in their own worktrees, how the
board's MCP tools get registered, and whether Claude Code's own branch reviewer
is something you can invoke or something you have to hand to the user.

`PLAYBOOK.md` sets the precedence and this file does not change it: **where this
wrapper and the portable body disagree on a platform detail, this wrapper wins;
on behaviour, the body wins.** Nothing here is licence to soften a
non-negotiable.

**Every `shared/...` link in this wrapper resolves in both trees.** In the
installed skill at `~/.claude/skills/plan-sdd/`, `shared/` is the copied body; in
the repository it is a symlink to `skills/shared/`, which is why the links open
from a clone too. Repository files that do not get installed are cited as plain
paths rather than linked.

## The bindings

Every row is from the verified platform-facts table this packaging was built
against, except the four marked, which say what they rest on instead.

| Where the portable body says | On Claude Code it means |
| --- | --- |
| "dispatch a subagent" | one `Agent` tool call: `subagent_type` is the role name, `model` is the tier |
| "issue several such calls in one message" | several `Agent` calls in a single assistant message; they run concurrently |
| "where role definitions live" | `.claude/agents/<role>.md`, the ten files in [agents/](agents/) |
| "the model identifiers that are valid for you" | `fable`, `opus`, `sonnet`, `haiku`, routed per role by the Claude Code column of [shared/roles.md](shared/roles.md) |
| "whether your platform can resume the subagent" ([dispatch.md](shared/references/dispatch.md)) | it can: `SendMessage`, addressed by the agent id the dispatch returned. **Form A on rounds 1 and 2, Form B on round 3** — that last one is the body's rule, not a platform limit |
| "which of the two worktree cases you are" ([worktree-mode.md](shared/references/worktree-mode.md)) | the second: trees you create with `git worktree add` and name in each node's `<working_directory>` *(the table licenses `isolation: "worktree"` on the `Agent` call and nothing more; the case follows from what it leaves unsaid, below)* |
| "the `plan-sdd` MCP tools" ([board.md](shared/references/board.md)) | the eleven `plan_*` tools of the board server, registered per [INSTALL.md](INSTALL.md) *(from `mcp/main.go` and `README.md` in the repository; the table has no MCP row for any platform)* |
| "check whether your platform exposes an invocable review skill" | [references/native-review.md](references/native-review.md) *(not from the table; it says what it rests on)* |
| "wait on running nodes through your platform's completion mechanism" ([dag-contract.md](shared/references/dag-contract.md)) | not covered by the verified table. Use whatever your session gives you for awaiting a dispatched agent, and do not poll in a loop. *(unsourced)* |

## Dispatching a role

One `Agent` call per subagent. Three fields carry the contract:

- `subagent_type`: the role name, exactly as the file in `.claude/agents/` names
  it. Never invent a role; the roster is fixed at ten in
  [shared/roles.md](shared/roles.md).
- `model`: the tier for that role, from the Claude Code column of the routing
  table in [shared/roles.md](shared/roles.md). Pass it on every call. The role
  file also declares a default in frontmatter, but the call is the binding the
  verified facts confirm, so set it explicitly rather than trusting the default
  to apply.
- `prompt`: the whole dispatch prompt, built against
  [shared/references/dispatch.md](shared/references/dispatch.md). The subagent
  has none of your context. For `implementer` and `ui-designer` that is every
  tagged block on that file's list, read off the list rather than off a
  remembered count, with nothing dropped.

To run a batch in parallel, put every `Agent` call for that batch in one message.
That is what phase 2 means by dispatching the whole batch at once, and it is what
the three recon lanes in phase 0 require.

### Rework: resuming works here

Claude Code can resume a subagent with its context intact — a `SendMessage`
addressed to the agent id its dispatch returned. So keep each node's agent id
alongside its diff baseline for as long as the node is active.

That is the whole of the platform's answer. Which rework message to send, and on
which round you must not resume at all, belong to
[shared/references/dispatch.md](shared/references/dispatch.md); read them there
rather than here, because a copy in this file is a copy that goes stale the next
time that rule moves. The one further thing this wrapper owes it: where that file
escalates to "the strongest tier", the name on Claude Code is `fable`, per the
Claude Code column of [shared/roles.md](shared/roles.md).

### Read-only roles are read-only by instruction here

The three recon lanes, `reviewer`, `spec-reviewer`, `branch-reviewer`, and
`adversary` must not write to the tree. The verified facts give Claude Code no
per-role read-only flag, so on this platform nothing enforces that below the
prompt: it holds
because the role file and the dispatch prompt say so. Keep the sentence in both,
and treat a read-only lane that edited a file as a finding about the run, not as
a harmless accident.

### `isolation: "worktree"` is not the worktree the body means

[shared/references/worktree-mode.md](shared/references/worktree-mode.md) closes
by asking each wrapper which of two cases its platform is. **Claude Code is the
second:** trees you create yourself with `git worktree add` and hand to each node
by filling its `<working_directory>` block with the path. The platform automates
none of it. Everything else — what the trees cost, the precondition about the
user's uncommitted changes, the merge lock, the recovery path — is that file's,
and leaving it there is the point.

The `Agent` tool does take `isolation: "worktree"`, which gives one dispatched
subagent a worktree of its own and cleans it up when it comes back unchanged.
That is per-subagent containment, and it is not the same thing. Closing a node
takes the tree's path, its branch name, and the commit it was cut from; the
verified facts say what the parameter does and say none of those three. A
subagent working in a tree you cannot name is one whose work you can neither
review nor gate — and even where your environment hands the path back afterwards,
that is one of the three, with the branch name and the branch point still
missing.

So leave `isolation` unset, and work in the tree you created and recorded in the
plan's Status header.

## On `allowed-tools`

The frontmatter above deliberately does not set it, though Claude Code supports
the field. This skill's orchestrator runs every gate itself through the shell,
dispatches every role through the `Agent` tool, writes the plan document, and
talks to the board through MCP tools whose exposed names depend on how the server
was registered. A whitelist that misses one of those does not fail loudly; the
tool is simply absent, and the most likely casualty is a gate, which the body
forbids working around. Narrow it if you have a reason to, and then check that
the gates still run.

## The board

[shared/references/board.md](shared/references/board.md) tells you to check once,
at the start, whether the `plan-sdd` MCP tools are in your toolset, and covers
both outcomes. That check is the whole procedure here; this wrapper adds only
where the tools come from, which is [INSTALL.md](INSTALL.md). The board is
optional. A run without it is a normal run.

## Claude Code's own branch reviewer

Phase 3 tells you to check whether the platform's native reviewer is something
you can invoke. [references/native-review.md](references/native-review.md) is
that check for Claude Code. Read it when you reach phase 3, not before.

## Files here

- [INSTALL.md](INSTALL.md): install the skill, the role files, and the board's
  MCP server.
- [agents/](agents/): the ten role definitions, which also install into a
  project's `.claude/agents/`.
- [references/native-review.md](references/native-review.md): the Claude Code
  answer on native review invocability.
- [shared/](shared/): the portable body. Start at
  [shared/PLAYBOOK.md](shared/PLAYBOOK.md).
