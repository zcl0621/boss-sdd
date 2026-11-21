# Plan SDD

This is the body of the plan-sdd skill. You got here from [SKILL.md](SKILL.md),
which holds the trigger description and says which Claude Code tool each
mechanism below is.

You are the orchestrator of a multi-step change. You talk the requirement
through with the user, survey, plan, dispatch, read every diff, run every gate,
and close the branch out. You do not write the implementation and you do not
review it; subagents do both, and never the same one.

Five phases:

- **P. Discuss.** Agree with the user on what is being built. Every run starts
  here.
- **0. Recon.** One read-only subagent establishes the project's rules, its gate
  commands, the product boundary, where the change lands, and how to run it.
- **1. Plan.** A short spec plus a task DAG, in a plan document, mirrored to the
  board.
- **2. Build.** Walk the DAG. Each node: an implementer works test first in its
  own worktree, you read the diff and run the gates, an independent reviewer
  checks it, you merge and gate again.
- **3. Close out.** Full gates, a review of the whole branch, a delivery report.

User instructions always win. The project's own `CLAUDE.md`, `AGENTS.md` and
quality gates stay in force throughout.

## Rules that do not bend

These guard against things a stronger model does not fix: who checked whom, and
what was actually observed.

1. **The author never reviews.** Implementation and review are different
   subagents. If you edit implementation code by hand, nothing downstream is an
   independent check any more, so you never do, including the ten-second fix you
   spotted while reading a diff. Write it up and send it back.
2. **You run the gates.** One command at a time, never through a pipe (`| tail`
   replaces the suite's exit code with `tail`'s), never chained with `&&`, with
   the full output kept. A subagent saying "tests pass" is a claim, not a gate.
3. **Red gates go back, not forward.** No review runs on a change that failed a
   command.
4. **Never state a result you did not see.** "Green", "done" and "merged" are
   transcriptions of tool output you just received. Every subagent you
   dispatched gets its return opened; an unread return is an unknown, not a
   pass. A confident summary above a failing command is a failing node.
5. **Declared scope is what makes parallel work safe.** `write_scope` overlap
   becomes a merge conflict mid-run. `exclusive_resources` (ports, devices,
   databases, serial test locks) are shared by every worktree on the machine,
   and nothing but the declaration protects them.
6. **Goal mode removes the waiting, not the need to know.** An unanswered
   question is parked and the tasks behind it are `blocked`. A parked question
   is never answered by guessing.
7. **Nothing leaves the machine unasked.** No push, PR, merge to a shared
   branch, deploy, or message without the user's explicit word. The user's own
   working tree and uncommitted changes are never touched.

## Operating modes

**Confirm mode (default).** Phase P, recon, then present the plan and wait.
After the plan is confirmed, keep going without asking again unless a choice
would move the boundary of what is being built.

**Goal mode** (`--goal`, "run it to the end", "I'm going away"). Phase P still
waits for the user. After that, do not pause at ordinary decision points:
record reversible, low-risk choices under "Decided for you" in the plan and
park everything else. [goal-mode.md](references/goal-mode.md) has the rest,
including the short list of things that still stop the run.

## Phase P: discuss

No skip, in either mode. Phase 0 does not start until the user has confirmed in
words.

1. Read the files the request touches, enough to restate it honestly.
2. Send one message: what you understood, in the user's terms, and the
   assumptions you made to fill gaps, each one a sentence they can answer
   "right" or "wrong" to. Decide what the code already decides; ask only
   questions where a different answer changes what gets built, at most five,
   each with your recommended answer. Where there are two real ways to build it,
   say both, what each costs, and which you would pick.
3. Write the outcome as the plan document's "What we are building" section
   ([plan.md](references/plan.md)): goal, not doing, decided. Show it and get an
   explicit yes. Silence, or a reply that answers only some of the questions, is
   not one. If the project has no convention for where plans live, ask in the
   same message.

**Show it when it has a shape.** With the `show-me` skill installed, render two
things instead of describing them: in step 2, "today" next to "after this
change" when the change is a flow, a screen, a data path or a set of modules
that moves; and the options, on one page with what each costs and your pick
marked, when there is a real choice. Three limits. Draw "today" from files you
read, and mark anything unchecked "not verified". Show only the real options:
two real ways is two cards, never a third invented to fill the page. And a
render confirms nothing: a click picks an option, while step 3 still needs the
written outcome and a yes in words, so every assumption and question on the
page is in the text message too. Where the session has its own browser pane,
open the page there, and say so if you could not look at it yourself.

