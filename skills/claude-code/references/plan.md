# The plan document

The plan is one file in the repository. It is the spec, the task DAG, and the
record of the run, and it is what a later session reads after a compaction. The
board mirrors it; it does not replace it. Put it where the project keeps plans,
or ask the user where.

Keep it short. A field is written only when it differs from the default, and a
line of reasoning belongs here only if someone will need it to overturn a
decision.

## Format

```text
# <title>

Status: running · base <commit> · run <board run_id | no board> · goal mode off
Integration branch: sdd/<slug>
Integration worktree: <absolute path>
Main working tree: <absolute path>   (the user's; never touched)

## What we are building   (confirmed by the user, <date>: "<their words>")
Goal: <what the user can observe once this lands>
Not doing: <what this change deliberately leaves alone, specifically>
Decided: <one line each: the choice, the alternative it beat, why>

## Rules, gates, run
Hard rules: <quoted from the project's own files, with the path>
Gates: <one command per line, exactly as they will be run>
Tests concurrent: yes | no (<evidence>)
Run recipe: <start command, URL or port, seed step, test accounts>

## Tasks
### T2 Pins show context notes   <- T1
Writes: plugins/sidebar/state.ts, plugins/sidebar/state.test.ts
Acceptance:
1. <behaviour, checkable>
2. <boundary, checkable>
Status: pending

## Decided for you
## Waiting on you
```

`Status` uses the plan vocabulary: `planning`, `awaiting_confirmation`,
`running`, `review`, `blocked`, `done`. The three tree lines cannot be
reconstructed later, and a session that guesses which tree is the user's will
guess wrong at the worst moment, so write them when the trees are created.

## Tasks

The heading carries the id, a title, the markers, and `<-` the tasks it depends
on. Under it:

- `Writes`: the concrete paths this task may write. A directory covers what is
  under it. "Related files" is not a scope.
- `Acceptance`: numbered, each one checkable by a command, a request and its
  response, or an interaction and its result. A `[bug]` task's first criterion
  names the reproduction test and quotes the wrong behaviour it must show
  (`expected 404, got 500`, not "fails").
- `Status`: `pending`, `running`, `review`, `blocked` or `done`, with the merge
  commit when done and the reason when blocked.

Written only when they apply:

- `Locks`: exclusive resources, by name (`db:test`, `port:3000`, `gate:e2e`).
- `Gates`: only when this task's gates differ from the plan's.
- Markers in the heading: `[bug]`, `[no-test: <reason>]`, `[qa]`.

An acceptance criterion that turns out to be wrong is amended in place with a
dated note saying what showed it, not silently edited.

## The two lists at the bottom

**Decided for you**: reversible, low-risk choices you made without asking, one
line each: what you chose, the other option. The user overturns them cheaply at
delivery.

**Waiting on you**: questions nobody answered, each naming the tasks blocked
behind it. An entry here means the answer is unknown.

They are never merged. Moving a question from the second list to the first
without an answer turns it into a guess and hides that it was one.

## Node states

```text
pending -> running (implement, your diff read, gates) -> review -> done (merged, gated again)
                 ^------------- rework, at most 3 rounds -----'
any stage, on a real stop -> blocked
```

`done` means implemented, gated, independently reviewed, committed, merged into
the integration branch, and gated again there. An implementer returning is not
`done`, and neither is a green gate in the node's own tree.

`blocked` is the only way a node stops without being `done`: three rework
rounds spent, a parked question it depends on, a missing external condition
(credential, service, device), or a blocked upstream. **Blocking propagates**:
every task downstream takes the status too, with a reason naming the node that
stopped it. A task left `pending` behind a blocked one can never become ready,
and phase 3 would wait on it forever. When a blocker clears, set the node and
the tasks it alone was holding back to `pending`.

`running` and `review` are both active. A node holds its `Writes` and `Locks`
until it is `done` or `blocked`, not until its implementer returns.

## The ready set and the batch

A task is **ready** when its status is `pending` and every task it depends on is
`done`. Nothing else makes it ready; an upstream whose review is still running
is not `done`.

From the ready set, a batch may contain a task only if:

1. its `Writes` overlap no active node and no other member of the batch
   (identical paths, parent and child paths, and shared build output all
   overlap);
2. it shares no `Locks` with an active node or the batch;
3. the project allows the corresponding tests or builds to run concurrently;
4. you can still keep up with the returns.

If you cannot show two scopes are disjoint, they do not go together. Do not
declare the whole repository as every task's scope, which serializes the run,
and do not under-declare to manufacture parallelism, which surfaces later as a
confusing gate failure in some other task.

When nothing can be dispatched and nodes are still active, wait for their
returns. When nothing is active and unfinished tasks remain, record the blocker,
block them, and move to phase 3.

## Changing the plan mid-run

A new task (a bug found along the way, a phase 3 finding) gets a full entry
here first, then goes to the board, then the graph is revalidated. You may make
a task that has not started depend on the new one. You may not add a dependency
to a task that is `running`, in `review` or `done`: it already ran without that
guarantee. If an active node cannot pass until the new task lands, block it,
naming the new task, and bring the integration tip into its worktree when the
blocker clears ([worktrees.md](worktrees.md)).
