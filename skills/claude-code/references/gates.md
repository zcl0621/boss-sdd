# Gates

A gate is a command the project defines that decides whether the change is
acceptable: formatting checks, lint, type checking, build, unit tests, the full
test suite. Recon lane A collected the real commands for this repository; they
are copied verbatim into the plan's Gates section and into each task's acceptance
criteria.

Some of those commands may have reached lane A as a stored claim from an earlier
run rather than as a fresh discovery. A claim is not a gate command until the
lane has quoted it out of the file that defines it, this run. Running one that
nobody quoted is how a suite that has moved reports green over nothing; see
[memory.md](memory.md).

## The rules

**You run them.** Not a subagent, not a script, not a wrapper someone wrote to
make it convenient. A gate result is only evidence when you obtained it. When an
implementer reports that the tests pass, that is a claim about a command you have
not seen run, and the whole point of the gate is to be the thing that does not
depend on the implementer's account of its own work. The implementer's brief
lists these commands under `<orchestrator_gates>` so it knows what it will be
judged by; it never runs them as evidence that the node passed.

**Red is send-back.** Gates run before any review, and a red gate ends the lap:
no static review, no spec audit, no walkthrough, no adversary. Send the raw
output back through the rework message in [dispatch.md](dispatch.md), with the
failure classified into its obstacle episode. A green test suite does not waive
another red gate, and a gate failure on its own never justifies a stronger model;
only an episode that survived two ordinary repairs does. Independent review is
for a change that already passed the commands.

A `[verify]` node is the one place the expectation inverts; see the next
section. Everywhere else, red means a non-zero exit.

When a gate is a measured comparison (complexity, coverage, a size budget) and
the diff touches what it measures, run that comparison yourself on this lap. A
ratchet that moved the wrong way makes the lap red like any failing command.

**One command at a time.** Do not chain gates with `&&`, do not run them as a
batch, do not put several into one shell invocation. When a combined run fails
you get one exit code and have to work backwards to find which stage produced it,
and the usual result is re-running everything.

**Never through a pipe.** No `| head`, no `| tail`, no `| grep`, no redirect that
drops the status. A shell reports the exit status of the last command in a
pipeline, so `pytest | tail -5` exits 0 while the suite is red, and nothing in
the output you kept says otherwise. If the output is long, read the long output.

## A verify node's gates

The `[verify]` half of a red-test chain closes with its named tests failing on
purpose ([dag-contract.md](dag-contract.md)), so its gates are judged against
that expectation instead of against "everything exits 0". All three of these
must hold, and any one that does not is the node's red gate, sent back like any
other:

- **The named tests fail.** Run them by the command the plan names for exactly
  those tests. It must exit non-zero. A named test that passes reproduces
  nothing: the test does not reach the bug, or the bug is not what was reported.
- **They fail for the reported reason.** Read the failure text against the
  reported behaviour in the task's acceptance: the assertion that fails is the
  one about that behaviour, and the actual value is the wrong one the report
  describes. A compile error, an import error, a missing fixture, a timeout, or
  an assertion about something else is a failure for another reason, and that
  is a red gate, not a pass.
- **Every other gate is green.** Formatting, lint, type checking and build run
  as usual and must exit 0. The full test suite will exit non-zero, because it
  contains the named tests; read its output, and the only failures in it must be
  the named tests, failing as above. Any other failing test is a red gate. This
  is the one gate whose exit code you cannot take as the verdict, which is why
  you read the whole output rather than filtering it: a pipe here is still
  forbidden.

Record the named tests' failure text in the plan document when the node closes.
The fix node is checked against it before it is dispatched.

The `[fix: <id>]` half has no special case. Its gates must all exit 0, the
named tests included, and a named test that still fails, or that passes only
because it was edited, is a red gate.

## Which gates when

Per task, at step 4 of the node loop, before any review: the gates covering what
that task touched, from its acceptance criteria. This is the fast feedback, and
it is what tells you whether a repair cleared its obstacle episode.

At branch close-out: the project's full set. Formatting check, type check, build,
and the complete test suite, whatever the project actually defines. A green
per-task gate does not imply a green full suite. Task gates run scoped, so what
the tasks did to each other falls outside every one of them.

Watch the exclusive resources here. A gate that takes a serial test lock is why
`exclusive_resources` exists, and a task holds its resources through its gate
stage, not just through implementation.

A task's gates run inside that task's worktree, which means a
full build per tree, and a second gate run per task after its branch merges. The
close-out set runs on the integration branch. The rules above are unchanged
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
