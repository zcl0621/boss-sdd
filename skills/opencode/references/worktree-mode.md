# Worktree mode

Every dispatched node gets its own git worktree on its own branch, cut from the
integration branch, and its work reaches the rest of the plan by merging. This
is how the skill runs: there is no shared-tree mode to fall back to and no
variant in which two nodes write into one tree. A repository the orchestrator
cannot `git worktree add` in cannot run phase 2, and phase 0 is where you find
that out.

This file owns six steps of the phase 2 loop and what `write_scope` is
protecting you from. It leaves the DAG, the roles, the review protocol, the
obstacle-episode escalation policy, and who runs the gates alone.

Read the next two sections before you set anything up. The obvious reading of
"each agent is now isolated" is wrong in two separate directions, and each one
costs real time when it is learned from a failed run instead of from here.

On-demand files, loaded only when that path is live:

- [worktree-merge.md](worktree-merge.md) — 8b/8c detail, merge lock, conflict, red post-merge gate, attribution
- [worktree-resume.md](worktree-resume.md) — reopen a `done` node; blocked node returning
- [worktree-cleanup.md](worktree-cleanup.md) — remove trees and branches


## Isolation does not relax `exclusive_resources`

A worktree isolates files, and nothing else.

Ports, devices, simulators, shared test databases, license seats, a serial test
lock, a deployment environment: every one of those is global to the machine, and
two worktrees reach the same one. Two nodes that each bind port 5432, or each
drive the one attached device, collide with their own trees exactly as they would
have collided sharing one.

So `exclusive_resources` is the only concurrency safety left standing. File
overlap surfaces later and quieter, as a merge conflict. An under-declared
resource surfaces later still, as a test that passes alone and fails in a batch,
which reads as flakiness and gets retried instead of fixed. Declare resources at
least as carefully as you would with every node in one tree, and preferably more.

## Green in your worktree is not green after the merge

This is the failure per-node worktrees introduce, and the reason the node loop grows a
merge step rather than just a setup step.

A node's gates pass in its own tree, against its own branch. That proves the node
works alone. It does not prove the node works alongside the nodes that merged
before it, because those changes were not in its tree when it tested. Two nodes
can each be correct in isolation and wrong together: one renames a helper the
other started calling, both add a migration with the same version, both register
the same route.

So a node is not `done` when its own gates pass. It is `done` when its work has
been committed, merged into the integration branch, and gated again **after** that
merge. The commit, the merge and the post-merge gate are part of the node, not
part of close-out.

## What this costs

**Per node: a tree, a full dependency install, and a build.** A repository with a
slow install or a fragile toolchain pays that once per node instead of once per
run. There that is an argument for fewer and wider tasks, not for sharing a
tree, which is not on offer.

**Per node: a second full gate run, after the merge.** This is the cost most
often underestimated, because **merges are serial and so those gate runs are
serial too**. Ten nodes means ten full gate runs one after another, however wide
the implementation ran.

And the tail is worse than those gate runs alone, because the merge lock stops
more than merging. The merge lock ([worktree-merge.md](worktree-merge.md))
forbids dispatching anything at all while it is held, so for the whole of a
node's 8b and 8c nothing else starts: no new pass, and no rework or review round
for any other node either. Every other node that is mid-loop waits out every
merge, not just its own. Budget the tail as the sum of every node's post-merge
gate run, with the rest of the run stopped for the duration of each. The only
lever on that sum is the node count.

In exchange a misbehaving implementer can only damage its own tree, a failure is
always attributable to the node that caused it, and two nodes that touch the
same neighbourhood despite disjoint scopes (a shared generated file, a lockfile)
surface it as a merge conflict instead of as corruption.

## Red-test chains (verify then fix)

Every bug fix is two nodes: a `[verify]` node that commits the reproduction
as failing tests, and a `[fix: <verify id>]` node that makes those *named
tests* pass. Those two are one chain. Siblings of that chain are not. Which
stages each node runs is in SKILL.md Phase 2; this section is the trees and
the merges.

Per-node worktrees already keep a chain's red tests out of every sibling's
tree: siblings are cut from the integration branch, and the verify node does
not merge there while its tests are red. What the chain still needs is a
different branch point for the fix node.

**Trees.** The fix node gets its own worktree, cut from the verify node's
branch after the verify node's 8a, not from the integration tip. Do not cut
the fix node from integration: that tree would lack the red tests.

The verify branch is as old as the verify node's own branch point, so it
lacks whatever other nodes merged into integration since, including nodes
the fix depends on. Before the first dispatch, bring them in:

```
git -C <fix worktree> merge --no-ff --no-edit <integration branch>
```

The commit after this merge (the cut itself when there was nothing to merge)
is the fix node's branch point (setup step 5), so its diff shows the fix
alone.

