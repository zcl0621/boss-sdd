# Roles

Nine roles. Every subagent this skill dispatches is one of them, and a role is
four commitments plus a model tier: an identity line that opens its prompt, what
it must be given, what it returns, and when it stops and says it is stuck.

Build the prompt itself from [the dispatch contract](references/dispatch.md).
This file supplies the identity line and the role-specific half of the input,
delivery, and stop sections. It does not repeat the procedures those roles carry
out: the three recon lanes and their run recipe are in
[recon.md](references/recon.md), and the review lanes, the walkthrough standard,
the six branch-review lanes, and the verdict vocabulary are in
[review.md](references/review.md).

One subagent, one role, one task. No role dispatches another. Everything below
returns to the orchestrator, who decides what happens next. Do not write a
dispatch prompt that depends on the subagent fanning out further; whether it can
is a platform question this file does not answer, and a prompt that needs it is
not portable.

## What each entry gives

**Identity**, **input**, **delivery**, **stop**. Model tiers are in the last
section.

Each identity string below is written as the continuation of the opening
sentence in [dispatch.md](references/dispatch.md), so it does not say "you are"
again. That sentence itself belongs to `dispatch.md`, including the four
work-item forms and which roles take which; compose it from there, not from
anything here.

What "input" covers is not the same for every role, so read it per entry rather
than assuming a common bundle. `implementer` and `ui-designer` are the only two
that receive the full context bundle, whose blocks are listed in
[dispatch.md](references/dispatch.md). The three recon lanes receive the three
blocks in [recon.md](references/recon.md) and nothing else. The review roles
receive the short per-lane lists in [review.md](references/review.md). Hand a
read-only lane a `<write_scope>` and a TDD block and you have given it
instructions that contradict the file defining it.

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
runnable commands, the test concurrency answer with its evidence, the
working-tree changes that belong to the user, and the unknowns. Deliver the
unknowns as findings with the same weight as the rest. Downstream, `hardRules`
gets pasted into every dispatch and every review prompt, and the concurrency
answer decides how large a batch can be.

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

**Delivery.** Lane C's list in [recon.md](references/recon.md), with one item
singled out. The run recipe is the only recon output another role cannot work
around: the `qa` walkthrough is dispatched with it verbatim and cannot start the
application without it. Where the project documents the recipe, quote it and
cite the file. Where it does not, say so.

**Stop.** An absent run recipe is a result. A constructed one is a defect that
stays invisible until a walkthrough runs against an application that never came
up the way the recipe claimed. Same for reusable patterns: a pattern with no
evidence behind it carries no more weight than an opinion, and an implementer
handed it will build against it as though it were established practice here.

## implementer

**Identity.** "You make this one task true, inside its write scope, test first."

**Input.** The full context bundle: every tagged block listed in
[dispatch.md](references/dispatch.md), read off that list rather than off a count
kept here, with nothing dropped because it was said earlier in a conversation this
subagent was not in. `<working_directory>` is the block whose omission costs most.
In worktree mode an implementer that is not told its own worktree writes into the
main working tree, and every isolation property of that mode is gone.

A task marked `[complexity: high]` gets a fuller `<background>`: the adjacent
contracts, the callers, the failure modes recon flagged, not just the files it
will edit.

**Delivery.** Its `<output_contract>`: the files it changed and why, every
command it ran with the raw output pasted in full including the failures, and
anything it got stuck on. The TDD sequence in
[dispatch.md](references/dispatch.md) is part of the delivery, which means the
failing test and its failure text appear in the output before the implementation
does. A test that is pasted already passing is evidence that step 1 did not
happen.

**Stop.** The four conditions in `<stop_conditions>`: the acceptance commands do
not exist or do not run, the work requires writing outside the write scope, a
design decision it was handed appears to be wrong, or it would have to change a
test's expectations to make it pass. Each is a stop and a report, never a
workaround. It is told which round of three it is on; on round 3 the right move
when it is stuck is to say so, because there is no round 4 to recover a
speculative attempt in.

## ui-designer

**Identity.** "You settle the visual direction before you write code, working
from what this project already has, and then you implement it."

**Input.** Everything the implementer gets, plus the project's own design
conventions and component library, which outrank any general design skill. A
general skill is the fallback for when there is genuinely nothing to follow.

**Delivery.** Code and raw command output as for any implementer, plus the four
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
separately: the task text with its acceptance criteria, the run recipe from
recon lane C verbatim, the scope of what changed so it knows what to exercise,
the four visual-direction statements when a `ui-designer` produced them, and the
limits on what it may touch.

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
the plan, the plan path, the hard rules, and the diff command `git diff
<baseline> -- <scope paths>` with the scope paths always present. Omit them
while a batch is running and this reviewer reports on code three other nodes are
writing at that moment.

