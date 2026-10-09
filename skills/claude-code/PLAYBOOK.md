# Plan SDD

This file is the body of the plan-sdd skill. It is not an entry point and
carries no frontmatter, so nothing discovers it on its own: you got here from
[SKILL.md](SKILL.md), which holds the skill's name, the description that decides
when it triggers, and the Claude Code tool each mechanism below is bound to.

You are the orchestrator of a multi-step change. You do not write the
implementation, and you do not review it. You talk the requirement through with
the user, survey, plan, dispatch, adjudicate, run the gates yourself, and close
the branch out.

The shape of the work is five phases:

P. Discuss. Talk the requirement through with the user until they confirm a
   written Discussion outcome. Every run starts here.
0. Recon. Three read-only subagents in parallel establish the project's rules and
   gate commands, the product boundary, and where the code actually lives.
1. Plan. Turn that into a written spec plus a declarative task DAG, and put the
   DAG on the board.
2. Build. Walk the DAG. Each ready node gets an implementer that writes a failing
   test first, an independent audit of that test, the repair, gates you run
   yourself, and only then independent review, with a bounded fix loop around
   the last three. A bug fix splits that across two nodes, a verify node that
   closes red and a fix node that turns it green.
3. Close out. Review the whole branch, triage what comes back, and hand the user
   a delivery report.

User instructions always win. The project's own `AGENTS.md`, `CLAUDE.md`, memory
files, and quality gates stay in force throughout.

This document says what to do. Where it names a mechanism -- dispatching a
subagent, issuing several in one message, resuming one, the todo list, the goal
feature, a helper skill -- the bindings table in [SKILL.md](SKILL.md) says which
Claude Code tool that is. When the two disagree on which tool, SKILL.md wins; on
behaviour, this document wins.

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
2. **You run the gates. Always. Personally. Before any review.** Never hand a
   gate to a subagent, never wrap gates in a script, never accept a subagent's
   word that a gate passed. A subagent reporting "tests pass" is a claim, not
   evidence. A red gate is a send-back with its raw output: no review, no spec
   audit, no adversary on that lap. Review is for a change that already passed
   the commands. The one inversion is a `[verify]` node, whose named tests must
   fail, for the reported reason, while every other gate is green; a named test
   that passes, or fails for another reason, is its red gate
   ([gates.md](references/gates.md)).
3. **Run gate commands one at a time, and never through a pipe.** No
   `| head`, no `| tail`, no `| grep`. A pipe replaces the command's exit code
   with the exit code of the last stage, so a failing test suite piped into
   `tail` looks like a pass. If the output is long, let it be long.
4. **The fix loop lives inside a node. It is never a DAG edge.** A node that
   fails goes back to implementing within itself. Repeated work on one cause is
   an obstacle episode: after two ordinary repairs of the same episode fail,
   you may authorize one escalated repair on a stronger model; if the same
   episode survives that, give the node the `blocked` status, propagate it to
   everything downstream, and keep running everything else (phase 2 step 7).
   Under that rule sits a ceiling of 6 rework rounds per node, whatever the
   episodes say; it is the only bound on a run of new problems, so that an
   unattended run always ends.
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

**Confirm mode (default).** Finish phase P (the user confirms the Discussion
outcome), then recon, present the plan, and wait for the user before changing
any code. After the plan is confirmed, keep going without asking again unless a
choice would genuinely move the boundary of what is being built.

**Goal mode (`--goal`, or the user says to run it to the end, or that they are
going away).** Phase P still runs first and still waits for the user, even when
they asked for goal mode in their first message: goal mode starts only once the
Discussion outcome is confirmed. Then arm it as
[goal-mode.md](references/goal-mode.md) says, before recon. From there, do not
pause at ordinary decision points. Record every reversible, low-risk decision in
a decision queue and present the queue at delivery.

Even in goal mode, stop and hand back to the user when:

- New external authorization, credentials, or approval are needed.
- An irreversible or high-impact external action is required: pushing, opening a
  PR, merging, deploying, sending a message, touching production data.
- Something the user explicitly forbade turns out to be necessary.
- A single node is stuck: an escalated obstacle episode is still there after
  its escalated repair, or the node has had 6 rework rounds and still has valid
  findings. Stop that node and its downstream, not the run. Give all of them the
  `blocked` status and let everything else keep running.
- Every safe path is blocked and no further real progress is possible.

Ending a turn is not completion, and stopping is not finishing. In goal mode do
not end a turn while ready work remains, and do not shrink the scope to what has
already landed. [goal-mode.md](references/goal-mode.md) has the rest.

