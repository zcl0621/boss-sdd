# boss-sdd
English | [中文](README.zh-CN.md)

boss-sdd uses agents to carry a multi-step change through to the end. It surveys the project, writes a task graph (DAG) with dependencies, dispatches a separate implementer and reviewer to each node in dependency order, then reviews the whole result and hands it over. The repository contains:

- **The `plan-sdd` skill**, in two fully independent copies. Neither references the other, and each installs on its own:
  - `skills/claude-code/`: for Claude Code. Todos and unattended runs use Claude Code's built-in task list and `/goal`.
  - `skills/opencode/`: for OpenCode 2.x. Todos and unattended runs depend on the plugins below.

  Both copies follow the same process. They discuss the change with the user first (Phase P), then do recon and write the spec and the DAG. Each node works in its own worktree: write a red test, review the red test, then fix. Gates run first, and review starts only once they are green. The model gets upgraded once only after two failed fixes for the same cause. The number of roles and the platform details differ: the Claude Code version has 10 roles, the OpenCode version has 5.
- **Six OpenCode plugins** (`plugins/`). Claude Code needs none of them:
  - `context-keeper`: context management. It fixes the loss of project information, skill rules, and worktree progress after a long session compacts.
  - `pin`: the `pin_context` tool. The agent pins durable facts (worktree, deploy target, decisions) and removes them once they no longer hold.
  - `goal`: unattended goals. When the session stops, it sends a "continue" message until the goal is done or a human is needed.
  - `todo`: the `todowrite` / `todoread` tools. The orchestrating agent records the tasks that are running.
  - `plan-memory`: reminders to read, write and tidy the board's project memory at the points the skill names.
  - `sidebar`: a TUI sidebar showing context usage, the goal, todos, running subagents, and git status.
- **The board**: a macOS menu bar app (Swift) that stores the task graph in SQLite, plus an MCP server written in Go that agents use to read and write the board and project memory. Both packagings can connect to it, and both run without it.
- **Two helper skills**: `skills/shuorenhua/` (rewrites Chinese text to remove AI tone, used when talking to the user in Phase P) and `skills/prompt-engineer/` (checks dispatch instructions before work is handed out). Both versions use them, and both run without them.

## Why Claude Code needs only a skill and OpenCode also needs a plugin

After a compact, Claude Code reattaches the working set. The summary keeps every user message, and Claude Code reattaches the full text of recently read files, the full text of invoked skills, and CLAUDE.md / AGENTS.md / memory files. So on Claude Code the plan-sdd skill alone is enough.

OpenCode 2.0.23 does not do this. What the agent learns while working (the dev server connection details read at the start, deployment info, how far each worktree has got, the body of loaded skills) exists only in the conversation history. A compact is a lossy, one-way rewrite:

- the summary prompt explicitly asks to omit environment details;
- loaded skill bodies are not reattached;
- a long session compacts several times, and each time loses a bit more.

The facts most likely to be lost are ones read through tools early and never mentioned again, and rules from skills. Sessions that run for days with a context of about 256K hit this over and over.

## What context-keeper does

`plugins/context-keeper/context-keeper.js` is an OpenCode 2.x plugin (plugin API v2). It does five things, and **it never changes the system prompt or alters the tool list per request**, so it does not break the prompt cache:

1. **Rebuilds the working set after a compact.** It attaches a `<restored-context>` block to the first message after a compact. The block is computed once per compact cycle and replayed byte for byte after that (cache friendly). It contains:
   - what the user said, verbatim;
   - git / worktree status;
   - the status header and task list of the current plan document (read straight from the file on disk);
   - the full text of loaded skills;
   - a subagent ledger (the last 40);
   - the current content of recently read files;
   - `.opencode/context/*.md` and `~/.config/opencode/context/*.md`.

   Pins, the goal and the todo list are not in this block: the pin, goal and todo plugins each add their own state to every request (see below).
