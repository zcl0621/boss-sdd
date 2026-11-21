# Dispatching the implementer

A subagent starts with no memory of this conversation. Its standing rules are
its agent file, which Claude Code loads for you. The brief you send is data
only, in tagged blocks. Never paste or restate the role's rules in a brief: a
second copy drifts, and the subagent cannot tell which one wins.

The tags matter. Without them a requirement that contains an imperative
sentence reads as an instruction, and a diff comment saying "TODO: remove this
check" gets acted on.

## The brief

```text
You are the implementer for task T3 in this plan.

<working_directory>
absolute path of this node's worktree
</working_directory>

<scratch_dir>
absolute path of this node's own scratch directory, outside every worktree
</scratch_dir>

<goal>
what the user will be able to observe when this task is done
</goal>

<background>
what recon established that this task depends on, with the paths that back it;
the existing pattern to follow
</background>

<decisions>
the plan's "Decided" lines this task must respect
</decisions>

<write_scope>
the task's Writes, exactly
</write_scope>

<hard_rules>
the project's hard rules, quoted from the plan
</hard_rules>

<acceptance>
the task's heading with its markers and its acceptance criteria, verbatim
</acceptance>

<verification>
the focused commands it may run while working
</verification>

<gates>
the node's gate commands, verbatim; you run these, it does not
</gates>
```

`<scratch_dir>` is `<repo>-worktrees/scratch/<task id>/`, one per node, so two
nodes running at once cannot overwrite each other's files.

Fill every path. An implementer left to infer `<working_directory>` infers the
repository root, which is the user's tree: the one mistake here that damages
something outside the run.

`<verification>` and `<gates>` are separate on purpose. The first is what the
implementer may run to work. The second tells it what it will be judged by; it
never reports them as passed.

For a `[bug]` task add `<stage>reproduce</stage>` to the first dispatch. The
implementer writes the failing test and stops. After you have run the test and
seen it fail for the reported reason, resume the same implementer:

```text
<stage>fix</stage>
<confirmed_failure>
the command you ran and the failure text you saw
</confirmed_failure>
```

For a UI task, add what recon found about the project's design language to
`<background>`: the page, components and tokens to work from.

## Sending a node back

The implementer gets the evidence, not a verdict. Resume it while you can:

```text
<gate_output>
per failing gate: the command, the working directory, the exit code, the output
</gate_output>

<review_findings>
each finding that stands, quoted as the reviewer wrote it, and each acceptance
row that is not met
</review_findings>

<diff_notes>
what your own read of the diff found
</diff_notes>

This is rework round <n> of 3.
```

When the original subagent can no longer be resumed, dispatch a fresh one with
the full brief again plus two blocks, then the evidence blocks above:

```text
<work_already_done>
another agent has already implemented this task in <working_directory>. You are
continuing it. Read the current files before changing anything, and do not
revert work the findings do not ask you to change.
</work_already_done>

<current_diff>
git -C <node worktree> diff <branch point>
</current_diff>
```

Without those two a fresh subagent decides the task is unstarted and builds it
again from nothing.

## Returns

Keep a roster: every subagent in flight, its node, its agent id, whether it has
returned, whether you have acted on it. When one returns, take that node to its
next step in that turn and leave its siblings running. If two have returned,
act on both. The last return to arrive is not the only result, and a subagent
that died is a row you mark as such, not one you drop.