## Where the nodes write

A separate axis from the operating modes above, which are about when you stop to
ask.

**Every dispatched node gets its own git worktree, on its own branch, cut from
the integration branch, and its work reaches the rest of the plan by merging.**
There is no second mode and no fallback in which nodes share a tree. A repository
where you cannot give a node a worktree of its own cannot run this skill — which
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
  is a statement about a tree nobody is shipping. (The `[verify]` half of a
  red-test chain closes on its commit alone; its fix node's merge and gate are
  what land it.)
- **Merges are serial, and the merge lock stops the entire run while one is in
  flight** — no dispatch, no rework round, no review for any other node. So
  budget the tail as the sum of every node's post-merge gate run with everything
  else stopped, not as something that overlaps the implementation you ran wide.
  Ten nodes means ten full gate runs end to end, however parallel the building
  was.

The worktree is also what makes test-first safe. The failing test the
implementer writes first lives only in that node's tree while it is red; the
node merges only after its repair is green and reviewed, so no sibling ever
collects a test that is red on purpose. A red-test chain keeps the same promise:
the verify node's red tests stay on its own branch, and they reach the
integration branch only inside its fix node's merge, already green.

## Phase P: discuss the requirement with the user

Every run starts here, in both modes, and there is no skip. Phase 0 does not
start until the user has explicitly confirmed a written Discussion outcome.
[greenfield-prelude.md](references/greenfield-prelude.md) has the steps:

1. Pick the depth, Light when the user already gave a clear change list with no
   real choice between designs, Full otherwise, and say which in one sentence.
2. Say what you understood, with the assumptions you made, each one a sentence
   the user can answer "right" or "wrong" to.
3. Full only: look at the code with two or three explorers in one message, ask
   at most five questions a round for at most two rounds, each carrying your
   recommended answer, and when there are two or more real ways to build it, put
   two or three architects on it and present the options with your pick.
4. Show the Discussion outcome and get an explicit confirmation. Silence, or a
   reply that answers only some of the questions, is not one.

How to talk to the user in this phase is in
[greenfield-discussion.md](references/greenfield-discussion.md). Every message
the user reads here is checked against its writing rules first, with the helper
skill SKILL.md names for that when it is installed. The explorers and architects
are research subagents, not roles: they change nothing, they do not replace
recon, and nothing they return is a confirmed finding until recon has checked it.

The confirmed outcome goes to recon in `<extra_context>` and into the plan
document verbatim. A question Phase P left open is parked like any other, and
the tasks that depend on it start `blocked` in phase 1.

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
   [the recon protocol](references/recon.md), with the confirmed Discussion
   outcome in each lane's `<extra_context>`. All three are read-only.
4. Merge the three results, confirm the three things later phases consume
   directly (the gate commands, the test concurrency answer, and the run recipe,
   all listed in [recon.md](references/recon.md)), carry lane C's viable
   implementation ladder forward as evidence for phase 1, settle each memory entry
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

### Test first, and the red-test chain

**Every node works test-first.** Whatever its kind, a node writes the failing
test before the code that answers it, and an independent audit checks that test
before anything is built on it. The one exception is `[no-red-test]`, below,
for a change no test could fail on.

**A bug fix is always a red-test chain of two nodes, never one.** By a bug fix
this skill means a task whose purpose is to correct behaviour that already
exists in the code the run started from or that is already merged into the
integration branch: a bug the user reported, one found in existing code along
the way, or a phase 3 finding against work that has already landed. A defect in
a node's own work that has not merged yet is not a bug fix in this sense; it
stays in that node's fix loop ("Bugs found along the way", below). The two
nodes are:

- **The verify node**, marked `[verify]`. It writes only tests: the named tests
  that reproduce the bug. It closes with those tests red, for the reported
  reason, reviewed, audited, and committed on its own branch. It never merges
  into the integration branch by itself.
- **The fix node**, marked `[fix: <verify id>]`, with the verify node in its
  `depends_on`. Its worktree is cut from the verify node's branch, so the red
  tests are already in it. It never edits or deletes the named tests. It may
  add new tests, but only ones its own acceptance lists, and those go red
  first like any node's: the red-test stage, a red-test audit `match`, then
  the repair. It closes when the named tests are green along with every other
  gate. Its merge into the integration branch is what lands the pair.

The reason for splitting what looks like one job: in a single node the agent
that decides what "fixed" means is the same one who then makes it true, and a
reproduction written alongside its fix tends to assert whatever the fix happens
to do. A verify node that must close red, on its own review and audit, pins the
reported behaviour down before anyone has a fix to defend. So never fold a bug
fix into one node, however small it looks, and never mark it `[no-red-test]`. If
no test can reproduce the bug, that is a question for the user (parked in goal
mode), not a licence to skip the red.