2. **Improves the summary.** When the history fits in the summary request, it appends extra summary requirements to the end of the request. The summary request then shares the conversation prefix and still hits the cache. When the history doesn't fit, it summarizes in chunks and merges them (map-reduce), then hands the result to OpenCode, so no history is dropped.
3. **Clears old tool output in stages.** This applies only to orchestrating agents (default `build,plan,plan-sdd`). When context reaches 25% / 50% / 75% / 90% of the budget, it clears once at each level. Tool output that can be fetched again (file reads, command output) from before the current turn (the last user message) becomes a one-line placeholder that tells the model how to get it back. Long briefs sent to subagents become summary placeholders too (the subagent's own session has the full text). Output from `skill`, `pin_context`, and `goal` is left alone. A very long turn is protected only up to its last 10 messages (4 at 90%). At the same time it sends a `<context-budget>` reminder with exact token counts; when the pin plugin is installed, the reminder also asks the agent to pin what it still needs and drop pins that no longer hold. Clearing happens only at these points and is replayed byte for byte, so the cache impact is limited to that one request.
4. **Subagent model guard.** Orchestrators often name subagent models by Claude tier names (`haiku` / `sonnet` / `opus`). OpenCode doesn't recognize these names, so the orchestrator guesses some "available" model and the whole run fails at random. The guard handles it like this:
   - names it can map are rewritten using `CONTEXT_KEEPER_MODEL_MAP`;
   - models OpenCode knows (for example ones resolved from `model-policy.json`) are kept as they are;
   - anything else is removed, falling back to the agent file's model or the orchestrator's model.
5. **Compaction requests share a prefix with the main request.** In the compaction hook it first replays the clearing results and attaches the existing restore block, so the summary request also hits the cache.

Usage is an estimate over the serialized request (a CJK character counts as one token, other text as one per 3.5 characters), which runs high where the provider tokenizes JSON tightly: 13% over on DeepSeek in one run. After each step the plugin compares its estimate for that request with the input size the provider reported and scales later estimates by the running ratio (clamped to 0.5–1.3), so clearing levels and the budget reminder follow what the model actually holds. The size check that decides whether compaction must be chunked stays unscaled.

Each time an orchestrating agent sends a request, the plugin also writes a `meter` to the state file: estimated usage, window, clearing levels already triggered, and how many outputs were cleared. The sidebar reads this for display.

## pin, goal, todo, plan-memory, sidebar

pin, goal and todo each add a short block of their own state as the last message of every request: `<pins>`, `<goal>`, `<todos>`. The block is added per request and never stored, so it survives compaction and clearing without being restored, and the cached prefix of the conversation is unaffected. Each plugin owns its own reminders and cleanup.

**pin** (`plugins/pin/pin.js`). `pin_context` adds, updates and removes pins; one call can do several (`remove: [keys]`). The `<pins>` block lists every pin with its age and asks the agent to remove or update the ones that no longer hold. Pins have no time-based expiry; the tool description names when to drop one (decision reversed, value changed, worktree merged, task done, finding fixed). At most 30 pins of up to 500 characters; past that, new keys are refused until some are removed. Sessions that pinned with an older context-keeper keep their pins.

**goal** (`plugins/goal/goal.js`). When the user says "finish it and then call me", the model calls `goal set` to set a goal. After that, every time the session stops, the plugin waits 5 seconds and sends a `<goal-continue>` to keep it going. It stops continuing when:
- the model calls `goal wait` (it needs credentials, approval, or a product decision from the user) or `goal complete` (evidence required);
- the user interrupts, or the turn errors out (for example, quota runs out);
- the model calls no tools across two consecutive automatic continues;
- it has continued 200 times.

While a background subagent is still running, it waits 30 minutes before continuing, because OpenCode wakes the session itself when the subagent finishes. When the user sends a new message, a waiting goal goes back to active. Until the goal is complete, every request carries a `<goal>` block with the objective and its status.

**todo** (`plugins/todo/`). `todowrite` takes the whole list every time and `todoread` reads it back. Lists are stored per session in `~/.config/opencode/state/todos/`. The plan-sdd rules: once the DAG is confirmed, one item per task; mark it `in_progress` when dispatched, and a parallel batch can have several at once; mark it `completed` when `done`; if it disagrees with the plan document, the plan wins. Every request carries the open items in a `<todos>` block; if subagents were dispatched after the last `todowrite`, the block says how many and asks for an update.

**plan-memory** (`plugins/plan-memory/plan-memory.js`). The skill already says when to read, write and tidy the board's project memory; in recorded runs the orchestrator nearly always read it, almost never filed what recon confirmed, and never tidied. This plugin watches board calls and, only while a reminder is due, adds a `<memory>` block:
- read: a run is open and `plan_memory_list` has not been called since the previous run finished;
- write: recon was dispatched and the task graph written, but nothing was filed with `plan_memory_add` (shown for 3 requests, since recon may have found nothing new);
- tidy: 5 tasks reached `done`/`blocked` since memory was last listed, or the run moved to `review` (close-out).

It only reminds; what to read, write or delete is still the skill's call.

**sidebar** (`plugins/sidebar/`). Replaces OpenCode's built-in Context block (which has only three lines: token count, percentage, cost). Rendered with mock data it looks like this (36 columns wide):

```
▼ Context 58%
█████████████████░░░░░░░░░░┃░░
152K / 262K tokens         cache 93%
Next clearing at 75% (197K)
┃ auto-compact at 236K
Compacted 2× · 5 pins
Cleared 18 old outputs (96K chars)

▼ Goal active · 3 continues
Finish plan docs/plans/storage.md:
T1-T6, gates green, branch ready to
merge
1 background subagent still running

▼ Todo 1/4
☑ T1 parser
▶ T2 storage layer (implementer)
▶ T3 api
☐ T4 review + gates

▼ Subagents 1 running
▼ Git refresh
plan/t2-storage · base main
1 changed file +40 −3
```

- The progress bar changes color by percentage (green below 60%, yellow below 80%, red above). `┃` marks where OpenCode auto-compacts: the window minus max(10%, 16K), which is about 90% for a 256K window.
- Token counts and cache hit rate are the real values the provider returned for the last request. Until real values exist, it shows context-keeper's estimate prefixed with `≈`.
- The compact count comes straight from counting compaction messages in the session. "Next clearing" and "Cleared" come from context-keeper's meter.
- Click any block's title to collapse it. Clicking a file under Git previews it with Otty (if Otty isn't installed, a notice pops up).

