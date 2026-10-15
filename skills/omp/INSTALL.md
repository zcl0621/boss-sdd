# Installing plan-sdd on omp

Start from a clone of this repository, with your shell in its root. Every command
below is written to be run from there. Nothing is scripted for you on purpose:
the copies land outside the repository, in your home directory and in whatever
project you want the skill to work on, and you should see exactly what goes
where.

Steps 1 to 4 give you a working skill. Step 5 adds the board and is optional:
without it the skill keeps its state in the plan document instead, which
[the board reference](references/board.md) describes as the normal state for
anyone who installed the skill without the MCP server. Step 6 adds omp
extensions, also optional.

`skills/omp/` is the whole skill: every link inside it points at another file
inside it, so the same links open in the clone and in the installed copy.
Repository files that are not installed are cited as plain paths, never linked:
`README.md`, `Scripts/bundle.sh`, `mcp/main.go`. omp's own documentation is
cited by URL, under `https://github.com/can1357/oh-my-pi`, because it is not in
this repository.

## What you need

- omp (`oh-my-pi`), tested against 18.11.1 (the release binary).
- For step 5 only: an Apple silicon Mac, a Swift toolchain, and Go. The board app
  is Apple silicon only by design; see `README.md` in the repository.
- Optional: the `prompt-engineer` and `shuorenhua` skills, which the skill
  loads for the dispatch preflight and for phase P messages when they are
  installed, and works without. This repository carries both, under
  `skills/prompt-engineer/` and `skills/shuorenhua/`; install each the way step
  1 installs this one, into `~/.omp/agent/skills/<name>/`.
- Optional: the `show-me` skill, which phase P uses to render the P1
  before/after and the P4 options when it is installed, and works without. It
  is not carried here; copy the `SKILL.md` of
  https://github.com/charlie947/show-me into `~/.omp/agent/skills/show-me/`.
  Whether its page reaches your browser from an omp session was not checked.

## 1. Install the skill

omp finds a skill at `~/.omp/agent/skills/<name>/SKILL.md`, one level under
`skills/` (`https://github.com/can1357/oh-my-pi/blob/main/docs/skills.md`). The directory name must be `plan-sdd`,
matching the `name` in the frontmatter of [SKILL.md](SKILL.md); explicit
invocation is then `/skill:plan-sdd`.

```bash
rm -rf ~/.omp/agent/skills/plan-sdd
mkdir -p ~/.omp/agent/skills/plan-sdd
cp -R skills/omp/. ~/.omp/agent/skills/plan-sdd/
```

The `rm -rf` makes a re-install idempotent. Without it `cp` merges into what is
already there, so a file renamed or dropped upstream stays in your installed
tree and goes on being read. Step 7's first command is what makes that visible;
run it after every install.

The copy includes `test/`, which is harmless and keeps the diff in step 7 clean.
What you should have afterwards:

```text
~/.omp/agent/skills/plan-sdd/
  SKILL.md             the entry point: frontmatter, and the omp bindings
  PLAYBOOK.md          the method: start here when running the skill
  roles.md             the ten roles, the model bindings, obstacle episodes
  INSTALL.md           this file
  config.example.yml   example modelRoles (step 3)
  agents/              the ten role definitions, as installed in step 2
  references/          the reference files, native-review.md among them
  test/                the skill's own tests
```

If a project also has the Claude Code variant at `<project>/.claude/skills/plan-sdd`,
omp discovers that one too: omp reads Claude project skills by default, and two
different skills with one name are both kept, the lower-priority one under a
`<namespace>/plan-sdd` name with a collision warning (`https://github.com/can1357/oh-my-pi/blob/main/docs/skills.md`,
"Collision and duplicate handling"). To avoid the second copy, remove that
directory from the project, or turn off the `enableClaudeProject` source toggle
(same page, "source toggles").

Do not rename anything inside it. To pick up a change, re-run the three commands
above rather than editing the installed copy; an edit made there is lost at the
next install and never reaches the repository.

`PLAYBOOK.md` is not a second skill. It carries no frontmatter and nothing
discovers it; you reach it only from `SKILL.md`.

## 2. Install the ten role files

The skill dispatches subagents by role name, and each role is a file in omp's
agent directory. Install them for your user, so every project sees them:

Copying overwrites any file of the same name, and a user agent called, say,
`implementer` is probably one you wrote. Check first:

```bash
mkdir -p ~/.omp/agent/agents
for f in skills/omp/agents/*.md; do
  [ -e ~/.omp/agent/agents/$(basename "$f") ] && echo "exists: $(basename "$f")"
done
```

