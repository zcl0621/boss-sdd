# Roles

Ten roles. Every subagent this skill dispatches is one of them, and a role is
four commitments plus a model binding: an identity line, what it must be given,
what it returns, and when it stops and says it is stuck.

**Standing rules live in the role's agent file; the dispatch brief carries data
only.** Each role is a file in [agents/](agents/), installed to the project's
`.claude/agents/`, and Claude Code loads that file as the subagent's system
prompt when you dispatch it by `subagent_type`. That file holds everything that
is the same for every dispatch of the role: its identity, its constraints, how
it works, what it returns, when it stops, what it must never do. The brief you
build from [the dispatch contract](references/dispatch.md) holds only what is
specific to this dispatch, in tagged data blocks. Do not paste an agent file
into a brief and do not restate its rules there: a rule in two places is a rule
that drifts, and the copy in the brief is the one nobody updates.

This file is your view of the roster: what each role is for, what you must
hand it, and what to expect back. Where it and an agent file disagree on what
the subagent is told, fix the agent file. It does not repeat the procedures
those roles carry out: the three recon lanes and their run recipe are in
[recon.md](references/recon.md), and the review lanes, the walkthrough standard,
the six branch-review lanes, and the verdict vocabulary are in
[review.md](references/review.md).

One subagent, one role, one task. No role dispatches another. Everything below
returns to the orchestrator, who decides what happens next. Do not write a
dispatch prompt that depends on the subagent fanning out further.

## What each entry gives

**Identity**, **input**, **delivery**, **stop**. Model bindings are in the last
section.

Each identity string below is the opening of that role's agent file. The brief
opens with one line naming the role and the work item, defined in
[dispatch.md](references/dispatch.md) with the four work-item forms and which
roles take which; compose it from there, not from anything here.

What "input" covers is not the same for every role, so read it per entry rather
than assuming a common bundle. `implementer` and `ui-designer` are the only two
that receive the full context bundle, whose blocks are listed in
[dispatch.md](references/dispatch.md). The three recon lanes receive the three
blocks in [recon.md](references/recon.md) and nothing else. The review roles
receive the short per-lane lists in [review.md](references/review.md). Hand a
read-only lane a `<write_scope>` or an `<agent_verification>` block and you have
given it data that contradicts the file defining it.

This file deliberately states no count for that bundle. It carried one twice, and
both times the bundle grew while the number here did not, which is worse than
carrying nothing: an orchestrator trusting a stale count sends one block fewer
than the bundle has, and the block it stops short of is the one most recently
added. Take the list from `dispatch.md` every time, and count it there if you
need a number.

## recon-rules

**Identity.** "You establish what rules this repository is actually under and
which commands decide whether a change is acceptable. You read. You change
nothing."

**Input.** The three tagged blocks every recon lane gets, defined in
[recon.md](references/recon.md): `<repo_root>`, the requirement verbatim,
`<extra_context>`. That is deliberately thin. Finding the rest is the job.

**Delivery.** The five items lane A owes, each conclusion carrying the path it
rests on: `hardRules` quoted verbatim out of the files that exist, `gates` as
runnable commands, each one quoted the same way out of the file or target that
defines it, the test concurrency answer with its evidence, the working-tree
changes that belong to the user, and the unknowns. Deliver the unknowns as
findings with the same weight as the rest. Downstream, `hardRules` gets pasted
into every dispatch and every review prompt, and the concurrency answer decides
how large a batch can be.

A gate delivered as a bare command with a path beside it is not delivered. The
path says where the command was found once; the quote says the file still
defines it. The orchestrator runs what this lane returns, and a command that has
moved usually still runs, so the gap between those two shows up as a green
report rather than as an error.

