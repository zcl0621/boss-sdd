# Project memory

The board's server also stores facts about the project that outlive a run, so
phase 0 does not have to rediscover them every time. This store is not the
project's own memory files; those are repository content that recon reads, and an
entry here is a claim about the project that has to name where it came from.

The four tools reaching it are `plan_memory_list`, `plan_memory_get`,
`plan_memory_add` and `plan_memory_delete`. Failure semantics (upsert by
key, cap refuses a new key, delete of a missing key is an error, empty
list is not proof) live on the MCP descriptions. This file owns when to
call them, which claims may be acted on before recon, and tidy-up. They
come and go with the rest of the `plan-sdd` tools, so [board.md](board.md)
decides which of its three cases you are in before any of this applies.
"The four tools" throughout this file means those four and not the board's
other nine.

## Turning it off

It is on wherever those four tools are registered. To turn it off, write
`Project memory: off` into the plan document's Status header in phase 0 step 1,
where [plan-spec.md](plan-spec.md) defines that line. Off means the four tools go
unused for the whole run, reading as well as writing: no listing before recon,
no claims handed to it, no tidy-up after the last merge. Recon then
establishes the gates and the run recipe from the repository, which is what it
does in a first run anyway. Nothing else in the protocol changes, and a session
resuming mid-run reads the line rather than guessing.

This store is the plan-sdd board memory. It is not chat history, and
it is not a project memory file in the repository. Those repository files
are content recon reads. An entry here is a claim that has to name where it
came from, so the next run can open that source and settle it.

Do not mirror these entries into any other store. This store holds claims
about the repository that recon can settle by opening one file: gates, run
recipes, hard rules, exclusive resources, conventions. A fact written into
two stores is a fact that gets corrected in one of them.

`project` is the repository, not the directory you happen to be working in. Use
the value you gave `plan_create_run`, every time. A run has several trees
for the one project and they share the one memory; a node's worktree path is not
a project and must not be sent as one.

`kind` is one of `gate`, `run_recipe`, `convention`, `hard_rule`,
`exclusive_resource`, `note`. Route by what the value says, not by the label
it was filed under. `source` is required. `key` is stored lower-cased; use
what comes back. Cap is 100 per project, no search, no eviction to make
room: at the cap, tidy-up then retry once.

## Reading it, in phase 0

Call `plan_memory_list` for the project before dispatching recon.

Everything it returns is a claim. It was true in some earlier run, of a
repository that has been edited since. Recon is what turns a claim into evidence:
hand every entry, `source` included, to the one `recon` agent, in the tagged
block [recon.md](recon.md) defines. That file routes each claim to a *section*
(Rules, Product, Code), because it is what the person briefing recon is reading.

What memory buys is a lookup in place of a search, and what it must not buy is
a recon section you skipped. Recon runs once on every run, with or without a
stored answer, and returns all three sections. Memory changes what it is told
and does not change whether it is dispatched. Skipping recon because the store already had
the answer is how a gate command gets read out of a file that no longer contains
it.

## Which entries you may act on before recon confirms them

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
gate run until recon has come back with a verdict on it and the line as it reads
in the repository today, quoted. The `recon` agent's delivery contract is
what turns the re-check into something you can check rather than something
you hope happened: an entry recon did not mention, or marked `confirmed`
without quoting the line, is unexamined. Treat an unexamined claim exactly
as you would treat no memory at all, and let whatever recon found on its
own stand instead.

**Act on directly: `exclusive_resource`, `convention`.** A stored
`exclusive_resource` is honoured as declared while recon is still running. Being
wrong in that direction costs parallelism and nothing else, and the opposite
mistake corrupts a run, so this is the one entry worth over-trusting. A
`convention` is about how this codebase is written: layout, naming, test
placement, style. It steers an implementer toward a pattern the project already
has, and a stale one produces a mismatch that the independent review and your own
read of the diff are there to catch. It reaches the implementer in the dispatch
prompt's `<background>` block, among findings that have been confirmed this run;
[dispatch.md](dispatch.md) says how to mark it there so it is not read as one of
them.

A `convention` is not about how the run is run. A fact that would steer your own
scheduling instead, such as whether the tests can run concurrently or how large a
batch may be, is not covered by that justification and does not get acted on
directly: nothing downstream reviews your batching, so the review and the diff
read are both downstream of the damage a bad batch does. The Rules section
answers the concurrency question every run, and its answer is the one to use.