If nothing prints, copy. If something does, read those files, then either move
yours aside or use `cp -n`, which skips every existing file; that leaves your
file in place and the playbook dispatching your version of the role, so report
which ones were skipped and reconcile them by hand before a run.

```bash
cp -n skills/omp/agents/*.md ~/.omp/agent/agents/ || true
```

On macOS `cp -n` exits 1 when it skips a file, so the `|| true` keeps a chained
command going; the files it skipped are the ones to report.

On a re-install of this skill you want the new role files, so use plain `cp`
there, after the same check shows the existing ones are this skill's own.

For one repository only, copy them to `<project>/.omp/agents/` instead
(`mkdir -p <project>/.omp/agents` first). omp does not read `.claude/agents/`
(`https://github.com/can1357/oh-my-pi/blob/main/docs/task-agent-discovery.md`), so an existing Claude Code install does
not carry over.

That is ten files: `recon-rules`, `recon-product`, `recon-code`, `implementer`,
`ui-designer`, `qa`, `plan-reviewer`, `spec-auditor`, `branch-reviewer`,
`adversary`. The roster is fixed. Do not add an eleventh and do not rename one;
the playbook dispatches these names. The reviewer role is `plan-reviewer`
because omp bundles an agent named `reviewer`, which a same-named file would
shadow ([roles.md](roles.md)).

Each file is that role's standing rules, which omp loads as the subagent's system
prompt; the skill's dispatch briefs carry data only and rely on them. Re-copy all
ten whenever you re-install the skill.

## 3. Set the model roles

Every role file names its model as an alias, `model: "@sdd-implementer"` and so
on, and omp resolves an alias through `modelRoles` in its config. The `task`
call has no model field, so this is the one place the models are chosen. The
aliases and the example models are in [config.example.yml](config.example.yml),
and the table that maps each binding to an alias is under "Model bindings" in
[roles.md](roles.md).

This is a merge, not a copy: `config.yml` holds your other settings, so do not
replace it. Exactly:

1. Open `skills/omp/config.example.yml` and put your own provider and model ids
   on the `modelRoles` entries.
2. If your config is `config.yaml` rather than `config.yml`, use that file name in
   every command here. If `modelRoles` is written in flow-style
   (`modelRoles: { a: b }`), convert it to block style or edit it by hand, since
   the `sdd-*` lines cannot be added under it as written. If
   `~/.omp/agent/config.yml` has no `modelRoles:` key, append the whole
   `modelRoles:` block. If it has one, add the `sdd-*` lines from the example
   under it at the same indentation, one key each. A key that already exists
   (for example `sdd-recon`) stays as you have it.
3. The `task:` block in the example is commented out and does not belong in
   `~/.omp/agent/config.yml`: any `task.agentModelOverrides` entry (the
   implementer's, or phase P's `scout`) outranks the agent's own model for
   every dispatch while it is set, so the whole block goes in the project's
   `<project>/.omp/config.yml` only, per dispatch, as `config.example.yml` and
   [roles.md](roles.md) say. In
   the `compaction:` block only `experimentalContextManagement: true` is live;
   merge it under an existing `compaction:` key, or append the block; the
   threshold lines stay commented out unless you want a cap. Keeping it trades
   summary guidance on automatic compaction for Pins (see
   `plugins/omp-context/README.md`); delete the line if you want the guidance
   more than Pins.
4. Check that every `@sdd-*` alias the agent files use is defined; omp passes an
   undefined alias on as a literal model pattern instead of failing, and the
   dispatch then runs on whatever that matches:

```bash
for a in $(grep -h '^model:' ~/.omp/agent/agents/*.md | grep -o '@sdd-[a-z-]*' | sort -u); do
  grep -q "^[[:space:]]*${a#@}:" ~/.omp/agent/config.yml || echo "missing: $a"
done
```

No output means every alias is defined. Under a named profile (`omp --profile
<name>`) the user config lives in `~/.omp/profiles/<name>/agent/`, not in
`~/.omp/agent/`, for `config.yml`, `mcp.json` and the agent directory alike
(`https://github.com/can1357/oh-my-pi/blob/9d81cd1/docs/config-usage.md`, "Profiles", line 78); use that directory in
steps 2, 3 and 5 for a profile you run the skill under.

## 4. Check that omp sees the agents

Start omp in any project and open its agent list (`/agents`), or ask it to
dispatch one role with `task`, as step 7 does. If a role is missing, check the
file's `name` against its filename and that it sits in `~/.omp/agent/agents/`.

