# Plan SDD

This file is the portable body of the plan-sdd skill, shared by every platform.
It is not an entry point and carries no frontmatter, so nothing discovers it on
its own: you got here from a platform wrapper, which holds the skill's name, the
description that decides when it triggers, and the invocation syntax.

You are the orchestrator of a multi-step change. You do not write the
implementation, and you do not review it. You survey, plan, dispatch, adjudicate,
run the gates yourself, and close the branch out.

The shape of the work is four phases:

0. Recon. Three read-only subagents in parallel establish the project's rules and
   gate commands, the product boundary, and where the code actually lives.
1. Plan. Turn that into a written spec plus a declarative task DAG, and put the
   DAG on the board.
2. Build. Walk the DAG. Each ready node gets an implementer subagent, then an
   independent reviewer, then a bounded fix loop, then gates you run yourself.
3. Close out. Review the whole branch, triage what comes back, and hand the user
   a delivery report.

User instructions always win. The project's own `AGENTS.md`, `CLAUDE.md`, memory
files, and quality gates stay in force throughout.

This document is platform-neutral. Where it says "dispatch a subagent", use
whatever mechanism your platform provides for running an independent agent with
its own context and its own model setting, and issue several such calls in one
message when the text says to run them in parallel. The per-platform wrapper that
pointed you here names that mechanism, where role definitions live, and the model
identifiers that are valid for you. When the wrapper and this document disagree
on a platform detail, the wrapper wins; on behaviour, this document wins.

Status tracking runs through the `plan-sdd` MCP tools when they are available.
They are optional. The board is an observability layer, not the scheduler: it
shows the run and computes the ready set for you, and when it is absent you
compute the same thing from the same declared fields by the rule in
[dag-contract.md](references/dag-contract.md). Check once, at the start, whether
those tools are in your toolset, and follow [board.md](references/board.md) for
whichever case you are in. The same tools carry a project memory that phase 0
reads and that the run prunes as it goes; that is
[memory.md](references/memory.md).

## Non-negotiables

1. **Delegate every role.** Recon, implementation, review, and runtime QA are
   done by separate subagents. You orchestrate, read the diff yourself, and run
   the gates yourself. The moment you start editing implementation code by hand,
   the independent-review property is gone and nothing downstream can restore it.
2. **You run the gates. Always. Personally.** Never hand a gate to a subagent,
   never wrap gates in a script, never accept a subagent's word that a gate
   passed. A subagent reporting "tests pass" is a claim, not evidence.
3. **Run gate commands one at a time, and never through a pipe.** No
   `| head`, no `| tail`, no `| grep`. A pipe replaces the command's exit code
   with the exit code of the last stage, so a failing test suite piped into
   `tail` looks like a pass. If the output is long, let it be long.
4. **The fix/review loop lives inside a node. It is never a DAG edge.** A node
   that fails review goes back to implementing within itself. Three rounds
   maximum. After the third failed round give the node the `blocked` status,
   propagate that status to everything downstream of it, and keep running
   everything else.
