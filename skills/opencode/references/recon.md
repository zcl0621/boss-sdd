# Phase 0: recon

Recon is read-only. Dispatch **one** `recon` subagent. It does not write code,
edit config, or touch the working tree. It returns one report with three
sections (rules, product, code): evidence paths, conclusions, risks, and open
questions. Do not fan out three recon agents.

Standing rules live in the `recon` agent file. Build the dispatch prompt
with [the dispatch contract](dispatch.md).

Give it three inputs, each in its own tagged block:

```text
<repo_root>absolute path to the repository</repo_root>
<requirement>
the user's requirement, pasted verbatim, including the discussion it came out of.
Do not summarize it. A summary drops the detail one of the three sections
was going to need, and you cannot tell in advance which section or which detail.
</requirement>
<extra_context>
anything else already established, including the confirmed Discussion outcome, or empty
<stored_claims>
the stored entries routed to this agent, each with its source, or omitted
</stored_claims>
</extra_context>
```

Stored project memory goes inside `<extra_context>` when the project has any, in
the `<stored_claims>` tag nested there that [dispatch.md](dispatch.md) defines,
each entry with its `source`. Prose around the entries saying they are claims is
not enough. `<extra_context>` otherwise reads as things already established, and
the tag is what stops a claim being read as one of them. Hand **every** stored entry to this one `recon` agent. None of them stays with
you unchecked. Route still names which *section* must answer it:

| Kind | Section |
| --- | --- |
| `gate`, `hard_rule` | Rules |
| `run_recipe`, `convention` | Code |
| `exclusive_resource` | Rules, and you also declare it in phase 1 |
| `note` | the section its text is about; Code if you cannot tell |

Route on what the entry says, not on the label it was filed under.
[memory.md](memory.md) has the worked example.

The agent owes a verdict on each claim and the line as it reads today, quoted.
The `recon` agent makes the re-check observable. [memory.md](memory.md)
says what the verdicts mean.

## Rules, Product, Code

The loaded `recon` standing rules own what each section returns. You paste
`hardRules` into every later dispatch, confirm the gate commands and the
test-concurrency answer from Rules, and carry the run recipe from Code into
every `qa` brief verbatim. Carry the Code section's viable implementation
ladder into Phase 1 as evidence: it records which implementation level was
actually checked and why earlier applicable levels did not hold. The planner
may choose a broader approach only when an explicit requirement, acceptance
criterion, or recorded product decision justifies it.

An open question that would materially change the result must not slip
silently into implementation in confirm mode.

A formatting gate must be a read-only check mode (`--check`, `-l`, or the
project's equivalent). A gate that edits the tree is not a gate. The run
recipe is what the `qa` role needs in order to do a walkthrough at all.
Without it that lane cannot run, and a task marked `qa` cannot be accepted.

If the Code section could not find the recipe, try the recovery below, and if
that also fails, ask the user, the same as any other unknown. In confirm mode
you wait for the answer. In unattended mode nobody is there to answer, so park the
question in "needs a decision from the user", and in phase 1 every task
carrying `qa` or `ui` is written with the `blocked` status naming that parked
question, propagated downstream. Those tasks do not run without a
walkthrough, and a walkthrough does not happen without the recipe. Do not
dispatch them and skip the walkthrough, and do not invent a start command to
get past this.

## After it returns

The agent already combined the three sections. Name remaining conflicts rather
than smoothing them over. Any conclusion not backed by evidence is an assumption
and must be labelled as one. In confirm mode, an assumption that would change the
product boundary cannot pass into implementation without the user seeing it.

Before phase 1, confirm three things out of the merged result, because later
phases consume them directly: the gate commands from the Rules section, the test
concurrency answer from the Rules section (batch selection in phase 2 depends on
it), and the run recipe from the Code section (the `qa` review lane depends on
it).

## When a section comes back empty

Rules or Code missing: dispatch `recon` again asking only for the missing
section. If it still returns nothing, fill that gap yourself with read-only
shell, file reads, and search. That is information gathering before
orchestration. Whatever you still cannot determine becomes a question for the
user. Do not substitute a default.

Product missing is different, and the self-service path above does not apply.
Re-dispatch `recon` for the product section. If it fails again, write the
non-goals list and the boundary judgment yourself, hand it to the user together
with a plain statement that recon produced no product section this time and that
you set the boundary directly, and wait for an explicit reply before entering
phase 1. When nobody is watching the run, this is the only outside check on
scope that exists, so it is not the step to skip.

This is the one case that stops the whole run rather than blocking individual
tasks, and it stops it in unattended mode too. Every task's scope descends from
the product boundary, so there is nothing left that is safe to run, which is the
"every safe path is blocked" stop condition in [SKILL.md](../SKILL.md). Report
what you have, call `goal` `wait` naming the missing product boundary if the
tool is present, and end the turn. Do not report a finish.