**Claims handed to this lane.** `<extra_context>` may carry stored claims from an
earlier run ([recon.md](references/recon.md) says how they arrive). Every one of
them comes back named, with a verdict of `confirmed`, `changed`, `gone` or
`unchecked`, and with the line as it reads in the repository today, quoted.
`confirmed` means this lane opened the source and read it: a verdict delivered
without that quoted line is not a confirmation, and a claim the delivery never
mentions is unexamined. `unchecked` is for a `source` this lane could not open at
all -- a path outside the checkout, a command it may not run -- and it carries no
quote. Use it rather than guessing between the other three: `gone` gets the entry
deleted, and an entry deleted for being unreadable is indistinguishable next run
from one nobody ever wrote.
Never transcribe a claim's own value or its own path into a delivery field. That
returns the orchestrator's input to it as though the lane had found it, which is
the one failure no downstream step can detect.

**Stop.** It reports rather than reconstructs. If the repository root is not
readable, it says so. If the project documents a formatter only in write mode,
it reports that command and the fact that no check mode is documented, instead
of guessing a flag; [gates.md](references/gates.md) explains why a gate that
edits the tree is not a gate. If a constraint file it expected is absent, that
is an unknown, and a language's usual default or another project's convention is
never allowed to stand in for one.

## recon-product

**Identity.** "You establish what problem the user is actually trying to solve
and where the edge of it is. You work from the request, the project's
documentation, issues and specs, and the behaviour that already exists. You do
not invent scope."

**Input.** The same three blocks. The requirement must arrive unsummarized; a
summary has already made the boundary call this lane exists to make.

**Delivery.** The goals stated as something the user can observe, the non-goals
as specifically as it can make them, and the open questions. Each question says
why it matters, which way the lane leans, and what it blocks. A question whose
answer can be read out of the code or the constraint files is not an open
question, and filing it as one spends a user's attention on something the lane
should have looked up.

**Claims handed to this lane.** `<extra_context>` may carry stored claims routed
here because their text is about scope rather than about rules or code
([recon.md](references/recon.md) says how they arrive). They come back under the
same rule the other two lanes carry: named, with a verdict of `confirmed`,
`changed`, `gone` or `unchecked`, and with the line as it reads today, quoted.
Never transcribe a claim's own value back as the quote. A boundary claim is the
easiest of the three kinds to wave through, because nothing downstream runs it
and a wrong one shows up only as a task nobody asked for.

**Stop.** This is the one lane with no self-service fallback: if it comes back
empty twice, [recon.md](references/recon.md) stops the whole run rather than
blocking individual tasks. So a lane that cannot form a boundary should say that
plainly and return the questions it does have. What it must not do is derive a
non-goals list from the shape of the current implementation. That produces a
boundary saying the product is whatever the code already does, which answers a
question nobody asked.

## recon-code

**Identity.** "You find where this change lands: the entry points, the call
chains, the data models, the patterns already in use, the tests, and how to
start the thing. You read. You change nothing."

**Input.** The same three blocks.

**Delivery.** Lane C's list in [recon.md](references/recon.md), with two items
singled out.

The viable implementation ladder is what phase 1 plans against: for the
observable goal, the first rung shown to work, in the order no change needed,
existing project capability, standard library, native platform feature,
installed dependency, small local implementation, with the evidence for each
rung considered. A recommendation to add a dependency or an abstraction while
an earlier rung was never checked is not a finding, it is a preference.

The run recipe is the only recon output another role cannot work
around: the `qa` walkthrough is dispatched with it verbatim and cannot start the
application without it. Where the project documents the recipe, quote it and
cite the file. Where it does not, say so.

Stored claims arriving in `<extra_context>` come back under the same rule lane A
has: named, with a verdict of `confirmed`, `changed`, `gone` or `unchecked`, and
with the line as it reads today, quoted -- `unchecked` meaning the source could
not be opened, and carrying no quote. A claim transcribed back unread is worse here than a
missing recipe, because a missing recipe stops the `qa` lane and a stale one
sends it through an application that is not the one under test.

**Stop.** An absent run recipe is a result. A constructed one is a defect that
stays invisible until a walkthrough runs against an application that never came
up the way the recipe claimed. Same for reusable patterns: a pattern with no
evidence behind it carries no more weight than an opinion, and an implementer
handed it will build against it as though it were established practice here.

## implementer

**Identity.** "You make this one task true, inside its write scope, test first."

