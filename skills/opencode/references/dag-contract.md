# The DAG contract

The task DAG describes completion dependencies between tasks. Each node
separately runs its own implementation, review, and gate state machine. The DAG
has no back edges, and the fix and re-review rounds inside a node do not change
its topology.

Dispatch nodes with the OpenCode `subagent` tool. To run several conflict-free
nodes at once, issue all their calls in a single message with
`background: true`. A lone child whose result you need now stays in the
foreground (omit `background`). An ordinary fix inside a node continues with the
same child by passing `sessionID` (Form A) when usable; otherwise dispatch a
fresh subagent with the full context bundle defined in [dispatch.md](dispatch.md)
on the task's starting binding. A fresh child does not reset the obstacle
episode. An authorized obstacle escalation is instead a fresh Form B on
`implementer.obstacle_escalation`.

Every node runs in its own git worktree on its own branch
([worktree-mode.md](worktree-mode.md)); there is no shared-tree mode. Batch
safety comes from the `write_scope` and `exclusive_resources` declarations below
and from you scheduling around them. The worktrees change how two rules here
read, each flagged where it is stated: the definition of `done` below gains
a merge and a second gate run, and a node blocked after its review passed returns
to `review` rather than to `pending`. It also adds a merge lock, which is
deliberately not an `exclusive_resources` entry and is not subject to the batch
rules; that file says why. Everything else here holds unchanged, including the
declarations themselves, the ready rule, the batch rules, and the state names.
`write_scope` overlap costs a merge conflict rather than concurrent corruption,
and the rule against overlapping a batch stays.

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
(see [review.md](review.md)), the spec-auditor `match` after adversary, and the
task's gates have all passed. An implementation subagent returning a result is
not `done`. A quality-reviewer ALLOW is not a spec-auditor `match`.

`done` also needs more than that, and you must not close a node on
this paragraph alone: the node's work has also been committed, merged into the
integration branch, and gated again after the merge. Gates passing in a node's
own worktree prove it works alone and prove nothing about it working alongside
what merged before it. See [worktree-mode.md](worktree-mode.md).

Exception: a `[verify]` node, the reproduction half of a bug fix's red-test
chain. Its `done` means the failing tests are committed on its node branch
(8a), the named tests fail on the reported behaviour with every other gate
green ([gates.md](gates.md#verify-nodes-the-one-expected-red)), and review
passed with its red-test `match`. It does not merge into integration. Keep its
worktree and branch: the fix node's tree is cut from that branch, and the fix
node's 8b/8c is the merge that lands the pair
([worktree-mode.md](worktree-mode.md#red-test-chains-verify-then-fix)).

Because a verify node's `done` is not a merge, only its own `[fix]` node may
list it in `depends_on`. A task that needs the bug fixed depends on the fix
node. A task that depended on the verify node would be cut from integration
without the red tests, and with the bug still in place.

A valid finding sends the node from `review` back to `running` within the same
node. Track repeated failures as obstacle episodes: same acceptance/gate, stable
failure signature/finding, and evidenced causal mechanism. Distinct independently
evidenced findings may continue without a node-wide attempt cap. That transition
is not a DAG edge; do not draw it as one.

After two unsuccessful ordinary repairs of the same episode, only the
orchestrator may authorize one fresh escalated repair on
`implementer.obstacle_escalation`. If orchestrator-run evidence shows that same
episode remains after the escalated repair, give the node the `blocked` status,
then **propagate that status to every node downstream of it, transitively**.
Each one gets the `blocked` status and a reason naming the upstream node that
stopped it. Everything not downstream of it keeps running.

### What counts as a blocker

`blocked` is the only way a node stops without being `done`. There is no
"frozen", no "parked", no "waiting on the user" state. Anything that stops a node
indefinitely uses this status, with a reason saying which of these it is:

- An escalated obstacle episode still standing after its fresh escalated repair.
- An unanswered question the node depends on, parked in the plan's "needs a
  decision from the user" list. In unattended mode this is the common one, and
  the reason names the parked question. The goal stays active; parking is not
  `goal` `complete`.
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
during implementation is unstarted. The one exception is a node blocked after
its implementation and review have already passed, waiting on a reconciliation
task. Returning that one to `pending` would send a fresh implementer at work
that is already finished. It returns to `review` instead; see
[worktree-resume.md](worktree-resume.md).

`running` and `review` are both active states. The node holds its `write_scope`
and its `exclusive_resources` through implementation, independent review, spec
audit, runtime QA, and its gates. They are released when it reaches `done`, or
when it hits a real blocker and goes to `blocked`. Do not release them when the
implementer returns.

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
release downstream. Nodes in one batch do not share a wait. When A returns,
advance A; leave B and C running. Do not sit on the last child while earlier
returns sit unconsumed. A foreground tool result is already a return.
A background child is running until the host delivers it. Do not poll; the one
suspicion-triggered liveness check is in
[subagent-lifecycle.md](subagent-lifecycle.md). If
there are no active nodes and unfinished nodes remain, record the specific
blocker, give those nodes the `blocked` status, and propagate it downstream.
Do not write the plan up as complete.

## Inserting a bug found mid-flight

If the defect is in the current node's own unmerged work, it is that node's
rework, reviewed there. No new node, no back edge. The rework starts with a
failing test that shows the defect, before the fix.

A defect in behaviour already in the base the run started from, or already
merged into the integration branch (a Phase 3 finding against landed work
included), is a bug fix. A bug fix is always two new tasks, a `[verify]` node
and a `[fix]` node that depends on it, never one, and never a reopening of the
node that landed the behaviour:

1. Declare the full set for each: `depends_on`, `write_scope`, `exclusive_resources`,
   role, acceptance, risk.
2. You may adjust nodes that have not started yet so they depend on the new
   fix node. You may not add a predecessor to a node that is `running`, in `review`,
   or `done`. Doing so retroactively removes a guarantee that node already
   executed under, and nothing in the run would catch it.
3. Write the new nodes and the changed edges into the plan document, and into the
   board if you have one, before dispatching anything else. Revalidate. While the
   graph is not valid, dispatch nothing.

If such a bug is a precondition for an active node passing its acceptance, it
still gets its own verify/fix pair: do not fold it into that node's fix rounds,
and do not add an edge to that node. Mark the active node `blocked` with a
reason naming the fix node; it returns when the fix node is `done`, the same way
a node blocked on a reconciliation task returns
([worktree-resume.md](worktree-resume.md#when-a-blocked-node-comes-back)).
