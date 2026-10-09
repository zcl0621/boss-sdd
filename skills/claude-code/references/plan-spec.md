# The plan document

The plan is a file in the repository, not a message in the conversation and not
the board. It is what a reviewer reads to find out what was supposed to happen,
and what a later session reads to pick the work back up. The board projects the
live status of this document; it does not replace it.

Put it wherever the project already keeps plans. If the project has no
convention, ask the user where it goes rather than choosing for them.

## Sections

**Status.** A header block at the top of the file, before the prose:

```text
Status: running
Run id: <the board's run_id, or "no board">
Base ref: <the commit recorded in phase 0>
Discussion: confirmed (light | full), <date>
Goal mode: armed | off
Project memory: on | off
Integration branch: <name>
Main working tree: <absolute path>
Integration worktree: <absolute path>
Updated: <date>
```

`Status` uses the same plan-level vocabulary as the board: `pending`, `planning`,
`awaiting_confirmation`, `running`, `review`, `blocked`, `done`. Keep it current
at the same moments you would write to the board.

The last three lines are required, not optional, because none of them can be
reconstructed later: the integration branch holds every node's merged work and is
the deliverable; the main working tree is the user's and is the tree that must be
left alone; the integration worktree is where the merges and the post-merge gates
ran. A recovering session given only the branch name cannot tell those two trees
apart, and the one it guesses wrong is the user's.
[worktree-mode.md](worktree-mode.md) says when to write them.

`Discussion` records that phase P ended in an explicit confirmation, at which
depth. A plan without it does not start phase 2. `Goal mode` is `armed` only when
the user asked for goal mode ([goal-mode.md](goal-mode.md)); confirm mode writes
`off`.

`Project memory` records whether the run uses the board's memory store, and it
is `on` unless the user asked for it off. [memory.md](memory.md) says what off
means and why the line is here.
Write it in phase 0 step 1, before the first `plan_memory_list` call would
happen, and do not change it mid-run: a run that read claims in phase 0 and then
switched off would leave the entries it settled unwritten.

`Base ref` has to stay current too. [worktree-mode.md](worktree-mode.md) has the
one case where the phase 0 value is replaced rather than merely recorded: a user
who clears their working tree by committing before a worktree run. This header is
where that replacement lives, and everything downstream reads the base from here.

With a board this header duplicates what the board holds, which is deliberate:
it is what a later session reads when the board is gone, and it is where the plan
status lives when there never was one. Without a board it is the only record of
the plan's own status, and the per-task statuses live in the Tasks section as
described under "Keeping it current".

**Discussion outcome.** The block the user confirmed in phase P, copied
verbatim ([greenfield-prelude.md](greenfield-prelude.md) has the format). Goals,
Non-goals, and Design decisions below must agree with it; if one of them has to
differ, change the outcome first and get the user to confirm it again. A plan
with no confirmed Discussion outcome does not start phase 2.

**Background.** What is true today and why the change is being made. Written from
recon's evidence, with the paths that back it.

**Goals.** What the user will be able to observe once this lands. Observable, not
architectural: "the admin can revoke a session from the user detail page" rather
than "refactor the session store".

**Non-goals.** What this change deliberately does not do. This is the section
that keeps the work from spreading, so be specific. "Not doing the mobile client"
is useful; "not doing unrelated work" is not.

**Design decisions already made.** Each decision, the alternative it beat, and
why. An implementer who disagrees with one of these must stop and say so rather
than quietly building the alternative, and the `spec-auditor` reads this
list -- together with the goals and non-goals -- to catch an implementer who
did not.

**Tasks.** One entry per task, each listing `depends_on`, `write_scope`,
`exclusive_resources`, the role, the acceptance criteria, and the risk or
rollback point. Field meanings are in [dag-contract.md](dag-contract.md). This
section is the source of truth for the DAG: it is written first, and the board is
a mirror of it, not the other way round. The acceptance criteria here are what
gets copied verbatim into dispatch prompts and what the task-audit lane checks
the branch against in phase 3. A task marked `[no-red-test]` carries its reason
there too.

A bug fix is two entries, a `[verify]` task and a `[fix: <verify id>]` task
that depends on it, with the acceptance shapes under "Red-test chains" below.
Any other task that is planned as a chain says why in its entry; one that is not
needs no note, since one test-first node is the default.

