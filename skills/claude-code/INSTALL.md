# Installing plan-sdd on Claude Code

Start from a clone of this repository, with your shell in its root. Every command
below is written to be run from there. Nothing is scripted for you on purpose:
the copies land outside the repository, in your home directory and in whatever
project you want the skill to work on, and you should see exactly what goes
where.

Steps 1 to 3 give you a working skill. Step 4 adds the board and is optional:
without it the skill keeps its state in the plan document instead, which
[the board reference](references/board.md) describes as the normal state for
anyone who installed the skill without the MCP server.

`skills/claude-code/` is the whole skill: every link inside it points at another
file inside it, so the same links open in the clone and in the installed copy.
Repository files that are not installed are cited as plain paths, never linked:
`README.md`, `Scripts/bundle.sh`, `mcp/main.go`.

## What you need

- Claude Code.
- For step 4 only: an Apple silicon Mac, a Swift toolchain, and Go. The board app
  is Apple silicon only by design; see `README.md` in the repository.
- Optional: the `prompt-engineer` and `shuorenhua` skills, which the skill
  loads for the dispatch preflight and for phase P messages when they are
  installed, and works without. This repository carries both, under
  `skills/prompt-engineer/` and `skills/shuorenhua/`; install each the way step
  2 installs this one, into `~/.claude/skills/<name>/`.

## 1. Where the skill goes

`~/.claude/skills/plan-sdd/`. The directory name must be `plan-sdd`, matching the
`name` in the frontmatter of [SKILL.md](SKILL.md); explicit invocation is then
`/plan-sdd`.

That is the only skill location this document covers. A project-level install
is not described here; if you use one, the role files in step 3 do not depend on
where the skill lives, since they carry their rules themselves.

## 2. Install the skill

The installed skill has to stand on its own, so it goes in as files rather than
as a link out of the clone. One copy does it:

```bash
rm -rf ~/.claude/skills/plan-sdd
mkdir -p ~/.claude/skills/plan-sdd
cp -R skills/claude-code/. ~/.claude/skills/plan-sdd/
```

The `rm -rf` makes a re-install idempotent. Without it `cp` merges into what is
already there, so a file renamed or dropped from the body upstream stays in your
installed tree and goes on being read.

That is silent. Step 5's first command is what makes it visible; run it after
every install rather than trusting the sentence above.

What you should have afterwards:

```text
~/.claude/skills/plan-sdd/
  SKILL.md        the entry point: frontmatter, and the Claude Code bindings
  PLAYBOOK.md     the method: start here when running the skill
  roles.md        the ten roles, the model bindings, obstacle episodes
  INSTALL.md      this file
  agents/         the ten role definitions, as installed in step 3
  references/     the reference files, native-review.md among them
```

The skill is copied unmodified, which is what keeps its internal links
resolving. Do not rename anything inside it. To pick up a change, re-run the
three commands above rather than editing the installed copy; an edit made there
is lost at the next install and never reaches the repository.

`PLAYBOOK.md` is not a second skill. It carries no frontmatter and is not
an entry point, which its own opening paragraph says: nothing discovers it, and
you reach it only from `SKILL.md`, which names the skill and its invocation.
Invoke `/plan-sdd`; there is nothing else to confuse it with.

## 3. Install the ten role files

The skill dispatches subagents by role name, and each role is a file in
`.claude/agents/`. Copy all ten into the project you want to run the skill on:

```bash
mkdir -p <project>/.claude/agents
cp skills/claude-code/agents/*.md <project>/.claude/agents/
```

That is ten files: `recon-rules`, `recon-product`, `recon-code`, `implementer`,
`ui-designer`, `qa`, `reviewer`, `spec-auditor`, `branch-reviewer`, `adversary`.
The roster is fixed. Do not add an eleventh and do not rename one; the playbook
dispatches these names.

Each file is that role's standing rules, which Claude Code loads as the
subagent's system prompt; the skill's dispatch briefs carry data only and rely on
them. So an out-of-date role file in a project is an out-of-date rule set for
every subagent of that role: re-copy all ten whenever you re-install the skill.

**If the project has an older install**, remove the retired file the copy above
does not overwrite:

