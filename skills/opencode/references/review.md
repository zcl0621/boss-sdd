# Review

Every reviewer is a subagent that did not write the code it is reviewing, and it
works from the actual diff, the actual tests, and the actual running system.
Reviewers report actionable problems, ordered by impact, with the evidence for
each. "Looks fine" is not a review result; what was checked and what was found
is.

Two levels of review exist. Task review runs inside every node in phase 2. Branch
review runs once over the whole change in phase 3. Both end with an adversarial
pass, because a review whose findings nobody argued against produces a fix queue
full of things that were never wrong.

## Task review

Dispatch order inside a node: you run the gates first. Review only after they
are green.

Do not dispatch quality, adversary, or spec-auditor on a red gate. Send the
raw output back to the implementer.

A `[verify]` node (the reproduction half of a bug fix) is the one node whose
gates expect red: its named tests must fail on the reported behaviour and
everything else must be green ([gates.md](gates.md#verify-nodes-the-one-expected-red)).
When that holds, it gets `reviewer` `quality` only, then the adversary over
the quality findings and its red-test `match`. No post-repair spec audit,
since it changes no runtime code, and no `qa`. Its quality brief is the same
as below; a runtime change in its diff is a finding.

After green gates, one message, in parallel: `reviewer` with
`<review_mode>quality</review_mode>`, `spec-auditor` with
`<audit_mode>post-repair</audit_mode>`, and `qa` when the task carries `ui` or
`qa`. They are separate subagents with separate briefs. When they have all
returned, one `reviewer` with `<review_mode>adversary</review_mode>` takes
every quality and walkthrough finding and the spec verdict together.

**Static review, `reviewer`, mandatory for every task regardless of its role.**
Give it, each in its own tagged block: the task's text from the plan, the plan
path, the hard rules, the working directory, and the diff command. The working
directory and the diff command go together: this node's worktree, and
`git -C <node worktree> diff <branch point>`, unrestricted. Nothing else is
writing in that tree, so the whole diff is this task's, and an unrestricted one
also reveals writes outside the declared scope.

Getting this wrong does not degrade the review, it empties it:
a reviewer pointed at the repository root sees none of the node's work and
reports that the task was never implemented.

The loaded reviewer standing rules own the quality checklist. Spec-vs-acceptance
match is not this lane's verdict; that belongs to `spec-auditor`. This lane may
still file a finding when a test does not cover a behaviour the task promised;
that finding is quality, not the spec-match verdict.

**Runtime walkthrough, `qa`, when the task carries `ui` or `qa`.** The
marker on the task is what decides this, and every task carrying either one gets
the walkthrough. The kinds of change that earn a task one of those markers in
phase 1 are a UI, a CLI interaction, a deployment script, a service integration,
or anything else a person interacts with; that is a planning criterion, not a
second condition to re-test here. A marked task whose change looks undramatic to
you still gets the lane.

Give it, each in its own tagged block:

- the task's text from the plan, including its acceptance criteria
- the working directory to start the application in: this node's worktree. The
  application it must exercise is the one in that tree, not the one at the
  repository root, which does not contain the change.
- **the run recipe from recon's Code section, verbatim**: the start command, the port or
  URL, the seed or fixture step, the test accounts or credentials, and the
  services that must already be running. This lane cannot start the application
  without it, and it must not invent a start command. If the recipe is missing,
  do not dispatch this lane; get the recipe first.
- the scope of what changed, so it knows which screens or endpoints to exercise
- the four visual-direction statements, when the implementer produced them on a `ui` task
- the limits on what it may touch: the project's own fixtures and test accounts
  only, and no production data beyond what the user authorized

The loaded `qa` standing rules own what a walkthrough records.

### Spec audit, `spec-auditor`, mandatory before `done`

A separate subagent from the quality reviewer, dispatched in the same parallel
message after green gates. It does not ride along on the quality reviewer's
brief. A reviewer ALLOW is not a `match`.

Give it, each in its own tagged block:

- the signed spec path, to be read in full from disk; or, when there is no spec
  file, the acceptance criteria verbatim from the plan
- the task's text from the plan
- the hard rules
- the same working directory and diff command the quality reviewer for this
  node received (the node's worktree; unrestricted diff from its branch point)

The loaded spec-auditor standing rules own the per-bullet rows and the overall
verdict (`match` / `missing` / `off-target` / `unclear`). A test name alone is
not evidence.

The adversary pass below covers the `match` verdict and every `missing` /
`off-target` finding, the same as a lane-6 `done`. `missing` or `off-target`
that survives is a send-back. `unclear` you judge yourself; it is not a pass.
Do not mark the node `done` without a `match` that survived the adversary.
For a `[verify]` node that `match` is the red-test one.

On a fix round, dispatch this lane again on the new diff. Do not waive it
because the quality reviewer ALLOW'd the fix.

### The adversarial pass

Send every finding from the review lanes (`reviewer` quality, `spec-auditor`
post-repair, and, when dispatched, `qa`) to one `reviewer` with
`<review_mode>adversary</review_mode>`,
which tries to
knock each one down: is it actually reachable, is it actually wrong, is it
already handled somewhere the reviewer did not look, was it already there before
this change.

It cannot answer any of those from the finding text alone, so give it:

- the claims themselves, one per tagged block so it can answer them individually,
  each carrying whatever location the producing lane cited
- the working directory it should read and run in, and permission to read
  anything in it, since "already handled somewhere the reviewer did not look"
  means going and looking. This is the same directory the lane it is challenging
  worked in: the node's worktree for a task-review claim and the integration
  worktree for a branch-review one.
- **the same diff the lane that produced the claim was looking at.** In task
  review that is `git -C <node worktree> diff <branch point>`. In branch review it is the
  unrestricted `git diff <baseRef>..<headRef>`. Sending the wrong one makes the
  adversary argue about a different change than the one under challenge.
- the baseline ref, so it can run `git log -S` or `git blame` to test whether a
  line predates this work
- the acceptance criteria and the project's hard rules, which decide whether a
  thing is a defect or merely a preference. In task review, that task's criteria.
  In branch review, the plan document, since a claim may span tasks.

It returns, per claim, one of the three verdicts below and the evidence it rested
on. An adversary that returns a verdict with no evidence has not done the job;
send that claim back or judge it yourself.

The word "finding" fits lanes 1 through 5 and the quality task-review lanes:
something is
wrong, here is where. Lane 6 of branch review sends something different, a `done`
verdict, which is a claim that something is right. Challenge it the same way with
the question inverted: does the cited code and test actually satisfy the stated
acceptance criteria, or does it only look like it does. Its "location" is whatever
the audit named as satisfying the criteria, and a `dismissed` verdict there means
the audit's `done` did not hold, which makes it a `missing` or `off-target` result
for that task.

Classify the result:

- `confirmed`. The finding survived the challenge. It goes into the node's fix
  round.
- `dismissed`. The challenge held. Record a one-line reason and close it.
  Findings dismissed as pre-existing get the extra check described below.
- `unsure`. The reviewer or the adversary said it could not tell. **You judge
  every one of these yourself, one at a time.** An `unsure` finding is not a
  pass. Treating "could not verify" as "no problem" is how a real defect ships.

If a lane produces nothing at all, dispatch that one lane again rather than
re-running the whole review. This applies wherever lanes fan out in this file,
task review and branch review alike: re-dispatch the missing lane on its own. A
lane returning "no problems found" with its reasoning is a result and needs no
re-dispatch; a lane returning nothing is a lane that did not run.

If a lane fails twice, say so in the close-out and name which check therefore did
not happen. Do not treat a lane that never ran as a lane that found nothing, and
do not cover for it by judging its dimension yourself. In branch review, a lane 6
that will not run leaves you with no per-task verdicts, and the completion
conditions in [SKILL.md](../SKILL.md) cannot be met; that is a partial close-out,
not a clean one.

### Re-review after a fix

Give the reviewer the diff from the new starting point, not from where the task
originally began. Reviewing the accumulated diff again buries the change you
actually need looked at under everything already reviewed, and makes it harder to
tell whether the same obstacle episode remains.

## Branch review

Once every task's status is `done` or `blocked`, set the plan to `review` and
check the whole change. `baseRef` is whatever the plan document's Status header
records as `Base ref`, which is the commit from phase 0 unless the worktree
setup's uncommitted-changes precondition replaced it; read the header rather than
remembering phase 0. `headRef` is the tip of the integration branch, which is
what every completed node merged into; the individual worktrees hold nothing
phase 3 needs. Give every lane,
each in its own tagged block: the plan document's path, the hard rules, the diff
range `git diff <baseRef>..<headRef>`, its lane's question, and the working
directory to read and run in, which is the integration worktree. Unlike task review, this diff is
not path restricted: the whole point is to see the change as one thing.

The working directory is not made redundant by the diff range. Refs are
repo-global, so the range itself resolves from any worktree, but lanes 1 through 5
read source files and lane 6 goes looking for the code and tests that satisfy each
task's acceptance criteria. A lane given no directory reads the main working tree,
which sits at the baseline and holds none of the run's work, so
coverage and the task audit report as `missing` what is present on the integration
branch. Branch-review lanes get the short per-lane list described here rather
than the implementer context bundle from [dispatch.md](dispatch.md). It is the
same directory the adversary is already told to use for a branch-review claim,
below; the five lanes it challenges get it here.

Fan out six `reviewer` subagents in parallel, each with
`<review_mode>branch</review_mode>` and one lane question. Five look for problems along
one dimension each:

1. **Coverage.** Did every task land in code and in tests? Any half-finished path
   left behind?
2. **Decisions.** Were the defaults chosen reasonable and reversible? Is the
   decision queue complete?
3. **Tests.** Do they cover combinations that cross task boundaries, regression
   points, failure modes, and real edges?
4. **Integration.** Are the interfaces, names, data contracts, migrations, and
   ordering between tasks consistent with each other?
5. **Correctness.** Does the final diff introduce logic, security, performance, or
   maintainability problems?

The sixth asks a different question, and so gets its own lane rather than riding
along on one of the five:

6. **Task audit.** For each task in the plan, in order: read its stated
   acceptance criteria, find the code and tests in the branch diff that are
   supposed to satisfy them, and return one verdict with the evidence it rested
   on.

   - `done`. The criteria are met, and here is what meets them.
   - `missing`. Nothing in the diff satisfies these criteria.
   - `off-target`. Something was built, but it does not satisfy what the task
     said it would.
   - `unclear`. The criteria cannot be checked against the diff, with the reason.

   It returns a verdict for every task including the blocked ones, and it does
   not skip a task because another lane already mentioned it. This is the lane
   that produces the per-task verdicts the completion conditions in
   [SKILL.md](../SKILL.md) require. You must not write those verdicts yourself:
   you are the one who ran the tasks, and a completion audit performed by the
   party being audited is not an audit.

Then dispatch `reviewer` with `<review_mode>adversary</review_mode>` over every
finding from lanes 1 through 5, and over every `done` verdict from lane 6, the
same as in task review. A `done` verdict is a
claim like any other and benefits from being argued with.

Sort the surviving findings into the groups below. One rule comes first: a
finding of wrong behaviour in work that has already landed on the integration
branch is a bug, whichever task it belongs to. It becomes a new verify/fix
pair under the dynamic-insertion rules in [dag-contract.md](dag-contract.md),
and does not reopen the task that landed it. The groups cover every other
finding.

- `byTask`. Findings that belong to a specific task. Send each back into that
  task's fix loop after classifying it as a new or existing obstacle episode.
  Distinct independently evidenced findings may be repaired without a task-wide
  attempt cap.

  A task already `blocked` has an escalated episode that remains unresolved or a
  real external blocker. Record the finding in the partial close-out unless it
  supplies the missing external condition or proves the recorded episode resolved;
  then follow the blocked-node return rule. Do not create another escalation for
  the same failed episode.
- `unassigned`. Findings that belong to no single task: a task that was never
  done, two tasks contradicting each other, the same thing implemented twice in
  different places. Do not fix these yourself. Add each as a new task to the
  plan's Tasks section, follow the dynamic-insertion rules in
  [dag-contract.md](dag-contract.md), and dispatch an implementer from round one.
- `dismissed`. For anything dismissed as pre-existing, verify it yourself with
  `git log -S` or `git blame`. If you cannot establish that the line predates this
  work, treat the dismissal as failed and handle the finding as `byTask`. Skim the
  titles of the rest.
- The lane 6 verdicts. These are what you mark each task pass or fail with at the
  end.

  For a task whose status is `done`, a `missing` or `off-target` verdict is a
  `byTask` finding against it and goes back into its fix loop after episode
  classification. For a task already `blocked`, it does not: record the verdict in
  the partial close-out as further detail on a task the user already has to look
  at. The audit still runs over blocked tasks, because what a blocked task did or
  did not manage to land is worth knowing; it just has nowhere to route.

  Resolve every `unclear` yourself against the plan and the diff, and record how
  you resolved it. Recording an `unclear` as done is how a task that was never
  finished reaches the delivery report as complete.

Findings a lane marked as unverified because it ran out of budget: read the
high-severity ones yourself and decide. The medium and low ones can be listed in
the final report as a line each.

Optional external branch review is user-driven only; plan-sdd reviewer lanes
remain authoritative. See [native-review-handoff.md](native-review-handoff.md).

## Your adjudication

You check every finding against its evidence. Valid ones go into a fix round.
False positives get a short recorded reason and get closed. Time pressure and
attempt count are not reasons to wave through a high-impact problem. Block only
when the same escalated obstacle remains or a real blocker exists; otherwise
classify the finding and repair it rather than reporting it as resolved.

When you cannot decide whether something counts as a failure, it counts.
