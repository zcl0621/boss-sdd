# Project memory

The board's server also stores facts about the project that outlive a run, so
phase 0 does not have to rediscover them every time. This store is not the
project's own memory files; those are repository content that recon reads, and an
entry here is a claim about the project that has to name where it came from.

The four tools reaching it come and go with the rest of the `plan-sdd` tools, so
[board.md](board.md) decides which of its three cases you are in before any of
this applies.

## Turning it off

It is on wherever those four tools are registered. To turn it off, write
`Project memory: off` into the plan document's Status header in phase 0 step 1,
where [plan-spec.md](plan-spec.md) defines that line. Off means the four tools go
unused for the whole run, reading as well as writing: no listing before the recon
lanes, no claims handed to them, no tidy-up after the last merge. Recon then
establishes the gates and the run recipe from the repository, which is what it
does in a first run anyway. Nothing else in the protocol changes, and a session
resuming mid-run reads the line rather than guessing.

The switch is here rather than in one platform's packaging because all three
platforms ship something called memory and none of them does this job.

Claude Code keeps a per-project file store and it is always on, but an entry
there carries no `source`. There is nothing to open and re-read, so a claim that
went stale looks exactly like one that is still true, and there is no cap to force
the pruning that would catch it.

Codex is off by default, and what it stores sits under the Codex home directory
rather than under the project, so two repositories share it. Codex writes it
itself from earlier chats, and its own documentation says not to edit those files
by hand as the primary control surface. A run cannot put a gate command into it
and read that command back next run, which is the whole transaction this store
exists for. That documentation also says to keep rules that must always apply in
`AGENTS.md` or checked-in documentation rather than in memory, which is the same
judgement as this paragraph, made by the people who built it.

Cursor's current documentation has no memories feature at all.

So where the platform has its own and it is on, do not mirror into it. This store
holds claims about the repository that a lane can settle by opening one file:
gates, run recipes, hard rules, exclusive resources, conventions. Leave the
platform's own store to whatever it already holds. A fact written into both is a
fact that gets corrected in one of them.

| Tool | What it does |
| --- | --- |
| `plan_memory_list` | Every memory for a `project`, or only one `kind` of them. |
| `plan_memory_get` | One memory, by `project` and `key`. |
| `plan_memory_add` | Upsert on `(project, key)`. Takes `value`, `kind`, `source`. |
| `plan_memory_delete` | Remove one, by `project` and `key`. |

`project` is the repository, not the directory you happen to be working in. Use
the value you gave `plan_create_run`, every time. Worktree mode has several trees
for the one project and they share the one memory; a node's worktree path is not
a project and must never be sent as one.

`kind` is one of `gate`, `run_recipe`, `convention`, `hard_rule`,
`exclusive_resource`, `note`. The first five name what a run has to establish
before it can dispatch anything: four of them are answers phase 0 goes looking
for, and `exclusive_resource` is a field phase 1 declares on each task. `note` is
the escape hatch, and it buys the least, because nothing constrains what it says.

`source` is required and must be non-empty: a file and a line, or the command
whose output the value was read from. It is there because a stored gate command
that has since changed is worse than no memory at all, since the agent runs the
wrong gate and reports green. `source` is the difference between an entry you can
falsify with one file read and an assertion you would have to re-derive from
scratch, and it comes back on every read path.

`key` is trimmed and lower-cased before it is stored, and every tool returns the
stored form. Use what comes back, not what you sent.

There is a cap of 100 memories per project, and there is deliberately no search.
At the cap a new key is refused with an error naming the current count. Nothing
is evicted, because a `hard_rule` silently dropped to make room is worse than one
never stored; an upsert onto a key that already exists still succeeds at the cap,
so a wrong entry can always be corrected. No search means no way for a lookup to
come back empty and be read as "no such fact was ever recorded" when the fact was
filed under a key you did not think to try. `plan_memory_list` returns everything,
and the cap is what keeps that listing readable.

## Reading it, in phase 0

Call `plan_memory_list` for the project before dispatching the recon lanes.

Everything it returns is a claim. It was true in some earlier run, of a
repository that has been edited since. Recon is what turns a claim into evidence,
and the lanes are what do it: hand each entry, `source` included, to the lane
that owns its kind, in the `<extra_context>` block [recon.md](recon.md) defines.
That file carries the routing, because it is what the person briefing the lane is
reading.

What memory buys is a lookup in place of a search, and what it must never buy is
a lane you skipped. All three lanes run on every run, with or without a stored
answer. Memory changes what they are told and never whether they are dispatched.
A lane skipped because the store already had the answer is how a gate command
gets read out of a file that no longer contains it.

## Which entries you may act on before a lane confirms them

The question to ask of an entry is what a wrong one costs, and whether acting on
it would reveal the error.

