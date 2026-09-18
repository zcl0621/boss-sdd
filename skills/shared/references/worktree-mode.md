# Worktree mode

An optional execution mode in which every dispatched node gets its own git
worktree on its own branch, instead of all nodes writing into one shared tree.
The default is shared-tree mode, described everywhere else in this skill.
Worktree mode changes six steps of the phase 2 loop and changes what
`write_scope` is protecting you from. It leaves the DAG, the roles, the review
protocol, the three-round limit, and who runs the gates alone.

Read the next two sections before deciding to use it. The obvious reading of
"each agent is now isolated" is wrong in two separate directions, and each one
costs real time when it is learned from a failed run instead of from here.

## Isolation does not relax `exclusive_resources`

A worktree isolates files, and nothing else.

Ports, devices, simulators, shared test databases, license seats, a serial test
lock, a deployment environment: every one of those is global to the machine, and
two worktrees reach the same one. Two nodes that each bind port 5432, or each
drive the one attached device, collide in worktree mode exactly as they collide
in shared-tree mode.

So this mode leans on `exclusive_resources` harder than the default does. In
shared-tree mode it is one of two safety mechanisms, and file overlap usually
bites first and loudly. In worktree mode it is the only one left, and an
under-declared resource shows up as a test that passes alone and fails in a
batch, which reads as flakiness and gets retried instead of fixed. Declare
resources at least as carefully as you would in shared-tree mode.

## Green in your worktree is not green after the merge

This is the failure this mode introduces, and the reason the node loop grows a
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

## Choosing a mode

Neither mode is better. They pay for different things.

**Shared-tree mode** costs you a shared blast radius. One node writing outside
its scope can corrupt a sibling mid-write, and the resulting gate failure points
at the wrong node. In exchange it is simple: one tree, one build, no merges, and
a diff you can read directly.

**Worktree mode** costs you a tree and a full dependency install and build per
node, merge work, and a second gate run per node after its merge. That second run
is the cost most often underestimated, because **merges are serial and so those
gate runs are serial too**. Ten nodes means ten full gate runs one after another,
however wide the implementation ran.

And the tail is worse than those gate runs alone, because the merge lock stops
more than merging. "The merge lock" below forbids dispatching anything at all
while it is held, so for the whole of a node's 8b and 8c nothing else starts:
no new pass, and no rework or review round for any other node either. Every
other node that is mid-loop waits out every merge, not just its own. Budget the
tail as the sum of every node's post-merge gate run, with the rest of the run
stopped for the duration of each.

In exchange a misbehaving implementer can only damage its own tree, and a failure
is always attributable to the node that caused it.

Roughly:

- Few tasks, small blast radius, cheap build: shared-tree. For a three-task plan
  the worktrees are overhead and the merges are busywork.
- A build slow enough that a corrupted tree costs an hour to notice: worktree.
- Nodes that touch each other's neighbourhoods even with disjoint scopes, such as
  a shared generated file or a lockfile: worktree, because the merge surfaces the
  conflict as a conflict instead of as corruption.
- An expensive or fragile toolchain where a per-tree install is painful: shared
  tree, and lean on `write_scope` discipline.
- Many tasks running wide in parallel: it depends on the gate suite, and the
  answer is not automatically worktree. Wide parallelism is where worktree mode's
  isolation pays best and where its serial post-merge tail costs most. If the
  gates take minutes, that tail can exceed everything you saved.

## Setup

### Before choosing this mode: the user's uncommitted changes

Worktree mode branches from a commit. Anything uncommitted in the main working
tree is by definition not in that commit, so it is in no node's tree and in
nothing that merges. The run would then deliver an integration branch built on a
base the user's tree does not match, while the completion condition "the user's
pre-existing changes are intact" reads as satisfied because nothing touched them.

