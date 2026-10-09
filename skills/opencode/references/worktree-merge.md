# Worktree merge, conflict, and attribution

On-demand. Standing rules for trees, setup, the happy-path node loop, and 8a
live in [worktree-mode.md](worktree-mode.md). Resume lives in
[worktree-resume.md](worktree-resume.md). Cleanup lives in
[worktree-cleanup.md](worktree-cleanup.md).

## 8b. Merge, into the integration branch

**The first thing this step does, before the lock and before the merge, is check
that there is something to merge:**

```
git -C <integration worktree> log --oneline <integration branch>..<node branch>
```

Empty output means the node's branch carries nothing the integration branch does
not already have. Go back to 8a and commit. Do not merge.

Its position is deliberate. A guard at the foot of 8a would only run if 8a ran,
and the failure this one exists to catch is "merged without committing", which
consists precisely of not being in 8a. Put it where the merge is and it cannot be
stepped around.

Its predicate is deliberate too, and it is not "the node's branch has moved off
its branch point". That version is vacuous on every lap after the first: the
branch moved off its branch point during the first lap, so the check passes while
the fix sits uncommitted. Asking instead what the node's branch has that the
integration branch lacks is the right question to ask at a merge, because it is
literally the question "is there anything here to merge".

**Read it as exactly that, and not as "8a ran this lap".** The two coincide only
while the node's earlier commits are already in the integration branch, and this
mode's recovery paths produce two laps where they are not, because both take the
node's earlier commit back out of it: a lap after an abort at 8b, where the
merge never landed, and a lap after a `reset --hard` at 8c, which removes a
merge that did. On those the earlier commit fills the range by itself, so a
skipped 8a passes the check. What catches it there is the merge: with this lap's
fix still uncommitted in the worktree, 8b re-merges exactly the content that
conflicted or failed before, so it conflicts again, or 8c goes red again. That
is a wasted lap, loudly, rather than a green report over work that is not there.
The check earns its place on the failure it does catch, a node that committed
nothing at all, which is the one that would otherwise reach `done` with no code
in the integration branch.

Run this check before anything that would itself put a commit on the node's
branch. A sync of the integration tip into the node's branch is that, when it
merges cleanly: the sync commit fills the range on its own, and then even the
node that committed nothing passes. That is why the syncs before a fix round are
run with `--no-commit`, and why the one sync with no round behind it, in "When a
blocked node comes back", is run after this check rather than before it.

Then, in order:

1. Take the merge lock (below).
2. Record the integration branch's current tip. Call it the pre-merge commit.
   You need it at 8c, and it is the only thing that can prove the merge did
   anything.

   ```
   git -C <integration worktree> rev-parse HEAD
   ```

   Read it under the lock, not before taking it. With a single-threaded
   orchestrator nothing can move the tip in between, so the order costs nothing
   either way today; the reason to keep it this way is what the wrong order
   would mean if that ever stopped being true. `reset --hard <pre-merge commit>`
   at 8c is only correct if that value is the tip this merge was made against.
   Read outside the lock it can be some earlier tip, and the reset would then
   discard another node's merge while that node was reporting `done`.

3. Merge the node's branch into the integration branch, in the integration
   worktree, always with a merge commit:

   ```
   git -C <integration worktree> merge --no-ff <node branch>
   ```

   `--no-ff` is not cosmetic. Without it the first node of a pass fast-forwards,
   because the integration branch is still at that node's branch point, and then
   there is no merge commit for "Reopening a node that is already `done`"
   ([worktree-resume.md](worktree-resume.md)) to
   recover that node's contribution from. A conflict here goes to attribution; see
   "When the merge does not go green".
4. Confirm the merge advanced the integration branch: `git -C <integration
   worktree> rev-parse HEAD` must now differ from the pre-merge commit you
   recorded. `git merge` printing "Already up to date" and leaving the tip where
   it stood is not a merge, and 8c would then gate content nobody changed and go
   green on it.

## 8c. Gate, after the merge

Run the node's gates again, in the integration worktree, on the merged result.
Same discipline. This is the run that decides `done`.

Green: the node is `done`. Release the merge lock and clean up its tree by the
commands in [worktree-cleanup.md](worktree-cleanup.md), which say what to do when `git worktree remove`
refuses rather than leaving you to reach for `--force`.
Red: undo the merge and then attribute, by the procedure in "A red gate at 8c".
Undo it before you attribute, not after; that undo is also the measurement the
attribution rests on.