## 5. Install and register the board (optional)

Build the app and the MCP binary, and install the app:

```bash
./Scripts/bundle.sh --install
```

This compiles the Swift app and the Go MCP server, assembles `BossSDD.app` with
an ad-hoc signature, and replaces `/Applications/BossSDD.app`. The MCP binary
ships inside the bundle, so installing the app installs the agent interface too.
Source: `Scripts/bundle.sh` and `README.md` in the repository.

Make sure the directory exists, then register the server by adding it to
`~/.omp/agent/mcp.json`, under the
key `plan-sdd`. The key matters: omp mints the tool names from it
(`mcp__plan_sdd_plan_board_status`), and the plan-memory extension in step 6 and
[the board reference](references/board.md) both expect `plan-sdd`. This is a
merge: the file may already hold other servers.

```bash
mkdir -p ~/.omp/agent
```

The entry to add is

```json
"plan-sdd": { "command": "/Applications/BossSDD.app/Contents/Resources/plan-sdd-mcp" }
```

under `mcpServers`. If the file does not exist, create it as
`{"mcpServers": {}}` first. With `jq`, this adds the entry and leaves every other
server alone, and refuses to overwrite an existing `plan-sdd`:

```bash
f=~/.omp/agent/mcp.json
[ -f "$f" ] || echo '{"mcpServers": {}}' > "$f"
jq -e '.mcpServers["plan-sdd"]' "$f" >/dev/null && echo "plan-sdd already registered: check it by hand" || {
  jq '.mcpServers["plan-sdd"] = {"command": "/Applications/BossSDD.app/Contents/Resources/plan-sdd-mcp"}' "$f" > "$f.new" && mv "$f.new" "$f"
}
```

Without `jq`, edit the file by hand to the same result, or run omp's `/mcp add`
and pick the user level. The binary path is the one `Scripts/bundle.sh` copies
into the bundle (the same path `README.md` registers for Claude Code). The file
shape is omp's, from `https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md`. A project-level
`<project>/.omp/mcp.json` works too.

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

omp mounts MCP tools behind `write` as `xd://` devices by default, so they may
not appear as top-level functions. `read xd://` lists them, and
`read xd://mcp__plan_sdd_plan_board_status` shows a tool's schema ([SKILL.md](SKILL.md)
has the calling convention). Match on the `plan_*` names.

[The board reference](references/board.md) covers what the skill does when
they are present, when the app will not start, and when they are absent
altogether. All three are handled; none of them stops a run.

## 6. omp extensions (optional)

Three extensions from this repository suit a plan-sdd run on omp. None is needed
by the skill.

- The sidebar, `plugins/omp-sidebar`: a right-hand sidebar showing context,
  agents, jobs and worktrees. Its README says how to install it
  (`~/.omp/agent/extensions/sidebar/`).
- The plan-memory reminder, `plugins/omp-plan-memory`: reminds the orchestrator
  to read, write and tidy the board's project memory. It needs the board server
  key `plan-sdd` from step 5. Its README has the install steps.
- The context extension, `plugins/omp-context`: restores the working set after
  a compaction or rollover. Its README says how to install it
  (`~/.omp/agent/extensions/omp-context/`).

## 7. Check the install

Do all four. The first needs only a shell and is the one to repeat after every
re-install; the rest need a live session.

1. **Compare the installed tree against the clone**, from the repository root:

   ```bash
   diff -r skills/omp/ ~/.omp/agent/skills/plan-sdd
   ```

   Silence means they match, and the wording of anything printed says which
   break you have. `Only in ~/.omp/agent/skills/plan-sdd/...` is a file the
   clone no longer carries, left behind by a re-install without the `rm -rf`. A
   diff hunk on a named file is an edit somebody made to the installed copy,
   which the next install will discard. `Only in skills/omp/...` is a file the
   install is missing.
2. Start omp in a project and confirm `/skill:plan-sdd` is offered.
3. **Dispatch one role and confirm it runs.** In that project, ask for exactly
   this:

   > Call the `task` tool with `agent: "recon-rules"`, asking it only to name
   > this repository's gate commands and the files it read them from. Do not
   > run the plan-sdd skill.

   A subagent that comes back having read the repository means the role file was
   found. An error naming an unknown agent means it was not: check that the ten
   files landed in `~/.omp/agent/agents/`.
4. If you did step 5, confirm the `plan_*` tools are reachable with
   `read xd://`. The skill checks this itself at the start of every run, so a
   missing board is reported rather than fatal.