```bash
rm -f <project>/.claude/agents/spec-reviewer.md
```

`spec-reviewer` became `spec-auditor`. A leftover `spec-reviewer.md` is never
dispatched, but it is still offered as an agent type in that project.

Repeat this step per project. This document covers the project's
`.claude/agents/` only.

Each role file declares a model in frontmatter, and the skill also passes the
model bound in the "Model bindings" table of [roles.md](roles.md) as the `model`
field of every fresh `Agent` call, so the routing does not depend on the
frontmatter being read. To retune models, change that table, not the files.

**One thing to know before step 5.** These files use the frontmatter keys
`name`, `description` and `model`. `name` matters: if your installation keys off
something else, `subagent_type` may resolve to nothing. Each file's `name` is
identical to its filename, so either convention finds it, but step 5 checks it
for real rather than trusting that.

## 4. Install and register the board (optional)

Build the app and the MCP binary, and install the app:

```bash
./Scripts/bundle.sh --install
```

This compiles the Swift app and the Go MCP server, assembles `BossSDD.app` with
an ad-hoc signature, and replaces `/Applications/BossSDD.app`. The MCP binary
ships inside the bundle, so installing the app installs the agent interface too.
Source: `Scripts/bundle.sh` and `README.md` in the repository.

Register it with Claude Code:

```bash
claude mcp add --scope user plan-sdd /Applications/BossSDD.app/Contents/Resources/plan-sdd-mcp
```

Source: `README.md` in the repository, which carries that command verbatim; the
binary path is the one `Scripts/bundle.sh` copies into the bundle. Where your
installation registers MCP servers differently, its documentation wins over this
one.

That registration exposes thirteen tools, named in `mcp/main.go`:

| Tool | What it does |
| --- | --- |
| `plan_board_status` | app state plus every run on this machine; starts the app if needed |
| `plan_create_run` | create a run, returns the `run_id` |
| `plan_update_run` | change the plan's overall status or summary |
| `plan_set_tasks` | write the whole DAG at once |
| `plan_set_task` | create or update one task |
| `plan_graph` | read-only graph projection |
| `plan_get_run` | every task plus the projection |
| `plan_delete_run` | delete one run with its tasks and events; irreversible |
| `plan_delete_task` | delete one task from a run; irreversible |
| `plan_memory_list` | every memory for a project, or only one kind of them |
| `plan_memory_get` | one memory, by project and key |
| `plan_memory_add` | upsert a memory on `(project, key)` |
| `plan_memory_delete` | remove one memory, by project and key |

Your client may present them under a namespace of its own. Match on these names.

[The board reference](references/board.md) covers what the skill does when
they are present, when the app will not start, and when they are absent
altogether. All three are handled; none of them stops a run.

## 5. Check the install

Do all four. The first needs only a shell and is the one to repeat after every
re-install; the rest need a live session.

1. **Compare the installed tree against the clone**, from the repository root:

   ```bash
   diff -r skills/claude-code/ ~/.claude/skills/plan-sdd
   ```

   Silence means they match, and the wording of anything printed says which
   break you have. `Only in ~/.claude/skills/plan-sdd/...` is a file the clone no
   longer carries, left behind by a re-install without the `rm -rf`. A diff hunk
   on a named file is an edit somebody made to the installed copy, which the next
   install will discard. `Only in skills/claude-code/...` is a file the install
   is missing.
2. Start Claude Code in the project from step 3 and confirm `/plan-sdd` is
   offered.
3. **Dispatch one role and confirm it runs.** In that project, ask for exactly
   this:

   > Dispatch a subagent with `subagent_type: "recon-rules"` and `model:
   > "haiku"`, asking it only to name this repository's gate commands and the
   > files it read them from. Do not run the plan-sdd skill.

   A subagent that comes back having read the repository means the role file was
   found and `subagent_type` resolved. An error naming an unknown agent type
   means it was not: check that the ten files landed in the project's
   `.claude/agents/`, and if they did, that your installation reads the `name`
   key rather than some other one.
4. If you did step 4, confirm the `plan_*` tools appear in the session's toolset.
   The skill checks this itself at the start of every run, so a missing board is
   reported rather than fatal.