### Configuration

All optional environment variables, set in the environment that starts the OpenCode service:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONTEXT_KEEPER_PRIMARY` | `build,plan,plan-sdd` | Which agents count as orchestrators (clearing and budget reminders apply only to them) |
| `CONTEXT_KEEPER_WINDOW` | Taken from the model list; 200000 if unavailable | Context window size, e.g. `262144` |
| `CONTEXT_KEEPER_MODEL_MAP` | empty | `haiku=prov/model,opus=prov/model#variant` |
| `CONTEXT_KEEPER_SUBAGENT_MODELS` | empty | Extra allowed models, `prov/model` or `prov/*` |
| `CONTEXT_KEEPER_MODEL_GUARD` | `on` | Set to `off` to disable the model guard |
| `CONTEXT_KEEPER_IDLE_MS` | `3600000` | After this much idle time the provider cache is assumed cold, so clearing can happen at no extra cost |
| `CONTEXT_KEEPER_LOG` | empty | When set to a file path, logs are also appended to that file |
| `OPENCODE_GOAL_DELAY_MS` | `5000` | How long to wait after a turn ends before sending "continue" |
| `OPENCODE_GOAL_MAX_CONTINUES` | `200` | Maximum number of automatic continues |
| `OPENCODE_GOAL_CHILD_WAIT_MS` | `1800000` | How long to wait before continuing while a background subagent is running |
| `OPENCODE_GOAL_LOG` | empty | Log file for the goal plugin |
| `OPENCODE_TODO_DIR` | `~/.config/opencode/state/todos` | Directory for todo lists (read by the todo, context-keeper, and sidebar plugins) |

State files live in `$XDG_STATE_HOME/opencode-context-keeper/` and `$XDG_STATE_HOME/opencode-goal/` (under `~/.local/state/` by default), one JSON file per session.

### Self-evolving prompts

The idea comes from the Context Language Models paper (only the idea; none of its prompts or code): use recall questions as an eval set, let a model rewrite the prompt, and keep the rewrite only if the score goes up.

**Each prompt has two parts.** There are five evolvable prompts: four in context-keeper (the summary requirements appended at compaction, chunk summary, merge, budget reminder) and the `pin_context` description in the pin plugin. Both plugins read the same `evolved.json`. Each one has two parts:

- **The fixed part** lives in code. These are hard rules that evolution can't touch: keep paths and commands verbatim, never pin secrets, the summary's section structure, write in the user's language.
- **The evolvable part** is a guidance passage appended after it, read from `~/.config/opencode/context-keeper/evolved.json` (the `CONTEXT_KEEPER_EVOLVED` environment variable changes the path). Each slot has a length cap: 800 characters for the summary requirements, 500 each for chunk and merge, 500 for the budget reminder, 300 for the pin description. A slot that is too long, isn't a string, or contains `<` is ignored and only the fixed part is used. If the file doesn't exist, the plugin behaves exactly as it would without this feature.

**Evaluation: offline replay of real compactions** (`plugins/context-keeper/evolve/`).
- For each compaction, it pulls the history before the compact out of the opencode database and regenerates the summary with the stock opencode 2.0.23 compaction prompt, plus the fixed summary requirements and the candidate guidance.
- Scoring only checks whether facts survived: a fact counts only if the expected answer appears verbatim in the new summary. The model never answers questions, so one candidate costs one request per compaction point.
- Questions only test facts read through tools. Content in AGENTS.md stays in the system prompt the whole time, so it can't tell candidates apart.
- For values that changed partway through (such as the jump host port), the last form that appears in the history is the expected answer.

**Guarding against overfitting.**
- The model that writes candidates never sees the answers. It only sees which category of fact lost points, such as "connection steps read from docs early on".
- Any candidate that contains a specific value from the question bank (host, port, ticket number, path) is thrown out without scoring.
- Every score is the mean of `--samples` runs (default 2). A candidate is adopted only if its training score beats the current text by at least `--margin` facts (default 1) and its holdout score doesn't drop. The holdout set is made of whole sessions held out.
- Results are written to `evolve/runs/<timestamp>/evolved.json`. They are not installed automatically; copy them over by hand.

```bash
cd plugins/context-keeper/evolve
node --no-warnings evolve.mjs items      # list compaction points and the questions each can be asked
node --no-warnings evolve.mjs stored     # score the summaries stored at the time; no model calls
node --no-warnings evolve.mjs evolve --model kimi-code-plan-cn/k3 --rounds 3 --items <id,id,...>
```

Models are called through the stateless generation endpoint of the local opencode service. OpenCode's free models aren't allowed on this endpoint, so add `--via run` to go through `opencode run` instead. That brings in the build agent's system prompt and tools, so it is only good for checking that the pipeline works.

### Baselines

Replayed compactions from synthetic projects, model DeepSeek V4.1 Flash, no evolved text.

**Summary.** With the stock opencode compaction prompt and none of keeper's requirements, 25 compaction points across 6 sessions kept 271/275 facts. All 4 misses were decisions that were later reversed, and some of those were only worded differently. On a model at this level the summary slot leaves little to evolve. What gets lost is structural (skill bodies not reattached, history truncated when it doesn't fit), and the restore block covers that.

**Pins.** At each compaction point the model sees the conversation so far plus the budget notice and writes the pins it would save; the score is how many facts asked about later are in those pins. 67 of the 76 points were run: 463/574 facts (80.7%), training 330/424, holdout 133/150.

| Source | Points | Facts in pins |
| --- | --- | --- |
| orders, inventory projects | 16 | 165/176 (93.8%) |
| Chinese long sessions | 30 | 258/317 (81.4%) |
| early experiment sessions | 21 | 40/81 (49.4%) |

About one fact in five that the agent needs later never gets pinned, so the pin and budget slots are the ones worth evolving.

### Inspecting compacts

```bash
python3 -I plugins/context-keeper/compaction-audit.py --last 30
```

It only reads `~/.local/share/opencode/opencode.db`. For each compact it prints the context size before the compact, the size the summary request actually saw, the ratio of the two, the summary length, and the share of Chinese text in the summary.

## Results