The node stays in the `review` state throughout 8a, 8b and 8c. It is still
active, still holding its `write_scope` and `exclusive_resources`, and it does not
reach `done` until 8c is green.

## The merge lock

Exactly one node merges at a time, because a post-merge gate failure has to be
attributable and two merges in flight make that impossible.

**The merge lock is not an `exclusive_resources` entry.** Do not declare it on any
task, and do not apply batch rule 2 to it. Every node needs it, so treating it as
a declared resource would mean no two nodes could ever be dispatched together,
and the run would have no parallelism left.

It is a different mechanism with different rules, and the difference is real
rather than a convenience. A declared resource is held for a node's entire active
life, from dispatch through `done`, which is why
[dag-contract.md](dag-contract.md) refuses partial acquisition and early release:
a subagent is running inside that window and you cannot reason about when it
touches the resource. The merge lock is held only inside step 8, by you, between
commands you run yourself. The window is bounded by your own actions, so it can be
acquired and released mid-node without the ambiguity that rule exists to prevent.

**Dispatch nothing while you hold it.** No implementer, no reviewer, no rework
round, and above all no new scheduling pass, because step 1's per-node setup cuts
a worktree from the integration branch's tip and that tip is what 8b and 8c are
moving. This instruction is what makes the paragraph above true rather than merely
assumed, and it is also what makes the `reset --hard` at 8c safe: with nothing cut
while the lock is held, no node's branch point can be the commit that reset
discards. Finish 8c, release, then dispatch.

Hold it from the start of 8b until one of these is true:

- The node reaches `done`.
- The merge is reset away and the integration branch is back at the pre-merge
  commit you recorded at 8b.
- The merge is aborted because it conflicted.

Release it in all three cases. A conflict is the one most easily missed: no gate
ran, the node is not `done`, and nothing was merged for the reset at 8c to take
back, so `git merge --abort` in the integration worktree is what returns the
branch to its previous state. Holding the lock through a conflicted node's fix
rounds would stall every other node's merge behind a node that is not even
running.

## When the merge does not go green

Two ways it fails, and they share an attribution rule.

### A conflict at 8b

Abort the merge and release the lock. The integration branch is back where it
was, and nothing else is queued behind a node that is not even running.

**Then, before attributing anything, put both sides of the conflict into the
node's worktree:**

```
git -C <node worktree> merge --no-commit --no-ff <integration branch>
```

It conflicts again, identically: same merge base, same two sides, so the
conflict is symmetric. That is the point. Git leaves the merge in progress, with
both versions and the markers between them, in the one tree where this node's
fix rounds happen. Do not abort it. Leave it sitting there as the input to
whatever the attribution decides next. The lock is not needed for this; it
writes only the node's branch.

`--no-commit` is what keeps the node's branch still while the round runs. A
conflicted merge could not commit itself anyway, but the same command is used
below where the sync merges cleanly, and there git would otherwise commit it for
you. A sync commit is a commit the node's branch has and the integration branch
lacks, so it makes 8b's first-line range non-empty on its own, and that range
would stop measuring whether 8a ran.

Everything below depends on this step having run. The node's own worktree holds
one side of the conflict and no trace of the other, so a fix round routed into
it unsynced asks an implementer to fix something it cannot see. It changes what
it can see, the re-merge produces the same conflict, and a mistaken escalation
can block a node that did nothing wrong. A cross-pass `write_scope` overlap is
legitimate, and it must not be able to end a correct node that way.

Three things follow, two of them from leaving that merge in progress rather than
committing it.

**The node's diff baseline moves to the tip you just merged in.** Record it in
place of the branch point from setup step 5; the branch point is no longer a
useful baseline, because a diff from it now contains everything that merged
ahead of this node. `git -C <node worktree> diff <synced tip>` shows exactly
what this node adds to what the integration branch already has, which is what
step 4, the reviewer's brief and any later form B `<current_diff>` each want,
and it is the same content 8b will merge.

**The resolution is committed at 8a, by you, with the rest of the round.** The
node's branch does not move while the round runs, so nothing but 8a can put a
commit in 8b's first-line range. Stage the node's scope paths at 8a as always.
The incoming side's other files are already staged, because git staged them when
it auto-merged them cleanly, and they belong in this commit: leave them alone.
That is not `git add -A` and does not license it.