So check the main tree before committing to the mode. If it is clean, proceed. If
it is not:

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
- In goal mode, do not wait and do not commit their work for you. Run shared-tree
  mode instead and say in the delivery report that worktree mode was unavailable
  because the tree had uncommitted changes.

Never commit or stash the user's changes yourself to clear the way. That is their
work and their decision, and the rest of this skill spends real effort protecting
it.

### Trees

Three kinds of tree exist in this mode, and keeping them distinct is what stops
the mode from trampling the thing above:

- **The main working tree.** The user's. Never checked out to another branch,
  never merged into, never gated. Leave it exactly as you found it.
- **The integration worktree.** A separate worktree with the integration branch
  checked out. All merges and all post-merge gates run here, and so does the full
  gate set at the start of phase 3. Creating it is what keeps the merges out of
  the main tree.
- **One worktree per node.** The implementer, the reviewer, the QA walkthrough
  and the node's own gates all work here.

**Put every worktree you create outside the main working tree's directory.** A
sibling directory works: if the repository is at `/w/repo`, create them under
`/w/repo-worktrees/<name>`. The obvious alternative breaks the rule directly
above it. `git worktree add .worktrees/nodeZ` puts a new untracked directory
inside the user's tree, `git status` then reports `?? .worktrees/`, and the tree
you promised to leave exactly as you found it is dirty for the length of the
run, in a way that also shows up in every `git status` the user runs themselves.
Inside the repository directory is acceptable only where the path is already
ignored by the project's own `.gitignore`, which you would have to have read to
know; do not add an ignore rule to make it true, because that is a write to the
user's repository for your own convenience.

### Sequence

Once, at the start of phase 2:

1. Create the integration branch from the baseline ref currently recorded as
   `Base ref` in the plan document's Status header: the one written in phase 0, or
   the replacement the precondition above told you to record if the user cleared
   their tree by committing. Read it out of the header rather than from memory, so
   there is exactly one answer to what the base is. Every node's work lands here,
   and this is what phase 3 reviews.
2. Create the integration worktree and check that branch out in it.
3. Record three things in the plan document's Status header, on their own lines
   under `Execution mode`: the integration branch's name, the absolute path of
   the main working tree, and the absolute path of the integration worktree.
   [plan-spec.md](plan-spec.md) gives the exact fields. A later session that
   recovers only the branch name cannot tell where the merges were happening or
   which of the trees it must leave alone.

Then per node, at dispatch:

4. Cut the node's branch and worktree **from the current tip of the integration
   branch**, not from the original baseline ref. For a node in the first pass
   those are the same commit. For a node with dependencies they are not: its
   dependencies are `done`, which in this mode means merged, and cutting from the
   stale baseline would hand the node a tree without the work it declared it
   depends on. Cutting from the tip is what makes `depends_on` mean anything
   here.
5. Record the commit the worktree was cut from. That is this node's diff
   baseline, and it replaces the shared batch baseline. Where this page, and
   [review.md](review.md) and [dispatch.md](dispatch.md) with it, write
   `<branch point>`, they mean whatever this record currently holds. It is not
   fixed for the node's whole life: syncing the integration tip into the node's
   branch replaces it, for the reason given under "A conflict at 8b".

A worktree needs whatever a fresh checkout needs before the gates will run:
dependency install, build, generated files. Do that as part of setup, not inside
the implementer's round, so a setup failure is not charged to the node.

## What changes in the phase 2 loop

Steps not listed here are unchanged.

**Step 1, pick a batch.** Unchanged in how the batch is chosen: same ready set,
same `write_scope` and `exclusive_resources` conflict rules, same concurrency
limits. Do not relax the `write_scope` rule because the trees are isolated; see
what that constraint is now buying, below. After choosing, do the per-node setup
above for each member of the batch.

One timing rule is new, and it is a scheduling rule rather than a batching one:
**do not start a pass while the merge lock is held.** Finish the 8b and 8c of
whichever node holds it, release the lock, and pick the next batch after that.
The per-node setup cuts each worktree from the integration branch's current tip,
and that tip is the thing 8b and 8c are in the middle of moving. "The merge lock"
below says what this buys and why the mode's recovery path depends on it.