Measured on OpenCode 2.0.23 with a synthetic project (an invoice-cli written in Node, with deployment docs, plan-sdd's AGENTS.md, and 10 roles).

### Recall test: how much survives a compact

Method: a multi-turn conversation that triggers several compacts, ending with "do not call any tools, answer only from the current context, write UNKNOWN if you don't know".

| Experiment | Model | Baseline | With keeper | What the baseline lost |
| --- | --- | --- | --- | --- |
| Long Chinese session, reads the dev access doc at the start, then investigates 14 log files | mimo-v2.6-flash (free) | 5/6 | 6/6 | `DEV_MARK` |
| Same, but with the jump host port, task status, and owner changed midway | mimo-v2.6-flash (free) | 7/8 | 8/8 | `DEV_MARK` |
| plan-sdd project, questions after round 2 | kimi-for-coding-highspeed | 5/6 | 6/6 | gate failure rule from the skill (answered UNKNOWN) |

In the second row, both groups gave the updated port.

### Is the key information in the context after a compact

For each request after a compact, whether these appear: the deploy marker, the deploy host, the plan's run id, and the restore block.

| Model | Group | Deploy marker | Deploy host | run id | Restore block |
| --- | --- | --- | --- | --- | --- |
| mimo-v2.6-flash | baseline | 0% | 0% | 0% | 0% |
| mimo-v2.6-flash | keeper | 100% | 100% | 100% | 100% |
| fledge-alpha | baseline | 0% | 0% | 0% | 0% |
| fledge-alpha | keeper | 100% | 100% | 100% | 100% |
| kimi | baseline | 75% | 75% | 98% | 0% |
| kimi | keeper¹ | 0% | 0% | 100% | 100% |

¹ This run stopped after round 1, so it may not have read the deployment doc before its compact (not verified).

### Prompt cache hit rate

| Model | Group | Main session | Compaction request |
| --- | --- | --- | --- |
| mimo | baseline / keeper | 85.6% / 87.5% | 89.9% / 99.2% |
| fledge | baseline / keeper | 92.6% / 96.4% | 98.8% / 97.9% |
| kimi | baseline / keeper (run 1) | 96.7% / 96.2% | 99.1%, 99.1% / 96.6% |
| kimi | baseline / keeper (run 2) | 95.7% / 96.3% | 98.2%, 97.8% / 96.8% |

### Batched clearing

The same 20-turn scripted session (reads large log files, re-reads some at the end), Kimi k3, window capped at 64K. All three runs have keeper installed; only clearing differs.

| Clearing | Model calls | Compactions | Cache hit | File reads | pin_context calls |
| --- | --- | --- | --- | --- | --- |
| off | 51 | 2 | 91.5% | 29 | 0 |
| protect last 10 messages (old rule) | 66 | 2 | 89.0% | 36 | 8 |
| protect current turn (current rule) | 72 | 1 | 93.2% | 28 | 18 |

Protecting the last 10 messages left too little to clear, and the model re-read cleared files. Protecting only the current turn halved the compactions with no extra reads. The extra calls in both clearing runs are `pin_context` calls prompted by the budget reminder. One run per row.

## OpenCode notes

- OpenCode caches plugin modules by path. After updating a plugin file, run `opencode service restart`.
- Paths outside the project need `external_directory` permission. `opencode run --auto` approves only while the client is alive, so unattended background subagents can hang on a prompt. The agent files allow `*-worktrees/*` (`*` also matches `/`); built-in agents need the global rule in installation step 4.
- With DeepSeek in code mode, plugin tools are called through `execute` (`tools.pin_context(...)`).
- `readonly: true` in an agent file has no effect in OpenCode 2.0.23; use `edit: deny` under `permission:`. An agent without `mode: subagent` is treated as primary.

## Installation

### Claude Code

Follow [`skills/claude-code/INSTALL.md`](skills/claude-code/INSTALL.md). The essentials:

```bash
rm -rf ~/.claude/skills/plan-sdd
mkdir -p ~/.claude/skills/plan-sdd
cp -R skills/claude-code/. ~/.claude/skills/plan-sdd/
cp -R skills/shuorenhua skills/prompt-engineer ~/.claude/skills/
```

Copy the 10 role files into the target project's `.claude/agents/`. If an older install put `spec-reviewer.md` there, delete it; it was renamed to `spec-auditor.md`. Which model each purpose uses is set in the "Model bindings" table in `skills/claude-code/roles.md`. It doesn't switch models automatically when quota runs short. The board is an optional step 4.

Unattended runs: the skill can't start `/goal` by itself. It gives you a `/goal ...` line to type. It still runs if you don't, but it stops at the end of each turn and waits for you to say something. Claude Code needs none of the six plugins above.

### OpenCode

Run these from the repository root.

1. The skill, the orchestrating agent, and the 5 roles:

   ```bash
   mkdir -p ~/.config/opencode/skills ~/.config/opencode/agents
   rm -rf ~/.config/opencode/skills/plan-sdd
   cp -R skills/opencode ~/.config/opencode/skills/plan-sdd
   cp skills/opencode/agents/*.md ~/.config/opencode/agents/
   ```

   `agents/plan-sdd.md` is the orchestrating agent (`mode: primary`). Switch to it in the TUI before you start.

2. The two skills it depends on:

   ```bash
   cp -R skills/shuorenhua skills/prompt-engineer ~/.config/opencode/skills/
   ```

3. Plugins. The six are independent; install what you need. Without pin there is no `pin_context`, without goal there is no auto-continue, without todo there are no todos, and the matching sidebar blocks don't show:

   ```bash
   mkdir -p ~/.config/opencode/plugins
   cp plugins/context-keeper/context-keeper.js plugins/pin/pin.js plugins/goal/goal.js plugins/plan-memory/plan-memory.js ~/.config/opencode/plugins/
   rm -rf ~/.config/opencode/plugins/todo ~/.config/opencode/plugins/sidebar
   mkdir -p ~/.config/opencode/plugins/todo ~/.config/opencode/plugins/sidebar
   cp plugins/todo/package.json plugins/todo/index.ts plugins/todo/store.ts ~/.config/opencode/plugins/todo/
   cp plugins/sidebar/package.json plugins/sidebar/index.ts plugins/sidebar/tui.tsx ~/.config/opencode/plugins/sidebar/
   opencode service restart
   ```

   Turn off two of OpenCode's built-in sidebar blocks: Context (duplicates the sidebar) and the MCP list. Add this to `~/.config/opencode/cli.json` (create the file if it doesn't exist):

   ```json
   { "plugins": ["-opencode.sidebar.context", "-opencode.sidebar.mcp"] }
   ```

   An entry starting with `-` disables the built-in plugin of that name.