A conflict here is the red tests colliding with newer work, not the fix's
fault: `git -C <fix worktree> merge --abort`, remove the fix tree and branch,
set the fix node back to `pending`, and reopen the verify node (`done` back
to `running`) in its kept worktree
(it never merged, so there is nothing to undo): merge the integration branch
there, send it back as `<stage>red-test</stage>` to resolve the tests against
it, run its audit, gates, and review again, 8a again. Then cut the fix tree
again.

**Verify close-out.** Commit on the node branch (8a), test paths only. Do
**not** run 8b or 8c: the named tests are red by design, and integration must
stay green for every sibling cut from it. Keep the worktree and the branch.
`done` for the DAG means: the failing tests are committed, the named tests
fail on the reported behaviour and every other gate is green
([gates.md](gates.md#verify-nodes-the-one-expected-red)), and review passed.
Cleanup does not run yet.

**Fix close-out.** Dispatch into the fix node's own worktree. It changes
production code and never edits or deletes the named tests; it may add only
the new tests its own acceptance lists, and those went red first through the
red-test stage and audit. Then 8a, 8b, 8c once, when the
named tests and every other gate are green. The fix
branch carries the verify commits, so that merge is what lands the pair.
8b's first-line range already holds the verify commits, so it cannot show
whether the fix itself was committed; before it, also check
`git -C <integration worktree> log --oneline <verify branch>..<fix branch>`.
Empty output: go back to 8a. Cleanup removes both trees and both branches
after the fix node is `done`.

**Siblings.** One chain's red tests must not sit in a sibling's tree. Do
not serialise sibling verifies on a shared test-suite resource (say
`gate:<suite>`) just because they share a suite name; each runs the suite
in its own tree. A shared production path (say `write:<path>`) still
serialises the fixers that write it.

## Setup

### Before setup: the user's uncommitted changes

Worktrees branch from a commit. Anything uncommitted in the main working
tree is by definition not in that commit, so it is in no node's tree and in
nothing that merges. The run would then deliver an integration branch built on a
base the user's tree does not match, while the completion condition "the user's
pre-existing changes are intact" reads as satisfied because nothing touched them.

So check the main tree before setup. If it is clean, proceed. If it is not:

- In confirm mode, say what is uncommitted and ask the user to commit or stash it
  first.

  If they stash, nothing moved. The baseline ref recorded in phase 0 is still the
  right base and you proceed from it unchanged.

  If they commit, their commit is the base now. Re-record it as `Base ref` in the
  plan document's Status header before you go any further, and use the header's
  value everywhere the recorded baseline ref is called for, including the
  integration branch below. Skip the re-recording and the two readings split:
  cutting the integration branch from the stale phase 0 ref puts it below the
  user's commit, so their work is in no node's tree and in nothing that merges,
  which is the exact failure this precondition exists to prevent; cutting it from
  the user's commit while the record still names the phase 0 ref makes phase 3's
  `git diff <baseRef>..<headRef>` span the user's own commit and report it as part
  of the run's change. Re-recording is what makes both readings land on the same
  commit and leaves that diff describing only what the run did.
- In unattended mode, do not wait and do not commit their work for you. There is
  no second mode to fall back into, so this is one of the things unattended mode
  stops for: before any dispatch, `goal` `wait` with the reason, naming the
  uncommitted paths ([unattended-mode.md](unattended-mode.md)), and say the same
  in the delivery report. Guessing that the user wanted their work stashed is not
  an unattended outcome.

Never commit or stash the user's changes yourself to clear the way. That is their
work and their decision, and the rest of this skill spends real effort protecting
it.

### Trees

Three kinds of tree exist, and keeping them distinct is what stops the run from
trampling the thing above:

- **The main working tree.** The user's. Never checked out to another branch,
  never merged into, never gated. Leave it exactly as you found it. Phase P
  explorers and Phase 0 `recon` read it, because no other tree exists yet and it
  is the state the plan starts from.
- **The integration worktree.** A separate worktree with the integration branch
  checked out. All merges and all post-merge gates run here, and so do the full
  gate set and the six branch lanes in phase 3. Creating it is what keeps the
  merges out of the main tree.
- **One worktree per node.** The implementer, the reviewer, the spec-auditor,
  the QA walkthrough, the node's own gates, and the node's post-commit scans all
  work here.

**Put every worktree you create in the sibling directory `<repo>-worktrees/`.**
If the repository is at `/w/repo`, create them under `/w/repo-worktrees/<name>`.
Use exactly that suffix. The plan-sdd agent files allow `external_directory`
access to `*-worktrees/*` and nothing else outside the project, so a worktree
anywhere else makes every subagent stop at an approval prompt, and an
unattended run then hangs until someone answers it. Inside the repository is
no better: `git worktree add .worktrees/nodeZ` puts a new untracked directory
in the user's tree, `git status` then reports `?? .worktrees/`, and the tree
you promised to leave exactly as you found it is dirty for the length of the
run, in a way that also shows up in every `git status` the user runs themselves.

### Sequence

Once, at the start of phase 2:

1. Create the integration branch from the baseline ref currently recorded as
   `Base ref` in the plan document's Status header: the one written in phase 0, or
   the replacement the precondition above told you to record if the user cleared
   their tree by committing. Read it out of the header rather than from memory, so
   there is exactly one answer to what the base is. Every node's work lands here,
   and this is what phase 3 reviews.
2. Create the integration worktree and check that branch out in it.
3. Record three things in the plan document's Status header, each on its own
   line: the integration branch's name, the absolute path of the main working
   tree, and the absolute path of the integration worktree.
   [plan-spec.md](plan-spec.md) gives the exact fields. A later session that
   recovers only the branch name cannot tell where the merges were happening or
   which of the trees it must leave alone.

A missing integration worktree mid-run is recreated from the header
(`Integration branch` / `Base ref` / current integration tip), never a reason to
let nodes write the main tree.

Then per node, at dispatch:

4. Cut the node's branch and worktree **from the current tip of the integration
   branch**, not from the original baseline ref. For a node in the first pass
   those are the same commit. For a node with dependencies they are not: its
   dependencies are `done`, which here means merged, and cutting from the
   stale baseline would hand the node a tree without the work it declared it
   depends on. Cutting from the tip is what makes `depends_on` mean anything
   here. The one exception is the fix half of a red-test chain, cut from the
   verify node's branch (above).
5. Record the commit the worktree was cut from. That is this node's diff
   baseline. Where this page, and [review.md](review.md) and
   [dispatch.md](dispatch.md) with it, write `<branch point>`, they mean
   whatever this record currently holds. It is not fixed for the node's whole
   life: syncing the integration tip into the node's branch replaces it, for the
   reason given under "A conflict at 8b" in [worktree-merge.md](worktree-merge.md).

A worktree needs whatever a fresh checkout needs before the gates will run:
dependency install, build, generated files. Do that as part of setup, not inside
the implementer's work, so a setup failure is not recorded as the node's
obstacle episode.

## The phase 2 loop in a worktree

SKILL.md's phase 2 gives the order; this section gives each step's tree, diff,
and command.

**Step 1, pick a batch.** Same ready set, same `write_scope` and
`exclusive_resources` conflict rules, same concurrency limits. Do not relax the
`write_scope` rule because the trees are isolated; see what that constraint is
buying, below. After choosing, do the per-node setup above for each member of
the batch.

One timing rule is a scheduling rule rather than a batching one: **do not start
a pass while the merge lock is held.** Finish the 8b and 8c of whichever node
holds it, release the lock, and pick the next batch after that. The per-node
setup cuts each worktree from the integration branch's current tip, and that tip
is the thing 8b and 8c are in the middle of moving.
[worktree-merge.md](worktree-merge.md) says what this buys and why the
recovery path depends on it.

**Step 2, dispatch an implementer.** The dispatch prompt's `<working_directory>`
block carries this node's worktree path. See [dispatch.md](dispatch.md). An
implementer that is not told its worktree writes into the main tree, and every
isolation property is gone: the pass is wasted, and the user's tree is left
dirty in the way the precondition above exists to prevent.

**Step 3, do not review yet.** After the red-test audit and the repair (a
`[verify]` node: the audit alone; a `[fix]` node: the repair alone), read
the diff and run the gates (steps 4 and 5) first. Quality, the spec audit, the
QA walkthrough, and adversary run in the node's worktree only after those gates
are green. [review.md](review.md) gives the exact
inputs. A red gate is send-back from this tree: no quality. The one expected
red is a `[verify]` node's named tests ([gates.md](gates.md#verify-nodes-the-one-expected-red)). Use Form A when the
session is usable, otherwise ordinary Form B with the task's starting binding;
an authorized obstacle escalation is fresh Form B on
`implementer.obstacle_escalation`. Briefing a
reviewer with the main tree's diff shows it none of the node's work, and it
will report that the task was never implemented.

**Step 4, read the diff yourself.** Diff the node's worktree against the commit
it was cut from, with no path restriction:

```
git -C <node worktree> diff <branch point>
```

No sibling writes into this tree, so an unrestricted diff is both correct and
complete: it shows everything this implementer did. A change outside the node's
`write_scope` is a finding, and an unambiguous one: nobody else could have
written it.

**Step 5, run the node's gates yourself.** Run them in the node's worktree. Same
discipline as always: you run them, one command at a time, never through a pipe,
full output kept. Gates that contend for a machine-global resource still
serialise on `exclusive_resources`, so two nodes holding the same test lock do not
run their gates at the same time, worktrees or not. If red, send back through
Form A when usable or ordinary Form B otherwise. Do not start quality; classify
the failure into its obstacle episode before any escalation decision.

After green gates, dispatch quality, `spec-auditor` post-repair (with the signed
spec path) and `qa` if marked, in one message, all against this worktree and
the same unrestricted `git -C <node worktree> diff <branch point>`; then one
adversary over their findings and the spec verdict. Do not
start 8a until it has returned `match` that survived adversary. A
quality-reviewer ALLOW on this tree is not that verdict.

**Step 8, close the node.** It is three actions, in a fixed order, described in
the next section. The node is not `done` until all three have passed.


## Step 8: commit, merge, gate

Order is commit, then merge, then gate. Do not start 8a until this node's
spec-auditor has returned `match` that survived adversary. The node stays in
`review` through 8a, 8b, and 8c. It is not `done` until 8c is green.

### 8a. Commit, in the node's worktree

```
git -C <node worktree> add -- <scope paths>
git -C <node worktree> commit -m "<message>"
```

**You make this commit, not the implementer.** The commit is transport: it is
the only way work leaves the node's worktree. Commit every node. The project's
conventions decide the message, not whether.

Never `git add -A`. Never `git commit -a`. Never push. If `git -C <node
worktree> status` shows changes the node did not report making, stop: nothing
else writes that tree, so either the implementer went somewhere it did not tell
you about or the isolation is not what you think it is.

**Post-commit scans run here, after 8a and before 8b.** If the project defines
any, send them all in one `explore` call through `explore.post_commit_scan`,
pointed at this node's worktree and its committed diff,
`git -C <node worktree> diff <branch point>..HEAD`. They run before the merge
lock is taken because the lock forbids dispatch. A `DENY` is a finding: back
into this node's loop, then 8a again and the scans again, before 8b.

### 8b and 8c, happy path

Hold the merge lock from the start of 8b until the node is `done`, the merge
is aborted, or the integration branch is reset to the pre-merge commit. The
lock is not an `exclusive_resources` entry. Dispatch nothing while you hold
it. Full rules: [worktree-merge.md](worktree-merge.md).

1. Confirm there is something to merge:

```
git -C <integration worktree> log --oneline <integration branch>..<node branch>
```

Empty output: go back to 8a. Do not merge.

2. Record the integration tip (`rev-parse HEAD` under the lock). Merge with a
   merge commit:

```
git -C <integration worktree> merge --no-ff <node branch>
```

Confirm `HEAD` moved. "Already up to date" is not a merge.

3. Run the node's gates again in the integration worktree. Green: the node is
   `done`; release the lock; clean up per [worktree-cleanup.md](worktree-cleanup.md).
   Conflict at 8b, or red at 8c: [worktree-merge.md](worktree-merge.md). Do not
   resolve a merge conflict yourself.

A verify node in a red-test chain does not run 8b or 8c into integration while
the named tests are red. The fix node's 8b/8c lands the pair.

## What `write_scope` is protecting

The rule does not change: do not dispatch nodes with overlapping `write_scope` in
the same pass. What it buys is not concurrent-write safety, since no two nodes
share a tree.

Here overlap means a merge conflict later. Nothing is corrupted; both versions
exist intact on their own branches, and the second node to merge hits the
conflict.

That is a mild failure, which is why the constraint might look optional. Keep it
anyway. A conflict surfaces at merge time, which is after both
nodes have been implemented, reviewed, and gated, so the cost of the collision
has already been paid twice over before anyone sees it. And resolving one is not
free either: it takes a sync into the node's worktree, an ordinary repair when
needed, and a brief that explains the other side to an agent that did not write it.
Scheduling the overlap away costs one pass.


## Phase 3

Phase 3 reviews the integration branch, once every node that reached `done` has
merged into it. Not the individual worktrees, and not the main working tree.

The full gate set at the start of phase 3 runs in the integration worktree, and
the six branch lanes read and run there. The branch review's diff range is the
baseline ref to the integration branch tip. The per-task audit in lane 6 reads
the same range. Findings route as they always do: wrong behaviour in landed
work is a new verify/fix pair, and any other `byTask` finding against a `done`
node reopens it by [worktree-resume.md](worktree-resume.md).

## Worktree on OpenCode

Subagents share the parent checkout unless the dispatch assigns a worktree path.
Asking for "its own environment" in the prompt does not create one. You
`git worktree add` every tree yourself, cut each node from the integration
branch (fix half of a chain: from the verify node's branch), and put that
absolute path in the child's `<working_directory>`. OpenCode does not create or
clean up those trees for you.

On the first node of the run, have the child report `git rev-parse
--show-toplevel` and one written file path, and compare that root with the
node's worktree. If the child wrote the user's main tree, that is a finding.
Recreate the node tree and send the round back. A child that does not honour a
path outside the project root is a platform problem to report to the user, not a
reason to let nodes write the main tree.
