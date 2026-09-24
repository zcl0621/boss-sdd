# Codex platform notes

What the portable body leaves to a per-platform wrapper, answered for Codex.
Everything positive here was read out of the Codex configuration reference and
the Codex documentation on 2026-09-18 and recorded in the verified platform
facts table in the repository, under
`docs/plans/2026-09-18-boss-sdd-hardening.md`. That table is the only source
this directory is allowed to cite. It is part of the repository and not of this
installed skill, so the citations below are there for whoever audits this file
rather than for you to open at run time.

None of it has been run: nobody on this project has Codex installed. Where a
question is open, this file says so and says how to check. Do not close one of
those from memory, and do not carry a value over from the Claude Code or Cursor
columns of the model matrix.

Paths are relative to the installed skill directory: `.agents/skills/plan-sdd/`
in a project, or `$HOME/.agents/skills/plan-sdd/` for a personal install.

## Dispatching a subagent

Roles are declared in `config.toml` under `[agents.<name>]`, which accepts
exactly two keys: `config_file`, a path to a TOML config layer for that role,
and `description`. The nine declarations were merged into your `config.toml`
when this skill was installed. The template they came from,
`config.toml.example`, lives in the repository next to the sources of this file
and is not copied into the installed directory.

**What Codex does with `description` is not documented.** The source lists the
field and gives it no meaning. Whether Codex reads those strings when it picks
an agent type, whether it only shows them to a person, or both, is open. The
nine shipped descriptions are written as though they were selection guidance,
each saying what its role is for and who it is not. If Codex never model-selects
from them they are inert, which is why it was safe to write them that way, but
do not read their existence as evidence that it does.

**The call that starts a subagent is not documented here.** That Codex has
subagents and how they are declared is settled; the syntax you use to run one is
not. Use whatever your installation exposes, and when the body says to run
several lanes in parallel, issue those calls in a single message. If your
installation caps concurrency it is `agents.max_concurrent_threads_per_session`,
one of the project concurrency limits the batch rule in
[shared/references/dag-contract.md](shared/references/dag-contract.md) already
tells you to respect.

**The mechanism for waiting on a running subagent is not in the table either.**
[shared/references/dag-contract.md](shared/references/dag-contract.md) tells you
that when nothing can be dispatched you wait on the running and reviewing nodes
through your platform's subagent completion mechanism rather than polling in a
loop. What that mechanism is on Codex is not covered. Use whatever your session
gives you for awaiting a dispatched agent. The half of the instruction that
survives the gap is the negative half, so do not substitute a polling loop, and
do not treat "I have no way to wait" as grounds for calling the remaining nodes
`blocked` while subagents are still running.

**Whether a subagent can be resumed is not documented either.** The rework
message in [shared/references/dispatch.md](shared/references/dispatch.md) has
two forms and the choice turns on exactly that. Until you have confirmed resume
works here, use Form B and send the full context bundle again: every tagged
block listed at the top of that file, in the list it keeps, and not a subset of
them. Do not reconstruct that list from memory or from a count written somewhere
else. Form B to a resumable subagent wastes tokens on rounds 1 and 2. Form A to a
fresh one leaves it with no working directory, no goal, no write scope, no rules
and no acceptance commands.

**Round 3 is Form B either way, so this open question does not reach it.** The
body escalates a twice-failed node to a fresh subagent on the strongest tier,
which makes Form B correct on round 3 whether or not resume turns out to work
here. If you do later confirm resume, narrow your use of Form A to rounds 1 and 2
and leave round 3 alone.

**Whether Codex can give a subagent its own git worktree is not documented.**
[shared/references/worktree-mode.md](shared/references/worktree-mode.md) is
optional on every platform and nothing in the skill depends on it; that is not a
concession to this gap. What the gap decides is only whether Codex can be one of
the platforms that runs it. That file opens two routes into the mode: the
platform hands a dispatched subagent a worktree of its own, or you create the
directory yourself and run a subagent against it, which it calls the same thing
by hand.

The first route is undocumented and there is nothing here to test. The second is
unknown but checkable, and the check is one node's worth of work: create the
tree with `git worktree add`, put its absolute path in that node's
`<working_directory>` block, and have the node report `pwd` and
`git rev-parse --show-toplevel` before it does anything else. Both coming back
as the worktree means the route is open on your installation and
`worktree-mode.md` specifies the rest. The node working in the repository root
instead means it is not, and you found that out on one node rather than on all
of them.

**Run that check in phase 0, because the answer decides whether the run starts at
all.** The body has no shared-tree fallback: a node owns its worktree or there is
no node. If the check comes back with the subagent in the repository root, say so
and stop rather than planning a run you cannot execute. What you may not do is
conclude from this file that per-subagent worktrees work — this file does not
know, which is exactly why the check is one node's worth of work and not a
paragraph of reasoning.