**Check for leftover markers before you stage anything:**

```
git -C <node worktree> diff --check | grep 'leftover conflict marker'
```

Until you stage, git itself refuses to finish the merge: `error: Committing is
not possible because you have unmerged files`, exit 128. That refusal is the
strongest net in this whole procedure, and `git add` is what spends it. Staging
a conflicted file marks it resolved whether or not it was, so `git add` on a
path still full of markers clears the conflict as far as git is concerned and
nothing asks again: the commit succeeds, 8b merges, and 8c runs the node's gates
over a file with the markers in it. Whether that is caught depends entirely on
whether some gate parses that file, which is why it survives in exactly the
files these conflicts land in most often, lockfiles and generated manifests and
data and documentation.

Run the same check again on the index immediately before every 8a commit, with
no exception for a lap you think is clean:

```
git -C <node worktree> diff --cached --check | grep 'leftover conflict marker'
```

**Narrow it to that one class, and do not gate on `--check`'s exit code.**
`--check` is git's whitespace linter and conflict markers are only one of the
things it reports. During a sync the index holds the entire incoming side, every
file the merge brought in off the integration branch, all of it outside this
node's `write_scope` by construction. One trailing space in another node's
already-merged, already-gated file and bare `diff --cached --check` exits 2:

```
other.txt:1: trailing whitespace.
```

Sent back as a finding, that is a defect the implementer did not cause and
cannot legally fix, because fixing it means writing outside its scope. The round
bounces, and in any repository that does not already enforce whitespace it
bounces on most syncs. `grep 'leftover conflict marker'` keeps git's detector,
which knows every marker form including the `|||||||` that the diff3 conflict
style adds, and drops everything else it reports. `grep` exits 0 when there is a
hit, which is the answer you want. This is bookkeeping rather than a gate, so
the pipe is allowed here; what it costs you is git's own exit status, so read
the stderr. If the git command itself failed, `grep` reports no hit and a broken
check looks like a clean one.

A hit means the round is not finished. It goes back to the implementer, not into
the commit. If you have already staged when it fires, you have spent git's
refusal and you choose between two imperfect moves: carry on and re-run the
index check before the next commit knowing you are now the only net, or restore
the unmerged state with `git checkout --merge -- <paths>`, which re-arms the
refusal but regenerates the conflict from the merge and throws away whatever the
implementer had already resolved in those files.

Then attribute. A conflict is not automatically the merging node's fault. Two
nodes in different passes may legitimately share a `write_scope`, because that
constraint only bars overlap among nodes active at the same time, so the second
one to merge can hit a conflict without having done anything wrong.

**You never resolve it yourself, and no subagent resolves it blind.** You do not
resolve it because you do not write implementation code, here as everywhere else
in this skill. A subagent may, but only after the sync: both sides in one tree,
each readable as a diff, and a brief that names the counterpart node and quotes
its goal. What is forbidden is resolving a conflict with one side visible, which
is what dispatching into an unsynced worktree amounts to.

Attribution decides who fixes it. Either way the fix happens in that synced
worktree, on that node's branch.

### A red gate at 8c

**Reset the integration branch back to the pre-merge commit you recorded at 8b,
then re-run the gate.**

```
git -C <integration worktree> reset --hard <pre-merge commit>
```

**Reset, not `git revert -m 1`.** The difference is the whole of this section. A
revert keeps the merge commit in the integration branch's history and adds a
second commit undoing its content, so git goes on treating the node's work as
merged: the merge base of the node's branch and the integration branch already
contains the node's first commit. When the node re-merges after its fix, only the
fix delta lands, and the original work stays undone on the integration branch
permanently. The node's own tests were undone along with it, so 8c goes green over
content that is not there and the node reaches `done` having contributed a fix to
missing code. Where the fix happens to touch a file the revert deleted you get a
modify/delete conflict instead, which is loud; everything the fix does not touch
is lost quietly, and that is the usual case. A reset removes the merge rather than
recording it, which leaves the node's branch holding work the integration branch
does not have, so the re-merge brings all of it back.

Reset is safe here for reasons specific to this branch, and you should confirm
both rather than assume them: the integration branch is local, is never pushed,
and nothing outside this run builds on it; and the merge lock forbids dispatch
while it is held, so no node's worktree was cut from the commit you are
discarding. If either is false, stop and say so rather than reaching for `git
revert` to get around it.

