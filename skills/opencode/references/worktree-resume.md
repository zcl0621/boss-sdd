# Worktree resume

On-demand. Standing rules live in [worktree-mode.md](worktree-mode.md). Merge
failure attribution lives in [worktree-merge.md](worktree-merge.md).

## Reopening a node that is already `done`

A `done` node's worktree and branch are gone, and its work is in the integration
branch. Several paths route findings back into such a node: a gate still red
after the reset at 8c, and every `byTask` finding from phase 3's branch review
that shows no wrong behaviour. A Phase 3 finding of wrong behaviour in landed
work is a bug: it becomes a new verify/fix pair
([dag-contract.md](dag-contract.md#inserting-a-bug-found-mid-flight)), not a
reopening.

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
   A `[verify]` node has no merge commit of its own: its commits landed
   inside its `[fix]` node's merge. A finding of wrong behaviour against a
   landed chain is a new verify/fix pair, as above. Any other finding against
   it reopens the fix node, and that merge commit's diff carries both halves.
4. Its obstacle ledger continues from what it already recorded. Reopening does
   not reset an episode or authorize another escalation.
5. When it passes, it goes through 8a, 8b and 8c again like any other node.

A reopened node is `blocked` only when an escalated obstacle episode remains
after its escalated repair. Its new worktree is kept under the cleanup rule below.

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

Recorded obstacle episodes remain recorded. The trip through `blocked` does not
reset an episode or authorize another escalation. No repair is recorded merely
because reconciliation blocked the node.

This refines the general rule in [dag-contract.md](dag-contract.md) that a
cleared blocker returns a node to `pending`. That rule is right for a node blocked
before or during implementation. A node blocked after its implementation and
review have passed returns to `review`.