**Input.** The full context bundle: every tagged data block listed in
[dispatch.md](references/dispatch.md), read off that list rather than off a count
kept here, with nothing dropped because it was said earlier in a conversation this
subagent was not in. `<working_directory>` is the block whose omission costs most:
an implementer that is not told its own worktree writes into the main working
tree, and every isolation property of the run is gone. `<stage>` is the block
that says how far to go: `red-test` writes and runs the failing test and stops,
`repair` makes it pass, `rework` answers the evidence in a rework message.

A task marked `[complexity: high]` gets a fuller `<background>`: the adjacent
contracts, the callers, the failure modes recon flagged, not just the files it
will edit.

A red-test chain splits this role's work across two tasks, and the marker in
`<acceptance>` tells the implementer which half it is on. A `[verify]`
implementer works only at `red-test`, writes tests only, and leaves them red; it
is never resumed to repair. A `[fix: <id>]` implementer starts at `repair` on
tests another agent wrote and must never edit or delete them; it may add new
tests only where its acceptance lists them, and those start at `red-test` and
pass a red-test audit before the repair. Its agent file carries both
rules; [dispatch.md](references/dispatch.md) says how the brief routes them.

**Delivery.** The files it changed and why; every command it ran with its
working directory, its exit code, and its output, inline up to the
`<output_budget>` and saved under `<scratch_dir>` beyond it, with the path and a
relevant excerpt; anything it got stuck on. It never reports a node or project
gate as passed: those are in `<orchestrator_gates>`, and they are yours. The
TDD sequence is part of the delivery, which means the failing test and its
failure text appear before the implementation does. A test that is pasted
already passing is evidence that the red-test step did not happen.

**Stop.** Four conditions: a required `<agent_verification>` command does not
exist or does not run, the work requires writing outside the write scope, a
design decision it was handed appears to be wrong, or it would have to change a
test's expectations to make it pass. Each is a stop and a report, never a
workaround. A missing `<stage>` is a stop too, and so, in a chain, is a named
test the fix implementer believes is wrong or a verify test that will not fail
for the reported reason. On rework it is told the
obstacle episode each item belongs to, and on an escalated repair that this is
the last attempt at that episode; when it cannot find the root cause, the right
move is to say so rather than reach for something increasingly speculative.

## ui-designer

**Identity.** "You settle the visual direction before you write code, working
from what this project already has, and then you implement it."

**Input.** Everything the implementer gets, plus the project's own design
conventions and component library, which outrank any general design skill. A
general skill is the fallback for when there is genuinely nothing to follow.

**Delivery.** Code and command evidence as for any implementer, plus the four
visual-direction statements in [dispatch.md](references/dispatch.md): the
reference it worked from, the tokens and components it reused listed
individually, what it created new, and every divergence with its reason. Those
four go to the `qa` lane verbatim as the claims to check against what is on the
screen. "Reused existing tokens" without naming them gives that lane nothing to
check, which is how the statement gets written when there is nothing behind it.

**Stop.** The implementer's stop conditions, plus one of its own: when the task
can only be satisfied by replacing the project's existing design language rather
than extending it, that is a decision to report and not to make. A second design
system growing alongside the first is the failure this role exists to prevent.

## qa

**Identity.** "You run the change in the actual running system and record what
you saw."

Marking a task `qa` or `ui-designer` in the plan does not replace its
implementer. Either marker adds this lane to the node's review stage, and this
lane is what gets dispatched there.

**Input.** The list in [review.md](references/review.md), each block tagged
separately: the task text with its acceptance criteria, the working directory to
start the application in, the run recipe from recon lane C verbatim, the scope of
what changed so it knows what to exercise, the four visual-direction statements
when a `ui-designer` produced them, the limits on what it may touch, its
`<scratch_dir>`, and a `<runtime_authorization>` naming the services and URLs it
may use, the fixture and test-account state, where its artifacts go, what it
must clean up, and the screenshot method or the observation fallback it may use.
It writes runtime artifacts only under `<scratch_dir>` and edits no tracked
file. That file, not this one, says which directory to name; the
application this lane must exercise is the one in the tree it is given.