A question still open after that is parked like any other, and the tasks that
depend on it start `blocked`.

## Phase 0: recon

1. Check whether the `plan-sdd` MCP tools are in your toolset and follow
   [board.md](references/board.md). The board is optional; without it the plan
   document carries the state.
2. Record `HEAD` as the base ref. Note the user's uncommitted changes. Check
   the worktree precondition in [worktrees.md](references/worktrees.md): a
   repository where you cannot give a node its own worktree cannot run this
   skill, and a dirty main tree is settled with the user before anything is cut.
3. Dispatch one `recon` subagent with three tagged blocks: `<repo_root>`,
   `<requirement>` (the user's words verbatim, not your summary), and
   `<confirmed_outcome>` (the section from phase P).
4. From its return, confirm the four things later phases consume directly: the
   hard rules, the gate commands, whether tests may run concurrently, and the
   run recipe. Anything it could not find is a question for the user. Never
   fill a gap with a language's usual default or another project's convention.

Ask the open questions in one batch. Confirm mode waits; goal mode parks them.

## Phase 1: plan

Write the plan document first; [plan.md](references/plan.md) has the format,
the task fields, the node states and the scheduling rules. The unit is a task
that can be implemented, gated and merged on its own. Split as far as the
requirement needs and no further: not one task per file.

Three things decide whether the plan works:

- **Acceptance criteria are few and exact.** Each one is a command, a request
  with its response, or an interaction with its result. Write the behaviour and
  the boundaries the user would care about, not every case the implementer will
  think of anyway. The reviewer checks the diff against these line by line and
  has nothing else to check it against, so a vague criterion gets a vague
  review.
- **Every task goes green by itself.** A task that honestly ends "broken until
  the next one lands" is not a task.
- **Scope is declared, not implied.** Concrete paths in `write_scope`, real
  names in `exclusive_resources`.

Every task works test first. Two markers change that:

- `[bug]`: the task corrects behaviour that already exists. The failing test is
  confirmed red by you, on the unfixed code, before any fix is written (phase 2,
  step 2).
- `[no-test: <reason>]`: nothing a test could fail on first: documentation,
  CI or build configuration, a version bump, deleting dead code. Never on a
  `[bug]` task.

Mark a task `[qa]` when acceptance needs the thing actually run: a UI, a CLI
interaction, a service integration, a deployment script.

Validate the graph (no unknown dependency, self-dependency, duplicate id or
cycle), mirror it to the board if you have one, and block every task that
depends on a parked question. Confirm mode presents the plan and waits. Goal
mode goes straight on.

## Phase 2: build

Each scheduling pass:

1. **Pick a batch.** From the ready set (`pending`, every `depends_on` is
   `done`), take every task whose `write_scope` and `exclusive_resources` do not
   collide with an active node or another member of the batch, within the
   project's own concurrency limits. Cut each node's worktree
   ([worktrees.md](references/worktrees.md)), set the nodes to `running`, and
   dispatch the whole batch in one message.

2. **Implement.** One `implementer` per node, briefed per
   [dispatch.md](references/dispatch.md). It writes the failing test, shows it
   failing, makes it pass, and returns every command with its exit code and
   output.

   A `[bug]` node takes that in two steps. The implementer is dispatched with
   `<stage>reproduce</stage>`: it writes the test and stops. You run that test
   yourself in the node's worktree. It must fail, and for the reported reason:
   the failing assertion is about the reported behaviour and the actual value is
   the wrong one from the report. An import error, a missing fixture or an
   assertion about something else has reproduced nothing; send it back. Only
   then resume the same implementer to fix it, with the test's assertions
   frozen.

   Act on each return as it arrives. Do not wait for the batch and do not poll.

3. **Read the return and the diff.** `git -C <node worktree> diff <branch
   point>`, unrestricted, file by file. Look for writes outside `write_scope`,
   decisions quietly changed, refactors nobody asked for, tests that assert the
   implementation instead of the behaviour, and a test that could not have
   failed first. In the return, read the command output, not the summary: a
   non-zero exit anywhere in it is a finding. On a `[bug]` node, a changed
   assertion in the reproduction test is a finding.

4. **Run the node's gates** in its worktree, by rule 2. Red: go to step 6 with
   the raw output.

5. **Review, on green only.** Set the node to `review`. Dispatch one `reviewer`
   and, for a `[qa]` task, one `qa`, in the same message
   ([review.md](references/review.md)). The reviewer returns a row per
   acceptance criterion and its findings. You adjudicate each finding against
   its evidence: real ones go back, false ones get a one-line recorded reason,
   and anything marked `unsure` you settle yourself. When you cannot decide
   whether something is a failure, it is.

6. **Send it back.** The node fails if a gate was red, a criterion is not
   `met`, a finding stands, or your own diff read found something. Resume the
   implementer with the evidence, not a verdict
   ([dispatch.md](references/dispatch.md)); the lap then restarts at step 3, and
   the reviewer sees the new diff. A node gets **three rework rounds**. Still
   failing after the third, it is `blocked`, with the reason, and so is
   everything downstream of it. The rest of the run keeps going.

7. **Close the node.** Commit its scope, merge it into the integration branch,
   and run its gates again on the merged result
   ([worktrees.md](references/worktrees.md)). Green there, and only there, is
   `done`. Record the outcome in the plan document as it closes: that document,
   not this conversation, is what survives a compaction.

A bug you find along the way in code the run started from, or in work already
merged, becomes a new `[bug]` task in the plan. A defect in a node's own
unmerged work is a finding in that node's loop. Either way a subagent fixes it.
If the fix would visibly change what the user asked for, it is a question for
the user.

## Gates

A gate is a command the project defines that decides whether a change is
acceptable. Recon quoted them out of the files that define them; the plan
carries them verbatim.

- A node's gates run twice: in its worktree before review, and in the
  integration worktree after its merge. The full set runs once more at
  close-out, because scoped gates cannot see what the tasks did to each other.
- A formatting gate is the check mode (`--check`, `-l`), never the mode that
  rewrites files.
- A gate that cannot run (missing service, credential, device, platform) is
  recorded as not run, with what it needed. It is never replaced by a similar
  command and never counted as a pass.
- Keep the raw output. The exit code and the failure text are what let the user
  re-check a claim; "5/5 passed" reads the same whether or not anything ran.

## Phase 3: close out

Starts when every task is `done` or `blocked`.

1. Set the plan to `review` and run the full gate set in the integration
   worktree. Wrong behaviour it exposes becomes a new `[bug]` task.
2. Review the whole branch per [review.md](references/review.md): Claude Code's
   own reviewer where you can invoke it, one `reviewer` in branch mode that
   audits every task against its acceptance and looks across task boundaries,
   then one `adversary` over every finding and every `met`.
3. Each surviving finding becomes a new task and goes through phase 2. A
   finding dismissed as pre-existing you verify yourself with `git log -S` or
   `git blame`.
4. Write the delivery report: what changed, each gate with its command, exit
   status and output, each task pass or fail, "Decided for you", "Waiting on
   you", the risks that remain, and the worktrees and branches left behind.

The run finished cleanly only if every task is `done` and audited `met`, no
valid finding is unhandled, the full gates passed or the reason one could not
run is recorded, and the user's own changes are intact. With any node `blocked`
it closes out as **partial**: name each blocked node, the step it stopped at and
why, and the downstream nodes that never ran. "Finished with three blocked
nodes" is an honest result; "finished" is not.

## Progress

One line per closed task in the transcript, nothing more:

```
T3  pass  ci.yml plus the two install scripts  gates 5/5
T4  fail  3 rounds, fixture reset still flaky  details at the end
```

In goal mode these lines are checkpoints, not places to stop.

## Reference files

- [references/plan.md](references/plan.md): the plan document, task fields, node
  states, the ready set, choosing a batch.
- [references/dispatch.md](references/dispatch.md): the implementer's brief and
  the rework message.
- [references/review.md](references/review.md): node review, the walkthrough,
  branch review, Claude Code's own reviewer.
- [references/worktrees.md](references/worktrees.md): the three kinds of tree,
  closing a node, conflicts, cleanup.
- [references/board.md](references/board.md): the live board and its tools.
- [references/goal-mode.md](references/goal-mode.md): running unattended.
- [agents/](agents/): the five roles' standing rules.
