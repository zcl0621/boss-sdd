# The DAG contract

The task DAG describes completion dependencies between tasks. Each node
separately runs its own implementation, review, and gate state machine. The DAG
has no back edges, and the fix and re-review rounds inside a node never change
its topology.

Dispatch nodes as subagents. To run several conflict-free nodes at once, issue
all their dispatch calls in a single message. A fix round inside a node continues
with the subagent already working that node while it can still be resumed; when
it cannot, or when the round is an escalated repair, dispatch a fresh subagent
with the full context bundle defined in [dispatch.md](dispatch.md). Either way it
is one round of the same node, and the count does not start over.

Every node gets its own git worktree on its own branch, and there is no other
mode; the mechanics are in [worktree-mode.md](worktree-mode.md). That leaves the
content of this file standing and changes how two of its rules read, each flagged
where it is stated: the definition of `done` below includes a merge and a second
gate run on the merged result, and a node blocked after its review passed returns
to `review` rather than to `pending`. It also adds a merge lock, which is
deliberately not an `exclusive_resources` entry and is not subject to the batch
rules; that file says why.

**Isolation does not relax the declarations below.** "Each node has its own tree"
reads like permission to schedule loosely, and for half of these rules the
opposite is true. `exclusive_resources` is untouched by isolation, because a
serial test lock, a database, a device or a port is shared by every tree on the
machine — that declaration now carries the concurrency safety on its own, with
nothing behind it. `write_scope` overlap still costs you a merge conflict you
resolve by hand in the middle of a run, so the rule against overlap inside a
batch stands.

## What each task declares

- `id`. Short, unique within the run, and stable once created.
- `depends_on`. Direct predecessors, and only real completion dependencies. An
  edge means "this cannot start until that is done", not "I would rather do that
  first".
- `write_scope`. The concrete paths or modules the task expects to write. A
  directory covers everything under it. A parent and a child path overlap, an
  identical path overlaps, and a known shared build artifact overlaps.
- `exclusive_resources`. Anything the project says cannot be used by two things
  at once: a serial test lock, a shared device, a database, a deployment
  environment. `[]` when there are none.
- The goal and its user-observable result, the implementing role, runnable
  acceptance criteria, and the risk or rollback point.

Two failure modes to avoid in opposite directions. Do not declare the whole
repository as every task's write scope, which serializes everything. Do not
under-declare a shared path or resource to manufacture parallelism, which is
worse, because the resulting corruption shows up as a confusing gate failure in
some other task.

The plan's `exclusive_resources` maps to the board task field named
`exclusive_resource`.

**Outside a red-test chain, a task that cannot go green by itself is not a
task.** `done` includes a merge and a gate run on the merged result, so an
ordinary node that ends with its tree red has nothing to merge and nothing that
can pass, and a `depends_on` edge does not rescue it: an edge orders work, it
does not let a predecessor close red. A task whose honest acceptance reads "the
suite is failing, and the next task fixes that" is either declared as the verify
half of a chain, below, or rewritten so it can go green. Deciding this at
planning time costs a minute. Discovering it at the node's merge step costs the
node.

### Red-test chains

A red-test chain is the one shape in which a node closes red, and it is
declared, never improvised. It is two tasks:

- **The verify task**, marked `[verify]`. Its `write_scope` is test files only.
  Its acceptance names the tests it adds and the reported behaviour each one
  must fail on (see [plan-spec.md](plan-spec.md)).
- **The fix task**, marked `[fix: <verify id>]`. Its `depends_on` includes the
  verify task, its `write_scope` is production code plus the paths of any new
  tests its own acceptance lists (it never edits or deletes the named tests),
  and its acceptance is that the same named tests pass with every other gate
  green. Those new tests go red first, through the red-test stage and audit,
  like any node's.

A bug fix is always declared this way, never as one task. Other work is one
test-first task by default, and a chain where the orchestrator judges the tests
worth settling on their own first; [PLAYBOOK.md](../PLAYBOOK.md) phase 1 says
when. A chain is exactly one verify task and one fix task: no third member, and
no fix task depending on two verify tasks. Nothing else may depend on a verify
task, because its `done` does not put anything on the integration branch; a
task that needs the fix depends on the fix task.

Validate this with the graph: a `[fix: <id>]` whose `<id>` is not a `[verify]`
task in its `depends_on`, a `[verify]` task with no fix task, or anything else
depending on a verify task, is an invalid plan, and dispatch waits on it like
any other invalidity. The board does not know these markers; they ride in the
task title there, and checking them is yours with or without a board.

## Node states

Node states are `pending`, `running`, `review`, `blocked`, and `done`.