The reset is also the test for whether the failure arrived with this merge, so do
not run a separate merge-base check afterwards:

- **Green after the reset.** The failure came in with this merge. Attribute
  between "inside the merging node's scope" and "genuine interaction", below.
- **Still red after the reset.** The failure was already on the integration
  branch before this merge, so it is not the merging node's. It belongs to a node
  that is already `done`. The merging node is charged nothing, stays unmerged,
  and waits.

  A red integration branch is now the top priority, because nothing else can
  merge onto it. Release the merge lock first: the reset put the branch back,
  which is one of the lock's release conditions, and "pause merges" means start
  no further 8b, not keep holding the lock. Holding it here deadlocks the run,
  because the reopen below dispatches and dispatching is the one thing the lock
  forbids. Then reopen the `done` node that owns the failure using the procedure
below, repair its identified obstacle episode, and resume merges once the branch
  is green. Nodes already dispatched keep implementing, reviewing and
  gating in their own trees while this is happening; only 8b and 8c are paused.

### Attribution

**Inside the merging node's `write_scope`.** This node's finding. Back into its
fix loop as an ordinary repair in the applicable obstacle episode: the node is still at `review`, its
worktree and its branch are still there, and the rework happens in that worktree
like any other repair.

Whichever of the two failures brought it here, the repair happens in a synced
tree, because both failures are about two sides meeting and a tree holding one
of them cannot show it. After a conflict that is already done: the worktree is
the one the sync left with the merge in progress. After a red gate at 8c, sync
now, same `--no-commit` command, same effect on the node's diff baseline, and
the same marker checks around 8a. The reset put the integration branch back
below this node's work, so without the sync the implementer gets a tree in which
the gate passes, which is what it was doing before the merge, and is asked to
fix something it cannot reproduce.

After a conflict, resolving the markers is part of the round's goal rather than
housekeeping the implementer should do quietly. Say so in the brief, and say
what the other side is: the counterpart node's id, what it was for, and that
both versions are work somebody already reviewed and gated. Left to infer it, an
implementer takes the cheapest route to a file with no markers in it, which is
deleting the half it did not write, and that is how a merged node's work
disappears from the integration branch with every gate still green.

A conflicted round is also where an implementer is most likely to stage
something, because that is what git's own conflict message tells it to do. The
loaded implementer standing rules already forbid staging and committing; do
not paste a second copy. An implementer that runs `git add -A` here puts the
whole incoming side and anything else it touched into the index, and your 8a
commit takes all of it.

When it passes your step 6 again it runs the whole of step 8 again, in order:
**8a, then 8b, then 8c.** Not 8b alone. 8a commits the fix on top of the commit
the reset took back off the integration branch, so the branch then carries the
original work and the fix together, and 8b's first-line check sees a non-empty
range because both are missing from the integration branch. Going straight to 8b
instead re-merges the same commit the reset removed while the fix is still
uncommitted, and 8b's check does not catch it: the reset already put that commit
back outside the integration branch, so the range is non-empty without this
lap's fix. 8c catches it, by going red on the same failure a second time. Every
lap through a node's close-out is the same three steps in the same order, and
that is the reason: there is no shorter path here that anything checks.

**A genuine interaction, with neither side wrong alone.** An interface both nodes
honoured differently, a shared assumption that drifted, two migrations that are
each valid and jointly not, or a conflict in a region both legitimately own in
different passes. This is not a defect of either node. It is a gap in the plan,
and it is the case [review.md](review.md) already calls `unassigned` in branch
review: a finding that belongs to no single task. Handle it the same way. Create a
reconciliation task with a scope spanning both areas, following the
dynamic-insertion rules in [dag-contract.md](dag-contract.md), and dispatch it.
**Record no obstacle episode against either node.** Neither did
anything wrong, and counting a planning gap as their obstacle is how a correct
node gets escalated or reaches `blocked` for someone else's reason.

**This reconciliation task does not get a worktree of its own.** It works in the
merging node's worktree, on the merging node's branch, and it needs both sides
present there for the same reason the merging node did:

- Reached from a conflict at 8b, that tree is already in the state the sync
  left, merge in progress, markers in place. Dispatch into it as it stands.
- Reached from a red gate at 8c, nothing is in progress anywhere. The merge was
  reset off the integration branch, so that branch does not have this node's
  side, and the node's branch does not have what merged ahead of it. Sync first,
  the same `--no-commit` command and with the same effect on the node's diff
  baseline, and dispatch into the result.

