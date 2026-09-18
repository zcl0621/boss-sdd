# The DAG contract

The task DAG describes completion dependencies between tasks. Each node
separately runs its own implementation, review, and gate state machine. The DAG
has no back edges, and the fix and re-review rounds inside a node never change
its topology.

Dispatch nodes as subagents. To run several conflict-free nodes at once, issue
all their dispatch calls in a single message. A fix round inside a node continues
with the subagent already working that node where the platform supports resuming
one; where it does not, dispatch a fresh subagent with the full context bundle
defined in [dispatch.md](dispatch.md) and count it as the same round rather than
starting the count over.

There is no worktree isolation and no branch isolation. Every node writes into
the same tree at the same time. Safety comes entirely from the `write_scope` and
`exclusive_resources` declarations below and from you scheduling around them.

That is the default. The optional worktree mode in
[worktree-mode.md](worktree-mode.md) gives each node its own tree and its own
branch. It leaves the content of this file standing and changes how two of its
rules read, each flagged where it is stated: the definition of `done` below gains
a merge and a second gate run, and a node blocked after its review passed returns
to `review` rather than to `pending`. It also adds a merge lock, which is
deliberately not an `exclusive_resources` entry and is not subject to the batch
rules; that file says why. Everything else here holds unchanged, including the
declarations themselves, the ready rule, the batch rules, and the state names.
What `write_scope` overlap costs you changes from concurrent corruption to a
merge conflict, and the rule against overlapping a batch stays either way.

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

## Node states

Node states are `pending`, `running`, `review`, `blocked`, and `done`.

One word, two meanings, and they are not the same thing: the `blocked` **status**
below is one you set on a node that has stopped. A board's graph projection also
has a group called `blocked`, which is just the waiting list, and includes
healthy `pending` nodes sitting behind an unfinished dependency. This file always
means the status. See [board.md](board.md) for the other one.

```text
pending -> running (implement) -> review (independent review) -> done
                               -> running (fix)               -> review
any stage, on a real blocker    -> blocked
```

`done` means implementation, the required independent static and runtime reviews
(see [review.md](review.md)), and the task's gates have all passed. An
implementation subagent returning a result is not `done`.

In worktree mode `done` means more than that, and you must not close a node on
this paragraph alone: the node's work has also been committed, merged into the
integration branch, and gated again after the merge. Gates passing in a node's
own worktree prove it works alone and prove nothing about it working alongside
what merged before it. See [worktree-mode.md](worktree-mode.md).

A valid finding sends the node from `review` back to `running` within the same
node. Three fix and review rounds maximum. That transition is not a DAG edge and
must never be drawn as one.

After the third round still has valid findings, give the node the `blocked`
status, and then **propagate that status to every node downstream of it,
transitively**. Each one gets the `blocked` status and a reason naming the
upstream node that stopped it. Everything not downstream of it keeps running.

### What counts as a blocker

`blocked` is the only way a node stops without being `done`. There is no
"frozen", no "parked", no "waiting on the user" state. Anything that stops a node
indefinitely uses this status, with a reason saying which of these it is:

- Three fix and review rounds spent with valid findings still standing.
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
during implementation is unstarted. The one exception is in worktree mode, where
a node can block after its implementation and review have already passed, waiting
on a reconciliation task. Returning that one to `pending` would send a fresh
implementer at work that is already finished. It returns to `review` instead; see
[worktree-mode.md](worktree-mode.md).

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

With a board, every write returns a read-only projection carrying both results:
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
implement/review/fix/gate machine, mark the passing ones `done`, revalidate and
release downstream. When nothing can be dispatched, wait on the running and
reviewing nodes through your platform's subagent completion mechanism rather than
polling in a loop. If there are no active nodes and unfinished nodes remain,
record the specific blocker, give those nodes the `blocked` status, and propagate
it downstream. Do not write the plan up as complete.

## Inserting a bug found mid-flight

If the bug falls within the current node's goal or acceptance scope, fix it
inside that node and review it there. No new node, no back edge.

Create a new task only when the bug has its own scope and its own acceptance and
can be scheduled like any other task:

1. Declare the full set: `depends_on`, `write_scope`, `exclusive_resources`,
   role, acceptance, risk.
2. You may adjust nodes that have not started yet so they depend on the new bug
   task. You may not add a predecessor to a node that is `running`, in `review`,
   or `done`. Doing so retroactively removes a guarantee that node already
   executed under, and nothing in the run would catch it.
3. Write the new node and the changed edges into the plan document, and into the
   board if you have one, before dispatching anything else. Revalidate. While the
   graph is not valid, dispatch nothing.

If a standalone bug is a precondition for an active node passing its acceptance,
it belongs to that node's fix rounds. Do not route around a failing acceptance by
building a new predecessor node for it.