**Re-check before use: `gate`, `run_recipe`, `hard_rule`.** These are the values
you execute, or that you report a result from. A replaced gate command usually
still runs: the project moved its suite and the old command now passes over
nothing, so the failure arrives as a green report rather than as an error. A
stale run recipe brings something up, and the `qa` lane walks through the wrong
application and records real observations of it. A `hard_rule` the project has
since dropped is you enforcing a constraint nobody asked for, and one that
changed quietly is worse.

None of the three goes into the plan document, into a dispatch prompt, or into a
gate run until the owning lane has come back with a verdict on it and the line as
it reads in the repository today, quoted. [roles.md](../roles.md) makes that the
lane's delivery obligation, which is what turns the re-check into something you
can check rather than something you hope happened: an entry the lane did not
mention, or marked `confirmed` without quoting the line, is unexamined. Treat an
unexamined claim exactly as you would treat no memory at all, and let whatever
the lane found on its own stand instead.

**Act on directly: `exclusive_resource`, `convention`.** A stored
`exclusive_resource` is honoured as declared while recon is still running. Being
wrong in that direction costs parallelism and nothing else, and the opposite
mistake corrupts a run, so this is the one entry worth over-trusting. A
`convention` is about how this codebase is written: layout, naming, test
placement, style. It steers an implementer toward a pattern the project already
has, and a stale one produces a mismatch that the independent review and your own
read of the diff are there to catch.

A `convention` is not about how the run is run. A fact that would steer your own
scheduling instead, such as whether the tests can run concurrently or how large a
batch may be, is not covered by that justification and does not get acted on
directly: nothing downstream reviews your batching, so the review and the diff
read are both downstream of the damage a bad batch does. Lane A answers the
concurrency question every run, and its answer is the one to use.

**Never act on directly: `note`.** Nothing constrains what a note says, so it has
the standing of a sentence somebody left in a comment. Read it as a lead.

### The bucket follows the content, not the label

`kind` was chosen by an agent in some earlier run, and the store checks only that
it is one of the six. Nothing checks that the value matches. So read the value
before you trust the label: if it is a command you would execute, or a rule you
would paste into a prompt, it belongs in the re-check bucket whatever `kind` it
carries.

`{key: "how-to-run-the-app", kind: convention, value: "./scripts/dev.sh --seed"}`
is a run recipe filed under the wrong label. Routed by its label it is acted on
directly, reaches the `qa` brief, which [roles.md](../roles.md) says goes to that
lane verbatim, and is executed. Route it by its content, and correct `kind` on
the upsert that records the re-check.

### Settling an entry against the verdict it came back with

A lane returns one of four verdicts per claim ([roles.md](../roles.md) defines
them in its delivery contracts). What each one does to the stored entry:

| Verdict | What it means | What you do with the entry |
| --- | --- | --- |
| `confirmed` | the lane opened `source` and quoted the line | leave it as it stands |
| `changed` | the source still exists and now says something else | upsert the same key with the lane's value and this run's `source` |
| `gone` | the file or target named by `source` is not there any more | delete it |
| `unchecked` | the lane could not open `source` at all | leave it alone, and do not use it this run |

Anything not in that table is unexamined and is treated as no memory at all: an
entry the lane never mentioned, and one marked `confirmed` with no quoted line.

When a lane's evidence and an entry disagree, the lane wins and the entry is
stale. Correct it with an upsert onto the same key carrying this run's `source`.
Do not add a second key for a fact that already has one, and do not leave the old
value standing on the grounds that the lane might have missed something.

`unchecked` and `gone` are the pair to keep apart. `gone` is a finding: the lane
looked where `source` points and there is nothing there, so the entry has nothing
left to be true about. `unchecked` is the absence of a finding, and deleting on
it throws away a fact that may well still hold, on the strength of a lane's
permissions rather than the repository's contents. Unverified is not refuted, and
next run a deleted entry and a fact nobody ever recorded look identical.

## Writing it

Store a fact when three things hold: it is about the project rather than about
this run, you expect it to be true the next time somebody plans work here, and
you can name where it came from. Two moments are the natural ones. After phase
0's merge, with recon's evidence in hand. And at close-out, when the run has
learned things recon did not know.

Store what recon had to work for. A gate command sitting on the first line of the
obvious file costs less to read than to keep honest, and storing it spends a slot
against the cap for nothing. The real test command hidden behind three Makefile
targets, with a plausible decoy next to it, is what a `gate` entry is for.

Never store:

- Anything true of this run alone: the run id, the base ref, branch names, the
  execution mode, which nodes blocked. The plan document holds all of it already
  -- the first four in its Status header, the last in its Tasks section
  ([plan-spec.md](plan-spec.md)) -- and that document is what a later session
  reads to pick the work back up. A memory entry here would be a second copy
  that goes stale the moment the run moves on.