One word, two meanings, and they are not the same thing: the `blocked` **status**
below is one you set on a node that has stopped. A board's graph projection also
has a group called `blocked`, which is just the waiting list, and includes
healthy `pending` nodes sitting behind an unfinished dependency. This file always
means the status. See [board.md](board.md) for the other one.

```text
pending -> running (red test, audit, repair, gates) -> review (independent review) -> done
                                                    -> running (fix, gates)       -> review
any stage, on a real blocker                         -> blocked

[verify]:    pending -> running (red test, audit, gates: named tests red) -> review -> done (committed, not merged)
[fix: <id>]: pending -> running (repair, gates: named tests green)        -> review -> done (merged; lands both)
```

A node stays `running` until its gates are green; a red gate sends it back to
implementing without ever entering `review`.

`done` means implementation, the task's gates, the required independent static
and runtime reviews, and a spec-audit `match` that survived the adversary (see
[review.md](review.md)) have all passed. An implementation subagent returning a
result is not `done`.

`done` also means more than that, and you must not close a node on
this paragraph alone: the node's work has also been committed, merged into the
integration branch, and gated again after the merge. Gates passing in a node's
own worktree prove it works alone and prove nothing about it working alongside
what merged before it. See [worktree-mode.md](worktree-mode.md).

A `[verify]` node is the one exception, and its `done` means less: its named
tests fail for the reported reason, every other gate is green, its red-test
audit `match` and its review survived the adversary, and its work is committed
on its own branch. Nothing is merged. That is enough to make its fix node
ready, which is all its `done` is for; the fix node's merge is what lands the
pair, and until that merge is gated green the verify node's worktree and branch
stay where they are.

A valid finding sends the node from `review` back to `running` within the same
node. Repeated work on one cause is an obstacle episode, which may earn one
escalated repair after two ordinary ones, per "Obstacle episodes and the one
escalation" in [roles.md](../roles.md); new, independent findings are repaired
without escalating, and the ceiling below is the only bound on them. That
transition is not a DAG edge and must never be drawn as one.

When an escalated obstacle episode is still there after its escalated repair, or
the node has had 6 rework rounds (the ceiling under the episode rule, whatever
the episodes say), give the node the `blocked` status, and then **propagate that
status to every node downstream of it, transitively**. Each one gets the
`blocked` status and a reason naming the upstream node that stopped it.
Everything not downstream of it keeps running.

### What counts as a blocker

`blocked` is the only way a node stops without being `done`. There is no
"frozen", no "parked", no "waiting on the user" state. Anything that stops a node
indefinitely uses this status, with a reason saying which of these it is:

- An escalated obstacle episode surviving its escalated repair, or 6 rework
  rounds spent with valid findings still standing.
- An unanswered question the node depends on, parked in the plan's "needs a
  decision from the user" list. In goal mode this is the common one, and the
  reason names the parked question.
- A missing external condition: an authorization, a credential, a service, a
  device, a piece of information recon could not find and nobody supplied.
- An upstream node that took the `blocked` status, for any of the above.

Each of these propagates downstream the same way.

Propagation is not bookkeeping. A downstream node left in `pending` can never
become ready, because its dependency will never be `done`, and it can never
become `blocked` on its own, because nothing is working it. Phase 3 starts when
every task is `done` or `blocked`, so a single node left in that limbo holds the
whole run open.

If a blocker later clears, including a parked question the user finally answers,
set the node back to `pending`, walk its downstream and return each node that was
blocked only by this one to `pending` as well, revalidate, and let them re-enter
the derived ready set.

`pending` is right because it means unstarted, and a node blocked before or
during implementation is unstarted. The one exception is a node that blocks
after its implementation and review have already passed, waiting on a
reconciliation task. Returning that one to `pending` would send a fresh
implementer at work that is already finished. It returns to `review` instead; see
[worktree-mode.md](worktree-mode.md). A fix node blocked while its verify node is
reworked is not an exception: it returns to `pending` and gets a fresh tree,
because the test it was building against has changed.

A verify node can also go from `done` back to `running` before its fix node has
landed: when the fix node's setup sync conflicts, or when the fix node shows
evidence that a named test is wrong. The edge does not change. The fix node is
`pending` or `blocked` meanwhile, never active at the same time as the verify
node it depends on, and it becomes ready again only when the verify node is
`done` again; worktree-mode.md under "A red-test chain" has the sequence.

`running` and `review` are both active states. The node holds its `write_scope`
and its `exclusive_resources` through implementation, independent review, runtime
QA, and its gates. They are released when it reaches `done`, or when it hits a
real blocker and goes to `blocked`. Do not release them when the implementer
returns.

