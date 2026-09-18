# The live board

The board is an observability layer over the run, not the scheduler. It mirrors
the plan document's task DAG, derives the topology and the ready queue from the
structured fields you send, and refuses two classes of unsafe write. It computes
things you would otherwise compute yourself. It does not decide anything you
could not decide without it.

You write to it through the `plan-sdd` MCP tools. Nothing changes state from
inside the board's own window. Subagents report back to you through whatever
subagent channel your platform provides, not to the board.

Two things the board cannot tell you, so never infer them: that a task succeeded
because time has passed, and that a task passed review because its implementation
finished.

## Deciding whether you have a board

Check once, at the start, and take one of three paths.

**The `plan-sdd` MCP tools are in your toolset.** Use them. Call
`plan_board_status` first: it returns the app's version, its port, and every run
already on this machine. When resuming a session, claim this plan's `run_id` from
that list, and do not take over a run because its title looks similar to yours.
For a new plan call `plan_create_run` and keep the returned `run_id` in your
context summary so a later session can find it. The board is a local menu bar
application with its own store, and the tools start it if it is not running, so
there is no launch step.

**The tools are there but the app will not start, or its port is taken.** Report
what the error said and carry on. Do not retry in a loop.

**The tools are not in your toolset at all.** This is the normal state for anyone
who installed the skill without the MCP server. Say so once, plainly, and run the
whole plan without a board. Do not stop, and do not ask the user to install
anything mid-run.

In both of the last two cases the plan document takes over as the state record,
for the plan's own status as well as the tasks'. Keep the plan status in the
document's Status header and each task's status in its Tasks entry, both in the
same vocabulary the board uses, with the same evidence you would have put in
`detail`. [plan-spec.md](plan-spec.md) defines both fields.

### What you lose, and what you do not

Without a board you lose live visibility for the user, the activity history, and
cross-session recovery, since a later session has nothing to claim and must
reconstruct state from the plan document and the git history. The project memory
in [memory.md](memory.md) goes with them, and that file says what it costs.

You do not lose scheduling correctness. The ready set is derived, not granted:
a task is ready when its status is `pending` and every task in its `depends_on`
is `done`. That rule is stated in full in
[dag-contract.md](dag-contract.md), and applying it yourself is arithmetic over
fields you wrote, not guesswork. The conflict rules over `write_scope` and
`exclusive_resources` were always yours to enforce anyway.

What you take on yourself is the board's two refusals. Without it, nothing stops
you from moving a task to `running` with an unfinished dependency, or from
running two tasks that hold the same exclusive resource. Check both before every
dispatch.

If the user wants to look at the board, point them at the menu bar icon. Do not
try to publish it as a web page or an artifact; it reads local process state that
nothing outside this machine can see.

## The tools

| Tool | What it does |
| --- | --- |
| `plan_board_status` | App state plus every run on this machine. Starts the app if needed. |
| `plan_create_run` | Create a run. Takes `title` and `project`. Returns the `run_id`. |
| `plan_update_run` | Change the plan's overall `status` or `summary`. |
| `plan_set_tasks` | Write many tasks at once. Use this to lay down the whole DAG after planning. |
| `plan_set_task` | Create or update one task. |
| `plan_graph` | Read-only graph projection. |
| `plan_get_run` | Every task plus the projection, optionally with recent activity. |

Every argument is structured JSON and never passes through a shell, so quotes,
`$`, and newlines inside a title or a `detail` go through exactly as written. Do
not escape them.

A typical sequence:

```text
plan_create_run  { title: "<plan name>", project: "<repo path>" }
plan_update_run  { run, status: "awaiting_confirmation",
                   summary: "Plan written, waiting for the user" }
plan_set_tasks   { run, tasks: [
  { id: "T1", title: "Add server-side validation",
    write_scope: ["service/api/orders/"], exclusive_resource: ["gate:pytest"] },
  { id: "T2", title: "Wire up the admin screen", depends_on: ["T1"],
    write_scope: ["admin-web/src/views/orders/"],
    exclusive_resource: ["admin-web-build"] },
] }
plan_update_run  { run, status: "running", summary: "Starting T1" }
plan_set_task    { run, id: "T1", status: "running", agent: "<subagent name>",
                   detail: "Dispatched; ready_task_ids contained T1" }
plan_set_task    { run, id: "T1", status: "review",
                   detail: "Implementation returned; reviewer dispatched. Evidence: ..." }
plan_set_task    { run, id: "T1", status: "done",
                   detail: "Independent review clean, gates green. Evidence: ..." }
```