**Step 2, dispatch an implementer.** The dispatch prompt's `<working_directory>`
block carries this node's worktree path instead of the repository root. That
block is part of the context bundle in every mode, so there is nothing to add to
the prompt here, only a different value to put in it. See
[dispatch.md](dispatch.md). An implementer that is not told its worktree writes
into the main tree, and every isolation property of this mode is gone: the pass
is wasted, and the user's tree is left dirty in the way the precondition above
exists to prevent.

**Step 3, review it independently.** The reviewer, the QA walkthrough and the
adversary all work in the node's worktree, against its branch point, and the
reviewer's diff loses its path restriction. [review.md](review.md) gives the
exact inputs. Briefing a reviewer with the main tree's diff shows it none of the
node's work, and it will report that the task was never implemented.

**Step 4, read the diff yourself.** Diff the node's worktree against the commit
it was cut from, with no path restriction:

```
git -C <node worktree> diff <branch point>
```

The path restriction existed because sibling nodes were writing into the same
tree. Here they are not, so an unrestricted diff is both correct and better: it
shows everything this implementer did. A change outside the node's `write_scope`
is still a finding, and in this mode it is an unambiguous one. In shared-tree
mode such a change might have been a sibling; here nobody else could have written
it.

**Step 5, run the node's gates yourself.** Run them in the node's worktree. Same
discipline as always: you run them, one command at a time, never through a pipe,
full output kept. Gates that contend for a machine-global resource still
serialise on `exclusive_resources`, so two nodes holding the same test lock do not
run their gates at the same time, worktrees or not.

**Step 8, close the node.** This is where the mode differs most. It grows from
one action into three, in a fixed order, described in the next section. The node
is not `done` until all three have passed.

## Step 8: commit, merge, gate

The order matters more than anything else on this page. The node's work is
uncommitted until you commit it, and an uncommitted worktree has a branch that
still points at its branch point. Merge before committing and you merge nothing,
the post-merge gate passes against an unchanged integration branch, and the node
reports `done` having contributed no code at all.

So: commit, then merge, then gate.

### 8a. Commit, in the node's worktree

```
git -C <node worktree> add -- <scope paths>
git -C <node worktree> commit -m "<message>"
```

**You make this commit, not the implementer.** That is unchanged from shared-tree
mode and from the implementer's brief, which forbids it to commit in either mode.
Nothing in this mode moves that responsibility; it only changes which tree the
command runs in.

**This commit is unconditional, and that part is not unchanged.** Shared-tree
step 8 in [PLAYBOOK.md](../PLAYBOOK.md) makes the commit conditional, "where the
project's conventions call for commits". That condition is safe there, because
the work sits in the one working tree whether anyone commits it or not, so the
commit is bookkeeping. Here the commit is transport: it is the only way work
leaves the node's worktree. Leave it out and the node's branch stays at its
branch point, 8b merges nothing, 8c gates unchanged content green, and the node
reaches `done` having contributed no code. So commit every node in this mode,
in a repository with no per-node commit convention exactly as much as in one that
has it. The project's conventions decide the message, never whether.

Still never `git add -A`, still never `git commit -a`. A worktree stops a
subagent from damaging a sibling; it does nothing to stop it writing outside its
own declared scope inside its own tree, and an unscoped stage would sweep that
into the commit and then into the integration branch. Never push.

### 8b. Merge, into the integration branch

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
   there is no merge commit for "Reopening a node that is already `done`" to
   recover that node's contribution from. A conflict here goes to attribution; see
   "When the merge does not go green".
4. Confirm the merge advanced the integration branch: `git -C <integration
   worktree> rev-parse HEAD` must now differ from the pre-merge commit you
   recorded. `git merge` printing "Already up to date" and leaving the tip where
   it stood is not a merge, and 8c would then gate content nobody changed and go
   green on it.