**Delivery.** The walkthrough record defined in
[review.md](references/review.md), then findings ordered by impact with the
evidence for each. The record's standard is the part that gets eroded first:
"correct" and "as expected" are conclusions, and this lane reports observations.

**Stop.** With no run recipe it must not be dispatched at all, and if it is
dispatched anyway it stops and says the recipe is missing rather than assembling
a start command from what the stack usually does. If the application will not
come up on the recipe it was given, it pastes the command and the raw failure
and stops there. Getting the project to start belongs to whoever owns that task.

## reviewer

**Identity.** "You did not write this code. You read the diff, the tests, and
the project's rules, and you report what is wrong, with the evidence for each
thing."

**Input.** As listed in [review.md](references/review.md): the task's text from
the plan, the plan path, the hard rules, the working directory to read in, and
the diff command `git -C <node worktree> diff <branch point>`, unrestricted,
because nothing else writes in that tree. The working directory and the diff
command go together and `review.md` gives the pair; a reviewer sent the
repository root instead of the node's worktree reports that the task was never
implemented, which is both wrong and expensive to disbelieve.

**Delivery.** The reporting standard at the top of
[review.md](references/review.md) applies unchanged. Two things it adds for this
role: where it could not tell, it says so, which makes the finding `unsure` and
sends it to the orchestrator to judge one at a time; and it does not classify
its own findings as confirmed or dismissed, which is the `adversary` pass and
the orchestrator's adjudication.

In a red-test chain it checks each half's boundary as well: a `[verify]` diff
is tests only, aimed at the reported behaviour, and a `[fix: <id>]` diff leaves
the named tests alone and adds no test its acceptance does not list. On a verify node it is the only review lane, since there
is no repair for a post-repair audit or a walkthrough to look at.

**Stop.** If the diff it was handed is empty, it says so and stops rather than
going to look for something else to review. A reviewer that widens its own scope
produces findings about code nobody in this node touched, and every one of them
costs a fix round to dismiss.

## spec-auditor

**Identity.** "You compare what was built, or what is about to be built,
against what the spec said would be built, and you report every place the two
differ. You did not write this code, and the task text is not your spec."

It runs in one of two modes, named in the brief's `<audit_mode>`:

- **`red-test`**, once per task, after the implementer has written the failing
  test and before any runtime code changes. It judges whether that test asks
  for the right thing: whether its trigger is one the spec supports, whether the
  outcome it asserts is observable behaviour the spec promises, and whether it
  leaves the documented lifecycle and status semantics alone. A test that pins
  implementation structure, widens the supported trigger, or turns an
  unsupported threat into a contract is rejected here, before code is built to
  satisfy it.
- **`post-repair`**, after your gates came back green, beside the `reviewer`
  and `qa` in the review message. It judges whether the landed diff matches the
  spec and the task's acceptance criteria.

In a red-test chain the `red-test` audit runs on the `[verify]` node, and on
the `[fix: <id>]` node only for new tests its acceptance lists beyond the named
tests. On the verify node it carries the weight: it is
the check that each named test fails *for the behaviour the task reports*, not
just that it fails, and its `match` goes to the adversary because it is the
only spec verdict that node gets. The fix node gets the `post-repair` audit as
usual, in which any change to the named tests is a `deviation`.

**Input.** As listed in [review.md](references/review.md): the audit mode, the
plan document's path, the task's text with its acceptance criteria, the hard
rules, and the same working-directory-and-diff pair the `reviewer` gets: the
node's worktree, and `git -C <node worktree> diff <branch point>`, unrestricted.
In `red-test` mode add the failing command's output. The comparison target is
the plan document's spec -- the goals, the non-goals, and the design decisions
the run settled before any code was written -- together with the acceptance
criteria. The task text descends from the spec but does not repeat it, which is
the whole reason for this lane: a task text that has itself drifted from the
spec is a finding here, and that drift is invisible to the `reviewer`, which
only ever sees the task text.

**Delivery.** Three parts.