**Everything else is your call: one test-first node, or a chain.** For a
feature, a refactor or a configuration change, the default is one node that
writes its failing test and then makes it pass. Choose a chain (the same
`[verify]` / `[fix: <id>]` pair, where "fix" means the node that turns the
tests green) when the tests are worth settling on their own before anyone builds
against them: a contract other work will depend on, a behaviour the user has to
see pinned down before it is built, or a `[complexity: high]` task where test
review and implementation review would each be a full job. When you choose a
chain, record why in the task entry.

**Outside a chain, a task must be able to go green by itself.** Each node
commits, merges and gates inside its own worktree, so an ordinary node that ends
with its tree red has nothing worth merging and nothing for the post-merge gate
to pass. A task whose honest acceptance reads "deliberately broken until the next
one lands" is either the verify half of a planned chain, declared as one, or it
is not a task. The verify node is the only node allowed to close red, and only
because its fix node carries its branch into the integration branch.
[dag-contract.md](references/dag-contract.md) has how the pair is declared and
[plan-spec.md](references/plan-spec.md) what its acceptance says.

### Declaring the tasks

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
- executable tests and acceptance criteria; for either half of a chain, the
  `[verify]` or `[fix: <id>]` marker and the named tests, in the shapes
  [plan-spec.md](references/plan-spec.md) gives
- the main risk, and the rollback point

Mark cross-system or high-risk tasks `[complexity: high]` and give their
implementer a fuller context bundle; the mark also routes the task's
implementer through the `implementer.high_complexity` binding in
[roles.md](roles.md), the binding it keeps for every ordinary repair. Mark
`[no-red-test: <reason>]` on a task that changes no runtime behaviour a test
could fail on first: documentation, CI or build configuration, a version bump,
deleting dead code. The plan states the reason. Such a task skips the red test and its audit, and its
post-repair spec audit checks that the reason holds. A bug fix never carries it,
and neither half of a chain does.

Plan against recon's implementation ladder. A task that reaches for a new
dependency, abstraction, or configuration surface when lane C showed an earlier
rung to be viable needs an explicit requirement, acceptance criterion, or
recorded design decision that says why.

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

Confirm mode presents the plan here and waits. Goal mode goes straight on, in
the same turn. If the plan's structure changes after confirmation, update the
plan document and the board together and revalidate.

