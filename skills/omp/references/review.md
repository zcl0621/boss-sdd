# Review

Every reviewer is a subagent that did not write what it is reviewing, working
from the actual diff, the actual tests and the actual running system. "Looks
fine" is not a result; what was checked and what was found is.

Review runs only on a change whose gates you ran and saw green.

## Node review

One `plan-reviewer` per node, every node. Give it, each in its own tagged block:

- `<review_mode>node</review_mode>`
- `<working_directory>`: **this node's worktree**. Pointed at the repository
  root, a reviewer sees none of the node's work and reports the task as never
  implemented.
- `<diff_command>`: `git -C <node worktree> diff <branch point>`, with no path
  restriction, so a write outside the declared scope shows up.
- `<task>`: the task's entry from the plan, verbatim, markers and acceptance
  included.
- `<spec>`: the plan's Goal, Not doing and Decided lines.
- `<write_scope>` and `<hard_rules>`.

It returns one row per acceptance criterion (`met`, `missing` or `off-target`,
with the `file:line` that shows it) and its findings, ordered by impact, each
with evidence, plus anything it could not settle marked `unsure`.

You adjudicate. A row that is not `met` is a send-back. A finding with evidence
is a send-back unless you can show it is wrong, in which case record why in one
line. An `unsure` you settle yourself; it is not a pass. A deviation from the
spec that you decide to keep is a plan change: amend the plan and the board,
not just your opinion of the diff.

After a rework round the reviewer runs again, on the node's whole diff, with
one added block, `<changed_since_last_review>`, saying what the round changed
and which findings it was answering.

## Runtime walkthrough

For a task marked `[qa]`, in the same message as the reviewer. Give it:

- `<working_directory>`: this node's worktree. The build to exercise is the one
  in that tree.
- `<task>`: the entry, with its acceptance.
- `<run_recipe>`: from the plan, verbatim. No recipe, no dispatch: get the
  recipe first, and in goal mode park the question and block the task.
- `<runtime_authorization>`: the services and URLs it may use, the fixtures and
  test accounts, where artifacts go under `<scratch_dir>`, what to clean up.
- `<scratch_dir>`.

A walkthrough is the change running. For a UI: per affected screen, a
screenshot, the step performed, and what was seen, described as a phenomenon.
For anything else: the exact request or command and the raw response. "Correct"
and "as expected" are conclusions, and reading the diff or running the test
suite is not a walkthrough.

## Branch review (phase 3)

Runs once, in the **integration worktree**, over
`git diff <base ref>..<integration branch>`, after the full gates are green.
Three parts.

**omp's own reviewer.** omp's bundled read-only agent is named `reviewer` (not
this skill's reviewer role), which its `/review` command uses. Dispatch
it with `task`, putting the integration worktree path, the branch and the base
ref in its `task` text, since it knows nothing of your worktrees. Take its
findings as text; nothing it returns is applied or posted. The `/review` and
`/annotate code-review` commands themselves are typed by the user: you cannot
run them, so never shell out to omp or simulate the keystroke. If the user
wants that interactive review, they type `/review` in a session whose directory
is the integration worktree and paste the result back; in goal mode, list it in
the delivery report as an outstanding item. A review that did not run is never
recorded as having run.

**One `plan-reviewer` in branch mode.** Blocks: `<review_mode>branch</review_mode>`,
`<working_directory>` (the integration worktree), `<diff_command>`,
`<plan_path>`, `<hard_rules>`. It does two things. It audits every task in the
plan, blocked ones included, against its acceptance: `met`, `missing`,
`off-target` or `unclear`, with what satisfies each criterion. And it looks at
what no node review could see: interfaces, names, data contracts and ordering
between tasks, behaviour that crosses task boundaries, the same thing built
twice, half-finished paths. You do not write the per-task verdicts yourself;
you ran the tasks.

**One `adversary`** over every finding from both, and over every `met`. Give
it the claims one per tagged block, each with the location its producer cited,
plus `<working_directory>`, `<diff_command>`, `<base_ref>`, `<plan_path>` and
`<hard_rules>`. For a finding it asks whether the thing is reachable, actually
wrong, already handled elsewhere, or older than this branch. For a `met` it
asks the opposite: does the cited code really satisfy the criterion. It returns
`confirmed`, `dismissed` or `unsure` per claim, with evidence.

### Triage

- A confirmed finding, or a `met` that did not hold, becomes a new task: a
  `[bug]` task when it is wrong behaviour, an ordinary one otherwise. It goes
  through phase 2 like any task. Nothing is fixed by hand and nothing is
  reopened.
- A confirmed finding whose fix falls under the plan's "Not doing", or would
  change what the user asked for, is not a task. It goes under "Waiting on
  you" and into the delivery report as a remaining risk, with the evidence.
- A blocked task's verdict is recorded in the partial close-out. Nothing routes
  into a blocked task.
- `dismissed` gets a one-line reason. Anything dismissed as pre-existing you
  verify yourself with `git log -S` or `git blame`; if you cannot show the line
  predates the base ref, the dismissal fails.
- `unsure` and `unclear` you resolve yourself against the plan and the diff,
  and record how.

A reviewer that returns nothing did not run: dispatch it again. If it fails
twice, say in the delivery report which check did not happen. A check that
never ran is not a check that found nothing, and without the task audit the run
closes out as partial.
