# omp's branch review

[The handoff protocol](native-review-handoff.md) says this file records which
case omp is in, and that it is more current than the protocol itself. That
statement is all this file holds: the procedure for checking, running, handing
off and triaging is in that file and is not repeated here.

omp offers two things for a branch review, and they differ in who may start
them. Everything below was read from omp 18.11.1 source and docs; nothing was
run against a live branch.

## `/review` and `/annotate code-review`: typed by the user, so a handoff

`/review` is a bundled command (`extensibility/custom-commands/bundled/review/index.ts:379-384`,
description "Launch interactive code review"). With a terminal UI it opens a
menu of targets (up to three pull requests named in the conversation, then the
local diff kinds, or a pull request given as an argument) and sends the prompt
it builds as the next message. `/annotate code-review [focus]` opens an
annotation overlay on the same frozen diff, offers "Continue with LLM review",
and posts nothing to GitHub (omp's `docs/slash-command-internals.md`, section 12).
Both are slash commands the user types. omp's tool list has no tool for running
one, so for you they are a handoff: ask the user to type `/review` in a session
whose directory is the integration worktree, and never shell out to omp, simulate
the keystroke, or ask another agent to type it.

The user can also pass the review a pull request (`/review pr://owner/repo/N`).
A cloud or billed variant was not found in omp's docs, so there is no ultra
path to warn about here.

## The bundled `reviewer` agent: invocable by you

Without a terminal UI, `/review` hands the model a request to call `task` with
`agent: "reviewer"` and one reviewer task (`prompts/review-headless-request.md`),
so that agent is the reviewer omp itself uses. It is embedded in omp
(`task/agents.ts:44-73`), read-only (`tools: read, find, grep, glob, bash, lsp,
web_search, ast_grep`, `prompts/agents/reviewer.md`), bound to the `@slow` role,
and returns a structured verdict with findings. You can dispatch it yourself:
that is the "invoke it yourself" case of the protocol.

Two cautions. It is named `reviewer`, which is why this skill's own reviewer role
is the agent `plan-reviewer` ([roles.md](../roles.md)); do not install an agent
called `reviewer` (omp's bundled one), which would shadow it. And it knows nothing of your
integration worktree: put the worktree path, the branch and the base commit in
its `task` text, and review its verdict as outside evidence, not as a gate.

Its model is `@slow`, a role omp defines, not one of this skill's aliases;
changing it goes through `task.agentModelOverrides.reviewer`, which affects every
spawn of that agent while set ([roles.md](../roles.md) explains why that needs
the same one-at-a-time care).

## Findings are text: nothing here applies a fix or posts a comment

Neither `/review` nor the bundled `reviewer` has a flag that applies findings or
posts them to a pull request; the bundled reviewer's tool list has no
`edit` or `write`. Keep it that way. Take the findings as text and send them back
through the fix loop: the body's first non-negotiable is that you do not write
implementation code, and a reviewer that edited the tree would also write
outside every node's declared write scope. Anything that posts to a pull
request is the same kind of external, user-visible action as a push, and is left
to the user's explicit authorization. That last line is this skill's own
conservative rule, not something omp's docs state.