### 8c. Gate, after the merge

Run the node's gates again, in the integration worktree, on the merged result.
Same discipline. This is the run that decides `done`.

Green: the node is `done`. Release the merge lock and clean up its tree by the
commands in "Cleanup" below, which say what to do when `git worktree remove`
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
and the mode would have no parallelism left.

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
it can see, the re-merge produces the same conflict, and three rounds later a
node that did nothing wrong is `blocked`. A cross-pass `write_scope` overlap is
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
  below, take its fix through its own rounds, and resume merges once the branch
  is green. Nodes already dispatched keep implementing, reviewing and
  gating in their own trees while this is happening; only 8b and 8c are paused.

### Attribution

**Inside the merging node's `write_scope`.** This node's finding. Back into its
fix loop, one round spent, standard route: the node is still at `review`, its
worktree and its branch are still there, and the rework happens in that worktree
like any other fix round.

Whichever of the two failures brought it here, the round happens in a synced
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
something, because that is what git's own conflict message tells it to do. Send
the round with the `<forbidden>` block as [dispatch.md](dispatch.md) writes it,
which bars staging as well as committing: an implementer that runs `git add -A`
here puts the whole incoming side and anything else it touched into the index,
and your 8a commit takes all of it.

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
dynamic-insertion rules in [dag-contract.md](dag-contract.md), and dispatch it
from round one. **Charge neither node a round.** Neither did anything wrong, and
spending their rounds on a planning gap is how a correct node reaches `blocked`
for someone else's reason.

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

**When you cannot tell which it is**, treat it as the merging node's and spend the
round. That matches this skill's standing bias: when you cannot decide whether
something counts as a failure, it counts. Record in the close-out that the
attribution was uncertain, so the user can see a round was spent on a judgement
call rather than on a demonstrated defect.

Guessing wrong here costs a round and nothing else. Both branches start from the
same synced tree, with both sides visible and the same work to do in it, and
they differ only in who pays for it.

**One collision, one round.** A single interaction can surface twice: first as a
conflict at 8b, then, once that is resolved, as a gate failure at 8c in the same
region. That is one problem seen from two angles, and it is charged once. Before
spending a round, check whether it is the same interaction the node was already
charged for; if it is, carry on with the round already spent. Charging both would
cost a node two of its three rounds for one collision the scheduler allowed.

The test is the same counterpart node plus the same ground: the other side of the
collision is the node it collided with before, and the conflict and the gate
failure land in the same files or on the same symbol. A different counterpart, or
a failure somewhere the conflict never touched, is a second interaction and a
second round.

**When you cannot tell whether it is the same interaction, treat it as the same
one and charge nothing further.** That inverts this skill's standing "when you
cannot decide, it counts" bias, deliberately. That bias exists so an unverified
defect never ships, and nothing ships either way here: the node is in a fix round
whichever way you call it, and the only question is who pays. Guessing wrong in
this direction costs one extra round somewhere later, and you will see it happen.
Guessing wrong in the other direction puts a correct node at `blocked` for a
collision the scheduler created, which the delivery report shows as a node that
failed.

Three rounds is still three rounds. A node that spends its third on a merge or
post-merge failure takes the `blocked` status unmerged, propagates that
downstream, and keeps its worktree.

## Reopening a node that is already `done`

A `done` node's worktree and branch are gone, and its work is in the integration
branch. Several paths route findings back into such a node: a gate still red
after the reset at 8c, and every `byTask` finding from phase 3's branch review.

To reopen one:

1. Cut a fresh worktree and branch for it **from the current tip of the
   integration branch**, not from its old branch point. Its own work is already in
   that tip, along with everything that merged after it.
2. Set the node back to `review`, which is the state it was in when it last
   held work in progress. It is active again and holds its scope and resources
   again.