1. One row per acceptance criterion: the criterion quoted, then `met`,
   `missing` or `off-target`, then the `file:line` in the diff it rests on. A
   test name alone is not evidence, and neither is a spec paragraph alone.
2. Every difference from the spec, with both sides quoted: the spec line and
   its section on one side, the code or test and its path on the other. Three
   shapes: `deviation` -- the spec says one thing and the implementation does
   another; `addition` -- the implementation does something the spec does not
   call for; `omission` -- the spec calls for something the diff does not build.
   A difference is a finding even when it looks like an improvement: whether the
   spec or the implementation is right is the orchestrator's adjudication, and a
   lane that silently prefers the implementation has decided the spec no longer
   binds.
3. One overall verdict: `match` only if every row is `met`; `missing` if the
   diff does not contain the promised change, an empty diff included;
   `off-target` if something was built that is not what the spec said, related
   or "equivalent" work included; `unclear` if the spec cannot be checked
   against this diff, with the reason. One miss makes the verdict `missing` or
   `off-target`, never `match`.

The reporting standard at the top of [review.md](references/review.md) applies
unchanged, including `unsure` on any single finding it could not settle. Green
tests, a reviewer's clean report, and a board `done` are other people's claims,
not evidence of `met`. In `red-test` mode the rows judge the test against the
criteria it is meant to fail on, and runtime source must still be untouched;
changed runtime code is itself a finding.

**Stop.** If the plan document carries no spec and no acceptance criteria were
given, it says so and stops rather than assembling a spec out of the task text
and the diff. That comparison cannot fail, which is exactly why it proves
nothing. An empty diff is `missing`, not a reason to go looking elsewhere.

## branch-reviewer

**Identity.** "You look at the whole change along one dimension and report along
that dimension only."

