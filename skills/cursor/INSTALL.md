# Installing the plan-sdd skill on Cursor

This directory is the Cursor packaging of the `plan-sdd` skill. It is a
distribution source, not a live install: Cursor does not read `skills/cursor/`.
Copy it into place with the steps below.

```
skills/cursor/
  SKILL.md        the Cursor wrapper; becomes .cursor/skills/plan-sdd/SKILL.md
  INSTALL.md      this file; not installed
  shared -> ../shared   symlink to the platform-neutral body
  agents/         nine subagent definitions; become .cursor/agents/*.md
  BUGBOT.md       optional review rules; becomes .cursor/BUGBOT.md at the repo root
```

The `shared` symlink points at `skills/shared/`, the platform-neutral body that
all three packagings share. It exists so the wrapper's `shared/...` links resolve
when you browse this repository, and so one copy command installs the body.
Dereference it when you copy: `cp -RL`, not `cp -R`.

The body's entry file is `PLAYBOOK.md`, not a second `SKILL.md`, and it carries
no frontmatter. That is a decision, not a prediction: nothing in the verified
platform facts this packaging was built on covers what Cursor would do with a
`SKILL.md` nested inside an installed skill, and a packaging that never creates
one never has to find out. Do not rename it back.

## Before you start

- A clone of this repository. Below, `$REPO` is its path.
- The project you want to run the skill in. Below, `$TARGET` is its path. It can
  be the same as `$REPO`, but then `.cursor/skills/plan-sdd/shared/` is a second
  physical copy of the body sitting inside this repository, untracked and not
  ignored, and easy to commit by accident. Either add that path to `.gitignore`
  first, or install at the user level instead (see step 1).
- Cursor, with a plan that gives you the models in the roster (see
  [SKILL.md](SKILL.md)). If your plan does not offer one of them, edit that role's
  `model` after installing.
- For the optional board only: a Mac on Apple silicon, a Swift toolchain, and Go.

Set them once:

```bash
REPO=<path to your clone of this repository>
TARGET=<path to the project you want to run plan-sdd in>
```

## Step 1: install the skill

```bash
if [ -z "$REPO" ] || [ -z "$TARGET" ]; then
  echo "REPO and/or TARGET is empty: set them (see 'Before you start') and re-run"
else
  mkdir -p "$TARGET/.cursor/skills/plan-sdd"
  cp "$REPO/skills/cursor/SKILL.md" "$TARGET/.cursor/skills/plan-sdd/SKILL.md"
  rm -rf "$TARGET/.cursor/skills/plan-sdd/shared"
  cp -RL "$REPO/skills/cursor/shared" "$TARGET/.cursor/skills/plan-sdd/shared"
fi
```

**The guard is why the `rm -rf` is safe, and it is not decoration.** `REPO` and
`TARGET` are shell variables, set once above and gone the moment you open a new
terminal. Run the bare `rm -rf "$TARGET/.cursor/skills/plan-sdd/shared"` in a
shell where `TARGET` is unset and the path it deletes is
`/.cursor/skills/plan-sdd/shared`, at the filesystem root. Paste the block whole,
guard included, every time; it is written as one `if` so that pasting it whole is
also what makes it safe.

**The `rm -rf` itself is load-bearing.** Within `$TARGET` it deletes only the
copy of the body that this step made, and nothing of yours lives under that path.
Without it, the second run of this step does not overwrite the first: `cp -R`
onto an existing directory copies *into* it, so you end up with
`.cursor/skills/plan-sdd/shared/shared/` and a wrapper whose `shared/...` links
point at a directory whose contents moved one level down.

A second failure is worth naming because it looks like the same thing and is not.
`cp` never deletes. If you deviate from the command above by writing the
merge-into form, `cp -RL "$REPO/skills/cursor/shared/" "$TARGET/.../shared/"` with
the trailing slashes, the copy merges into what is already there, and a file the
body dropped or renamed upstream survives in the install next to its replacement,
where it can be read instead of the current file. The `rm -rf` removes that
outcome too, and step 5 checks for it directly rather than taking the command's
word for it.

The directory name has to be `plan-sdd`: Cursor requires the `name` in the
frontmatter to match the parent folder name, and the frontmatter says `plan-sdd`.
Do not name it `cursor`.

To install it for every project instead of one, use `~/.cursor/skills/plan-sdd/`
as the destination, with the same block. Cursor reads eight skill locations in
all, listed in the wrapper's "Two installations in one project". Pick one of them
and use only it.

