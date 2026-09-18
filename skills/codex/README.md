# plan-sdd for Codex

The Codex packaging of the `plan-sdd` skill. It is a thin layer: the procedure
lives in [../shared/](../shared/), platform-neutral and shared with the Claude
Code and Cursor packagings. What is here is what makes that body installable and
runnable on Codex.

Every Codex fact in this directory was read out of the Codex configuration
reference and documentation on 2026-09-18 and recorded in the platform table in
[../../docs/plans/2026-09-18-boss-sdd-hardening.md](../../docs/plans/2026-09-18-boss-sdd-hardening.md).
That table is the only source these files cite. **None of it has been run:
nobody on this project has Codex installed.** Where the source is silent these
files say so, and the open questions are indexed at the end. Check the whole
directory against your own installation before trusting it.

## What is in here

| Path | What it is |
| --- | --- |
| `SKILL.md` | The skill entry point. Frontmatter is `name` and `description`, which is all Codex supports. Points at the body; holds no procedure. |
| `codex-platform.md` | The per-platform answers: subagent dispatch, the effort ladder, role config layers, the canary, the board, Codex's own reviewer, `AGENTS.md`. |
| `agents/*.toml` | Nine role config layers, one per role, each setting that role's model and reasoning effort. Named by `config_file` in the declarations. |
| `config.toml.example` | The nine `[agents.<name>]` declarations, plus the global block the canary lives in. |
| `AGENTS-review-rules.md` | An optional snippet for a project's `AGENTS.md`, since Codex takes its Code Review rules from there. |
| `shared` | A symlink to `../shared`, the portable body. Step 2 dereferences it, so the installed tree holds a real copy. |

Step 2 installs `SKILL.md`, `codex-platform.md`, `agents/` and a copy of the
body. `config.toml.example` and `AGENTS-review-rules.md` are not installed: one
is merged into your `config.toml` by hand, the other pasted into a project's
`AGENTS.md` by hand.

The `shared` entry is a symlink to `../shared`, the same convention the Claude
Code and Cursor packagings use. It is what lets the `shared/...` links inside
`SKILL.md` and `codex-platform.md` resolve in both places: here in the
repository, through the link, and in the installed directory, where step 2 has
put the real body at that path. Follow it and you are reading
[../shared/](../shared/).

## Requirements

- Codex CLI, with skills support.
- For the live board, which is optional: an Apple silicon Mac, a Swift toolchain
  and Go. The skill runs without it; see
  [../shared/references/board.md](../shared/references/board.md) for what you
  lose.

## Install

### 1. Get the repository

```bash
git clone https://github.com/zcl0621/boss-sdd.git
cd boss-sdd
```

If you already have a checkout, `cd` into it instead. The rest of this section
assumes the checkout is your working directory.

### 2. Install the skill

Pick where it goes. `$HOME/.agents/skills/plan-sdd` installs it for you
everywhere; `.agents/skills/plan-sdd` inside a project installs it for that
project.

```bash
REPO="$PWD"
SKILL_DIR="$HOME/.agents/skills/plan-sdd"   # or <project>/.agents/skills/plan-sdd

rm -rf "$SKILL_DIR"
mkdir -p "$SKILL_DIR"
cp "$REPO/skills/codex/SKILL.md"           "$SKILL_DIR/SKILL.md"
cp "$REPO/skills/codex/codex-platform.md"  "$SKILL_DIR/codex-platform.md"
cp -R  "$REPO/skills/codex/agents"         "$SKILL_DIR/agents"
cp -RL "$REPO/skills/codex/shared"         "$SKILL_DIR/shared"
```

**The `-L` on the last line is required, not stylistic.**
`skills/codex/shared` is a symlink to `../shared`, so that the `shared/...`
links in `SKILL.md` and `codex-platform.md` resolve when someone browses this
repository as well as after install. `cp -R` would copy the link itself, and the
copy would point at `$SKILL_DIR/../shared`, which does not exist: you would get
an installed tree whose `shared` is a dangling symlink, with `SKILL.md`,
`codex-platform.md` and `agents/` landed correctly and the entire body missing.
`-L` dereferences it and copies the real directory.