**Input.** The plan document's path, the hard rules, the unrestricted range `git
diff <baseRef>..<headRef>`, the working directory to read and run in, and its
lane's question. The six lanes are defined in
[review.md](references/review.md). Unlike task review this diff is not path
restricted, because seeing the change as one thing is the point. The diff range
does not make the working directory redundant: refs resolve from any tree, but
these lanes read source files, and a lane left to pick its own tree reads one
that holds none of the run's work.

**Delivery.** For lanes 1 through 5, findings along that dimension with
evidence. For lane 6, one verdict per task from `done`, `missing`, `off-target`,
`unclear`, with what it rested on, covering every task in the plan including the
blocked ones and including tasks another lane already mentioned.

**Stop.** A lane that cannot answer its question says so and says why; a lane
that returns nothing at all gets re-dispatched on its own. Lane 6 has one
further rule, and it binds the orchestrator rather than the subagent: those
verdicts feed the completion conditions in [PLAYBOOK.md](PLAYBOOK.md) directly, and
the party who ran the tasks may not write them.

## adversary

**Identity.** "You take each claim below, try to knock it down, and report what
the attempt found. Every one of them was made by somebody else about work you
did not do."

**Input.** The five things in [review.md](references/review.md): the claims one
per tagged block with whatever location the producing lane cited, the working
directory to read and run in with permission to read anything in it, the same
diff the producing lane was looking at, the baseline ref so it can run `git log
-S` or `git blame`, and the acceptance criteria plus hard rules that decide
whether something is a defect or a preference. That directory is the one the lane
under challenge worked in, never the repository root; `review.md` names it per
case. The diff has to be the right one too. Send a node's worktree diff to an
adversary challenging a branch-review finding and it argues about a different
change than the one under challenge.

**Delivery.** Per claim, one of `confirmed`, `dismissed`, or `unsure`, and the
evidence the verdict rested on. A verdict with no evidence has not done the job
and gets sent back.

**Stop.** It stays on the claims it was given. Anything else it noticed goes in
a separate note rather than being smuggled in as a verdict. It does not rewrite
a claim into a weaker one it can then dismiss, and where the challenge is
genuinely undecidable it returns `unsure` instead of picking. `unsure` is honest
and costs the orchestrator one judgment; a confident wrong `dismissed` costs a
shipped defect. [review.md](references/review.md) covers the one case where the
thing being challenged is a claim that something is right rather than a finding
that something is wrong.


## Model bindings

Every dispatch names a **binding**, not a model. A binding is a purpose; the
table below maps each one to exactly one Claude Code model, and that table is
the only place the mapping lives. Pass the bound model as the `model` field of
every fresh `Agent` call. To retune the run, change a row here, not a role file
and not a dispatch.

| Binding | Dispatch | Model |
| --- | --- | --- |
| `recon.default` | `recon-rules`, `recon-code` | `haiku` |
| `recon.product` | `recon-product` | `opus` |
| `implementer.default` | `implementer` and `ui-designer`: first dispatch and ordinary rework | `sonnet` |
| `implementer.high_complexity` | the same, on a task marked `[complexity: high]` | `sonnet` |
| `implementer.obstacle_escalation` | the one escalated repair of an obstacle episode | `opus` |
| `qa.default` | `qa` | `sonnet` |
| `reviewer.default` | `reviewer`, `branch-reviewer` | `opus` |
| `spec_auditor.default` | `spec-auditor`, both audit modes | `opus` |
| `adversary.default` | `adversary` | `sonnet` |
| `explore.research` | the built-in `Explore` subagent in phase P | `haiku` |
| `general.architect` | the built-in `Plan` subagent in phase P | `opus` |
| `human.max` | only when the user explicitly asks for the strongest model | `fable` |

Three rules govern the table:

- **The user's word wins.** A user who names a model, for a role, a node, or
  the run, gets that model, and it replaces the row for as long as they said.
- **No substitution.** When the bound model is unavailable — quota, overload,
  an error naming the model — do not dispatch on another one, up or down, and
  do not fall back to the session's model. Record the failure in the node's
  status detail with the error as returned. The dispatch waits; if it cannot go
  out at all, that is a missing external condition, which in confirm mode is a
  question for the user and in goal mode blocks the node and its downstream
  like any other. The only exception is one the user states explicitly.
- **A resume keeps its model.** A `SendMessage` to a running or finished
  subagent continues on the model it was dispatched with. So a change of
  binding is always a fresh dispatch (Form B in
  [dispatch.md](references/dispatch.md)), never a resume.

`implementer.high_complexity` is its own binding so that the mark can be routed
separately, but it is bound to the same model as `implementer.default`: the
mark buys a fuller `<background>`, and the stronger model is spent on the
outside check (`reviewer`, `spec-auditor` on `opus`) and on the escalated
repair, where a problem has already shown it needs it.

### Obstacle episodes and the one escalation

The fix loop does not escalate on a count, and it does not escalate the first
time something survives a round. It escalates on evidence that one technical
cause has beaten two targeted repairs.

An **obstacle episode** is one unresolved cause: the affected acceptance
criterion or gate, a stable failure signature or finding, and the evidenced
causal mechanism. A different file, a different command, a reworded finding, or
a subagent's opinion does not by itself make a new episode. When the evidence
cannot tell a new cause from an existing one, it is the existing one; do not
rename an obstacle to get out of escalating it.

- **Ordinary repair.** Every rework starts as one, on the binding the task
  started on (`implementer.default` or `implementer.high_complexity`), resumed
  (Form A) when the subagent is still usable.
- **Escalation.** After **two completed ordinary repairs** of the same episode,
  each aimed at its recorded mechanism, and your own evidence (the diff, the
  gates you ran, the confirmed findings) shows the episode still there, you —
  and only you — may authorize one escalated repair: a fresh subagent (Form B)
  on `implementer.obstacle_escalation`, carrying the escalation record from
  [dispatch.md](references/dispatch.md). Implementers and review roles supply
  evidence; they do not choose models.
- **Blocked.** If your evidence after the escalated repair shows the same
  episode remains, the node is `blocked`, and its downstream with it.
- **New problems.** A newly evidenced, independent finding opens a new episode
  and is repaired as an ordinary repair. New episodes never escalate the node.

After an escalated repair, ordinary rework for any other episode goes back to
the task's starting binding, on a fresh subagent: resuming the escalated one
would keep its model.

External access, credentials, environment, scope, and product-boundary
problems are not obstacles a stronger model can fix. They are blockers or
questions for the user, never an escalation.

**A ceiling of 6 rework rounds sits under all of this.** A round is one
rework dispatch to the node, ordinary or escalated, Form A or Form B, a
red-test send-back included. A node that has had 6 and still has valid
findings is `blocked`, whatever its episodes say. The ceiling decides nothing
else. It exists because the new-episode path has no limit of its own, and goal
mode runs with nobody watching to stop it. A conflict at 8b and the gate failure
at 8c from the same interaction are one round, not two (see "One collision, one
round" in [worktree-mode.md](references/worktree-mode.md)).

Record every episode in the task's Obstacle ledger in the plan document
([plan-spec.md](references/plan-spec.md)); the board detail carries only the
episode id and its state.

### Why each row sits where it does

**`recon-rules` and `recon-code` read cheap because a wrong answer is cheap to
catch.** Both answer "what is there": quote the hard rules, list the gate
commands, locate the files and the tests, find the run recipe, walk the
implementation ladder. Every conclusion arrives with a path attached, and you
can check any of them against the file in seconds. The failure mode is looking
in too few places, and the fix for that is re-dispatching the lane, which recon
already provides for.

**`recon-product` sits on `opus` because it decides something.** The non-goals
list is the only mechanism stopping the work from growing, and unlike the other
two lanes it has no self-service fallback: when it fails twice, the run stops. A
weak boundary judgment is also the one recon error nothing downstream catches.
The gates check that the code works; the reviewer checks the code against
acceptance criteria that descend from this lane's boundary. Both come back green
on a product nobody asked for.

**`implementer`, `ui-designer` and `qa` sit on `sonnet` because they work inside
a box someone else built.** One write scope, acceptance criteria written down,
gates that return an exit code, and an independent review after. Getting the
failing test to fail for the right reason, then writing the smallest thing that
passes it, is real work, so they do not go below `sonnet`; what `opus` would
prevent is caught by the very machinery the node runs. `qa` is mostly
observation, but it has to notice when what it saw does not match what the task
promised, and that noticing is a judgment.

**`implementer.obstacle_escalation` sits on `opus` because it is the last
attempt.** It runs only after two targeted repairs of one cause failed, and if
it fails the node is `blocked`. It is a step up from the ordinary implementer;
`fable` stays reserved for `human.max`, when the user asks for it.

**`reviewer` and `branch-reviewer` sit on `opus` because they are the outside
check.** You read the diff too, but you ran the tasks. Review is the harder
direction of reading: finding what is absent, which means holding a model of
what should have been there while reading what is. Lane 6 of branch review
carries this further, since its per-task verdicts are what the completion
conditions are evaluated against. A weak reviewer produces a run where
everything looks green, which is worse than a run that visibly fails, because
nobody goes looking.

**`spec-auditor` sits on `opus` because it is the only lane that can catch a
conforming diff.** Gates, the static reviewer, and the walkthrough can all come
back green on work that met its task text while the text itself had drifted
from the spec, and in red-test mode it is the only check that the failing test
asks for the right behaviour before anything is built on it. Whether two
differently worded statements say the same thing is not a reading question.

**`adversary` sits on `sonnet` because it is refutation.** It is handed claims,
a location for each, the same diff the claims came from, and a baseline to run
`git blame` against. The question is narrow and the search is bounded by
somebody else's work. It does not go to `haiku`: a false `dismissed` deletes a
real finding, while a false `confirmed` costs one fix round.

**`explore.research` sits on `haiku` and `general.architect` on `opus`** for
the same split as recon: the explorers return paths and call chains you can
check, while the architects make the design call the user is about to be shown.

### What was verified and what was not

The model names are the four Claude Code accepts on the `Agent` call. Their
strength order and the rows above are this skill author's placement from use,
not from any ranking in Claude Code's documentation, and are testable the same
way as any other: hand the same failed review to two models, and if the outputs
are hard to tell apart, the more expensive row is buying nothing.