Plan statuses: `pending`, `planning`, `awaiting_confirmation`, `running`,
`review`, `blocked`, `done`.

Task statuses: `pending`, `running`, `review`, `blocked`, `done`.

## Field semantics

A new task must carry `write_scope`. Add `depends_on` and `exclusive_resource`
whenever they apply. Those three fields are the data source for the dependency
graph and the resource projection. Natural language in `detail` creates no edges
and reserves no resources.

List fields follow one rule: **omit the field and the stored value is kept; send
an array and it replaces the stored one; send an empty array and it is cleared.**
To drop all of T2's dependencies, send `depends_on: []`.

`detail` holds checkable progress evidence, verification results, review
conclusions, and blocking or decision reasons. It does not carry dependencies,
scope, resources, acceptance criteria, or roles. Put the actual owner in `agent`.
The planned role and the full acceptance criteria live in the plan document and
in the dispatch prompt.

## Validation and scheduling

**Every write returns the latest graph projection along with it, so there is no
need to validate separately afterwards.** Call `plan_graph` only when you have
not just written and need to re-read the state.

What the projection gives you for scheduling:

- `valid`. While this is not `true`, dispatch nothing. `errors` says whether the
  problem is an unknown dependency, a self-dependency, a duplicate id, or a
  cycle.
- `ready_task_ids`. The candidate set: `pending` tasks whose dependencies are all
  `done`. Prefer it over your own arithmetic when it is there, because it cannot
  drift from what the board actually stores.
- `active`. The `running` and `review` nodes, with the `write_scope` and
  `exclusive_resource` each one is holding. This is what you compare a candidate
  batch against.
- `blocked`. **This is the projection's waiting list, not the task status of the
  same name.** It names, for every unfinished node, which upstream task or which
  resource holder it is waiting on, including nodes that are merely `pending`
  behind a dependency and are perfectly healthy. The `blocked` *status* is
  something you write, and it means this node has stopped: three failed rounds,
  or a real external blocker, or an upstream that stopped. Throughout this skill,
  "the `blocked` status" is the one you set and "the projection's `blocked`
  group" is the one the board derives. Never read the second as the first.

After a `plan_set_tasks` call, read the result before moving on: confirm each id
you sent came back written, and confirm `valid` in the returned projection. Fix
and rewrite anything that was rejected.

The board **rejects** two kinds of write and returns an error explaining why:
moving a task to `running` while a dependency is unfinished, and taking an
`exclusive_resource` that an active task already holds. The board does not police
`write_scope` overlap or the project's own concurrency limits. Those stay your
job when you choose a batch.

## Status discipline

- Write before dispatching, when a result comes back, and on every review or fix
  round change. Long-running work needs no fake heartbeat. Update the summary
  when there is real progress.
- Use `awaiting_confirmation` for an ordinary plan confirmation. Give the plan
  the `blocked` status, with a stated reason, when input or an external condition
  is genuinely missing, and update it explicitly to the current phase once it
  clears.
- When a task takes the `blocked` status, give the same status to every task
  downstream of it, transitively, each with a `detail` naming the upstream node
  that stopped it. A node sitting in `pending` behind a blocked upstream will
  never become ready and never become `blocked`, and phase 3 waits on it forever.
- A single task can be in `review` while the plan is still `running`. The plan
  goes to `review` during branch close-out, and to `done` only once every
  completion condition in [PLAYBOOK.md](../PLAYBOOK.md) holds. A gate that could not be
  run keeps its reason in the summary.
- `running` and `review` are both active states. A node holds its declared write
  scope and exclusive resources through implementation, independent review,
  runtime QA, and its gates. Do not release early because the implementer
  returned.
- A manual abort, a crashed session, or a killed process can leave a status
  behind. A stale `running` does not mean work is still happening. On resume,
  check the actual state of the tree before correcting the record, and do not go
  digging through private session history to guess at it.
- Never write credentials, private reasoning, or unrelated logs to the board.
  Summaries hold checkable conclusions and paths to evidence. The board has no
  authority to execute, confirm, commit, or deploy anything.
