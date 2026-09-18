# Gates

A gate is a command the project defines that decides whether the change is
acceptable: formatting checks, lint, type checking, build, unit tests, the full
test suite. Recon lane A collected the real commands for this repository; they
are copied verbatim into the plan's Gates section and into each task's acceptance
criteria.

## The three rules

**You run them.** Not a subagent, not a script, not a wrapper someone wrote to
make it convenient. A gate result is only evidence when you obtained it. When an
implementer reports that the tests pass, that is a claim about a command you have
not seen run, and the whole point of the gate is to be the thing that does not
depend on the implementer's account of its own work.

**One command at a time.** Do not chain gates with `&&`, do not run them as a
batch, do not put several into one shell invocation. When a combined run fails
you get one exit code and have to work backwards to find which stage produced it,
and the usual result is re-running everything.

**Never through a pipe.** No `| head`, no `| tail`, no `| grep`, no redirect that
drops the status. A shell reports the exit status of the last command in a
pipeline, so `pytest | tail -5` exits 0 while the suite is red, and nothing in
the output you kept says otherwise. If the output is long, read the long output.

## Which gates when

Per task, at step 5 of the node loop: the gates covering what that task touched,
from its acceptance criteria. This is the fast feedback and it is what the fix
rounds are measured against.

At branch close-out: the project's full set. Formatting check, type check, build,
and the complete test suite, whatever the project actually defines. A green
per-task gate does not imply a green full suite. Task gates run scoped, so what
the tasks did to each other falls outside every one of them.

Watch the exclusive resources here. A gate that takes a serial test lock is why
`exclusive_resources` exists, and a task holds its resources through its gate
stage, not just through implementation.

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