Cutting it a fresh worktree from the integration tip instead would hand it
exactly the one-sided view that makes the problem unresolvable, which is the
whole reason the sync exists.

Because its work lands on the merging node's branch, **the reconciliation task
has no 8b or 8c of its own.** It has an 8a, committing onto that branch like any
other round's work and with the same leftover-marker check before the commit, and
the merging node's 8b and 8c are what carry it into the integration branch and
gate it there. Two tasks do not merge one branch separately. The merging node is
`blocked` on it meanwhile and comes back by the route in "When a blocked node
comes back", resuming at 8b.

**And it is exempt from cleanup, because it owns no tree.** The worktree and
branch it worked in belong to the merging node, which is `blocked` and whose
tree the cleanup rule says to keep. Run the ordinary "reaches `done`, remove the
worktree and delete the branch" on this task and you delete a blocked node's
worktree while it is still waiting to come back. Nothing stops you: this task's
own 8a left that tree clean, so `worktree remove` does not refuse, and the node
then returns from `blocked` to a sync command that fails with `fatal: cannot
change to '<path>': No such file or directory`. The work itself survives on the
branch, which `branch -d` refuses to delete while it is unmerged, but you are
off the documented path in the middle of a recovery. This task reaches `done`
and nothing is cleaned up for it.

**Its diff baseline is the merging node's**, because no worktree was cut for it
and setup step 5 therefore recorded nothing. Brief its reviewer and its
adversary with that record, the synced tip, and tell them in the same breath
what the diff contains: this node's own work with the reconciliation's changes
on top of it. That is a superset of what this task wrote. It is the right thing
to judge, since the task exists to make the combination correct rather than to
make a change of its own, but say so, or a reviewer told "this is the task's
diff" reports the merging node's work as this task's.

**Reopening it later needs a different command**, since it has no merge commit
for "Reopening a node that is already `done`" to diff against. Record the commit
its 8a makes on the merging node's branch. That commit concludes a merge, so:

```
git -C <node worktree> show <its 8a commit>
```

prints a combined diff, which here is exactly what this task did by hand: the
resolution, plus anything it created during the merge, and nothing that came
verbatim off either side. This is the one place where `git show` on a merge
commit is the right command rather than the empty one, and the reason is the
same reason it is empty elsewhere: it shows only what differs from every parent.
Reopening the merging node instead gives you a diff carrying the reconciliation's
changes as though that node had written them, which is accurate for "what this
branch contributed" and wrong for "what this node wrote".

**When you cannot tell which it is**, treat it as the merging node's obstacle
episode. That matches this skill's standing bias: when you cannot decide whether
something counts as a failure, it counts. Record the uncertain attribution in the
episode evidence rather than inventing an independent episode.

Guessing wrong here costs one ordinary repair and nothing else. Both branches start from the
same synced tree, with both sides visible and the same work to do in it, and
they differ only in who pays for it.

**One collision, one ordinary repair.** A single interaction can surface twice: first as a
conflict at 8b, then, once that is resolved, as a gate failure at 8c in the same
region. That is one problem seen from two angles, and it is charged once. Before
recording a repair, check whether it is the same interaction the node was already
charged for; if it is, carry on with the repair already recorded. Charging both
would fabricate a second obstacle episode for one collision the scheduler allowed.

The test is the same counterpart node plus the same ground: the other side of the
collision is the node it collided with before, and the conflict and the gate
failure land in the same files or on the same symbol. A different counterpart, or
a failure somewhere the conflict never touched, is a second interaction and is
recorded on its own.

**When you cannot tell whether it is the same interaction, treat it as the same
one and record nothing further.** That inverts this skill's standing "when you
cannot decide, it counts" bias, deliberately. That bias exists so an unverified
defect never ships, and nothing ships either way here: the node is in a fix round
whichever way you call it, and the only question is who pays. Guessing wrong in
this direction costs one extra repair somewhere later, and you will see it happen.
Guessing wrong in the other direction can trigger escalation or block for a
collision the scheduler created, which the delivery report shows as a node that
failed.

A merge or post-merge failure is handled as an obstacle episode. It blocks the
node unmerged only when the same episode remains after its authorized escalated
repair; then it propagates downstream and keeps its worktree.