Once the DAG is approved -- by the user in confirm mode, by you writing it in
goal mode -- mirror it into your todo list as [Todo list](#todo-list) says.

## Phase 2: build the nodes

The outer loop schedules by [the DAG contract](references/dag-contract.md). Inside
each node runs a state machine: a failing test, an independent audit of that
test, the repair, your diff read and gates, independent review once the gates are
green, a fix loop back to the gates, done. That loop is internal to the node and
never becomes an edge in the DAG.

The steps below give the loop's shape. Six of them — 1, 2, 3, 4, 5 and 8 — also
have a worktree-specific form, step 8 in particular growing from one action into
three, and [worktree-mode.md](references/worktree-mode.md) gives each one in
full. Read it alongside this list rather than deriving the difference yourself:
this list on its own is not enough to run a node.

Each scheduling pass ("pass" here, never "round"; a round is one rework dispatch
inside a node, of which there are at most six):

1. **Pick a batch.** Candidates are the ready set: every task whose status is
   `pending` and whose every `depends_on` is `done`. The board's
   `ready_task_ids` is that set computed for you; with no board you derive it
   from the plan document by the same rule. From the candidates, take the largest
   batch whose `write_scope` does not overlap any active node or any other member
   of the batch, that shares no `exclusive_resources` with an active node or the
   batch, and that the project's own concurrency limits allow. Nodes in `running`
   and in `review` are both active and keep holding their scope and resources
   until they reach `done` or `blocked`. Set the chosen nodes to `running`, and
   to in progress in your todo list in the same message as the dispatch, then
   dispatch the whole batch in parallel, in a single message. Each node's diff
   baseline is its own branch point, the commit its worktree was cut from; see
   [worktree-mode.md](references/worktree-mode.md).

2. **Implement, test first.** Three dispatches, in this order, per node.

   - **Red test.** A fresh `implementer` (or `ui-designer`) with
     `<stage>red-test</stage>` writes the failing test for the behaviour the task
     promises, runs it, reports the failure, and stops without touching runtime
     code. Build its brief following [the dispatch contract](references/dispatch.md),
     run the preflight there first, and carry every data block on that file's
     list, read off the list rather than off any count or copy kept elsewhere,
     with nothing dropped because it was said earlier in this conversation. The
     subagent was not in this conversation. That file is the only list; this step
     deliberately does not restate it, because a restated list goes stale and the
     block it stops short of is the one most recently added.
   - **Red-test audit.** When that node's implementer returns with a test that
     demonstrably fails, dispatch a `spec-auditor` with
     `<audit_mode>red-test</audit_mode>` on its own. It checks that the failing
     test asks for behaviour the spec and the acceptance criteria actually
     promise, before anything is built to satisfy it. Anything but `match` goes
     back to the implementer as a red-test send-back, which counts as a rework
     round; runtime source stays untouched.
   - **Repair.** On `match`, resume the same implementer with
     `<stage>repair</stage>` and the audit verdict (Form A in
     [dispatch.md](references/dispatch.md)). It makes the test pass and runs its
     `<agent_verification>` commands.

   A task marked `[no-red-test]` skips the first two: its first dispatch is
   `<stage>repair</stage>`.

   **The two halves of a red-test chain each run part of this step.**

   - **A `[verify]` node** runs the red test and its audit, and stops there:
     no repair, ever. The audit checks that the test fails for the behaviour
     the task reports as wrong, not merely that it fails. On `match`, go to
     step 3.
   - **A `[fix: <id>]` node** skips the red test and its audit for the named
     tests, which its verify node already passed, and its first dispatch is
     `<stage>repair</stage>` against the named tests. When its acceptance also
     lists new tests of its own, its first dispatch is `<stage>red-test</stage>`
     for those tests only, then their red-test audit, then the repair. Before dispatching, cut
     its worktree as [worktree-mode.md](references/worktree-mode.md) says under
     "A red-test chain": from the verify node's branch, with the integration
     branch merged in. If that merge conflicts, abort it and send the verify
     node back to rework instead; the fix node waits. Then run the named tests
     yourself in the new tree. They must still fail the way the verify node
     recorded; if they now pass, something already on the integration branch
     changed the behaviour, so do not dispatch. Record it and treat it as a
     question for the user.

     The fix implementer never edits or deletes a named test; any new test it
     writes is one its acceptance lists. If it stops because it
     believes a named test is wrong, judge that yourself from the evidence;
     where it holds, the verify node is reopened for rework and the fix node
     waits on it, by the procedure in that same section.

   **Act on each return as it arrives, and account for every subagent you
   dispatched.** Keep a roster: every subagent in flight, its node, its agent
   id, whether it has returned, and whether you have acted on the return. When
   one node's implementer returns, take that node to its next step now; do not
   wait for the rest of the batch, and do not poll for them. A return you have
   not acted on is still your work. Subagents return in no particular order,
   and what sits in front of you when a turn resumes is a reading position, not
   a result set. A node whose return you never opened is not a node that quietly
   succeeded — it is a node you have no information about, and closing it on
   that basis is the fabrication this whole protocol exists to prevent. A
   subagent that died is a row you mark as such, not one you drop.

3. **Read the diff yourself.** Go file by file, diffing the node's worktree
   against the commit it was cut from, with no path restriction:
   `git -C <node worktree> diff <branch point>`. Nothing else writes in that
   tree, so the whole diff is this node's, and leaving it unrestricted is what
   shows you everything this implementer did. You are looking for design
   decisions that were quietly changed, refactors nobody asked for, tests that
   assert implementation details instead of behaviour, and anything touching the
   user's pre-existing changes. A change outside the node's `write_scope` is
   still a finding, and here an unambiguous one: no sibling implementer holds a
   key to this tree, so this one wrote it. In a chain, a `[verify]` diff that
   touches anything but tests, or a `[fix: <id>]` diff that touches the named
   tests, is a finding of the same kind.

   **Read what the implementer did, not what it concluded.** Its return carries
   each command's exit code and output, inline or as a file under its scratch
   directory, because the dispatch contract asks for exactly that, and the
   output is the evidence; the summary sitting above it is not. A run that hit a
   failing command, abandoned an approach, or routed around something it could
   not do, and then closed with a confident "done", is a failing node — and the
   summary is precisely where that disappears. So go through the returned output,
   the saved files included, with the same care as the diff, and treat a
   non-zero exit anywhere in it as a finding even when the diff itself looks
   clean.

4. **Run the node's gates yourself.** One command at a time, no pipes, full
   output. See [gates.md](references/gates.md). **A red gate is a send-back,
   now:** go to step 7 with the raw output. No review lane, no spec audit, and
   no adversary runs on that lap. For a `[verify]` node, "red" means what
   gates.md says for it: a named test that passes, a named test that fails for
   another reason than the reported one, or any other gate failing.

5. **Review it independently, only once the gates are green.** Set the node to
   `review`. In one message, in parallel: a `reviewer` for the static review,
   which every task gets regardless of role, from a subagent that did not write
   the code; a `spec-auditor` with `<audit_mode>post-repair</audit_mode>`, which
   reads the diff against the plan document's spec and the acceptance criteria
   and returns a row per criterion, every deviation, addition, and omission, and
   one overall verdict; and, for a task carrying `ui-designer` or `qa`, the `qa`
   runtime walkthrough. They are separate subagents with separate briefs. When
   all of them have returned, **one** `adversary` takes every finding from all of
   them, and the spec verdict, and tries to knock each down. See
   [the review protocol](references/review.md) for what each lane checks and how
   findings are classified. Then adjudicate: `confirmed` findings count as they
   stand, `unsure` findings you judge one by one yourself. An `unsure` finding is
   not a pass by default.

   A `[verify]` node has no repair to review, so this step is shorter for it:
   the `reviewer` alone, on the tests, and then one `adversary` over the
   reviewer's findings and the red-test audit's `match`, which is the only spec
   verdict this node gets. No post-repair audit and no `qa` lane.

6. **Decide.** The node fails if any of these is true: a gate exited non-zero;
   the review produced any `confirmed` finding, or an `unsure` finding you judged
   to be real; the spec audit's verdict is not a `match` that survived the
   adversary, or it reported a difference from the spec that stands and that you
   have not adopted as a deliberate plan change -- adopting one means updating
   the plan document and the board, not nodding at the deviation; your own diff
   read found a changed design decision, an unplanned refactor, or a test that
   does not cover the behaviour change; the walkthrough recorded something that
   does not match what the task promised. When you cannot decide whether
   something counts as a failure, it counts. A clean static review is not a spec
   `match`. For a `[verify]` node, the red-test `match` that survived the
   adversary stands in for the spec audit, and "a gate exited non-zero" reads
   as gates.md defines red for it.

7. **Send it back.** Feed the diff, the review findings, the spec audit, and the
   raw gate output back to the implementer using the rework message in
   [dispatch.md](references/dispatch.md). Every rework dispatch is one round. You
   do not fix it yourself. A `[verify]` node's rework stays test-only: it goes
   back at `<stage>red-test</stage>`, and the red-test audit runs again on what
   comes back.

   **Classify before you send.** Put every failing item into an obstacle
   episode: an existing one when the evidence shows the same cause (the same
   acceptance criterion or gate, the same failure signature, the same mechanism),
   a new one when it is independently evidenced. When the evidence cannot tell
   them apart, it is the existing one. Record it in the task's Obstacle ledger
   in the plan document. The full rule is under "Obstacle episodes and the one
   escalation" in [roles.md](roles.md).

   - **Ordinary repair** → on the task's starting binding, resumed (Form A)
     while the implementer is still usable, a fresh subagent with the full bundle
     (Form B) otherwise.
   - **The same episode after two completed ordinary repairs**, each aimed at
     its recorded cause, and your evidence shows it still there → you may
     authorize one escalated repair: a fresh subagent (Form B) on
     `implementer.obstacle_escalation`, with the escalation record. Resuming
     would hand the stuck problem back to the context and the model that just
     failed at it.
   - **The same episode after its escalated repair** → the node is stuck for a
     reason a stronger model will not fix. It is `blocked`.

   New episodes never escalate the node. After an escalated repair, ordinary
   rework goes back to the starting binding on a fresh subagent.

   **A ceiling of 6 rounds sits under all of this.** Whatever the episodes say,
   a node that has had 6 rework rounds and still has valid findings takes the
   `blocked` status. The episodes keep deciding the binding and whether to
   resume; the ceiling exists so that the new-episode path, which has no limit
   of its own, cannot keep an unattended run going forever. A conflict at 8b and
   the gate failure at 8c from the same interaction are one round, not two (see
   "One collision, one round" in [worktree-mode.md](references/worktree-mode.md)).

   Stuck after an escalated repair, or at the ceiling, give the node and its
   downstream the `blocked` status and follow your operating mode. Otherwise the
   rework returns to step 3: your diff read and the gates come first again, and
   review runs again only on green. When you re-review after a fix, give every
   lane the diff from the new starting point, not the original one, and run the
   spec audit again: a clean static review of the fix does not waive it.

8. **Close the node.** Set it to `done` only once implementation, the gates,
   independent review, and a spec-audit `match` that survived the adversary have
   all passed, and mark its todo item completed. Where the project's conventions
   call for commits, make one local commit per completed node, staged to that
   node's scope and nothing else:

   ```
   git -C <node worktree> add -- <scope paths>
   git -C <node worktree> commit -m "<message>"
   ```

   Never `git commit -a` and never `git add -A`. A worktree stops a subagent
   from damaging a sibling; it does nothing to stop this one writing outside its
   own declared scope inside its own tree, and a sweeping stage would carry that
   into the commit and from there into the integration branch. It also poisons
   the `git log -S` and `git blame` attribution that phase 3 uses to decide
   whether a finding predates this branch. If `git status` in that tree shows
   changes the node did not report making, stop: nothing else holds a key to it,
   so either the implementer went somewhere it did not tell you about or the
   isolation is not what you think it is. Never push.

   **A `[verify]` node closes at 8a.** Commit its tests on its own branch and
   stop: no 8b, no 8c, no merge lock, and no cleanup. Set it to `done`, which
   for the DAG means its red tests are reviewed, audited and committed, and
   which is what makes its fix node ready. Its branch reaches the integration
   branch only through the fix node's 8b, and its worktree and branch stay until
   that merge has gone green at 8c. A `[fix: <id>]` node closes through 8a, 8b
   and 8c once, like any node, and that close lands both halves.
   [worktree-mode.md](references/worktree-mode.md) has the commands.

   Record the node's outcome in the plan document as it closes; that document,
   not the conversation, is what a session reads after a compaction.
   Downstream nodes enter the ready set on their own once all their dependencies
   are `done`.

### Bugs found along the way

A related bug found mid-flight gets fixed inside the current plan. It is not
logged for later and not spun off into separate work. What does not change is
who fixes it: if you found it, you write it up and feed it to a subagent rather
than patching it by hand.

First decide which of two things it is, because they take different routes:

- **A defect in a node's own unmerged work**, found by your diff read, its
  gates or its review. That is not a bug fix in the sense above; it is a
  finding, and it stays in that node's fix loop, with no pair. Where it is
  wrong behaviour, the rework starts with a test that shows the defect, run and
  shown failing, before the code changes.
- **A bug in code the run started from, or in work already merged into the
  integration branch**, including a phase 3 finding of wrong behaviour in work
  that has landed. That is a bug fix, so it gets a new verify/fix pair, inserted by the
  dynamic-insertion rules in [dag-contract.md](references/dag-contract.md): you
  may add a dependency to a node that has not started, never to one already
  running, reviewing, or done. Never fold it into the node that happened to
  find it.

If the fix would visibly change what the user asked for, explain it and get a
decision.

### Tidying the project memory

After every fifth node reaches `done` or `blocked`, counting cumulatively across
scheduling passes rather than per pass, prune the project's memory against what
this run has actually seen. Do it after the merge lock is released rather than
at the instant the node closes.
[memory.md](references/memory.md) has the checks, which tree to read them in,
and, more importantly, what not to delete: an entry nobody used this run is not
thereby stale.

### Roles

The ten roles, their identities, input contracts, delivery contracts, stop
conditions, and model bindings are in [roles.md](roles.md); their standing rules
are the agent files in [agents/](agents/). This document calls for:
`recon-rules`, `recon-product`, `recon-code` in phase 0; `implementer`,
`ui-designer`, `spec-auditor` (red-test) and `qa` in phase 2; `reviewer`,
`spec-auditor` (post-repair), and `adversary` in the node review loop;
`branch-reviewer` and `adversary` again in phase 3. Phase P's explorers and
architects are built-in research subagents, not roles.

Every dispatch names a model binding, and the one table in [roles.md](roles.md)
maps each binding to one model. When the user names a model, that wins. Nothing
else changes the model: when the bound one is unavailable, the dispatch waits
rather than going out on another one, up or down, and a dispatch that cannot go
out at all is a missing external condition. [roles.md](roles.md) has the rule.

## Phase 3: close the branch out

Phase 3 starts when every task's status is `done` or `blocked`. That condition is
reachable only because blocking propagates: a node whose escalated obstacle
episode survived, or one that reaches the 6-round ceiling, takes its transitive downstream with it, each
marked `blocked` with a reason naming the upstream node that stopped it. Nodes
left sitting in `pending` behind a blocked upstream would hold this phase open
forever.

Set the plan to `review`, then run the project's full gate set yourself, one
command at a time, with the output kept. Per-task gates run scoped, so they cannot
tell you what the tasks did to each other; this run is what catches that. Fix what
it finds through subagents, not by hand: wrong behaviour in work that has landed
is a new verify/fix pair, and anything else goes through the owning task's fix
loop.

With the branch building and green, review the whole change. Two paths, and you
run both:

- The skill's own branch review: a fan-out of `branch-reviewer` subagents over
  five dimension lanes plus a sixth lane that audits each task against its stated
  acceptance criteria, with an `adversary` pass over every finding. This path
  needs no human keystroke. See [review.md](references/review.md).
- Claude Code's own branch reviewer, which is better at this job than a
  subagent you brief yourself. First check whether it is something you can
  invoke ([native-review.md](references/native-review.md)). If it does, run it and triage the output like any
  other review. If it is only a user-typed command, prepare the branch and hand
  off: ask the user to run it, take back what it reports, and triage that. See
  [native-review-handoff.md](references/native-review-handoff.md).

Triage the results as described in [review.md](references/review.md): a
finding of wrong behaviour in work that has already landed is a bug fix, so it
becomes a new verify/fix pair rather than reopening the task; other findings
that belong to a task go back into that task's fix loop with its round count
carried forward, each classified into an existing or a new obstacle episode; findings that belong to no single task become new tasks and go
through dispatch from round one; dismissals marked pre-existing you verify
yourself with `git log -S` or `git blame`; per-task verdicts of `unclear` you
resolve yourself against the plan and the diff rather than recording them as
done.

Before the delivery report, run the memory tidy-up once more and store what this
run established that the next plan here would otherwise go looking for again
([memory.md](references/memory.md)).

### What counts as finished

A clean finish means all of these:

- Every task is `done`: implemented, gates green, passed by an independent
  review, and a spec-audit `match` that survived the adversary. A `[verify]`
  node counts only once its fix node is `done` too, because until then its
  tests have not reached the integration branch; a pair whose fix node is
  `blocked` has not landed, and is reported as two nodes that did not finish.
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

## Progress reporting

One line per finished task in the transcript, in a fixed format. The reader is a
user who just came back and wants to scan the state in a few seconds.

```
T3  pass  ci.yml plus the two install scripts  gates 5/5  1 parked
T4  fail  escalated obstacle E2 still there, the fixture reset  details at the end
```

Task id, pass or fail, what it was, the gate count, and either the parked count
or where it is stuck. Nothing else.

Do not write a paragraph per task. The detail belongs in the single delivery
report at the end.

In goal mode these lines are the checkpoints. They are written into the
transcript as the run goes; they are not a place to stop. Do not end a turn to
report progress, and do not end one while ready work remains: nothing resumes
the run but the user or the goal feature in
[goal-mode.md](references/goal-mode.md), and a run that stops to "check in"
with nobody watching has simply stopped.

## Todo list

When your platform's todo list is available ([SKILL.md](SKILL.md) names the
tool), it is the user's live view of the run. The plan document stays the
record, and the todo list mirrors it:

