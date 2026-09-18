# Dispatching a subagent

A subagent starts with no memory of this conversation. Everything it needs has to
be in the prompt you send it. A prompt that assumes shared context produces a
subagent that fills the missing half by improvising, which is the failure the DAG
and the write scopes exist to prevent.

Build each dispatch prompt deliberately. The sections below are the checklist. If
your environment offers a prompt-authoring skill, use it here rather than
assembling the prompt by feel.

## The context bundle

Throughout this skill, "the full context bundle" means all eleven tagged blocks
plus the role identity line:

`<goal>`, `<background>`, `<design_decisions>`, `<write_scope>`, `<hard_rules>`,
`<protected_changes>`, `<acceptance>`, `<how_to_work>`, `<stop_conditions>`,
`<output_contract>`, `<forbidden>`.

In other words: the whole structure below, with nothing left out because it was
said earlier in the conversation. The subagent was not in that conversation.

The bundle is assembled once per task and kept. You will need it again when a
node fails and your platform cannot resume the original subagent.

## Structure

Wrap every block of pasted content in its own tag. Without the tags, a
requirement that happens to contain an imperative sentence reads as an
instruction to the subagent, and a diff that contains a comment reading "TODO:
remove this check" gets acted on.

```text
You are the <role> for <this work item> in this plan. <one line of role identity, from roles.md>

  <this work item> is whichever of these the dispatch is against:
    a task           -> "task T3"          (implementer, ui-designer, qa, reviewer)
    a recon lane     -> "the rules lane"   (recon-rules, recon-product, recon-code)
    a review lane    -> "the tests lane"   (branch-reviewer)
    a set of claims  -> "these 7 findings" (adversary)
  Never write a task id for a dispatch that is not against a task. The three
  recon lanes run before any task exists.

<goal>
What the user will be able to observe when this task is done.
</goal>

<background>
The confirmed findings from recon that this task depends on, with the file paths
that back them. Include the existing patterns this task should follow.
</background>

<design_decisions>
The decisions already made that this task must respect, each with its reason.
If you think one of these is wrong, stop and say so. Do not build the alternative.
</design_decisions>

<write_scope>
The exact paths this task may write. Do not write anything outside this list.
If the work genuinely requires a file outside it, stop and report that instead.
</write_scope>

<hard_rules>
The project's hard rules, quoted from recon lane A verbatim.
</hard_rules>

<protected_changes>
The user's pre-existing uncommitted changes. Do not revert, rewrite, or
reformat any of these.
</protected_changes>

<acceptance>
The acceptance criteria and the exact commands to run, copied verbatim from the
plan. Run these commands. Do not go looking for your own.
</acceptance>

<how_to_work>
The TDD requirement, below.
</how_to_work>

<stop_conditions>
If you cannot do this, say exactly where you are stuck and stop. Do not invent an
approach and push it through. Specifically, stop and report if: the acceptance
commands do not exist or do not run; the work requires writing outside the write
scope; a design decision above appears to be wrong; you would have to change a
test's expectations to make it pass.
</stop_conditions>

<output_contract>
Report: the files you changed and why; every command you ran with its raw output
pasted in full, successes and failures alike; anything you got stuck on. Do not
write a summary that says work is complete in place of the output. A command's
output is the evidence; your description of it is not.
</output_contract>

<forbidden>
Do not commit. Do not push. Do not widen the scope. Do not refactor code that
this task does not require you to change. Do not delete or weaken a test to make
the suite pass. Do not hand-edit generated files, historical migrations, or
vendored directories.
</forbidden>
```

## The TDD requirement

Paste this into `<how_to_work>` for every implementing role:

```text
Write or change the test first, then the implementation.

1. Write a test that expresses the behaviour this task promises, and that fails
   for the right reason today. Run it and paste the failure. A test that passes
   before you write any implementation is testing the wrong thing.
2. Write the smallest implementation that makes it pass. Run it and paste the
   result.
3. Clean up only the code you just wrote.
4. Run the acceptance commands given above, one at a time, and paste each one's
   full output.

Test behaviour, not implementation. If renaming a private function breaks your
test, the test is coupled to the wrong thing. If you cannot write a failing test
for a change, say so and explain why rather than skipping the step quietly.
```