4. Permissions for paths outside the project. The agent files above allow worktrees and `/tmp`, but OpenCode's built-in agents (for example `explore`, which the orchestrator sometimes dispatches) don't read those files. In an unattended run they stop at an approval prompt and the run hangs. Add the same rule to `~/.config/opencode/opencode.json`:

   ```json
   {
     "permission": {
       "external_directory": { "*-worktrees/*": "allow", "/tmp/*": "allow", "/private/tmp/*": "allow" }
     }
   }
   ```

5. Board MCP (optional). Install the board app first (see below), then add to `opencode.json`:

   ```json
   {
     "mcp": {
       "plan-sdd": {
         "type": "local",
         "command": ["/Applications/BossSDD.app/Contents/Resources/plan-sdd-mcp"]
       }
     }
   }
   ```

6. Model policy (optional). Start from the example:

   ```bash
   cp skills/opencode/references/model-policy.example.json ~/.config/opencode/model-policy.json
   ```

   Each purpose (`implementer.default`, `reviewer.default`, and so on) maps to one specific model; see `skills/opencode/references/model-policy.md` for the format. It is read and validated once at the start of each run. If the file doesn't exist, no model is specified, and subagents use the model from their own agent file or the orchestrator's model. It doesn't switch models automatically when quota runs short.

7. Check:

   ```bash
   opencode debug agents
   ```

   Confirm that `recon`, `implementer`, `qa`, `reviewer`, and `spec-auditor` are all there with `mode` set to `subagent`.

## Board

A macOS menu bar app (Swift 6, SwiftPM) that stores the task graph in SQLite and serves HTTP on the local loopback address. An MCP server written in Go forwards that HTTP, and agents use it to read and write the board as structured JSON. Apple silicon and macOS 14 or later only.

![Board, graph view, light](docs/images/board-graph-light.png)

The column view of the same run, grouped by status:

![Board, column view, light](docs/images/board-columns-light.png)

### Build and install

```bash
./Scripts/bundle.sh --install
```

This does a release build of the Swift app, cross-compiles the `darwin/arm64` MCP binary, packages them as `BossSDD.app` (ad-hoc signed), and replaces `/Applications/BossSDD.app`. The MCP binary is at `BossSDD.app/Contents/Resources/plan-sdd-mcp`. Without `--install`, the app stays at `.build/BossSDD.app`.

Register the MCP with Claude Code:

```bash
claude mcp add --scope user plan-sdd /Applications/BossSDD.app/Contents/Resources/plan-sdd-mcp
```

