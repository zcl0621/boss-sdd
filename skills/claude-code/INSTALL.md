# Installing plan-sdd on Claude Code

Run every command from the root of a clone of this repository. Nothing is
scripted, on purpose: the copies land in your home directory and in the project
you want to work on, and you should see what goes where.

Steps 1 and 2 give you a working skill. Step 3 adds the board and is optional;
without it the skill keeps its state in the plan document.

Also optional: the `show-me` skill, which phase P uses to draw the change and
the options when it is installed. It is not carried here; copy
`skills/show-me/SKILL.md` from https://github.com/charlie947/show-me into
`~/.claude/skills/show-me/`.

## 1. The skill

```bash
rm -rf ~/.claude/skills/plan-sdd
mkdir -p ~/.claude/skills/plan-sdd
cp -R skills/claude-code/. ~/.claude/skills/plan-sdd/
```

The directory name must be `plan-sdd`, matching the `name` in
[SKILL.md](SKILL.md); the skill is then invoked as `/plan-sdd`. The `rm -rf`
matters on a re-install: without it, files this version no longer has stay
behind and go on being read.

## 2. The five role files

The skill dispatches subagents by role name, and each role is a file in the
project's `.claude/agents/`. Per project:

```bash
mkdir -p <project>/.claude/agents
cp skills/claude-code/agents/*.md <project>/.claude/agents/
```

That is `recon`, `implementer`, `reviewer`, `qa` and `adversary`. Each file is
that role's standing rules, loaded as the subagent's system prompt, so re-copy
them whenever you re-install the skill.

**Coming from an older install**, remove the roles this version retired; the
copy above does not delete them, and they would still be offered as agent
types:

```bash
cd <project>/.claude/agents && rm -f recon-rules.md recon-product.md recon-code.md ui-designer.md spec-auditor.md spec-reviewer.md branch-reviewer.md
```

Which model each role runs on is the table in [SKILL.md](SKILL.md). The skill
passes it on every dispatch, so change the table, not the frontmatter.

## 3. The board (optional)

Needs an Apple silicon Mac, a Swift toolchain and Go.

```bash
./Scripts/bundle.sh --install
```

```bash
claude mcp add --scope user plan-sdd /Applications/BossSDD.app/Contents/Resources/plan-sdd-mcp
```

The first builds `BossSDD.app` with the MCP binary inside it and installs it to
`/Applications`. The second registers the server, which exposes the `plan_*`
tools [references/board.md](references/board.md) describes.

## 4. Check

1. `diff -r skills/claude-code/ ~/.claude/skills/plan-sdd` prints nothing.
2. In the project, Claude Code offers `/plan-sdd`.
3. Ask it to dispatch a subagent with `subagent_type: "recon"`, asking only for
   this repository's gate commands, without running the skill. An error naming
   an unknown agent type means the role files are not in `.claude/agents/`.
4. If you installed the board, the `plan_*` tools appear in the session.