3. Dispatch the rework using form B in [dispatch.md](dispatch.md), since the
   original subagent is long gone. Its `<current_diff>` is that node's own
   contribution, which you recover by diffing its merge commit against that
   commit's first parent:

   ```
   git -C <integration worktree> diff <merge commit>^1 <merge commit>
   ```

   `git show <merge commit>` is the wrong command here and fails quietly. On a
   merge commit it prints a combined diff, which shows only what differs from
   every parent and is therefore empty for a clean merge: a commit header and
   nothing under it. Paste that into `<current_diff>` and the block that exists
   to stop a fresh agent starting over is empty, so it starts over. `git log -p
   <merge commit>^1..<merge commit>` reads the same range commit by commit if
   you want the messages with it.
4. Its round count continues from what it already spent. Reopening does not
   refill it.
5. When it passes, it goes through 8a, 8b and 8c again like any other node.

A node reopened this way and then exhausting its rounds takes the `blocked`
status, and its new worktree is kept under the cleanup rule below.

## When a blocked node comes back

A node blocked awaiting a reconciliation task returns when that task is `done`.
It does **not** return to `pending`. A `pending` node with satisfied dependencies
is in the ready set, and phase 2 would dispatch a fresh implementer for a node
that is already implemented, reviewed, gated and committed, throwing all of it
away.

Return it to `review` instead, which is where it was when the merge failed, and
resume at 8b. This is the one route into step 8 that does not begin at 8a, and it
is allowed only because this node's work was already committed at 8a before the
merge that conflicted, and the reconciliation's own 8a committed its part onto
the same branch. 8b's first-line check is what confirms that rather than assumes
it: if the range comes back empty, the work was never committed and you resume at
8a, not 8b.

Before merging again, bring the integration branch's current tip into the node's
branch so it is merging against what is there now rather than against what was
there when it blocked:

```
git -C <node worktree> merge --no-ff <integration branch>
```

**Run 8b's first-line check before that sync, not after.** This is the one sync
with no fix round behind it to commit it, which is why it is not `--no-commit`:
it commits itself when it merges cleanly, and that commit is one the node's
branch has and the integration branch lacks, so it makes the range non-empty by
itself. Check first and the range still answers "did this node's work get
committed"; check after and it answers "did a sync happen", which is yes in
every case including the one where the node's work was never committed at all,
and the merge then goes green on content this node did not contribute. The
premise of this section is that the work was committed at 8a, so the two orders
should give the same answer here; keeping the check first is what stops that
premise from having to be right.

If the sync itself conflicts, that is a conflict at 8b and goes to attribution
like any other. You are already in the state that section's sync produces, a
merge in progress in the node's worktree with both sides in it, so leave it
there and attribute from it; there is no second sync to run.

Rounds already spent stay spent. The trip through `blocked` does not refill the
count. What it does mean is that no round is charged for the blocking itself,
which is the point of charging nobody for a reconciliation.

This refines the general rule in [dag-contract.md](dag-contract.md) that a
cleared blocker returns a node to `pending`. That rule is right for a node blocked
before or during implementation, which is every case in shared-tree mode. A node
blocked after its implementation and review have passed returns to `review`.

## What `write_scope` is protecting in this mode

The rule does not change: do not dispatch nodes with overlapping `write_scope` in
the same pass. What it buys you does change, and the reader should know which one
they are relying on.

In shared-tree mode, overlap means concurrent corruption. Two implementers write
the same file at the same time and one of them loses, silently, mid-edit.

In worktree mode, overlap means a merge conflict later. Nothing is corrupted;
both versions exist intact on their own branches, and the second node to merge
hits the conflict.

That is a much better failure, which is why the constraint might look optional
here. Keep it anyway. A conflict surfaces at merge time, which is after both
nodes have been implemented, reviewed, and gated, so the cost of the collision
has already been paid twice over before anyone sees it. And resolving one is not
free either: it takes a sync into the node's worktree, a round spent by somebody,
and a brief that explains the other side to an agent that did not write it.
Scheduling the overlap away costs one pass.