## Step 2: install the roles

```bash
mkdir -p "$TARGET/.cursor/agents"
cp "$REPO/skills/cursor/agents/"*.md "$TARGET/.cursor/agents/"
```

Nine files, one per role. They are not optional and they are not renameable: the
shared body dispatches these nine names.

`~/.cursor/agents/` is documented too, so a user-level install of the roles is an
option in the same way as a user-level install of the skill. Keep the two
together: roles in `~/.cursor/agents/` with the skill in `.cursor/skills/` works,
but it makes the pair harder to find and harder to remove.

Same-name subagents have a documented precedence, unlike skills: project beats
user, and `.cursor/` beats `.claude/` or `.codex/`. So these nine files, in this
project's `.cursor/agents/`, win over anything of the same name left behind by
another packaging. That resolves the conflict; it does not make the duplicate
harmless, for the reasons in the wrapper's "Two installations in one project".

## Step 3, optional: the board

The skill runs without the board. Skip this step and it takes the no-board path
in `shared/references/board.md`, keeping state in the plan document instead.

Build and install the menu bar app, which carries the MCP server inside its
bundle:

```bash
cd "$REPO"
./Scripts/bundle.sh --install
```

That builds the Swift app and the Go MCP binary, assembles `BossSDD.app` with an
ad-hoc signature, then **kills any running BossSDD and replaces
`/Applications/BossSDD.app`**. The MCP server lands at
`/Applications/BossSDD.app/Contents/Resources/plan-sdd-mcp`. It speaks stdio,
registers itself as `plan-sdd`, and exposes seven tools: `plan_board_status`,
`plan_create_run`, `plan_update_run`, `plan_set_task`, `plan_set_tasks`,
`plan_graph`, `plan_get_run`. The app listens on `127.0.0.1:18888`, overridable
with `BOSS_SDD_PORT`; the MCP server is the only thing that talks to it.

**How to register that binary with Cursor is not something this packaging can
tell you.** The verified platform table this packaging is built on covers skills,
subagents, models and review, and has no row for MCP registration on any
platform. Nobody here has Cursor installed to check. So this repository ships no
Cursor MCP configuration, and rather than print a plausible-looking config block
that nobody has run, it says: register
`/Applications/BossSDD.app/Contents/Resources/plan-sdd-mcp` as a stdio MCP server
the way your version of Cursor's own MCP documentation says to, then confirm the
seven tool names above appear in a session.

For reference, the registration this repository does document is Claude Code's,
in the root `README.md`, and it is a `claude mcp add` command. It is not
transferable.

## Step 4, optional: review rules

```bash
cp "$REPO/skills/cursor/BUGBOT.md" "$TARGET/.cursor/BUGBOT.md"
```

`.cursor/BUGBOT.md` at the repository root is where Cursor's native reviewer reads
its rules; the file itself opens by saying which copies get loaded. What it holds
is the skill's own review standard, written for Bugbot, so that a Bugbot run and
the skill's own reviewers judge by the same thing.

This one changes review behaviour for everybody working in the repository, not
just for you, so agree it with the project before committing it. If the project
already has a `.cursor/BUGBOT.md`, merge rather than overwrite.

## Step 5: verify

In the same shell, with `REPO` and `TARGET` still set:

```bash
ls "$TARGET/.cursor/skills/plan-sdd/SKILL.md" \
   "$TARGET/.cursor/skills/plan-sdd/shared/PLAYBOOK.md" \
   "$TARGET/.cursor/skills/plan-sdd/shared/roles.md"
ls "$TARGET/.cursor/agents/" | wc -l
diff -r "$REPO/skills/cursor/shared/" "$TARGET/.cursor/skills/plan-sdd/shared" \
  && echo "INSTALLED BODY MATCHES SOURCE"
```

Expect the three files, `9`, and the `INSTALLED BODY MATCHES SOURCE` line.

The `diff -r` is the check that matters, and it is deliberately not a check for
one named file. It compares the whole installed body against the source, so it
catches every way this step goes wrong at once: a `shared/` nested inside
`shared/` from a run without the `rm -rf` (reported as `Only in ...: shared`), a
file that was renamed or dropped upstream and survived a merge-style copy
(`Only in` the install), a truncated copy, and a local edit somebody made to the
installed body instead of to the source. A check written against one historical
filename would have confirmed nothing about any of those.

