# Worktree cleanup

On-demand. Standing rules live in [worktree-mode.md](worktree-mode.md). Do not
remove a blocked node's tree; that rule is restated below.

## Cleanup

Remove a node's worktree and delete its branch when the node reaches `done`,
except a `[verify]` node (the reproduction half of a bug fix's red-test
chain): keep its tree and branch until its `[fix]` node reaches `done` and
has merged. If the fix node is `blocked`, the verify tree stays too. Until then the verify node's work is
not in the integration branch, and the fix node's tree was cut from that
branch. After the fix node's 8c, the pair is in the integration branch:
remove both trees and delete both branches by the commands below.

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
last repair of the unresolved obstacle episode left behind. It is the one artefact a person debugging the blockage
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