## Validation and the ready set

Two checks run before every dispatch, and both are defined over the declared
fields rather than over any particular tool.

**The graph must be valid.** No unknown dependency, no self-dependency, no
duplicate id, no cycle. While it is not, dispatch nothing.

**The ready set is derived by this rule:**

> A task is ready when its status is `pending` and every task listed in its
> `depends_on` has status `done`.

Nothing else makes a task ready. In particular, an upstream whose implementation
returned but whose review has not finished is not `done`, so nothing downstream
of it is ready.

With a board, every write to a run, other than deleting the run itself, returns a
read-only projection carrying both results:
`valid`, and `ready_task_ids` computed by the rule above. Use them, and call
`plan_graph` when you have not just written and need to re-read. Without a board,
evaluate both yourself against the plan document. That is not guessing. Guessing
would be deciding a node is ready because its upstream "looks finished" or
because time has passed; this is reading two fields you wrote down and applying a
stated rule to them. What you must never do is invent readiness by any other
route.

The tasks whose status is `blocked` are not in the ready set and do not become
ready. Clearing a blocker means setting the node back to `pending` first, which
puts it back under the rule. Do not start a node directly and bypass the set.

## Choosing a conflict-free batch

Re-evaluate validity and the ready set before every dispatch, then choose from
the ready set. Nothing imposes a batch size limit, but all four of these must
hold:

1. The candidate's `write_scope` does not overlap any currently active node
   (`running` or `review`) or any node already chosen for this batch.
2. The candidate shares no `exclusive_resources` with any active node or any node
   already chosen for this batch.
3. The project's rules permit the corresponding tests, builds, databases,
   devices, or services to run concurrently. Lane A of recon answered this.
4. You can still keep up: receive each result promptly, arrange its independent
   review, and protect the user's existing changes. When a batch is large enough
   that you are falling behind, make it smaller. That is a real constraint, not a
   formality.

Within those limits take as many ready nodes as you can and dispatch them in one
message. If you cannot demonstrate that two scopes do not conflict, they do not
go in the same batch.

The protocol has no partial acquisition and no early release, so do not argue
that two conflicting nodes can start together because "the resource is only
needed at the gate stage".

A board refuses two unsafe writes for you: moving a node to `running` with an
unfinished dependency, and taking an exclusive resource an active node already
holds. `write_scope` overlap and the project's concurrency limits are yours to
enforce either way. With no board, all four checks above are yours, including the
two the board would have refused.

The loop: validate the graph, read the ready set, choose a conflict-free batch,
mark those nodes `running` and dispatch them, run each node's internal
red-test/audit/repair/gate/review/fix machine, mark the passing ones `done`,
revalidate and release downstream. When nothing can be dispatched, wait for the
running and reviewing nodes' subagents to return ([SKILL.md](../SKILL.md) says
how they arrive) rather than polling in a loop. If there are no active nodes and unfinished nodes remain,
record the specific blocker, give those nodes the `blocked` status, and propagate
it downstream. Do not write the plan up as complete.

## Inserting a bug found mid-flight

A defect in a node's own unmerged work is a finding in that node's fix loop, not
a bug fix, and gets no new node; its rework starts with a test that shows the
defect failing before the fix. A bug in code the run started from, or in work
already merged into the integration branch (a phase 3 finding of wrong
behaviour in landed work included), is a bug fix, and a bug fix is always
inserted as a new red-test chain: a verify task and a fix task, never folded
into the node that found it and never a reopening of the node that landed it.

1. Declare both in full: `depends_on`, `write_scope`, `exclusive_resources`,
   role, acceptance with the named tests, risk. The fix task depends on the
   verify task.
2. You may adjust nodes that have not started yet so they depend on the new fix
   task. You may not add a predecessor to a node that is `running`, in `review`,
   or `done`. Doing so retroactively removes a guarantee that node already
   executed under, and nothing in the run would catch it.
3. Write the new nodes and the changed edges into the plan document, and into
   the board if you have one, before dispatching anything else. Revalidate.
   While the graph is not valid, dispatch nothing.

If the bug is a precondition for an active node passing its acceptance, do not
add an edge to that node and do not fold the fix into its rounds. Give it the
`blocked` status with a reason naming the fix task. When the fix task is `done`,
bring the integration tip into that node's worktree with the same `--no-commit`
sync [worktree-mode.md](worktree-mode.md) uses after a conflict, and return the
node to the state it was in, not to `pending`, for the same reason as the
exceptions under "What counts as a blocker": its work so far is not thrown away.
The wait charges it no round.