## Cleanup

Remove a node's worktree and delete its branch when the node reaches `done`. Its
work is in the integration branch by then, so the tree holds nothing the run
still needs.

**One task is exempt: the reconciliation task created at a failed merge.** It
was dispatched into the merging node's worktree and has none of its own, so
"its" worktree and branch are somebody else's, and that somebody is `blocked`
and waiting to use them. Clean up nothing when it reaches `done`.

```
git -C <main working tree> worktree remove <node worktree>
git -C <integration worktree> branch -d <node branch>
```

Both of those refuse in the one case where refusing is right, and the refusals
are the reason to run them this way rather than reaching for the forcing flags.

`worktree remove` refuses while the tree has modified or untracked files:
`contains modified or untracked files, use --force to delete it`. For a `done`
node that is usually build output, the dependency install and generated files
setup put there, which is not evidence of anything. It can also be work that
never got committed. Tell the two apart before deciding, with `git -C <node
worktree> status --short`, and add `--force` only once you have confirmed 8c was
green for this node, which is the same thing as confirming its work is in the
integration branch. **`--force` on a node that is not `done` destroys exactly
what the rule below says to keep**, and it cannot be recovered from the
integration branch, because that node's work never reached it.

`branch -d` refuses to delete a branch that is not merged into the branch you
run it from, which is why it is run from the integration worktree: there
`error: the branch '<name>' is not fully merged` means the node's work is not in
the integration branch, and a node whose work is not in the integration branch
is not `done`. Never `-D` it to get past that. Treat it as the same discovery
8b's first-line check makes, arriving late.

Run the two commands in the order given. Run them the other way round and
`branch -d` refuses for an unrelated reason, `error: cannot delete branch
'<name>' used by worktree at '<path>'`, which says nothing at all about whether
the work is merged and reads exactly like the refusal that does.

**Keep the worktree and the branch of any node that reached `blocked`.** That
tree is the evidence: the half-finished state, the failing test, whatever the
third round left behind. It is the one artefact a person debugging the blockage
would actually want, and once it is deleted it cannot be reconstructed from the
integration branch, because that node's work never landed there.

Be clear about which half of that is protected by anything. The branch is the
backstop: `branch -d` refuses while it is unmerged, so committed work survives a
mistake. The tree is not backed by anything. `worktree remove --force` on a
blocked node deletes an in-progress merge, its conflicted files and every
uncommitted edit in them, with no refusal and no way back. That residue is
precisely what the paragraph above calls the evidence.

The tidying instinct at close-out will reach for these; do not let it. Name the
retained worktrees and branches in the delivery report so the user knows where
to look, and leave removing them to the user.

Keep the integration worktree until the run is over, including through phase 3,
which reads it. Leave it in place at the end along with the integration branch:
the user has not merged or pushed anything yet, and that branch is the deliverable.

## Phase 3

Phase 3 reviews the integration branch, once every node that reached `done` has
merged into it. Not the individual worktrees, and not the main working tree.

The full gate set at the start of phase 3 runs in the integration worktree. The
branch review's diff range is the baseline ref to the integration branch tip. The
per-task audit in lane 6 reads the same range. Findings route as they always do,
and a `byTask` finding against a `done` node reopens it by the procedure above.

## Degradation

Worktree mode is optional and nothing in this skill depends on it. Use it when
your platform can give a dispatched subagent a worktree of its own, or when it
can run a subagent against a directory you created, which is the same thing by
hand. Your per-platform wrapper says which of these applies to you, and whether
the platform does the setup and cleanup for you.

If the platform cannot do it, or you are unsure whether it can, run shared-tree
mode. That is the default, it is fully specified, and a run in it is not a
degraded run. Do not stall to ask the user which mode to use, and do not treat
the absence of worktree support as a blocker.