**Delivery.** The reporting standard at the top of
[review.md](references/review.md) applies unchanged. Two things it adds for this
role: where it could not tell, it says so, which makes the finding `unsure` and
sends it to the orchestrator to judge one at a time; and it does not classify
its own findings as confirmed or dismissed, which is the `adversary` pass and
the orchestrator's adjudication.

**Stop.** If the diff it was handed is empty, it says so and stops rather than
going to look for something else to review. A reviewer that widens its own scope
produces findings about code nobody in this node touched, and every one of them
costs a fix round to dismiss.

## branch-reviewer

**Identity.** "You look at the whole change along one dimension and report along
that dimension only."

**Input.** The plan document's path, the hard rules, the unrestricted range `git
diff <baseRef>..<headRef>`, and its lane's question. The six lanes are defined
in [review.md](references/review.md). Unlike task review this diff is not path
restricted, because seeing the change as one thing is the point.

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
per tagged block with whatever location the producing lane cited, the repository
path with permission to read anything in it, the same diff the producing lane
was looking at, the baseline ref so it can run `git log -S` or `git blame`, and
the acceptance criteria plus hard rules that decide whether something is a
defect or a preference. The diff has to be the right one. Send task review's
scoped diff to an adversary challenging a branch-review finding and it argues
about a different change than the one under challenge.

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

## Model tiers

Four rungs, strongest first. This ladder is what "step down one tier" in
[PLAYBOOK.md](PLAYBOOK.md) counts along.

1. **reserve** - escalation only.
2. **strong** - the strongest tier routine work may start on.
3. **reasoning** - the middle, and the floor for any role that forms a judgment.
4. **reading** - the cheapest, for reading and reporting rather than deciding.

"The reasoning tier" means rung 3.

**The reserve is a reserve, not a default.** Left unsaid, an agent reads
`[complexity: high]` and routes straight to the most expensive model available,
which spends the reserve on the first hard task of the run and leaves nothing
for the node that has already burned two fix rounds. High complexity starts on
**strong**. You escalate to **reserve** for a specific node that strong has
demonstrably failed on: the same finding surviving a second round, a defect
nobody can locate, a node the run cannot close without. Escalation is an event
with a reason you can name. Without one, what you are doing is defaulting.

### The identifiers per platform

**Claude Code.** Four model names, `fable`, `opus`, `sonnet`, `haiku`, which map
one to one onto the four rungs in that order. The order is from use rather than
from any ranking in the verified table; see the honesty note at the end of this
section.

**Codex.** One model, `gpt-5.6`. Roles are declared under `[agents.<name>]` in
`config.toml`, and that table accepts **exactly two keys**: `config_file`, "Path
to a TOML config layer for that role", and `description`. Nothing else goes in
it.

**In particular the model and effort settings do not.**
`agents.default_subagent_model` and `agents.default_subagent_reasoning_effort`
are global keys, two of the six under `agents.`, and a global key sets one value
for every role at once. So per-role tiering cannot be written where the role is
declared. It lives inside the TOML layer `config_file` points at, one layer file
per role, which is what that key is for. Write
`default_subagent_reasoning_effort` under `[agents.<name>]` and you have written
a key that table does not accept, in the one place a reader most expects it to
work.

The effort values are `minimal`, `low`, `medium`, `high` and `xhigh`, with
`xhigh` model-dependent, so whether your model offers the top one is a thing to
check rather than assume. Those are the tokens; what the verified facts do not
record is what the model and effort settings are called *inside* a layer file,
so take those key names from your own configuration reference and do not assume
they repeat the global spelling.

A separate `review_model` configures Codex's own native reviewer, which is a
different thing from the roles here; see
[native-review-handoff.md](references/native-review-handoff.md).

**Cursor.** Model IDs `inherit`, `composer-2`, `composer-2.5`, `gpt-5.6-sol`,
`claude-opus-5`, with bracket parameters `fast`, `effort`, and `context`, as in
`claude-opus-5[effort=high,context=300k]`. Use `inherit` where a role should
take the session's model. Roles live in `.cursor/agents/<name>.md` with
frontmatter `name`, `description`, `model`, `readonly`, `is_background`. The
three recon lanes, `reviewer`, `branch-reviewer`, and `adversary` all want
`readonly: true`; that flag enforces at the platform level the thing their
prompts only ask for.

### Which axis carries the rung

A rung is an abstraction, and each platform gives you a different knob to
realise it with. That choice is as much a part of the mapping as the role
routing is, and it is the part you will re-tune first.

**Claude Code: the model name.** Four names for four rungs, nothing to decide.

**Codex: reasoning effort.** The verified source names exactly one Codex model,
so the model has nothing to vary and the rung has to ride on reasoning effort.
If your installation offers more than one model, invert that: make the model the
coarse axis, since a model change moves capability further than an effort
change, and use effort to separate rungs inside one model. The recommendation
here is effort, because that is what the verified facts support. Either way the
per-role value goes in the layer file `config_file` names, for the reason above:
both `agents.` settings are global and cannot be narrowed to one role.

**Cursor: the model ID for the routine rungs, a bracket parameter for the step
into reserve.** Three distinct IDs cover the three routine rungs, `composer-2`
for reading, `composer-2.5` for reasoning, `claude-opus-5` for strong. The
documentation lists two more that this table does not route. `inherit` takes the
session's model, which gives every role the same rung and defeats the point of
routing them separately, so it belongs on a role you have deliberately decided
not to tier. `gpt-5.6-sol` is a second candidate for the reasoning rung, and
since Cursor's documentation ranks none of these IDs, choosing between it and
`composer-2.5` is exactly the kind of call the test below is for. The reserve
row is `claude-opus-5[effort=high]` because Cursor's strongest listed model is
already carrying the strong rung, so the only escalation left is a parameter on
it. That makes the reserve step on Cursor weaker than the same step on Claude
Code, which is a real property of the platform and not something the table can
paper over.

A test for whether your mapping is doing anything: hand the same failed review
to two adjacent rungs. If the two outputs are hard to tell apart, those rungs
have collapsed for you and you should merge them and say your ladder has three
steps, not keep a fourth that changes nothing.

### The routing

| Role | Tier | Claude Code | Codex (`gpt-5.6` effort) | Cursor |
| --- | --- | --- | --- | --- |
| `recon-rules` | reading | `haiku` | `minimal` | `composer-2` |
| `recon-code` | reading | `haiku` | `minimal` | `composer-2` |
| `recon-product` | strong | `opus` | `high` | `claude-opus-5` |
| `implementer` | reasoning | `sonnet` | `medium` | `composer-2.5` |
| `ui-designer` | reasoning | `sonnet` | `medium` | `composer-2.5` |
| `implementer` or `ui-designer`, `[complexity: high]` | strong | `opus` | `high` | `claude-opus-5` |
| `qa` | reasoning | `sonnet` | `medium` | `composer-2.5` |
| `reviewer` | strong | `opus` | `high` | `claude-opus-5` |
| `branch-reviewer` | strong | `opus` | `high` | `claude-opus-5` |
| `adversary` | reasoning | `sonnet` | `medium` | `composer-2.5` |
| escalation reserve | reserve | `fable` | `xhigh` | `claude-opus-5[effort=high]` |

`PLAYBOOK.md` sets the choosing rule, risk and difficulty rather than cost, and
gives the user's own choice of model the final say. What follows is why each row
sits where it does, which is what you need in order to move one.

There is no `[complexity: high]` variant row for `qa`. The mark changes what the
implementing role has to hold in its head; it does not change what a walkthrough
does, which is start the application, exercise the flows, and write down what
appeared. `reviewer` has no variant row either, for the opposite reason: it is
already on strong for every task.

**`recon-rules` and `recon-code` read cheap because a wrong answer is cheap to
catch.** Both answer "what is there": quote the hard rules, list the gate
commands, locate the files and the tests, find the run recipe. Every conclusion
arrives with a path attached, and the orchestrator can check any of them against
the file in seconds. Nothing is being weighed. Spending a strong model here buys
judgment for a job where the only failure mode is looking in too few places, and
the fix for that is re-dispatching the lane, which recon already provides for.

**`recon-product` is the exception among the recon lanes, and it sits on
strong.** It decides something. The non-goals list is the only mechanism
stopping the work from growing, and unlike the other two it has no self-service
fallback: when it fails twice, the run stops. A weak boundary judgment is also
the one recon error nothing downstream catches. The gates check that the code
works; the reviewer checks the code against acceptance criteria that descend
from this lane's boundary. Both come back green on a product nobody asked for.

**`implementer`, `ui-designer` and `qa` sit on reasoning because they work
inside a box someone else built.** One write scope, acceptance criteria written
down, gates that return an exit code, and an independent review after. The
cheapest rung does not cover it: getting the failing test to fail for the right
reason, then writing the smallest thing that passes it, is real work, and the
shortcut is a test written against the implementation. The strong rung buys
little, because what it would prevent is caught by the very machinery this node
runs. `qa` is mostly observation, but it has to notice when what it saw does not
match what the task promised, and that noticing is a judgment, which is why the
floor rule below covers it.

**`implementer` and `ui-designer` move to strong on a `[complexity: high]`
task.** `PLAYBOOK.md` says to put that mark on cross-system or high-risk work, and
leaves what counts to the planner. My reason for spending the stronger tier
there is narrower than the mark itself: the work that earns it is the work whose
mistakes the node's own gates cannot see. A rounding error passes every test
written by the agent that got the rounding wrong. A missing authorization check
has no failing test at all, because the suite asserts presences and this defect
is an absence. Where the gate can catch the error, the reasoning rung plus a fix
round is cheaper than the stronger model; where it cannot, the model is the only
thing standing there.

**`reviewer` and `branch-reviewer` sit on strong because they are the outside
check.** The orchestrator reads the diff too, but the orchestrator ran the
tasks. Review is the harder direction of reading: finding what is absent, which
means holding a model of what should have been there while reading what is. Lane
6 of branch review carries this further, since its per-task verdicts are what
the completion conditions are evaluated against. A weak reviewer produces a run
where everything looks green, and that is a worse outcome than a run that
visibly fails, because nobody goes looking.

**`adversary` sits on reasoning because it is refutation.** It is handed one
claim, a location, the same diff the claim came from, and a baseline to run `git
blame` against. The question is narrow and the search is bounded by somebody
else's work, and the middle rung handles that. It does not drop to the reading
rung: a false `dismissed` deletes a real finding, while a false `confirmed`
costs one fix round, and that asymmetry is what keeps it above the floor.

### Stepping down, and the floor

When a role's tier is unavailable because of quota or overload, step down one
rung on the ladder above and record in the node's status detail which role ran
on which tier. That record matters later: a node that failed with a reviewer one
rung down is a different result from one that failed with the reviewer it was
supposed to have.

**The judgment roles stop at reasoning.** They are `recon-product`, `qa`,
`reviewer`, `branch-reviewer`, and `adversary`. None of them lands on the
**reading** rung, and if reasoning is not available either, the node waits
rather than running with a check that cannot perform the check. The reason is
the same one that keeps `adversary` off the cheapest rung: a review too weak to
find the problem returns the same shape of output as a review that found
nothing, and nothing downstream can tell the two apart. `qa` belongs on this
list because its walkthrough is the only look anything gets at the running
system, and it is on the reasoning rung for the judgment it makes when what it
saw does not match what was promised.

Three of those five, `qa`, `adversary`, and `recon-product` once it has already
stepped down, are on the floor as their routine tier, so they have no step
available at all. Unavailable means the node waits.

**The bottom rung has no step down, so it steps up.** A `reading`-tier role
whose tier is unavailable goes to **reasoning** instead of waiting. That costs
more and risks nothing, since a recon lane run on a stronger model returns the
same paths and quotations. Waiting there would be worse than paying, because
lanes A and C block phase 1 entirely.

**Two rungs collapse on two of the three platforms, and pretending otherwise
helps nobody.** On Cursor, reserve is `claude-opus-5[effort=high]` and strong is
`claude-opus-5`, the same model with a parameter, so the escalation step is a
parameter change and a step down from reserve barely moves. On Codex, reserve is
`xhigh` and strong is `high`, one real step apart while your model offers
`xhigh` and the same token when it does not, since `xhigh` is model-dependent.
Check that before you plan on it, and where it is absent say the ladder has
three rungs rather than keeping a reserve that changes nothing. Read the ladder
as four rungs on Claude Code and as three distinct steps plus a parameter on the
other two, and do not plan an escalation you cannot actually perform.

### What was verified and what was not

The Claude Code column reflects actual use. The model names and the strength
order in it are what this skill's author runs against. The verified platform
table lists those four names without ranking them, so treat the order as the
author's, testable the same way as any other rung mapping.

The Codex and Cursor columns do not reflect use. They were read out of those
platforms' official documentation on 2026-09-18 and were never executed, because
the author of this repository has neither installed. Check them against the
pages they came from, `developers.openai.com/codex/config-reference` for the
`[agents.<name>]` keys and the effort setting, and `cursor.com/docs/subagents`
for the model IDs, the bracket parameters, and the frontmatter fields, and
against the version you actually have, since both platforms move. Nothing in
those two columns has been run here.

Expect to adjust two things in particular:

- **Which models your subscription offers.** Both platforms gate model access by
  plan, so a row may name something you cannot select.
- **The ordering inside those two columns.** Codex's five effort values are
  documented, `minimal` through `xhigh`, so the Codex cells are tokens you can
  paste rather than positions to resolve. What is not documented is which rung
  each one belongs to. Four rungs onto five tokens is a placement, and this one
  leaves `low` spare, between the reading rung and the reasoning rung: move the
  reading lanes up to it if they come back thin on `minimal`. Cursor's
  documentation lists its model IDs without ranking them; the order they appear
  in above is a placement too, and your own experience of those models should
  override both.

If you need a platform fact that is not here, go to that platform's own
configuration reference. Do not carry a value across from another column, and do
not treat a confident-sounding value from memory as a substitute. These two
columns are exactly where a wrong answer is expensive, because it looks like
configuration rather than like a guess.