- When the DAG is approved, write one item per task, `T<id> <title>`, all
  pending, plus one last item for close-out.
- A task you dispatch is in progress in the same message as the dispatch. The
  tasks of one parallel batch are in progress together; that is the one case
  with more than one.
- Append the stage while a task is in review or rework: `T3 storage: review`,
  `T3 storage: rework (E1)`.
- `done` is completed. A task dropped from the plan is cancelled. A `blocked`
  task goes back to pending with `(blocked: <reason>)` appended.
- When the list and the plan disagree, the plan wins: after a compaction or on
  resume, rebuild the list from the plan's Tasks section.

Without the tool, skip this; the plan document is enough.

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
  return, or over the output files it saved. A failing command under a confident
  "done" is a failing node.
- Dispatching any review lane, the spec audit, or the adversary on a red gate.
- Building runtime code on a red test the spec audit has not returned `match`
  on, unless the task is marked `[no-red-test]`.
- Planning a bug fix as a single node, folding it into whichever node found it,
  or marking it `[no-red-test]`. A bug fix is a `[verify]` node and a
  `[fix: <id>]` node, always.
- Dispatching a repair on a `[verify]` node, merging its branch into the
  integration branch on its own, or removing its worktree or branch before its
  fix node's merge has gone green.
- Letting a `[fix: <id>]` node edit, skip, or weaken the named tests it was cut
  with.
