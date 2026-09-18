# Phase 0: recon

Recon is read-only. Three lanes run at once, each as its own subagent, dispatched
in a single message so they run in parallel. None of them writes code, edits
config, or touches the working tree. Each returns evidence paths, conclusions,
risks, and open questions.

The three roles are `recon-rules`, `recon-product`, and `recon-code`. Their
identities, delivery contracts, and model tiers are in [roles.md](../roles.md).
Build each dispatch prompt with [the dispatch contract](dispatch.md); the same
rules about self-contained prompts and tagged data blocks apply to read-only
subagents.

Give every lane the same three inputs, each in its own tagged block:

```text
<repo_root>absolute path to the repository</repo_root>
<requirement>
the user's requirement, pasted verbatim, including the discussion it came out of.
Do not summarize it for them. A summary drops the detail one of the three lanes
was going to need, and you cannot tell in advance which lane or which detail.
</requirement>
<extra_context>anything else already established, or empty</extra_context>
```

Stored project memory goes in `<extra_context>` when the project has any: the
entries for this lane's kinds, each with its `source`, marked as claims for the
lane to check against the repository rather than findings to accept. Which kind
reaches which lane:

| Kind | Where it goes |
| --- | --- |
| `gate`, `hard_rule` | lane A |
| `run_recipe`, `convention` | lane C |
| `exclusive_resource` | lane A, and you also declare it in phase 1 |
| `note` | the lane its text is about; lane C if you cannot tell |

Route on what the entry says, not on the label it was filed under. The label was
chosen by an earlier run and nothing validates it, so a gate command filed as a
`note` is still a gate command and belongs in front of lane A.
[memory.md](memory.md) has the worked example and says why the label is the
weaker signal. The one rule that survives a wrong label: every entry goes to some
lane. None of them stays with you unchecked, because the reason this table exists
is that you are the one who cannot check them.

A lane that is handed claims owes a verdict on each of them and the line as it
reads today, quoted. All three lanes carry that obligation in their delivery
contracts in [roles.md](../roles.md), which is what makes the re-check observable
in what comes back rather than assumed. [memory.md](memory.md) says what the
verdicts mean for the stored entries, and which kinds may be used before a lane
returns one.

## Lane A: project rules and gates (`recon-rules`)

Reads `AGENTS.md`, `CLAUDE.md`, README, contributing guides, build configuration,
git hooks, and relevant memory files, from the repository root down to the target
directory. Returns:

- The instruction hierarchy in force, how conflicts between layers resolve, the
  paths of the constraint files that actually exist, and the hard rules quoted
  verbatim out of them. Call this `hardRules`; you will paste it into every
  dispatch prompt and every review prompt.
- The commands for formatting, lint, type check, build, unit tests, and full
  tests. Call this `gates`. A formatting gate must be a read-only check mode
  (`--check`, `-l`, or the project's equivalent), never a command that rewrites
  files. A gate that edits the tree is not a gate.
- Whether tests can run concurrently, with the evidence for the answer.
- Which changes in the current working tree belong to the user and must be
  protected.
- Everything it could not determine, listed as unknowns. An unknown stays an
  unknown. Do not let it be filled in from another project's conventions or from
  a language's usual defaults.

## Lane B: product boundary and acceptance (`recon-product`)

Works only from the user's request, the project's documentation, issues, specs,
and the product behaviour that already exists. It does not invent scope. Returns:

- The problem the user is actually trying to solve, and the goals.
- Explicit non-goals. The more specific these are the better; this list is the
  gate that stops the work from growing.
- Open questions that genuinely need the user to decide, each with why it
  matters, which way the lane leans, and what it blocks. A question whose answer
  can be read out of the code or the constraint files is not an open question.

An open question that would materially change the result must not slip silently
into implementation in confirm mode.

## Lane C: code and test landing points (`recon-code`)

Locates the entry points, call chains, data models, protocol boundaries, existing
implementation patterns, and tests involved. Returns:

- The files or modules expected to change and what each is responsible for.
- Reusable existing patterns with the evidence for each. Implementation should
  follow these rather than starting a parallel approach next to them.
- Where the unit, integration, end-to-end, and runtime tests live.
- **The run recipe**: how to actually start this project so a human or an agent
  can use it. The command or commands, the port or URL it comes up on, the seed
  or fixture step if one is needed, the test accounts or credentials the project
  provides for development, and anything that has to be running first (a
  database, a queue, a second service). Where the project documents this, quote
  it and cite the file. Where it does not, say so rather than constructing a
  plausible command.
- Risks around cross-module coupling, migrations, compatibility, concurrency, and
  security.

The run recipe is what the `qa` role needs in order to do a walkthrough at all.
Without it that lane cannot run, and a task marked `qa` cannot be accepted. Carry
it forward into every `qa` brief verbatim.

If lane C could not find it, try the recovery below, and if that also fails, ask
the user, the same as any other unknown. In confirm mode you wait for the answer.
In goal mode nobody is there to answer, so park the question in "needs a decision
from the user", and in phase 1 every task carrying `qa` or `ui-designer` is
written with the `blocked` status naming that parked question, propagated
downstream. Those tasks do not run without a walkthrough, and a walkthrough does
not happen without the recipe. Do not dispatch them and skip the walkthrough, and
do not invent a start command to get past this.

## Merging the three

Combine the three viewpoints, drop the duplicates, and name the conflicts rather
than smoothing them over. Any conclusion not backed by evidence is an assumption
and must be labelled as one. In confirm mode, an assumption that would change the
product boundary cannot pass into implementation without the user seeing it.

Before phase 1, confirm three things out of the merged result, because later
phases consume them directly: the gate commands from lane A, the test concurrency
answer from lane A (batch selection in phase 2 depends on it), and the run recipe
from lane C (the `qa` review lane depends on it).

## When a lane comes back empty

Lane A or lane C missing: dispatch that lane again. If it still returns nothing,
fill the gap yourself with read-only shell, file reads, and search. That is
information gathering before orchestration, not you doing the implementation
work. Whatever you still cannot determine becomes a question for the user, parked
and blocking the tasks that need it if the user is not there. Do not substitute a
default.

Lane B missing is different, and the self-service path above does not apply.
Re-dispatch it. If it fails again, write the non-goals list and the boundary
judgment yourself, hand it to the user together with a plain statement that recon
produced no product lane this time and that you set the boundary directly, and
wait for an explicit reply before entering phase 1. When nobody is watching the
run, this is the only outside check on scope that exists, so it is not the step
to skip.

This is the one case that stops the whole run rather than blocking individual
tasks, and it stops it in goal mode too. Every task's scope descends from the
product boundary, so there is nothing left that is safe to run, which is the
"every safe path is blocked" stop condition in [PLAYBOOK.md](../PLAYBOOK.md). Report
what you have and wait.