Keep the `rm -rf`, and keep it even when you think you know why it is there.
`cp -R src dst` creates `dst` when it does not exist and copies `src` *into* it
when it does, so the second run of these commands without the wipe produces
`agents/agents` and `shared/shared/references`. The skill then still loads, from
a tree with two copies of the body in it, one of them stale.

The body is copied whole and unmodified, which is what keeps its own internal
links working: it links to `roles.md` and `references/*.md` relative to itself,
and those paths survive the move because the directory structure came with them.

Check what landed:

```bash
find "$SKILL_DIR" -type f | sort
```

Expect these, not a total: `SKILL.md`, `codex-platform.md`, nine files under
`agents/`, and under `shared/` a `PLAYBOOK.md`, a `roles.md`, and whatever
`references/` currently holds. This step deliberately states no count for
`references/` or for the tree as a whole: a count stood here before, and it
went stale twice in one day for two unrelated reasons -- a smaller version of
the same problem [../shared/roles.md](../shared/roles.md) already names for the
dispatch context bundle, and the same fix applies: read the shape, not a
number written somewhere else. If one of the named files is missing, or a file
turns up that these commands did not put there, the install is wrong; the
listing above is what proves it.

### 3. Declare the nine roles

Merge `skills/codex/config.toml.example` into the user-level
`~/.codex/config.toml`, or into the project-level `.codex/config.toml`, which
Codex loads only for a project you trust.

**One substitution makes it work:** replace every `<SKILL_DIR>` with the value
`SKILL_DIR` expanded to in step 2 -- the absolute path, written out. Not the
literal text `$SKILL_DIR`, not `$HOME/...`, not `~/...`. TOML performs no
variable expansion, and whether Codex expands anything inside a path value is
not in the verified table, so a `config_file` that still contains a dollar sign
may be looked up exactly as written. `echo "$SKILL_DIR"` gives you the string to
paste.

Verify it before you start Codex, rather than finding out from a run:

```bash
grep -nE '^[^#]*(SKILL_DIR|\$HOME|"~)' ~/.codex/config.toml   # must print nothing
grep -c '^config_file' ~/.codex/config.toml                   # must print 9
grep -oE '^config_file = "[^"]+"' ~/.codex/config.toml | cut -d'"' -f2 |
  while read p; do [ -f "$p" ] || echo "MISSING $p"; done
```

All three anchor on real TOML lines rather than anywhere in the file, so the
commented example paths in `config.toml.example` do not trip them if you paste
the comments in too. Line 1 catches an unsubstituted placeholder or an
unexpanded variable. Line 2 counts every `config_file` in the file, so it reads
9 only if these nine roles are the only agents you have declared; adjust if you
have others. Line 3 prints one `MISSING` line per layer that is not on disk, and
prints nothing when all nine resolve. This matters because the repository cannot
tell you what Codex does with a `config_file` pointing nowhere -- error, or
silently drop the role -- so the check has to happen on your side of the run.

Model and reasoning effort are not in the declarations. `[agents.<name>]`
accepts `config_file` and `description` and nothing else, and the two settings
that carry the tier -- `agents.default_subagent_model` and
`agents.default_subagent_reasoning_effort` -- are among the six keys in the
`agents` namespace that are global. (Not the whole namespace: the nine
`agents.<role>.config_file` keys are in it and are per-role.) So per-role
tiering lives in the TOML layers under `agents/`. Those ship filled in, with
each role's rung matching [../shared/roles.md](../shared/roles.md), so there is
nothing to substitute in them.

There is one thing to know about them, and it is the reason the global block in
`config.toml.example` ships uncommented: both the key names inside a role layer
and the assumption that writing a global key there re-scopes it to that role are
unverified, and either failing looks identical from inside a run. The global
default is set to `low`, which no role layer uses, so the first run tells you
which case you are in -- any role running at `low` means its layer did not take.
`codex-platform.md`, under "The canary in the global block", is the full
explanation. Do not comment that line back out.

### 4. Register the board's MCP server, if you want the board