If it reports differences, redo step 1 as written, with the guard and the
`rm -rf`, and run the `diff -r` again. If `Only in` names something under the
install that you put there on purpose, you have edited the installed copy: move
the change into `skills/shared/` in the repository, or it disappears at the next
install.

If `shared` came out as a dangling symlink, you used `cp -R` instead of `cp -RL`;
delete it and redo step 1.

Then in Cursor: type `/plan-sdd` and confirm the skill loads. Confirm the nine
roles appear wherever your version lists subagents. If you did step 3, confirm
the seven `plan_` tools are in the session's toolset.

## Do not install two packagings in one project

The argument is in the wrapper's "Two installations in one project", which is
also the copy a running agent has: Cursor reads the other two platforms' skill
and subagent directories as well as its own, this repository ships three
packagings of the same skill, and same-name *skills* have no published
precedence. The short version for install time: one packaging per project, and if
you find a second one, do not reason about which copy answers, because nothing
documents that.

Check before you install and after, from `$TARGET`:

```bash
find . -path '*/skills/*' -name SKILL.md -exec grep -l '^name: plan-sdd' {} +

for d in ~/.cursor/skills ~/.agents/skills ~/.claude/skills ~/.codex/skills; do
  if [ -d "$d" ]; then echo "== $d"; ls -1 "$d"; else echo "== $d: no such directory"; fi
done

for d in .cursor/agents .claude/agents .codex/agents ~/.cursor/agents ~/.claude/agents ~/.codex/agents; do
  if [ -d "$d" ]; then echo "== $d"; ls -1 "$d"; else echo "== $d: no such directory"; fi
done
```

The `find` matches on the `name:` in the frontmatter rather than on the folder
name, which is what makes it a check rather than a formality: a copy installed
under some other folder name still declares `name: plan-sdd` and still turns up.
Whether Cursor loads such a copy at all is a separate question nobody here can
answer, because the frontmatter `name` is required to match the parent folder and
that copy's does not. Either way you want to know it is on disk.

The two loops print a line per directory whether or not it exists, so a silent
result cannot be mistaken for a clean one. `no such directory` is a real answer;
an empty listing under a directory that exists is a different real answer.

More than one `plan-sdd` skill, or a role name appearing in two agent
directories, is the finding. Keep exactly one packaging per project. If teammates
use different tools, keep the other packagings out of the repository and let each
person install theirs under their own home directory rather than checking a
second copy in. If you find duplicates you did not create, ask before deleting
somebody else's install.

## Packaging decisions, and why

**Only `name` and `description` in the frontmatter.** Cursor accepts `name`,
`description`, `paths`, `disable-model-invocation`, `icon`, `color` and
`metadata`. The two that would change behaviour are both deliberately unset.

`paths` scopes a skill to files matching a glob. This skill is not tied to a file
type: it is chosen by the shape of the request, at a moment when nothing has been
touched yet, since the first thing it does is read-only recon. A glob would make
the skill least visible exactly when it is needed. Left off, it stays available
everywhere, which is what a workflow skill needs. (`globs` is the older spelling
of the same field and is still accepted; new skills should use `paths`. This one
sets neither.)

`disable-model-invocation` would leave only explicit invocation. The description
is written to trigger on the right kind of request, so turning that off would
throw away the part that decides when the skill is used at all. The rest are
cosmetic and are left to Cursor's defaults.

**No `is_background` in the agent files.** It is a boolean and its default is
`false`, and the files leave it at that default by not writing it. The reason is
in the wrapper, under "The roles and their models": the shared body's phase 2
loop works on a node while it is open, so there is nothing for an orchestrator to
do with a node it cannot watch. Omitting the field rather than writing
`is_background: false` keeps the nine files to the fields this packaging actually
decided.

**`readonly` written explicitly on all nine.** `true` on the three recon lanes,
`reviewer`, `branch-reviewer` and `adversary`, which is the platform enforcing
what those roles' prompts otherwise only ask for: no file edits and no
state-changing shell commands, with reading left alone. `false` is spelled out on
`implementer`, `ui-designer` and `qa`. That matches the documented default, so it
changes nothing; it is there so that a reader of those three files can see the
write permission was decided rather than inherited.

**The wrapper is thin on purpose.** It points at `shared/PLAYBOOK.md` and adds
only the platform layer. When the shared body changes, re-run step 1 exactly as
written, `rm -rf` included; nothing in the wrapper needs editing for that.
