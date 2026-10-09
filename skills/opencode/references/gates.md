# Gates

A gate is a command the project defines that decides whether the change is
acceptable: formatting checks, lint, type checking, build, unit tests, the full
test suite. Recon's Rules section collected the real commands for this
repository; they are copied verbatim into the plan's Gates section and into each
task's acceptance criteria.

Some of those commands may have reached recon as a stored claim from an earlier
run rather than as a fresh discovery. A claim is not a gate command until recon
has quoted it out of the file that defines it, this run. Running one that
nobody quoted is how a suite that has moved reports green over nothing; see
[memory.md](memory.md).

## The three rules

**You run them.** Not a subagent, not a script, not a wrapper someone wrote to
make it convenient. A gate result is only evidence when you obtained it. When an
implementer reports that the tests pass, that is a claim about a command you have
not seen run, and the whole point of the gate is to be the thing that does not
depend on the implementer's account of its own work.

This rule is for **command gates** (tests, lint, typecheck, build, any
measured ratchet the project defines). It is not the post-commit **scans** a
project's `AGENTS.md` may define (recon quotes them; there may be none). Those
are `ALLOW`/`DENY` reading work: send them after the node commit to one
`explore` call through `explore.post_commit_scan`. Do not send them to
`reviewer`. A `DENY` is a finding you fix through the node's loop.

**Red is send-back.** The one exception is a `[verify]` node's named tests,
below. A green test suite does not waive another red gate. If
the project measures a ratchet (complexity, coverage) and it moved the wrong
way, that lap is red. Do not dispatch quality, adversary, or spec-auditor. Send the raw
command output back through Form A when the session is usable, otherwise ordinary
Form B with the task's starting binding. Classify the failure into its obstacle
episode; gate failure alone does not justify a model escalation.
Independent review is for a change that already passed the commands.

When recon's `gates` include a measured comparison (complexity, coverage) and
the diff touches what it measures, you run that comparison yourself this lap.
Do not wait for a post-commit scan to learn a regression you can measure now.

**One command at a time.** Do not chain gates with `&&`, do not run them as a
batch, do not put several into one shell invocation. When a combined run fails
you get one exit code and have to work backwards to find which stage produced it,
and the usual result is re-running everything.

**Never through a pipe.** No `| head`, no `| tail`, no `| grep`, no redirect that
drops the status. A shell reports the exit status of the last command in a
pipeline, so `pytest | tail -5` exits 0 while the suite is red, and nothing in
the output you kept says otherwise. If the output is long, read the long output.

## Verify nodes: the one expected red

A `[verify]` node exists to commit a bug's reproduction as failing tests, so
its gates are read inverted for those tests and only those. It passes step 5
when all of these hold:

- Each named test (listed in the task's acceptance) fails, and the failure is
  the reported behaviour: the assertion on the bug's observable, with the
  wrong value the bug report describes.
- Every other test in the commands run is green. The suite command still
  exits non-zero because of the named tests; read the output and check that
  the failing set is exactly the named tests.
- Every other gate (lint, type check, build, format check) is green.

Each of these is red for the verify node, and a send-back like any red gate:
a named test that passes; a named test that fails for another reason (import
error, missing fixture, syntax error, timeout, an assertion on something
other than the reported behaviour); any other failing test; any other red
gate. Record the raw output as usual, and say in the record which failures
are the expected named ones.

The fix node gets no exception: the named tests must pass and every gate
must be green, in its tree and again at 8c.

## Which gates when

Per task, at step 5 of the node loop: the gates covering what that task touched,
from its acceptance criteria. This is the fast feedback used to verify each
repair and decide whether an obstacle episode remains.

At branch close-out: the project's full set. Formatting check, type check, build,
and the complete test suite, whatever the project actually defines. A green
per-task gate does not imply a green full suite. Task gates run scoped, so what
the tasks did to each other falls outside every one of them.

Watch the exclusive resources here. A gate that takes a serial test lock is why
`exclusive_resources` exists, and a task holds its resources through its gate
stage, not just through implementation.

A task's gates run inside that task's worktree, which means a full build per
tree, and a second gate run per task in the integration worktree after its
branch merges (8c). The close-out set runs in the integration worktree. The three rules above are unchanged
by any of that, and a gate that contends for a machine-global resource still
serialises on `exclusive_resources`, because a worktree isolates files and not
ports, devices, or databases. See [worktree-mode.md](worktree-mode.md).

## Recording the result

Paste the raw output. Not a summary of it, not "5/5 passed" on its own. The exit
code and the failure text are what let the user re-check the claim later. A
summary reads the same whether or not the command was ever run.

For the delivery report, the per-gate line is the command, the exit status, and
the relevant output. Successes can be short. Failures get quoted in full.

## When a gate cannot run

Sometimes a gate needs something that is not available: a network service, a
credential, a device, a platform you are not on. That is a legitimate outcome and
it has exactly one correct handling:

- Record the command, what it needed, and what was missing.
- Say plainly that it did not run. Do not substitute a similar command and report
  it as though it were the gate.
- Keep it in the plan summary and in the delivery report as an unrun gate.

An unrun gate never counts as a pass, and "it would have passed" is not a result.

## A formatting gate must not write

A formatting command in write mode changes files, which means it can quietly
rewrite the user's pre-existing changes and can make a diff you already reviewed
no longer match what is on disk. The gate is the check mode: `--check`, `-l`, or
whatever the project's formatter calls it. If recon returned a write-mode command
as the formatting gate, that is a recon error to correct, not a gate to run.
