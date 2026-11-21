# Installing plan-sdd on omp

Run every command from the root of a clone of this repository. Nothing is
scripted, on purpose: the copies land in your home directory, and you should see
what goes where. Tested against omp 18.11.1.

Steps 1 to 3 give you a working skill. Step 4 adds the board and step 5 the omp
extensions; both are optional. Without the board the skill keeps its state in
the plan document.

Also optional: the `show-me` skill, which phase P uses to draw the change and
the options when it is installed. It is not carried here; copy the `SKILL.md`
of https://github.com/charlie947/show-me into `~/.omp/agent/skills/show-me/`.
Whether its page reaches your browser from an omp session was not checked.

Under a named profile (`omp --profile <name>`) the user config lives in
`~/.omp/profiles/<name>/agent/`, not `~/.omp/agent/`, for `config.yml`,
`mcp.json` and the agent directory alike. Use that directory in every step
below for a profile you run the skill under.

## 1. The skill

```bash
rm -rf ~/.omp/agent/skills/plan-sdd
mkdir -p ~/.omp/agent/skills/plan-sdd
cp -R skills/omp/. ~/.omp/agent/skills/plan-sdd/
```

The directory name must be `plan-sdd`; the skill is then invoked as
`/skill:plan-sdd`. The `rm -rf` matters on a re-install: without it, files this
version no longer has stay behind and go on being read.

If a project also has the Claude Code variant at
`<project>/.claude/skills/plan-sdd`, omp discovers that one too and keeps both
under a collision warning. Remove that directory from the project, or turn off
omp's `enableClaudeProject` source toggle.

## 2. The five role files

Each role is a file in omp's agent directory. A user agent called, say,
`implementer` may be one you wrote, so check before copying:

```bash
mkdir -p ~/.omp/agent/agents
for f in skills/omp/agents/*.md; do
  [ -e ~/.omp/agent/agents/$(basename "$f") ] && echo "exists: $(basename "$f")"
done
```

If nothing prints, copy. If something does, read those files first; `cp -n`
skips every existing file, so the ones it skipped are yours to reconcile by
hand before a run. On macOS `cp -n` exits 1 when it skips, hence the `|| true`.

```bash
cp -n skills/omp/agents/*.md ~/.omp/agent/agents/ || true
```

On a re-install of this skill you want the new files, so use plain `cp` once
the check shows the existing ones are this skill's own. For one repository
only, copy them to `<project>/.omp/agents/` instead.

That is `recon`, `implementer`, `plan-reviewer`, `qa` and `adversary`. The
reviewer role is `plan-reviewer` because omp bundles an agent named `reviewer`.

**Coming from an older install**, remove the roles this version retired:

```bash
cd ~/.omp/agent/agents && rm -f recon-rules.md recon-product.md recon-code.md ui-designer.md spec-auditor.md branch-reviewer.md
```

## 3. The model roles

Every role file names its model as an alias (`model: "@sdd-implementer"`), and
omp resolves it through `modelRoles` in its config. The `task` call has no
model field, so this is the one place the models are chosen. The five aliases
and example models are in [config.example.yml](config.example.yml).

This is a merge, not a copy; `config.yml` holds your other settings.

1. Put your own provider and model ids on the `modelRoles` entries in
   `skills/omp/config.example.yml`.
2. If your config is `config.yaml` rather than `config.yml`, use that name
   below. If `modelRoles` is written in flow-style (`modelRoles: { a: b }`),
   convert it to block style first. With no `modelRoles:` key, append the whole
   block; with one, add the `sdd-*` lines under it, leaving keys you already
   have.
3. In the `compaction:` block only `experimentalContextManagement: true` is
   live. Merge it under an existing `compaction:` key or append the block. It
   trades summary guidance on automatic compaction for Pins; see
   `plugins/omp-context/README.md`.
4. Check every alias is defined. omp passes an undefined alias on as a literal
   model pattern instead of failing:

```bash
for a in $(grep -h '^model:' ~/.omp/agent/agents/*.md | grep -o '@sdd-[a-z-]*' | sort -u); do
  grep -q "^[[:space:]]*${a#@}:" ~/.omp/agent/config.yml || echo "missing: $a"
done
```

Aliases from the older version (`sdd-recon-product`, `sdd-implementer-high`,
`sdd-escalation`, `sdd-spec-auditor`, `sdd-explore`, `sdd-architect`,
`sdd-max`) are no longer used and can be deleted, along with any
`task.agentModelOverrides` you set for it.

## 4. The board (optional)

Needs an Apple silicon Mac, a Swift toolchain and Go.

```bash
./Scripts/bundle.sh --install
```

Then register the server in `~/.omp/agent/mcp.json` under the key `plan-sdd`.
The key matters: omp mints the tool names from it
(`mcp__plan_sdd_plan_board_status`). This is a merge; the file may hold other
servers.

```bash
mkdir -p ~/.omp/agent
```

```bash
f=~/.omp/agent/mcp.json
[ -f "$f" ] || echo '{"mcpServers": {}}' > "$f"
jq -e '.mcpServers["plan-sdd"]' "$f" >/dev/null && echo "plan-sdd already registered: check it by hand" || {
  jq '.mcpServers["plan-sdd"] = {"command": "/Applications/BossSDD.app/Contents/Resources/plan-sdd-mcp"}' "$f" > "$f.new" && mv "$f.new" "$f"
}
```

Without `jq`, edit the file by hand to the same result, or run omp's
`/mcp add`. [SKILL.md](SKILL.md) says how the tools are called on omp, and
[references/board.md](references/board.md) what the skill does with them.

## 5. omp extensions (optional)

- `plugins/omp-sidebar`: a right-hand sidebar showing context, agents, jobs and
  worktrees.
- `plugins/omp-context`: restores the working set after a compaction or
  rollover.

Each README has its install steps. An older install may have left a
plan-memory reminder extension in `~/.omp/agent/extensions/omp-plan-memory/`.
This skill no longer uses the board's project memory (omp has its own memory
tools), so remove that directory.

## 6. Check

1. `diff -r skills/omp/ ~/.omp/agent/skills/plan-sdd` prints nothing.
2. In a project, omp offers `/skill:plan-sdd`.
3. Ask it to call the `task` tool with `agent: "recon"`, asking only for this
   repository's gate commands, without running the skill. An error naming an
   unknown agent means the role files are not in `~/.omp/agent/agents/`.
4. If you installed the board, `read xd://` lists the `plan_*` tools.