**No read-only flag for an agent is documented.** Six of the nine roles change
nothing by contract: `recon-rules`, `recon-product`, `recon-code`, `reviewer`,
`branch-reviewer`, `adversary`. Cursor enforces that with a frontmatter field.
The verified facts give Codex no equivalent, so on this platform nothing holds a
lane to read-only below the prompt.

Be exact about what in the prompt carries it, because the obvious candidate is
the wrong one. It is **not** the `<forbidden>` block. That block belongs to the
full context bundle, which
[shared/references/dispatch.md](shared/references/dispatch.md) sends to
`implementer` and `ui-designer` only, and what it forbids is staging, committing
and scope creep, which are write-role concerns. The six read-only lanes never
receive it: a recon lane gets the three blocks listed in
[shared/references/recon.md](shared/references/recon.md), and a review lane gets
the short per-lane list in
[shared/references/review.md](shared/references/review.md).

What carries it is the role identity line that every dispatch prompt opens with,
taken from [shared/roles.md](shared/roles.md) -- `recon-code`'s ends "You read.
You change nothing." -- together with whatever the lane's own contract in
`recon.md` or `review.md` says. So paste that identity line verbatim rather than
paraphrasing it, and treat a read-only lane that edited a file as a finding
about the run, not a harmless accident.

## Role config layers

The four rungs of the ladder ride on reasoning effort here. The accepted efforts
are `minimal`, `low`, `medium`, `high` and `xhigh`, and `xhigh` is
model-dependent.

The verified source gives one model spelling, `gpt-5.6`. That is a spelling, not
a census: it does not establish that your installation offers only one model.
[shared/roles.md](shared/roles.md) recommends effort as the axis for this column
because effort is what the verified facts support, and it says what to do if the
premise turns out to be wrong. If your installation offers more than one model,
invert it: make the model the coarse axis, since a model change moves capability
further than an effort change, and use effort to separate rungs inside one
model. The nine layers as shipped take the effort reading, so inverting means
editing all nine.

Six keys in the `agents` namespace are global: `agents.enabled`,
`agents.interrupt_message`, `agents.max_concurrent_threads_per_session`,
`agents.max_threads` (the legacy alias of the last one),
`agents.default_subagent_model` and `agents.default_subagent_reasoning_effort`.
The last two set the default for every role at once and cannot be narrowed to
one role by writing them under `[agents.<name>]`, because that block takes only
`config_file` and `description`. Per-role tiering therefore lives in the TOML
layer `config_file` points at, one per role under `agents/`.

Not everything in the namespace is global, and it would be wrong to say so:
`agents.recon-rules.config_file` is a key in the `agents` namespace and is
per-role by construction. The claim is about those six keys and no others.

| Rung | Effort |
| --- | --- |
| reserve | `xhigh` |
| strong | `high` |
| reasoning | `medium` |
| reading | `minimal` |

Which role sits on which rung is [shared/roles.md](shared/roles.md), and it is
not repeated here; each role's own layer under `agents/` names its rung in a
comment.

Three things to know about that table.

`low` is on no rung, which is what makes it usable as the install's canary; see
the next section. The ladder has four rungs and the axis has five tokens, so one
falls out, and the reading rung is documented as the lowest. If your recon lanes
come back thin, moving `recon-rules` and `recon-code` from `minimal` to `low` is
the first adjustment to try, and it is exactly the retune
[shared/roles.md](shared/roles.md) invites at the end of its tier section. Doing
it spends the canary, so do it after the canary has answered, or move the global
default to another token no layer uses and keep one.

`xhigh` may not exist on your model, and that decides whether Codex has an
escalation step at all. Where it exists, the reserve is a genuine rung above
`high`. Where it does not, reserve collapses into `high`, escalating a node buys
nothing, and [shared/roles.md](shared/roles.md) is describing your installation
when it says not to plan an escalation you cannot perform. Check which case you
are in before a node needs it, not while one is stuck.

The reserve is not a role. Escalating one node means editing that role's layer
and dispatching again, unless your installation exposes an override at dispatch
time, which is not documented here. Put the layer back afterwards, or the whole
run quietly continues on the escalated rung.

## The canary in the global block

**Two things about a role layer are assumptions rather than facts: the key names
and the scoping.** The source says `config_file` is a path to a TOML config
layer for that role and stops there. It does not enumerate what such a layer
accepts, so the nine layers use the spellings the two settings carry in the
global namespace. And it does not say that a global key written inside a role
layer is re-scoped to that role, which is the half of the design everything else
rests on. A layer whose key names are right but which is still read globally
would leave every role on whichever layer loaded last: one rung for the whole
run, the same outcome as getting the names wrong.