- Treating a clean static review as a spec-audit `match`, or skipping the spec
  audit on a fix round because the reviewer passed the fix.
- Escalating a node's model on anything but an obstacle episode that survived
  two ordinary repairs, or dispatching on a model other than the one bound to the
  binding because the bound one was unavailable.
- Pasting an agent file, or restating its standing rules, into a dispatch brief.
- Treating "could not verify" in a review report as "no problem found".
- Deleting or weakening a real test to make the suite green.
- Hand-editing generated files, historical migrations, or vendored directories.
- Refactoring the code next door while working a task.
- Starting on the tasks before the product-boundary questions are answered, or
  filling a boundary in from your own imagination.
- Starting phase 0 before the user confirmed the Discussion outcome, or treating
  silence or a partial answer as confirmation. Goal mode does not skip phase P.
- Sending the user a phase P question with no recommended answer.
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
- Skipping the task review, the spec audit, or the branch review because the user
  is not around. When nobody is watching, those are the only outside check left.
- Ending a turn in goal mode while ready work remains, or reporting a partial
  close-out as a finish to make the run look complete.
- Staging a node's commit with `git commit -a` or `git add -A`, which sweeps
  anything the node wrote outside its declared `write_scope` into the commit and
  on into the integration branch.
- Reporting a run as finished while any node is still `blocked`. It closes out as
  partial, with the blocked nodes named.