**The verified table does not cover MCP registration for any of the three
platforms, Codex included.** It has no MCP row. This repository cannot tell you
the `config.toml` syntax, and a config block invented here would look exactly as
convincing as a correct one. Get the syntax from your own configuration
reference.

What it can tell you is what you would be registering, all of it read out of the
code:

| | |
| --- | --- |
| Server name the skill expects | `plan-sdd` |
| Command | `/Applications/BossSDD.app/Contents/Resources/plan-sdd-mcp` |
| Arguments | none |
| Transport | stdio |
| Tools | `plan_board_status`, `plan_create_run`, `plan_update_run`, `plan_set_task`, `plan_set_tasks`, `plan_graph`, `plan_get_run`, `plan_memory_list`, `plan_memory_get`, `plan_memory_add`, `plan_memory_delete` |

Sources: `mcp/main.go` declares the server name `plan-sdd`, runs it over
`mcp.StdioTransport`, and registers those eleven tools. `Scripts/bundle.sh`
cross-compiles the Go binary, copies it to
`BossSDD.app/Contents/Resources/plan-sdd-mcp`, and installs the bundle to
`/Applications/BossSDD.app`. The root `README.md` documents the same path.

Build and install the app first, or there is no binary to point at:

```bash
./Scripts/bundle.sh --install
```

That compiles the Swift app and the Go binary, assembles `BossSDD.app` with an
ad-hoc signature, and replaces `/Applications/BossSDD.app`. Apple silicon only.
The app listens on `127.0.0.1:18888`, overridable with `BOSS_SDD_PORT`, and only
the MCP server talks to it.

**Skipping this step is a supported way to run the skill.** Without the tools it
keeps state in the plan document, loses live visibility, activity history and
cross-session recovery, and keeps scheduling correctness.
[../shared/references/board.md](../shared/references/board.md) is the authority
on that, and the skill checks once at the start and says which case it is in.

### 5. Optional: put review rules in AGENTS.md

Paste the block from [AGENTS-review-rules.md](AGENTS-review-rules.md) into your
project's `AGENTS.md` under a `## Code Review Rules` heading, and edit it to
match what the project actually believes. Codex searches the repository for
`AGENTS.md` files and applies the root guidance together with the more specific
guidance covering each changed file, so a nested file adds to the root rather
than replacing it. That snippet's own header covers the scope rule; this is how
a project steers `/review` and `@codex review`. Optional, and it changes nothing
about how the skill runs.

### 6. Check it works

Start Codex in a project and invoke the skill explicitly:

```text
$plan-sdd
```

It should read `codex-platform.md` and then the body. If the board is
registered, its first substantive step is a `plan_board_status` call.

## What the source did not cover

Eight things, so the next person knows which parts are gaps rather than
decisions. Each is argued where it bites; this is the index, not the argument.

| Gap | Where it is handled |
| --- | --- |
| MCP server registration syntax | Step 4 above, which gives the binary and tool names instead of a config block |
| What a role's TOML config layer accepts, and whether writing a global key in one re-scopes it | `codex-platform.md`, "The canary in the global block" |
| The call that starts a subagent | `codex-platform.md`, "Dispatching a subagent" |
| The mechanism for waiting on a running subagent | `codex-platform.md`, same section. [../shared/references/dag-contract.md](../shared/references/dag-contract.md) tells the orchestrator to wait on running nodes through one rather than polling; the table names none for Codex |
| Whether a subagent can be resumed, which picks between the two rework message forms | `codex-platform.md`, same section; forms are in [../shared/references/dispatch.md](../shared/references/dispatch.md) |
| Whether a subagent can be given its own git worktree | `codex-platform.md`, same section, which gives a one-node check for the route that is testable; the mode is [../shared/references/worktree-mode.md](../shared/references/worktree-mode.md) and shared-tree runs until that check passes |
| Whether an agent can invoke `/review`, or only a user | `codex-platform.md`, "Codex's own reviewer"; the skill assumes handoff until checked |
| Any read-only flag for an agent | `codex-platform.md`, "Dispatching a subagent"; the six read-only roles are held by their prompts alone |

One more that is not a documentation gap but an unverified reading: the file
position of `review_model`. `config.toml.example` puts it at config root and
says so in a comment.
