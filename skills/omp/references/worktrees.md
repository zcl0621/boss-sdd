# Worktrees

Every node works in its own git worktree, on its own branch, and its work
reaches the rest of the plan by merging. There is no mode in which nodes share
a tree.

Two things about this read backwards:

- Isolating files does not isolate ports, devices, databases or test locks. The
  task's `Locks` do that alone.
- Green in a node's own tree says the node works alone. It is `done` only after
  it is merged and gated on the merged result.

## Before the first tree

**Check `git worktree add` works here**, in phase 0. If it does not, say what
you ran and what it returned, and stop. There is no fallback.

**Check the main working tree is clean.** Uncommitted work is in no node's tree
and in nothing that merges, so the run would deliver a branch built on a base
the user's tree does not match. If it is dirty:

- Confirm mode: say what is uncommitted and ask the user to commit or stash it.
  If they commit, that commit is the base ref now; re-record it in the plan
  before cutting anything.
- Goal mode: stop before any dispatch and say why. This is one of the few
  things goal mode stops for.

Never commit or stash the user's changes yourself.

The plan document is written after this check and is the one file the run
puts in the main tree. It is the run's own, not the user's uncommitted work:
leave it uncommitted there, and do not count it as dirt on a resume.

## Three kinds of tree

- **The main working tree.** The user's. Never checked out to another branch,
  never merged into, never gated.
- **The integration worktree.** The integration branch, checked out in its own
  tree. Every merge, every post-merge gate and all of phase 3 happen here.
- **One worktree per node.** The implementer, the reviewer, the walkthrough and
  the node's first gate run all work here.

Put every tree in the sibling directory `<repo>-worktrees/`, never inside the
repository, where it would show up as untracked in the user's `git status`.
**Every path in the commands below is absolute.** With `git -C <main tree>`, a
relative path resolves inside the repository, which is exactly the wrong place.

## Setup

Once, at the start of phase 2:

```
git -C <main tree> worktree add -b sdd/<slug> <repo>-worktrees/integration <base ref>
```

Write the branch name and both absolute paths into the plan's header.

Per node, at dispatch:

```
git -C <main tree> worktree add -b sdd/<slug>-<id> <repo>-worktrees/<id> sdd/<slug>
git -C <repo>-worktrees/<id> rev-parse HEAD
```

Cut from the **current tip of the integration branch**, not from the base ref:
a node's dependencies are `done`, which means merged, and cutting from the tip
is what hands it their work. The second command's output is the node's
**branch point**, the baseline for its diff. Record it.

A new tree needs what a fresh checkout needs (dependency install, build,
generated files). Do that yourself before dispatching, so a setup failure is
not charged to the node.

## Closing a node: commit, merge, gate

In this order. An uncommitted worktree has a branch that still points at its
branch point; merge it and you merge nothing, the gate passes on unchanged
content, and the node is `done` having contributed no code.

**1. Commit, in the node's tree.** You make this commit, never the implementer,
and you make it for every node whatever the project's commit conventions are:
it is how the work leaves the tree.

```
git -C <node tree> add -- <the task's Writes>
git -C <node tree> commit -m "<message>"
```

Never `git add -A` or `git commit -a`, which would sweep in anything the node
wrote outside its scope. If `git status` there shows changes the node did not
report, stop and find out why.

**2. Check there is something to merge.**

```
git -C <integration tree> log --oneline sdd/<slug>..sdd/<slug>-<id>
```

Empty output: go back to step 1.

**3. Merge, one node at a time.** From here until this node is `done` or its
merge is undone, dispatch nothing: a tree cut while the tip is moving has the
wrong base.

```
git -C <integration tree> rev-parse HEAD          # the pre-merge commit; keep it
git -C <integration tree> merge --no-ff sdd/<slug>-<id>
git -C <integration tree> rev-parse HEAD          # must differ from the pre-merge commit
```

**4. Gate, in the integration tree.** The node's gates again, on the merged
result. Green: the node is `done`; clean up. Red: next section.

## When the merge does not go green

**A conflict at step 3.** Abort it (`git -C <integration tree> merge --abort`)
and resume dispatching. Then put both sides where the node's implementer can
see them:

```
git -C <node tree> merge --no-commit --no-ff sdd/<slug>
```

It conflicts the same way and git leaves it in progress. Send the node back
with the conflict as the finding, naming the task whose merged work it collided
with and quoting that task's goal. Its branch point for diffs is now the
integration tip you merged in. You never resolve a conflict yourself, and no
subagent resolves one with only one side visible. Before the next commit, check
no markers survived: `git -C <node tree> diff --check` must not report
`leftover conflict marker`. This costs the node one rework round.

**A red gate at step 4.** Undo the merge and run the gate again:

```
git -C <integration tree> reset --hard <pre-merge commit>
```

Reset, not `git revert`: a revert leaves git believing the node's work is
merged, so its next merge would bring back only the fix and silently drop the
rest. The reset is safe because the integration branch is local, never pushed,
and nothing was cut from the commit you are discarding.

- Green after the reset: the failure came in with this merge. Sync the tip into
  the node's tree as above and send the node back with the gate output. One
  rework round.
- Still red after the reset: the integration branch was already broken, and
  this node is not at fault and is charged nothing. Start no further merges.
  Add a `[bug]` task for the failure, run it through phase 2, and resume
  merging once the branch is green.

## Cleanup

When a node is `done`:

```
git -C <main tree> worktree remove <node tree>
git -C <integration tree> branch -d sdd/<slug>-<id>
```

In that order. Both commands refuse when refusing is right. `worktree remove`
refuses on modified or untracked files; look at `git status --short` there, and
add `--force` only when what is left is build output and step 4 was green.
`branch -d` refuses an unmerged branch, which means the node is not `done`;
never use `-D` to get past it.

**Keep the tree and branch of every `blocked` node.** They are the evidence of
what went wrong, and they cannot be rebuilt from the integration branch because
that work never landed. Name them in the delivery report.

Keep the integration worktree and branch at the end. The user has not merged or
pushed anything, and that branch is the deliverable.