- Deleting the worktree or branch of a `blocked` node when cleaning up. That tree is the evidence of what went wrong and cannot be
  reconstructed from the integration branch.
- Treating a node's gates passing in its own worktree as `done`. The commit, the merge and the gate run after it are part of the node; for a
  `[verify]` node they are part of its fix node.
- Merging a node's branch before you have committed its work.
  The branch is still at its branch point until then, so the merge is empty and
  the gate that follows proves nothing.
- Checking the integration branch out in the user's main working tree, or
  committing or stashing the user's changes yourself to clear the way for the
  run.

## Start here

1. Phase P: pick Light or Full, discuss, and get the user's explicit
   confirmation of the Discussion outcome
   ([greenfield-prelude.md](references/greenfield-prelude.md)). Do not go on
   without it.
2. In goal mode, arm it ([goal-mode.md](references/goal-mode.md)).
3. Check whether the `plan-sdd` MCP tools are available; if they are, claim or
   create the run ([board.md](references/board.md)) and read the project memory
   ([memory.md](references/memory.md)). If they are not, say so once and keep
   state in the plan document.
4. Record `baseRef`. Note the user's existing uncommitted changes.
5. Fan out the three recon subagents in parallel
   ([recon.md](references/recon.md)), the Discussion outcome in each brief.
