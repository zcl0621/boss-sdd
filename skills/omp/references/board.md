# The live board

The board shows the run to the user. It mirrors the plan document's tasks,
computes the ready set from the fields you send, and refuses a few unsafe
writes. It is not the scheduler and it has no authority: it decides nothing you
could not decide from the plan document.

## Do you have one

Check once, at the start.

- **The `plan_*` tools are in your toolset.** Call `plan_board_status` first; it
  starts the app if needed and lists every run on this machine. Resuming: claim
  this plan's `run_id`, the one in the plan's header, never a run whose title
  merely looks similar. New plan: `plan_create_run`, and write the returned id
  into the header.
- **The tools are there but the app will not start.** Report the error once and
  carry on without it. Do not retry in a loop.
- **No such tools.** Normal for an install without the MCP server. Say so once
  and run the whole plan without a board. Do not ask the user to install
  anything mid-run.

Without a board the plan document is the only state record, and the two
refusals below become checks you make yourself before every dispatch.

## Tools

| Tool | What it does |
| --- | --- |
| `plan_board_status` | app state plus every run on this machine |
| `plan_create_run` | create a run from `title` and `project`; returns `run_id` |
| `plan_update_run` | set the plan's `status` or `summary` |
| `plan_set_tasks` | write many tasks at once: the whole DAG after planning |
| `plan_set_task` | create or update one task |
| `plan_graph` | read the graph projection without writing |
| `plan_get_run` | every task plus the projection |
| `plan_delete_run`, `plan_delete_task` | irreversible; see below |

The server also exposes four `plan_memory_*` tools. This skill does not use
them.

```text
plan_set_tasks { run, tasks: [
  { id: "T1", title: "Add server-side validation",
    write_scope: ["service/api/orders/"], exclusive_resource: ["db:test"] },
  { id: "T2", title: "Wire up the admin screen [qa]", depends_on: ["T1"],
    write_scope: ["admin-web/src/views/orders/"] } ] }
plan_set_task  { run, id: "T1", status: "running", agent: "implementer",
                 detail: "dispatched" }
plan_set_task  { run, id: "T1", status: "done",
                 detail: "merged 0debc3e; gates green after merge" }
```

The plan's `Writes` is the board's `write_scope`, `Locks` is
`exclusive_resource`, and markers ride in the title. For list fields: omit the
field and the stored value is kept; send an array and it replaces it; send `[]`
and it is cleared. `detail` holds evidence and reasons, never dependencies or
scope: prose creates no edges and reserves nothing.

## What comes back

Every write returns the current projection, so there is nothing to re-read
after writing.

- `valid`: while not `true`, dispatch nothing. `errors` names the unknown
  dependency, self-dependency, duplicate id or cycle.
- `ready_task_ids`: `pending` tasks whose dependencies are all `done`.
- `active`: the `running` and `review` nodes with the scope and resources each
  holds. Compare a candidate batch against this.
- `blocked`: **the projection's waiting list, not the status of the same
  name.** It includes healthy `pending` nodes sitting behind an unfinished
  dependency. The `blocked` status is one you set on a node that has stopped.

The board refuses two task writes: moving a task to `running` with an
unfinished dependency, and taking an `exclusive_resource` an active task holds.
It does not check `write_scope` overlap; that is yours.

## Discipline

- Write when you dispatch, when a node changes state, and when it closes. No
  fake heartbeats.
- When a task is `blocked`, write `blocked` to everything downstream of it too.
- A crashed session can leave a stale `running`. On resume, look at the trees
  before correcting the record.
- Never write credentials or unrelated logs to the board.
- **Deletes are the user's.** `plan_delete_run` and `plan_delete_task` cannot be
  undone. Ask first, naming what goes; in goal mode, park it. A wrong status is
  fixed by writing the right one, not by deleting the task.
- To let the user look, point them at the menu bar icon. The board reads local
  state and cannot be published as a page.