The check that this actually happened is yours, at step 4 of the node loop: read
the diff and confirm the tests assert the behaviour the task promised. A test
added at the same moment as the code it tests, asserting only what that code
happens to do, is the common failure and it is visible in the diff.

## Extra clauses by role

**`ui-designer`.** Open the prompt with the identity: this subagent is the UI
designer for the task and settles the visual direction before writing code. Order
of authority for the visual language: the project's own design conventions and
component library first; only when there is genuinely nothing to follow does it
fall back to a general design skill. It must not start a second design system
alongside the one the project already has.

Its delivery includes four statements of visual direction, one sentence each, on
top of the code and the raw command output:

1. Which existing page, component, or design document it worked from.
2. Which existing tokens and components it reused. Colours, spacing, radii, font
   sizes and weights, component names, listed individually.
3. What it created new. "None" if nothing.
4. Every place it diverged from its reference, with the reason for each.
   "None" if there are none.

Pass those four statements to the reviewer verbatim as the visual claims to check
against what the screen actually shows.

**`qa`.** The task's own implementer needs no extra identity for this. The role
marker is what makes the review stage add a runtime walkthrough lane. See
[review.md](review.md) for what a walkthrough has to record.

## The rework message

When a node fails, the implementer gets the evidence, not a verdict. Which
message you send depends on whether your platform can resume the subagent that
did the work. Decide that first, because the two messages are not
interchangeable: sending the short one to a fresh subagent leaves it with no
goal, no write scope, no rules, and no acceptance commands.

Either form counts as one round, and both tell the subagent which round it is on.
That matters: round 3 is the last, and a subagent that knows it should say it is
stuck rather than reach for something increasingly speculative.

### Form A, when you can resume the original subagent

Its original prompt is still in its context, so add only what is new:

```text
<review_findings>
Each confirmed finding, quoted as the reviewer wrote it, plus your own judgement
on each finding the reviewer marked unsure.
</review_findings>

<gate_output>
The raw output of the failing gate commands, untruncated, with the exit codes.
</gate_output>

<diff_notes>
Whatever your own read of the diff turned up: changed design decisions, unplanned
refactors, tests that do not cover the behaviour change.
</diff_notes>

Fix these. Do not start other work. Re-run the acceptance commands from your
original brief and paste the full output. This is round <n> of 3.
```

### Form B, when you cannot

The new subagent knows nothing. Send the full context bundle again, unchanged
from the original dispatch, and then the three rework blocks and a different
closing instruction.

"The full context bundle" means everything listed at the top of this file, all
eleven tagged blocks and not a subset of them: the role identity line, `<goal>`,
`<background>`, `<design_decisions>`, `<write_scope>`, `<hard_rules>`,
`<protected_changes>`, `<acceptance>`, `<how_to_work>`, `<stop_conditions>`,
**`<output_contract>` and `<forbidden>`**. Those last two are the ones most
easily dropped and the most costly to drop: without `<output_contract>` the
subagent returns prose saying it finished instead of the raw command output you
need to judge it on, and without `<forbidden>` nothing tells it not to commit,
not to push, and not to widen its scope.

```text
<role identity line, then every block of the context bundle verbatim:
 goal, background, design_decisions, write_scope, hard_rules,
 protected_changes, acceptance, how_to_work, stop_conditions,
 output_contract, forbidden>

<work_already_done>
Another agent has already implemented this task. Its work is in the working tree.
You are continuing it, not starting over. Read the current state of the files in
your write scope before changing anything, and do not revert work that the
findings below do not ask you to change.
</work_already_done>

<current_diff>
The output of `git diff <baseline> -- <scope paths>`, so you can see what is
already there without reconstructing it.
</current_diff>

<review_findings>
...as in form A...
</review_findings>

<gate_output>
...as in form A...
</gate_output>

<diff_notes>
...as in form A...
</diff_notes>

Fix the findings above. Do not rewrite the parts nobody objected to, and do not
start other work. Re-run the acceptance commands in your brief and paste the full
output. This is round <n> of 3.
```

The `<work_already_done>` and `<current_diff>` blocks are what stop a fresh
subagent from deciding the task is unstarted and building it again from nothing,
which is the characteristic failure of form B.

You never make these edits yourself. That includes the bug you spotted while
reading the diff and could fix in ten seconds. Write it up and send it back.
