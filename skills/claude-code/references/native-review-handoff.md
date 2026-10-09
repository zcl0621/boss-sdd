# The native branch reviewer

Claude Code ships a code reviewer that runs locally against the current branch.
It is better at this specific job than a general subagent you brief yourself,
because it was built for it. So it is worth running.

**Whether you can launch it yourself varies by installation.** Some setups
expose the reviewer to agents as an invocable skill or tool; others expose it
only as a command the user types. [native-review.md](native-review.md) records
what is known for Claude Code and is more current than this file. Otherwise,
check rather than assume:

1. Look through your own available skills, commands, and tools for a code review
   entry. Match on what it does, not just on a name.
2. If you find one you can invoke, run it and triage its output the same way you
   triage any other review. Nothing else in this file changes.
3. If you find nothing you can invoke, hand off to the user using the protocol
   below.

The check decides it. Do not talk yourself out of a reviewer you can actually
invoke, and do not talk yourself into one you cannot.

When it is a handoff, it is a real one. Do not try to route around it by shelling
out to the command, by simulating keystrokes, or by asking another agent to type
it. And do not report a review you did not obtain: an agent that assumes the
command is just another tool call will write up findings that never existed.

The skill's own branch review (six `branch-reviewer` lanes plus `adversary`, in
[review.md](review.md)) is the path that never depends on any of this. The two
are not alternatives. Run the subagent review always; add the native review on
top, whichever way you get it.

## The commands

`/code-review` reviews the current branch; `/code-review ultra <PR#>` runs a
cloud multi-agent review of a pull request, and is always a handoff
([native-review.md](native-review.md) says why). Command names move; if the user
says the command does not exist, ask them what their version calls it rather
than guessing.

## Which branch it sees

"The current branch" is the branch checked out in the working directory the
reviewer runs in. Your session sits in the main working tree, and the main tree
never holds the integration branch ([worktree-mode.md](worktree-mode.md)), so a
`/code-review` typed into this session reviews the user's untouched branch and
can come back clean for that reason alone. Point it at the integration worktree:

- Invoking it yourself: only if you can run it with the integration worktree as
  its working directory, or it takes the branch as an argument. Otherwise treat
  it as a handoff.
- Handoff: the user opens a new Claude Code session in the integration worktree
  and runs the command there.

Never switch the main tree to the integration branch to make this work.

## Preparing the branch

Do this whether you are invoking the reviewer yourself or asking the user to.
Either way the branch has to be in a state worth reviewing.

1. Every task's status is `done` or `blocked`, and the blocked ones are written
   up.
2. The work is committed as far as the project's conventions call for, and
   nothing is pushed.
3. The working tree holds no debris: no stray scratch files, no commented-out
   experiments, no leftover debug logging.
4. All the gates have been run by you, with their output recorded. Reviewing a
   branch that does not build produces findings about the build, not the change.
5. The plan document is current, so the reviewer, or the user reading its output,
   can see what the branch was supposed to do.

## Asking, when it is a handoff

Give the user the command to type, one line of what it will look at, and what to
do with the output. Keep it short; they are being asked for a keystroke, not a
briefing.

```text
The branch is ready for the native reviewer. In a new terminal, start Claude
Code in the integration worktree and run the review there:

    cd <integration worktree path> && claude
    /code-review

It reviews the branch checked out there (<integration branch>). Paste whatever
it reports back here and I will triage each finding and route the real ones into
the right task's fix round.
```

## Triaging what comes back

The same three steps whether you ran the reviewer yourself or the user pasted its
output back. Treat the findings as evidence from an outside reviewer:

1. Run the `adversary` role over each finding. Is it reachable, is it actually
   wrong, is it already handled, did it predate this branch?
2. Sort the survivors the same way as the branch review results in
   [review.md](review.md): findings that belong to a task go back into that
   task's fix loop with its round count carried forward, findings that belong to
   no single task become new tasks inserted under the
   [DAG contract](dag-contract.md).
3. Dismissals get a one-line recorded reason. Anything dismissed as pre-existing
   you verify yourself with `git log -S` or `git blame`.

You do not fix any of it by hand. It goes back to a subagent like every other
finding.

## When the user is not there

This section applies only when the reviewer turned out to be a handoff. If you
can invoke it yourself, goal mode changes nothing: run it.

Otherwise, in goal mode there is nobody to type the command, and waiting would
defeat the mode. Do not block on it, and do not pretend it ran.

Run the skill's own branch review, finish the close-out on that basis, and put
the native review in the delivery report as an explicit outstanding item: the
command to run, the fact that it has not been run, and the offer to triage the
findings when they paste them back. That is a parked item, the same as any other
parked question. It is not a gate you may record as passed.
