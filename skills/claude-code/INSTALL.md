# Installing plan-sdd on Claude Code

Start from a clone of this repository, with your shell in its root. Every command
below is written to be run from there. Nothing is scripted for you on purpose:
the copies land outside the repository, in your home directory and in whatever
project you want the skill to work on, and you should see exactly what goes
where.

Steps 1 to 3 give you a working skill. Step 4 adds the board and is optional:
without it the skill keeps its state in the plan document instead, which
[the board reference](shared/references/board.md) describes as the normal state
for anyone who installed the skill without the MCP server.

Two conventions, so nothing in here misleads you:

- **Every markdown link beginning `shared/` opens in either tree.** In the clone
  it goes through `skills/claude-code/shared`, a symlink to `skills/shared/`; in
  the installed skill step 2 replaces that symlink with the body itself. Both
  spellings are the same file, which is why one set of links serves both.
- **Repository files that are not installed are cited as plain paths**, never
  linked: `README.md`, `Scripts/bundle.sh`, `mcp/main.go`.

## What you need

- Claude Code.
- For step 4 only: an Apple silicon Mac, a Swift toolchain, and Go. The board app
  is Apple silicon only by design; see `README.md` in the repository.

## 1. Where the skill goes

`~/.claude/skills/plan-sdd/`. The directory name must be `plan-sdd`, matching the
`name` in the frontmatter of [SKILL.md](SKILL.md); explicit invocation is then
`/plan-sdd`.

That is the only skill location this packaging uses. The verified platform facts
it was built against give exactly one skills path for Claude Code,
`~/.claude/skills/<name>/`, and no project-level equivalent, while listing two
paths for other platforms. The omission looks deliberate, so this document does
not invent a project-level install. If your installation does support one, you
are on your own for it, and note before you try: the nine role files in step 3
refer to the body by its absolute installed path, so they would all need
rewriting too.

## 2. Install the skill

The installed skill has to stand on its own, so the body goes in as files rather
than as a link out of the clone. One copy does it, because the wrapper already
carries the `shared` symlink:

```bash
rm -rf ~/.claude/skills/plan-sdd
mkdir -p ~/.claude/skills/plan-sdd
cp -RL skills/claude-code/. ~/.claude/skills/plan-sdd/
```

`-L` is what makes that one command enough: it follows the symlink and writes the
body's files into `~/.claude/skills/plan-sdd/shared/`. Plain `cp -R` copies the
link itself, and the installed `shared` is then a dangling pointer to a
`skills/shared` that does not exist under `~/.claude/skills/`, so every
`shared/...` link in the installed skill opens nothing.

The `rm -rf` makes a re-install idempotent. Without it `cp` merges into what is
already there, so a file renamed or dropped from the body upstream stays in your
installed tree and goes on being read.

Both of those are silent. Step 5's first command is what makes them visible;
run it after every install rather than trusting either sentence above.

What you should have afterwards:

```text
~/.claude/skills/plan-sdd/
  SKILL.md                      the entry point: frontmatter, and the platform bindings
  INSTALL.md                    this file
  agents/                       the nine role definitions, as installed in step 3
  references/native-review.md   whether /code-review is invocable here
  shared/PLAYBOOK.md            the portable body: start here when running the skill
  shared/roles.md               the nine roles and the model routing
  shared/references/            the body's reference files, copied whole
```

The body is copied unmodified, which is what keeps its own internal links
resolving. Do not rename anything inside `shared/`. To pick up a change to the
body, re-run the three commands above rather than editing the installed copy; an
edit made there is lost at the next install and never reaches the repository.

`shared/PLAYBOOK.md` is not a second skill. It carries no frontmatter and is not
an entry point, which its own opening paragraph says: nothing discovers it, and
you reach it only from the wrapper that names the skill and its invocation.
Invoke `/plan-sdd`; there is nothing else to confuse it with.

## 3. Install the nine role files

The skill dispatches subagents by role name, and each role is a file in
`.claude/agents/`. Copy all nine into the project you want to run the skill on:

```bash
mkdir -p <project>/.claude/agents
cp skills/claude-code/agents/*.md <project>/.claude/agents/
```

That is nine files: `recon-rules`, `recon-product`, `recon-code`, `implementer`,
`ui-designer`, `qa`, `reviewer`, `branch-reviewer`, `adversary`. The roster is
fixed. Do not add a tenth and do not rename one; the body dispatches these names.

Repeat this step per project. The verified facts name `.claude/agents/<name>.md`
and no user-level equivalent, so whether a home-directory copy also works is
something to check against your own installation rather than to assume here.

Each role file declares its model in frontmatter, and the skill also passes that
tier as the `model` field of the `Agent` call, so the routing does not depend on
the frontmatter being read. The routing table is the Claude Code column of
[shared/roles.md](shared/roles.md).

**One thing to know before step 5.** The verified facts name the location of
these files and the two `Agent` fields, but not the frontmatter keys inside them.
These files use `name`, `description` and `model`. `model` is belt-and-braces, as
above. `name` is not: if your installation expects a different key, or keys off
the filename instead, then `subagent_type` may resolve to nothing. Each file's
`name` is identical to its filename, so either convention finds it, but step 5
checks it for real rather than trusting that.

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
binary path is the one `Scripts/bundle.sh` copies into the bundle. **The verified
platform table has no MCP row, for Claude Code or for any other platform**, so
this line rests on this repository's own documentation and not on that table.
Where your installation registers MCP servers differently, its documentation
wins over this one.

That registration exposes seven tools, named in `mcp/main.go`:

| Tool | What it does |
| --- | --- |
| `plan_board_status` | app state plus every run on this machine; starts the app if needed |
| `plan_create_run` | create a run, returns the `run_id` |
| `plan_update_run` | change the plan's overall status or summary |
| `plan_set_tasks` | write the whole DAG at once |
| `plan_set_task` | create or update one task |
| `plan_graph` | read-only graph projection |
| `plan_get_run` | every task plus the projection |

Your client may present them under a namespace of its own. Match on these names.

[The board reference](shared/references/board.md) covers what the skill does when
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
   install will discard. `diff: ~/.claude/skills/plan-sdd/shared: No such file or
   directory` is the dangling symlink you get from `cp -R` without `-L`.

   Read the output, not the exit status. Only the first two of those exit
   non-zero; the dangling symlink exits 0 and puts its one line on stderr, so a
   check wired to `$?` alone reports the broken install as clean.
2. Start Claude Code in the project from step 3 and confirm `/plan-sdd` is
   offered.
3. **Dispatch one role and confirm it runs.** In that project, ask for exactly
   this:

   > Dispatch a subagent with `subagent_type: "recon-rules"` and `model:
   > "haiku"`, asking it only to name this repository's gate commands and the
   > files it read them from. Do not run the plan-sdd skill.

   A subagent that comes back having read the repository means the role file was
   found and `subagent_type` resolved. An error naming an unknown agent type
   means it was not: check that the nine files landed in the project's
   `.claude/agents/`, and if they did, that your installation reads the `name`
   key rather than some other one.
4. If you did step 4, confirm the `plan_*` tools appear in the session's toolset.
   The skill checks this itself at the start of every run, so a missing board is
   reported rather than fatal.