### MCP tools

9 for the board: `plan_board_status`, `plan_create_run`, `plan_update_run`, `plan_set_task`, `plan_set_tasks` (one transaction; if one fails, nothing is written), `plan_graph`, `plan_get_run`, `plan_delete_run` (rejected while the run is `running`), `plan_delete_task` (rejected while the task is `running` / `review`, or when another task depends on it).

4 for project memory: `plan_memory_list`, `plan_memory_get`, `plan_memory_add` (overwrites by `(project, key)`), `plan_memory_delete`.

Except for deleting a run, every write returns the latest graph projection (`valid`, `ready_task_ids`, `active`, `blocked`), so no separate validation is needed.

### Project memory

Stores project facts that hold across runs: gate commands, how to run things, conventions, hard rules, exclusive resources. `kind` is one of `gate`, `run_recipe`, `convention`, `hard_rule`, `exclusive_resource`, `note`.

- `source` is required. It records which file and line, or which command output, the fact came from, so a stale entry is easy to check and overturn.
- At most 100 entries per project. When full, new keys are rejected with no automatic eviction, but existing keys can still be overwritten.
- There is deliberately no search; `plan_memory_list` returns everything.

### Write protection

The app rejects two kinds of task writes: setting a task to `running` before its dependencies are done, and claiming an `exclusive_resource` already held by a `running` or `review` task. Overlapping `write_scope` and the project's own concurrency limits are the orchestrating agent's job.

### Port and HTTP

Listens on `127.0.0.1:18888`; change it with `BOSS_SDD_PORT`. It accepts only requests whose `Host` is `127.0.0.1` or `localhost`, rejects requests with an `Origin` header, and requires `Content-Type: application/json` for `POST` / `PUT` / `PATCH`. This keeps web pages in a browser on the same machine from reaching it.

Data lives in `~/.claude/plan-sdd/board.sqlite3`.

## Tests

```bash
./Scripts/verify.sh
```

Four steps, stopping at the first failure: release build; `swift test` and `go test ./...`; `./Scripts/bundle.sh`; start a real server and exercise it over HTTP (create a run, write dependencies, check the 409 rejection, read and write memory). That last step uses a system-assigned port and a temporary SQLite file, and doesn't touch the board in `~/.claude/plan-sdd/`. Requires `jq` and `curl`.

Plugin tests:

```bash
sh plugins/context-keeper/test/run.sh
sh plugins/pin/test/run.sh
sh plugins/goal/test/run.sh
sh plugins/plan-memory/test/run.sh
(cd plugins/todo && bun test)
(cd plugins/sidebar && bun install && bun test)
```

context-keeper, pin, goal and plan-memory run under node and write state to a temporary directory, without touching `~/.local/state`. The sidebar tests render the sidebar to text with mock data and need `bun install` first for the dev dependencies.

## Layout

| Directory | Contents |
| --- | --- |
| `skills/claude-code/` | Claude Code version: `SKILL.md` (platform bindings), `PLAYBOOK.md` (process), `roles.md`, 10 roles, references, `INSTALL.md` |
| `skills/opencode/` | OpenCode version: `SKILL.md`, `ADAPT.md`, 5 roles, references |
| `skills/shuorenhua/`, `skills/prompt-engineer/` | Helper skills used by both versions |
| `plugins/context-keeper/` | Context management plugin, compact audit script, tests |
| `plugins/pin/` | `pin_context` plugin and tests |
| `plugins/goal/` | Unattended goal plugin and tests |
| `plugins/plan-memory/` | Project memory reminder plugin and tests |
| `plugins/todo/` | todo tool plugin and tests |
| `plugins/sidebar/` | TUI sidebar plugin and render tests |
| `Sources/BoardKit` | Data model, DAG projection, SQLite storage, HTTP API; no third-party dependencies |
| `Sources/BossSDD` | SwiftUI app: menu bar and board window |
| `mcp/` | Go MCP server, stdio, forwarding to the app's local HTTP |
| `Tests/BoardKitTests` | Graph computation, storage protection, API, memory, legacy data import |
| `docs/plans/` | This repository's own plan documents |

## Open work

Unfinished work and known issues are tracked in [GitHub issues](https://github.com/zcl0621/boss-sdd/issues).