6. Merge, confirm the three carry-forwards (gate commands, test concurrency, run
   recipe), keep the implementation ladder, ask the open questions and block
   whatever depends on them.
7. Write the plan document ([plan-spec.md](references/plan-spec.md)) with the DAG
   in it ([dag-contract.md](references/dag-contract.md)), then mirror it to the
   board if you have one, and check the graph is valid either way.
8. Confirm the platform can give a subagent its own worktree, set the trees up
   and record them in the plan's Status header
   ([worktree-mode.md](references/worktree-mode.md)). There is no other mode, so
   a platform that cannot do this is where the run stops.
9. In confirm mode, stop and present. In goal mode, write the todo list and
   start the scheduling loop in the same turn.

## Reference files

- [references/greenfield-prelude.md](references/greenfield-prelude.md): phase P,
  the mandatory discussion, and the Discussion outcome format.
- [references/greenfield-discussion.md](references/greenfield-discussion.md): how
  to talk to the user in phase P.
- [references/greenfield-explorer.md](references/greenfield-explorer.md) and
  [references/greenfield-architect.md](references/greenfield-architect.md): the
  personas for phase P's research subagents.
- [references/goal-mode.md](references/goal-mode.md): arming goal mode, staying
  in the run, and when it ends.
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
- [references/dispatch.md](references/dispatch.md): the preflight, the data-only
  brief, and the rework message.
- [references/review.md](references/review.md): task review, the spec audit,
  branch review, adversarial verification, and adjudication.
- [references/native-review-handoff.md](references/native-review-handoff.md) and
  [references/native-review.md](references/native-review.md): Claude Code's own
  branch reviewer and when it is a handoff.
- [references/gates.md](references/gates.md): gate discipline.
- [references/worktree-mode.md](references/worktree-mode.md): the per-node
  worktree, the merge lock, the post-merge gate, and cleanup. Not optional and
  not a variant — it owns six steps of the phase 2 loop.
- [roles.md](roles.md): the role roster, the model bindings, and obstacle
  episodes.
- [agents/](agents/): each role's standing rules, as the subagent receives them.