**Do not act on directly: `note`.** Nothing constrains what a note says, so it has
the standing of a sentence somebody left in a comment. Read it as a lead.

### The bucket follows the content, not the label

`kind` was chosen by an agent in some earlier run, and the store checks only that
it is one of the six. Nothing checks that the value matches. So read the value
before you trust the label: if it is a command you would execute, or a rule you
would paste into a prompt, it belongs in the re-check bucket whatever `kind` it
carries.

`{key: "how-to-run-the-app", kind: convention, value: "./scripts/dev.sh --seed"}`
is a run recipe filed under the wrong label. Routed by its label it is acted on
directly, reaches the `qa` brief verbatim, and is executed. Route it by its
content, and correct `kind` on the upsert that records the re-check.

### Settling an entry against the verdict it came back with

Recon returns one of four verdicts per claim (defined in the `recon` agent's
delivery contract). What each one does to the stored entry:

| Verdict | What it means | What you do with the entry |
| --- | --- | --- |
| `confirmed` | recon opened `source` and quoted the line | leave it as it stands |
| `changed` | the source still exists and now says something else | upsert the same key with recon's value and this run's `source` |
| `gone` | the file or target named by `source` is not there any more | delete it |
| `unchecked` | recon could not open `source` at all | leave it alone, and do not use it this run |

Anything not in that table is unexamined and is treated as no memory at all: an
entry recon never mentioned, and one marked `confirmed` with no quoted line.

When recon's evidence and an entry disagree, recon wins and the entry is stale.
Correct it with an upsert onto the same key carrying this run's `source`. Do not
add a second key for a fact that already has one, and do not leave the old value
standing on the grounds that recon might have missed something.

One recon, one verdict per claim. `changed` is the verdict that requires a line
that differs from the claim; `confirmed` can be faked by transcribing the claim
back as the quote, which is the one failure no downstream step can detect.
Treat `confirmed` without a quoted line as unexamined.

`unchecked` and `gone` are the pair to keep apart. `gone` is a finding: recon
looked where `source` points and there is nothing there, so the entry has nothing
left to be true about. `unchecked` is the absence of a finding, and deleting on
it throws away a fact that may well still hold, on the strength of permissions
rather than the repository's contents. Unverified is not refuted, and next run a
deleted entry and a fact nobody ever recorded look identical.

## Writing it

Store a fact when three things hold: it is about the project rather than about
this run, you expect it to be true the next time somebody plans work here, and
you can name where it came from. Two moments are the natural ones. After recon
returns, with its evidence in hand. And at close-out, when the run has learned
things recon did not know.

Store what recon had to work for. A gate command sitting on the first line of the
obvious file costs less to read than to keep honest, and storing it spends a slot
against the cap for nothing. The real test command hidden behind three Makefile
targets, with a plausible decoy next to it, is what a `gate` entry is for.

Do not store:

- Anything true of this run alone: the run id, the base ref, branch names and
  tree paths, which nodes blocked. The plan document holds all of it already
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
- The development accounts and credentials recon's Code section collects as part of the
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

A node reaches `done` at step 8c while it still holds the merge
lock, and that lock stops the whole run rather than just the merging. Run the
tidy-up after releasing it, not at the instant the node closes. See
[worktree-merge.md](worktree-merge.md).

It writes no code. Opening every entry's `source` yourself would pull up to a
hundred files into your own context, so hand that part to one `explore` call
(binding `explore.post_commit_scan`): give it the list with each `source`, and
have it return per entry `supported` / `unsupported` / `unreadable` with the
line it read. You make the decisions below from that table. Which tree it reads
in is a real choice: read them in the integration worktree, whose absolute path
is in the plan document's Status header. The main working tree sits at the
user's pre-run state and the node worktrees hold work that has not merged, so the
same `source` can read as supported in one of them and unsupported in another.
The close-out tidy-up reads there too. A tidy-up before phase 2 setup (a write
refused at the cap during phase 0 or 1) has no integration worktree yet and
reads the main working tree, which is the run's state at that point.

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
  look most dispensable. In confirm mode the user decides which goes. In unattended
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
come from in a run with memory too, because recon always runs. The cost is
search time and nothing else, so a run without memory is a normal run and not a
degraded one. [board.md](board.md) covers the rest of the posture.

What is specific to memory: do not invent a substitute. A file in the repository
holding the same facts is a store nobody maintains, with no cap and nothing
requiring a `source`, which is the stale unfalsifiable thing this whole file
exists to prevent.