- A value whose provenance you cannot name. The tool refuses an empty `source`,
  which makes the temptation a specific one: writing a plausible-looking path in
  to get the write through. That is worse than not storing the fact at all,
  because it produces an entry that looks checkable and is not, and the next
  tidy-up reads that file, finds nothing resembling the value, and deletes
  something that may well have been true.
- The development accounts and credentials recon lane C collects as part of the
  run recipe. A `run_recipe` entry holds the commands, the port, the fixture
  step, and a `source` pointing at where the project documents the accounts.

When `plan_memory_add` is refused because the project is at 100, that is the
tidy-up below arriving late. Run it, then retry the write once. Do not clear
space for the entry in your hand, by deletion or by upsert; what goes is decided
by the rules below, not by what you happen to be holding.

## The tidy-up

A memory nobody prunes stops being memory and becomes a pile of assertions about
a repository that has moved on. Prune it on a schedule rather than when it occurs
to you.

**Trigger.** After every fifth node reaches `done` or `blocked`, counted
cumulatively across scheduling passes rather than per pass, so the fifth one
closes whenever it closes. Also once at close-out, before the delivery report,
and immediately whenever a write is refused at the cap.

In worktree mode a node reaches `done` at step 8c while it still holds the merge
lock, and that lock stops the whole run rather than just the merging. Run the
tidy-up after releasing it, not at the instant the node closes. See
[worktree-mode.md](worktree-mode.md).

It dispatches nothing and writes no code, so it costs a scheduling pass nothing.
It does read files, and which tree it reads them in is a real choice: in worktree
mode, read them in the integration worktree, whose absolute path is in the plan
document's Status header. The main working tree sits at the user's pre-run state
and the node worktrees hold work that has not merged, so the same `source` can
read as supported in one of them and unsupported in another. In shared-tree mode
there is one tree and the question does not arise.

**What it does.** Call `plan_memory_list` and read the whole list. With no search
that is the only way to see what is in there, and it is what the cap exists to
keep possible. Then, per entry:

1. Check the `source`. Open the file, or look at where the command is defined. If
   the file is gone, or nothing at that source resembles the value, the entry is
   unsupported: delete it.
2. Check it against what this run has established. A finding with evidence behind
   it beats a stored claim, so upsert the corrected value onto the same key with
   this run's `source`.
3. Check that it still describes something that exists. An entry about a
   subsystem the repository no longer has goes.

Then count what is left. From 90 up, say so in the progress report. The next
`plan_memory_add` is going to be refused, and the refusal lands on whoever is
writing at that moment rather than on whoever filled the store.

**What it must not do.**

- **Do not delete an entry because nothing in this run used it.** The `hard_rule`
  covering a subsystem this plan never went near is exactly the entry that pays
  for itself two runs from now. Usage tells you which parts of the repository
  this plan touched. It tells you nothing about whether a fact is true, and
  `source` is the only thing that does.
- **Do not delete to make room.** If every entry checks out and the store is
  still at the cap, that is a real result: report it and name the entries that
  look most dispensable. In confirm mode the user decides which goes. In goal
  mode this is a parked question like any other, and it is the rare one that
  blocks no task, because a full store costs the next run a search and costs this
  run nothing. Evicting for space is the one thing the cap was built to refuse.
- **Do not upsert a fact onto a key that names a different fact.** An upsert
  succeeds at the cap where a new key is refused, and it replaces that entry's
  value, its kind and its source, leaving nothing of what was there. Writing a
  new fact onto an unrelated key is therefore eviction wearing a correction's
  clothes, and no refusal stands in the way of it. An upsert corrects the entry
  its key already names, and nothing else.
- **Do not delete an entry you could not check.** A `source` inside a submodule
  that is not checked out, or behind a path you cannot read this run, leaves the
  entry unverified, and unverified is not refuted. Leave it, and say which ones
  you left that way. Next run, a deleted entry and a fact nobody ever recorded
  look identical.
- **Change a `source` only together with a fresh read of the value at the new
  source**, and report both the new source and the line you read there. A source
  moved on its own is the one edit that makes a wrong entry permanently
  uncheckable, because every later tidy-up will then check the value against a
  file chosen to agree with it.

Deleting a memory is cheap and safe once you have checked it, and the rules above
are what "checked" means. Without them a delete is silent, and the fact it
removed does not come back.

## When the tools are not there

With no tools there is no memory. Phase 0 runs exactly as [recon.md](recon.md)
describes it, and every answer comes out of the repository, which is where they
come from in a run with memory too, because the lanes always run. The cost is
search time and nothing else, so a run without memory is a normal run and not a
degraded one. [board.md](board.md) covers the rest of the posture.

What is specific to memory: do not invent a substitute. A file in the repository
holding the same facts is a store nobody maintains, with no cap and nothing
requiring a `source`, which is the stale unfalsifiable thing this whole file
exists to prevent.