What Codex does with a key it does not recognise is also not documented. It
might ignore it, and it might reject the file. This directory does not know and
will not guess.

So the install ships a canary rather than asking you to trust any of that. The
global block in `config.toml.example` is uncommented and sets:

```toml
agents.default_subagent_reasoning_effort = "low"
```

No role layer sets `low`. The nine use `minimal` twice, `medium` four times and
`high` three times. So on the first real run, with no knowledge of Codex needed
beyond reading back the effort a role actually ran at:

- **any role reporting `low`** fell through to the global default, so its layer
  did not take -- whether because the key name is unrecognised or because the
  layer does not re-scope, the tiering is not working and the run is effectively
  untiered;
- **no role reporting `low`** means the layers took.

That is the whole check, and it is one glance at one line. It replaces the
earlier instruction to check the key names against your own configuration
reference, which was not something you could act on before starting a run.

If the canary trips and you want to know which of the two failures you have, run
the differential afterwards. Set one layer -- `recon-code.toml`, say -- to a
token no other layer uses and that your model supports; `xhigh` if it exists
there, otherwise pick from the five. Dispatch that role and one `high` role and
compare what they ran at. Both on the new token means the key names work and the
scoping does not. Both on `low` means the names do not work. The new token and
`high` respectively means both work and nothing was wrong.

## The board

Status tracking runs through the `plan-sdd` MCP tools when they are there, and
the whole skill runs without them when they are not.
[shared/references/board.md](shared/references/board.md) covers both cases; take
the first step it describes, which is to check once, at the start, whether
`plan_board_status` is in your toolset.

Registering that server is an install question. The verified table has no MCP
row for any of the three platforms, so the repository's `README.md` for this
packaging gives the binary, the transport and the tool names, and sends the
installer to their own configuration reference for the syntax.

## Codex's own reviewer

Phase 3 runs two branch reviews: the skill's own six-lane fan-out, which needs
nobody at the keyboard, and the platform's native reviewer on top of it.
[shared/references/native-review-handoff.md](shared/references/native-review-handoff.md)
tells you to check whether your platform exposes the native one as something you
can invoke. For Codex that check cannot be answered from documentation.

**Documented.** `/review` exists in the Codex CLI and offers a review of
uncommitted changes or a comparison against a base branch. `review_model`
overrides the model it uses, defaulting to the current session model. On GitHub,
`@codex review` posts a review on a pull request, and Codex follows the Code
Review rules it finds in the repository's `AGENTS.md` files.

**Open.** Whether an agent can invoke `/review`, or whether it is only a command
a user types. The source records that the command exists and how to configure
its model. It says nothing about who may start it, and both readings fit what is
written.

**So check your own installation.** The procedure is the numbered check at the
top of
[shared/references/native-review-handoff.md](shared/references/native-review-handoff.md)
and is not repeated here: look for a code review entry among the skills,
commands and tools you actually have, run it if you find one, hand off to the
user if you do not, and in goal mode park it in the delivery report rather than
record it as passed.

Two things that file leaves to this one. First, until you have run that check,
assume handoff. Assuming wrongly in that direction costs one message to the
user; assuming wrongly in the other costs a review that never happened and a
report claiming it did. Second, `@codex review` acts on a pull request, and the
body forbids pushing, opening a pull request, or merging without the user's
explicit authorization, so it is not part of local close-out.

## AGENTS.md

Codex reads project instructions from `AGENTS.md`, and the verified table says
how it finds and merges them. Globally, `~/.codex/AGENTS.override.md` first,
then `~/.codex/AGENTS.md`. For a project, "Starting at the project root
(typically the Git root), Codex walks down to your current working directory",
checking each directory for `AGENTS.override.md`, then `AGENTS.md`. The merge
is additive:
"Codex concatenates files from the root down, joining them with blank lines.
Files closer to your current directory override earlier guidance because they
appear later in the combined prompt." The size limit is `project_doc_max_bytes`,
default 32 KiB.

Code Review rules live in those same files, but their scope is a separately
stated rule rather than something that falls out of that merge order, and the
rule is **root plus more specific, not nearest-wins.** Repository-wide rules go
in the root `AGENTS.md`, narrower rules in a nested file such as
`services/experiment_reporting/AGENTS.md`, and Codex applies the root guidance
together with the more specific guidance that covers each changed file. The
section heading to put them under is spelled `## Code Review Rules`, in the
`AGENTS.md` closest to the code the rules govern.

That is the one lever a project has over a reviewer this skill does not control,
whether that reviewer is `/review` locally or `@codex review` on a pull request.
A snippet written for pasting in, `AGENTS-review-rules.md`, ships in the
repository beside the sources of this file. It is not installed here, it is
optional, and it changes nothing about how the skill runs.