Each task also has an **Obstacle ledger**, empty to begin with. Open an entry
only when the evidence identifies an unresolved technical cause. Each entry
records the episode id (`E1`, `E2`, ...), the affected acceptance criterion or
gate, the stable failure signature or finding, the evidenced causal mechanism,
each targeted ordinary repair with the evidence you ran after it, and its state:
`open`, `escalated`, or `resolved`. Before an escalated repair, add why the
finding is not independent and the binding you selected. The board detail
carries only the episode id and state, pointing here. Independent findings open
separate entries. The task's round count sits beside the ledger, because the
ceiling of 6 counts rounds, not episodes.

**Run recipe.** How to start the project: the command, the port or URL, the seed
or fixture step, the test accounts, and any service that must be up first. From
recon lane C, quoted with its source. The `qa` review lane cannot run without
this, so a plan containing any task marked `qa` or `ui-designer` needs this
section filled in before implementation starts.

**Risks and open items.** Known risks with what would trigger them, and anything
still unresolved that does not block starting.

**Decision queue.** Reversible, low-risk choices you made while running, each
with the option you took and why. Goal mode fills this instead of stopping to
ask. It is presented at delivery so the user can overturn any of it cheaply.

**Needs a decision from the user.** Questions parked during the run. In confirm
mode this starts as the batch of questions you asked at the end of recon. In goal
mode it accumulates throughout and is delivered all at once at the end. An entry
here means the answer is unknown; it never means an answer was assumed.

Each entry names the tasks that depend on the answer, and each of those tasks
takes the `blocked` status with a reason pointing back at this entry. An
unanswered question is a real blocker and gets the real status, propagated
downstream like any other. Leaving such a task in `pending` instead would hold
the run short of phase 3 forever.

These two lists are different and must not be merged. The decision queue records
answers you chose and can defend. The parked list records questions you did not
answer. Moving an entry from the second list to the first without getting an
answer turns a question into a guess and hides that it was one.

**Gates.** The exact commands from recon's `gates`, copied verbatim, one per
line, in the form they will actually be run. See [gates.md](gates.md).

## Acceptance criteria

Every task needs criteria that can be executed and that describe behaviour rather
than implementation. Three properties make the difference:

- Runnable. A command, a request with its expected response, or a described
  interaction with a described result. "Works correctly" is not a criterion.
- Behavioural. It should survive a reasonable refactor of the code that satisfies
  it. A criterion that breaks when a private function is renamed is testing the
  wrong thing.
- Complete at the boundary. The happy path, the failure path, and whatever the
  task's own risk section says could go wrong.

### Red-test chains

The two halves of a chain share one set of **named tests**, and both entries
quote it identically: each test's file and name, and the one command that runs
exactly those tests. Naming them is what lets the gates tell an expected red
from an unexpected one, so a criterion like "add tests for the bug" is not
enough.

The verify task's acceptance says, for a bug fix:

- the reported behaviour: what happens today, what should happen instead, and
  how to trigger it, with the user's report or the evidence quoted;
- the named tests, and for each one the failure it must show at this node's
  commit, written as the observed wrong behaviour (`expected 404, got 500`, not
  "fails");
- that every gate other than the named tests is green, and that no production
  file changes.

The fix task's acceptance says:

- the named tests, unchanged, pass;
- any new tests the fix adds beyond the named tests, each listed by file and
  name; only these may be added, and they go red first like any node's;
- every other gate is green;
- the behaviour criteria a user would check, the same as any task.

A non-bug chain uses the same shapes, with the behaviour the tests pin down in
place of the reported bug.

### Using the criteria

These criteria go into the dispatch prompt verbatim. The `spec-auditor` returns
a row per criterion, and a `match` against them, before the node can close; the
static reviewer may still file a coverage finding, which is not that verdict; and
the task-audit lane checks the whole branch against them at close-out. A vague criterion produces a vague review at both levels, and the
failure surfaces at the gates or later, at a much worse moment.

## Keeping it current

When the plan structure changes during the run, update this document first, then
the board if you have one, then revalidate the graph. A task inserted for a bug
found mid-flight gets a full entry here, the same as any other task. The delivery
report at the end is written from this document plus the run's actual evidence,
not from memory.

With no board, this document is the whole status record. The plan's own status
goes in the Status header at the top. Each task's current status goes in its
Tasks entry, in the same vocabulary the board uses (`pending`, `running`,
`review`, `blocked`, `done`), along with the evidence that justified each
transition and, for a blocked task, the reason and the upstream node or parked
question that stopped it. Every instruction elsewhere in this skill to "set the
plan to `review`" or "set the node to `done`" means writing here when there is no
board to write to.