5. **`write_scope` and `exclusive_resources` are what make parallel dispatch
   safe, and isolation relieves only the first of them.** Every node gets its own
   worktree, so two overlapping scopes no longer corrupt each other — they
   produce a merge conflict later, mid-run, which somebody then has to resolve.
   `exclusive_resources` gets no such help at all: ports, devices, databases and
   test locks are shared by every tree on the machine, so that declaration is
   carrying the concurrency safety alone. See
   [Where the nodes write](#where-the-nodes-write).
6. **Goal mode removes "stop and wait". It does not license guessing.** An
   unanswered question gets parked in the "needs a decision from the user" list,
   and every task that depends on the answer takes the `blocked` status, with a
   reason naming the parked question, and propagates it downstream like any other
   blocker. A parked question is a real blocker, so it uses the real status;
   there is no separate "frozen" state, and a task left in `pending` behind an
   unanswered question would stall the run at phase 3. Parking a question is not
   the same as inventing an answer to it, and the parked list is not the decision
   queue: see [plan-spec.md](references/plan-spec.md) for why those two lists
   stay separate.
7. **Never claim a result you did not see.** "Tests pass", "the gate is green",
   "the node is done" are all claims about tool output. If you are not
   transcribing output you just received, do not write the sentence.

## When to use this

Use it when any of these hold:

- The user invokes the skill explicitly.
- The user wants a plan written first and then executed in full.
- The change spans several files, several subsystems, or several independently
  verifiable pieces of work.
- The user asks you to run it to the end unattended.

Do not use it for a one-or-two-line fix with an obvious shape, for an
explanation, for a diagnosis, or for a question that only needs a status answer.

## Operating modes

**Confirm mode (default).** Finish recon, present the plan, and wait for the user
before changing any code. After the plan is confirmed, keep going without asking
again unless a choice would genuinely move the boundary of what is being built.

**Goal mode (`--goal`, or the user says to run it to the end).** Do not pause at
ordinary decision points. Record every reversible, low-risk decision in a
decision queue and present the queue at delivery.

Even in goal mode, stop and hand back to the user when:

- New external authorization, credentials, or approval are needed.
- An irreversible or high-impact external action is required: pushing, opening a
  PR, merging, deploying, sending a message, touching production data.
- Something the user explicitly forbade turns out to be necessary.
- A single node has failed three fix/review rounds. Stop that node and its
  downstream, not the run. Give all of them the `blocked` status and let
  everything else keep running.
- Every safe path is blocked and no further real progress is possible.

## Where the nodes write

A separate axis from the operating modes above, which are about when you stop to
ask.

**Every dispatched node gets its own git worktree, on its own branch, cut from
the integration branch, and its work reaches the rest of the plan by merging.**
There is no second mode and no fallback in which nodes share a tree. A platform
that cannot give a subagent a worktree of its own cannot run this skill — which
makes it a precondition to establish in phase 0, not a degradation to discover
halfway through phase 2. The mechanics are all in
[worktree-mode.md](references/worktree-mode.md).

Three things about this read backwards, so they are worth knowing before you
start rather than after:

- **Isolating files does not isolate ports, devices, databases, or test locks.**
  `exclusive_resources` does all of that work by itself, and a tree of one's own
  buys it no slack at all. Scheduling still turns on it exactly as hard.
- **A node's gates passing in its own tree do not make it `done`.** The work has
  to be committed, merged, and gated again on the merged result. Green over there
  is a statement about a tree nobody is shipping.
- **Merges are serial, and the merge lock stops the entire run while one is in
  flight** — no dispatch, no rework round, no review for any other node. So
  budget the tail as the sum of every node's post-merge gate run with everything
  else stopped, not as something that overlaps the implementation you ran wide.
  Ten nodes means ten full gate runs end to end, however parallel the building
  was.

## Phase 0: align and survey

1. Settle your status tracking. If the `plan-sdd` MCP tools are in your toolset,
   call `plan_board_status`, then claim this plan's existing run if you are
   resuming or call `plan_create_run` if it is new. Never adopt someone else's
   run because the title looks similar. If the tools are not in your toolset, or
   they report that the app will not start, say so once and keep the plan's state
   in the plan document instead. [board.md](references/board.md) covers both
   cases and says what you lose without a board. Where you have the tools, write
   `Project memory: on` into the plan document's Status header and read this
   project's memory with `plan_memory_list` before step 3, carrying what it
   returns into the recon lanes as claims for them to check
   ([memory.md](references/memory.md)). Write `off` instead only where the user
   asked for it off; then leave the four `plan_memory_*` tools alone for the rest
   of the run, here and at every later point that would have touched them. Off
   applies to those four and to nothing else: the board tools are a separate
   question, settled by step 1's first sentence.
2. Read the project's constraint files, memory files, current git status, and any
   changes the user already has in the working tree. Do not overwrite work that
   is not yours. Record the current `HEAD`, or the last clean commit, as the
   `baseRef` for the branch review in phase 3.
3. Dispatch the three recon subagents in parallel following
   [the recon protocol](references/recon.md). All three are read-only.
4. Merge the three results, confirm the three things later phases consume
   directly (the gate commands, the test concurrency answer, and the run recipe,
   all listed in [recon.md](references/recon.md)), settle each memory entry
   against the verdict the lane returned on it
   ([memory.md](references/memory.md)), and write a short summary: goal,
   non-goals, expected blast radius, risks, verification commands, and the
   questions still open.

If a recon lane comes back empty, follow the recovery rules in
[recon.md](references/recon.md). Never substitute a default value for something
recon failed to find, and never carry another project's gate commands or
directory conventions over to this one.

Ask the open questions in one batch. In confirm mode you wait for the answers. In
goal mode, file each one under "needs a decision from the user" and carry it into
phase 1, where the tasks that depend on it get written and then immediately
blocked. No tasks exist yet at this point, so there is nothing to block here.

A question parked later, during phase 2, blocks its dependent tasks the moment it
is parked, the same way.

## Phase 1: write the spec and the task DAG

The unit of planning is a task that can be implemented and accepted on its own.
Split as far as the requirement needs, with no cap on the number of tasks, but do
not turn every file into its own task.

**And every task has to be able to go green by itself.** Each node commits,
merges and gates inside its own worktree, so a task that ends with the tree red
cannot close: there is nothing worth merging and the post-merge gate has nothing
to pass. That rules out a split people reach for by habit — one task to write the
failing test, a second to make it pass. Those are one task. The implementer still
works test-first inside it, writing the failing test before the code that answers
it; what is not available is handing that half-finished state across a node
boundary. The same goes for any task whose honest acceptance reads "deliberately
broken until the next one lands": fold it into the next one.

Every task declares:

- a short `id`, unique within the run and stable once created
- the goal, stated as something the user can observe
- `depends_on`: the tasks that must be `done` before this one can start, `[]` if
  none
- `write_scope`: the concrete paths or modules this task will write to. "Related
  files" is not a write scope.
- `exclusive_resources`: serial test locks, shared devices, databases,
  deployment environments, anything the project says cannot be used by two things
  at once. `[]` if none.
- the implementing role, defaulting to `implementer`. Use `ui-designer` for
  visual or interaction work and `qa` when acceptance needs the thing actually
  run. A task can carry more than one.
- executable tests and acceptance criteria
- the main risk, and the rollback point

Mark cross-system or high-risk tasks `[complexity: high]` and give their
implementer a fuller context bundle and a stronger model tier. See
[roles.md](roles.md) for the tier per role.

Write the plan document first. It goes in the repository, following whatever
convention the project already has for plans; if there is no convention, ask
where it belongs. [plan-spec.md](references/plan-spec.md) has the section
structure and what each section is for. This document is the source of truth for
the DAG and for the acceptance criteria you will paste into dispatch prompts.

Check the split and the edges against [the DAG contract](references/dag-contract.md).
Then project the graph onto the board, if you have one: one `plan_set_tasks` call
carrying the structured fields, then read the returned projection. If `valid` is
not `true`, or any task came back rejected, fix the plan document and the board
together and rewrite. Do not dispatch anything against an invalid graph.

With no board, run the same validation yourself against the plan document: no
unknown dependency, no self-dependency, no duplicate id, no cycle. An invalid
graph blocks dispatch whether or not anything computed that for you.

Then, before dispatching anything, settle the parked questions from phase 0. Any
task whose goal, scope, or acceptance depends on an answer you do not have starts
at the `blocked` status rather than `pending`, with a reason naming the parked
question, propagated downstream. In confirm mode the user is about to answer and
these usually clear immediately. In goal mode they stay blocked, and that is the
correct outcome: the run reaches phase 3 with those tasks honestly marked instead
of stalling on tasks nobody will ever unblock. Everything not touched by a parked
question is `pending` and schedules normally.

Confirm mode presents the plan here and waits. Goal mode goes straight on. If the
plan's structure changes after confirmation, update the plan document and the
board together and revalidate.

## Phase 2: build the nodes

The outer loop schedules by [the DAG contract](references/dag-contract.md). Inside
each node runs a state machine: implement, independent review, fix and re-review,
gates, done. That loop is internal to the node and never becomes an edge in the
DAG.

The steps below give the loop's shape. Six of them — 1, 2, 3, 4, 5 and 8 — also
have a worktree-specific form, step 8 in particular growing from one action into
three, and [worktree-mode.md](references/worktree-mode.md) gives each one in
full. Read it alongside this list rather than deriving the difference yourself:
this list on its own is not enough to run a node.

Each scheduling pass ("pass" here, never "round"; a round is one turn of the fix
loop inside a node, of which there are at most three):

1. **Pick a batch.** Candidates are the ready set: every task whose status is
   `pending` and whose every `depends_on` is `done`. The board's
   `ready_task_ids` is that set computed for you; with no board you derive it
   from the plan document by the same rule. From the candidates, take the largest
   batch whose `write_scope` does not overlap any active node or any other member
   of the batch, that shares no `exclusive_resources` with an active node or the
   batch, and that the project's own concurrency limits allow. Nodes in `running`
   and in `review` are both active and keep holding their scope and resources
   until they reach `done` or `blocked`. Set the chosen nodes to `running`, then
   dispatch the whole batch in parallel, in a single message. Record the commit or
   `HEAD` the batch starts from; that is the diff baseline for each node in it.

2. **Dispatch an implementer per task.** A fresh subagent each time. Build a
   self-contained dispatch prompt following
   [the dispatch contract](references/dispatch.md). It must carry the role
   identity line plus every block of the full context bundle, read off the list
   in that file rather than off any count or copy kept elsewhere, with nothing
   dropped because it was said earlier in this conversation. The subagent was
   not in this conversation. That file is the only list; this step deliberately
   does not restate it, because a restated list goes stale and the block it
   stops short of is the one most recently added.

   **Then account for every subagent you dispatched.** A batch returns one
   subagent at a time, not in the order you dispatched them, and on some
   platforms what sits in front of you when the turn resumes is whichever
   returned last. That is a reading position, not a result set. Keep the batch's
   node list beside you and tick each node off against its own return. A node
   whose return you never opened is not a node that quietly succeeded — it is a
   node you have no information about, and closing it on that basis is the
   fabrication this whole protocol exists to prevent. Nothing in the batch moves
   on to step 3 until every member has either returned or is known to have died.

3. **Review it independently.** Set the node to `review`. Every
   task gets a static review from a `reviewer` subagent that did not write the
   code, with no exceptions and regardless of role. Tasks carrying `ui-designer`
   or `qa` additionally get a runtime walkthrough. Then an `adversary` pass tries
   to knock each finding down. See [the review protocol](references/review.md)
   for what each lane checks and how findings are classified.

4. **Read the diff yourself.** Go file by file, from the node's baseline,
   restricted to the node's `write_scope`: `git diff <baseline> -- <scope paths>`.
   The path restriction is not optional when a batch is running, because the
   other nodes in that batch are writing into the same tree and an unrestricted
   diff mixes their work into this node's review. You are looking for design
   decisions that were quietly changed, refactors nobody asked for, tests that
   assert implementation details instead of behaviour, and anything touching the
   user's pre-existing changes. A change that appears outside the node's scope is
   itself a finding: either another node wrote it, which means the batch was
   unsafe, or this implementer went out of bounds. Then adjudicate the review
   output: `confirmed` findings count as they stand, `unsure` findings you judge
   one by one yourself. An `unsure` finding is not a pass by default.

   **Read what the implementer did, not what it concluded.** Its return carries
   raw command output because the dispatch contract asks for exactly that, and
   the output is the evidence; the summary sitting above it is not. A run that
   hit a failing command, abandoned an approach, or routed around something it
   could not do, and then closed with a confident "done", is a failing node — and
   the summary is precisely where that disappears. So go through the returned
   output with the same care as the diff, and treat a non-zero exit anywhere in
   it as a finding even when the diff itself looks clean.

5. **Run the node's gates yourself.** One command at a time, no pipes, full
   output. See [gates.md](references/gates.md).

6. **Decide.** The node fails if any of these is true: a gate exited non-zero;
   the review produced any `confirmed` finding, or an `unsure` finding you judged
   to be real; your own diff read found a changed design decision, an unplanned
   refactor, or a test that does not cover the behaviour change; the walkthrough
   recorded something that does not match what the task promised. When you cannot
   decide whether something counts as a failure, it counts.

7. **Send it back.** Feed the diff, the review findings, and the raw gate output
   back to the implementer using the rework message in
   [dispatch.md](references/dispatch.md), which has one form for a platform that
   can resume a subagent and a fuller one for a platform that cannot. Either way
   it counts as one round. You do not fix it yourself. Three rounds maximum per
   task.

   **Round 3 changes both the model and the subagent.** Rounds 1 and 2 stay on
   the tier the node started on and, where the platform can resume a subagent, go
   back to the one that did the work. Round 3 does neither: dispatch a fresh
   subagent on the strongest tier available to you, and send it the full context
   bundle rather than the short rework form. Resuming would hand the work back to
   a context that has already failed at it twice, carried by the same model that
   produced both failures; and the short form assumes a subagent that remembers
   the task, which a fresh one does not. This is the one escalation that needs no
   separate justification — two failed rounds are the justification.

   Still failing after the third, give the node and its downstream the
   `blocked` status and follow your operating mode. When you re-review after a
   fix, give the reviewer the diff from the new starting point, not the original
   one.

8. **Close the node.** Set it to `done` only once implementation, independent
   review, and the node's gates have all passed. Where the project's conventions
   call for commits, make one local commit per completed node, staged to that
   node's scope and nothing else:

   ```
   git add -- <scope paths>
   git commit -m "<message>"
   ```

   Never `git commit -a` and never `git add -A`. The other nodes in the batch are
   mid-write in the same tree, so a sweeping stage commits their unfinished work
   under this node's message. That also poisons the `git log -S` and `git blame`
   attribution that phase 3 uses to decide whether a finding predates this
   branch. If `git status` shows changes inside this node's scope that the node
   did not make, stop and treat it as the batch-safety finding it is. Never push.

   Downstream nodes enter the ready set on their own once all their dependencies
   are `done`.

### Bugs found along the way

A related bug found mid-flight gets fixed inside the current plan, with a test.
It is not logged for later and not spun off into separate work. What does not
change is who fixes it: if you found it, you write it up as rework and feed it to
a subagent rather than patching it by hand.

If the bug falls inside the current node's acceptance scope, it stays in that
node's fix loop. If it needs its own scope and acceptance, insert it as a new
task following the dynamic-insertion rules in
[dag-contract.md](references/dag-contract.md): you may add a dependency to a node
that has not started, never to one already running, reviewing, or done. If the
fix would visibly change what the user asked for, explain it and get a decision.

### Tidying the project memory

After every fifth node reaches `done` or `blocked`, counting cumulatively across
scheduling passes rather than per pass, prune the project's memory against what
this run has actually seen. In worktree mode, do it after the merge lock is
released rather than at the instant the node closes.
[memory.md](references/memory.md) has the checks, which tree to read them in,
and, more importantly, what not to delete: an entry nobody used this run is not
thereby stale.

### Roles

The nine roles, their identities, input contracts, delivery contracts, stop
conditions, and model tiers are in [roles.md](roles.md). This document calls for:
`recon-rules`, `recon-product`, `recon-code` in phase 0; `implementer`,
`ui-designer`, `qa` in phase 2; `reviewer` and `adversary` in the node review
loop; `branch-reviewer` and `adversary` again in phase 3.

Pick the model by the risk and difficulty of the work, not by cost. When the
user names a model, that wins. Never downgrade a judgment role to a
code-reading tier to save money.

When the tier a role asks for is unavailable because of quota or overload, step
down one tier and record which role ran on which tier in the node's status
detail. A judgment role (review, adversarial verification, product boundary)
stops stepping down at the reasoning tier and never lands on the cheapest
code-reading tier. If it cannot get at least the reasoning tier, the node waits.

## Phase 3: close the branch out

Phase 3 starts when every task's status is `done` or `blocked`. That condition is
reachable only because blocking propagates: a node that exhausts its three rounds
takes its transitive downstream with it, each marked `blocked` with a reason
naming the upstream node that stopped it. Nodes left sitting in `pending` behind a
blocked upstream would hold this phase open forever.

Set the plan to `review`, then run the project's full gate set yourself, one
command at a time, with the output kept. Per-task gates run scoped, so they cannot
tell you what the tasks did to each other; this run is what catches that. Fix what
it finds through the owning task's fix loop, not by hand.

With the branch building and green, review the whole change. Two paths, and you
run both:

- The skill's own branch review: a fan-out of `branch-reviewer` subagents over
  five dimension lanes plus a sixth lane that audits each task against its stated
  acceptance criteria, with an `adversary` pass over every finding. This path
  needs no human keystroke. See [review.md](references/review.md).
- The platform's native branch reviewer, which is better at this job than a
  subagent you brief yourself. First check whether your platform exposes it as
  something you can invoke. If it does, run it and triage the output like any
  other review. If it is only a user-typed command, prepare the branch and hand
  off: ask the user to run it, take back what it reports, and triage that. See
  [native-review-handoff.md](references/native-review-handoff.md).

Triage the results as described in [review.md](references/review.md): findings
that belong to a task go back into that task's fix loop with its round count
carried forward; findings that belong to no single task become new tasks and go
through dispatch from round one; dismissals marked pre-existing you verify
yourself with `git log -S` or `git blame`; per-task verdicts of `unclear` you
resolve yourself against the plan and the diff rather than recording them as
done.

Before the delivery report, run the memory tidy-up once more and store what this
run established that the next plan here would otherwise go looking for again
([memory.md](references/memory.md)).

### What counts as finished

A clean finish means all of these:

- Every task is `done`: implemented, passed by an independent review, gates green.
- The task-audit lane returned `done` for every task, and you resolved any
  `unclear` yourself against the plan and the diff.
- Branch review and adversarial verification have no unhandled valid findings.
- The project's formatting, type checking, build, and test gates have passed,
  with raw output shown; or the external reason a gate could not run is recorded
  explicitly.
- The user's pre-existing changes are intact.
- The plan is `done`, every task is marked pass or fail, and every failure says
  which step it stopped at and on what.
- The final message states the actual changes, the verification results, the
  decision queue, the remaining risks, and the accumulated "needs a decision from
  the user" list, all in one delivery.

A run with any node still `blocked` has not finished cleanly, and you must not
report it as though it had. It closes out as partial: say how many nodes are
blocked, name each one, say which step it stopped at and on what, and name the
downstream nodes that never ran because of it. Everything else on the list above
still applies to the nodes that did complete. "Finished with three blocked nodes"
is an honest result. "Finished" is not.

Do not push, open a PR, merge, or deploy without the user's explicit
authorization. A local commit is fine where the project expects commits.

## Progress reporting in goal mode

One line per finished task, in a fixed format. The reader is a user who just came
back and wants to scan the state in a few seconds.

```
T3  pass  ci.yml plus the two install scripts  gates 5/5  1 parked
T4  fail  still failing after round 3, stuck on the fixture reset  details at the end
```

Task id, pass or fail, what it was, the gate count, and either the parked count
or where it is stuck. Nothing else.

Do not write a paragraph per task. The detail belongs in the single delivery
report at the end.

Goal mode runs to a **checkpoint**: once 10 tasks have reached `done` or
`blocked` since the run started or since the last checkpoint, stop, report, and
let the user decide whether to continue. The count is cumulative across
scheduling passes, not a cap on batch size; a pass may dispatch as many
conflict-free tasks as the constraints allow, and the checkpoint lands whenever
the tenth one closes. This is not about cost. It is because when something goes
wrong forty tasks into an unattended run, nobody can tell which step it started
going wrong at.

## Prohibited

- Writing implementation code yourself, reviewing your own work, or running the
  QA walkthrough yourself.
- Delegating a gate to a subagent, or burying gates inside a script. A gate you
  did not run does not count.
- Truncating gate output through `head`, `tail`, or any pipe, which hides the
  real exit code.
- Dispatching an implementer on a prompt you threw together, instead of building
  it against [the dispatch contract](references/dispatch.md).
- Saying "tested" or "done" without the tool output in front of you, or writing
  the conclusion for a subagent that is still running.
- Letting a subagent decide whether something passed. Their output is evidence.
  The diff and the gates are yours to read.
- Reading only the subagent that returned last. Every node you dispatched gets
  its return opened and ticked off; the rest are not passes, they are unknowns.
- Taking an implementer's closing summary over the raw command output in the same
  return. A failing command under a confident "done" is a failing node.
- Treating "could not verify" in a review report as "no problem found".
- Deleting or weakening a real test to make the suite green.
- Hand-editing generated files, historical migrations, or vendored directories.
- Refactoring the code next door while working a task.
- Starting on the tasks before the product-boundary questions are answered, or
  filling a boundary in from your own imagination.
- Carrying another project's gate commands or directory conventions into this
  repository. If recon could not find them, ask.
- Putting a stored gate command, run recipe, or hard rule into the plan, a
  dispatch prompt, or a gate run when the owning recon lane did not come back
  with a verdict on it and the line as it reads today, quoted. An unexamined
  claim counts as no memory at all.
- Deleting a memory entry because nothing in this run happened to use it, or
  because the lane came back `unchecked` on it. A source the lane could not open
  is not a source that turned out to be wrong.
- Upserting a fact onto a memory key that names a different fact. At the cap that
  is the one write nothing refuses, and it evicts the entry that key held.
- Treating goal mode as permission to guess. It removes the waiting, not the
  requirement to know. No answer means park it, and parking is not guessing.
- Doing anything outside the plan because you happened to notice it while in goal
  mode. Write it into the parked list.
- Skipping the task review or the branch review because the user is not around.
  When nobody is watching, those two are the only outside check left.
- Staging a node's commit with `git commit -a` or `git add -A` while other nodes
  in the batch are mid-write.
- Reporting a run as finished while any node is still `blocked`. It closes out as
  partial, with the blocked nodes named.
- Deleting the worktree or branch of a `blocked` node when cleaning up in
  worktree mode. That tree is the evidence of what went wrong and cannot be
  reconstructed from the integration branch.
- Treating a node's gates passing in its own worktree as `done`. In worktree mode
  the commit, the merge and the gate run after it are part of the node.
- Merging a node's branch in worktree mode before you have committed its work.
  The branch is still at its branch point until then, so the merge is empty and
  the gate that follows proves nothing.
- Checking the integration branch out in the user's main working tree, or
  committing or stashing the user's changes to clear the way for worktree mode.

## Start here

1. Check whether the `plan-sdd` MCP tools are available; if they are, claim or
   create the run ([board.md](references/board.md)) and read the project memory
   ([memory.md](references/memory.md)). If they are not, say so once and keep
   state in the plan document.
2. Record `baseRef`. Note the user's existing uncommitted changes.
3. Fan out the three recon subagents in parallel
   ([recon.md](references/recon.md)).
4. Merge, confirm the three carry-forwards (gate commands, test concurrency, run
   recipe), ask the open questions and block whatever depends on them.
5. Write the plan document ([plan-spec.md](references/plan-spec.md)) with the DAG
   in it ([dag-contract.md](references/dag-contract.md)), then mirror it to the
   board if you have one, and check the graph is valid either way.
6. Confirm the platform can give a subagent its own worktree, set the trees up
   and record them in the plan's Status header
   ([worktree-mode.md](references/worktree-mode.md)). There is no other mode, so
   a platform that cannot do this is where the run stops.
7. In confirm mode, stop and present. In goal mode, start the scheduling loop.

## Reference files

- [references/board.md](references/board.md): the live board, its MCP tools, and
  the write discipline.
- [references/memory.md](references/memory.md): the project memory the runs
  share, which entries may be trusted before recon confirms them, and the
  tidy-up.
- [references/recon.md](references/recon.md): phase 0, the three read-only lanes.
- [references/plan-spec.md](references/plan-spec.md): the plan document's
  sections and what each one is for.
- [references/dag-contract.md](references/dag-contract.md): task fields, node
  states, batch selection, dynamic insertion.
- [references/dispatch.md](references/dispatch.md): how to write a dispatch
  prompt, the TDD contract, and the rework message.
- [references/review.md](references/review.md): task review, branch review,
  adversarial verification, and adjudication.
- [references/native-review-handoff.md](references/native-review-handoff.md): the
  platform branch reviewers and why they are a handoff.
- [references/gates.md](references/gates.md): gate discipline.
- [references/worktree-mode.md](references/worktree-mode.md): the per-node
  worktree, the merge lock, the post-merge gate, and cleanup. Not optional and
  not a variant — it owns six steps of the phase 2 loop.
- [roles.md](roles.md): the role roster and model tiers.
