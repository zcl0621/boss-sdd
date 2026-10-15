# boss-sdd 适配 omp（oh-my-pi）

```text
Status: running
Run id: 9d6aa9f5e59e4e7da7a37e7b29cc85e2
Base ref: dfe5aaa
Discussion: confirmed (full), 2026-10-16
Goal mode: armed
Project memory: on
Integration branch: plan/2026-10-16-omp
Main working tree: /Users/zhang/Project/boss-sdd
Integration worktree: /Users/zhang/Project/boss-sdd-worktrees/omp-integration
Updated: 2026-10-16
```

Goal-mode objective: the user's requirement below, plus a plan-sdd close-out of
this plan (clean or partial) with the delivery report written.

## Discussion outcome

```text
Discussion outcome
Depth: full
Confirmed by user: 2026-10-16, "方案确认，按这个开始 recon，跑到底。"
Goal: 在 omp 18.11.1 上能用 boss-sdd：
  - skills/omp/：plan-sdd 的 omp 专版。10 个角色写成 omp agent（~/.omp/agent/agents/*.md），
    模型用 "@role" + config.yml modelRoles；task 工具批量派发后用 wait 等结果；
    用 omp 原生 todo 和 goal；每个节点的 git worktree 由编排者自己建。
  - context 扩展：compact 之后恢复工作集；通过 session.compacting 改进摘要要求；
    接近 500k 时提醒。分段清理做不做，按实测决定。
  - pin：直接用 omp 原生 context_notes（实验功能，用户机器已开）；验证 compact 后仍在；
    侧栏 Pins 区显示 context_notes 内容。
  - plan-memory 提醒做成 omp 扩展。
  - evolve：读 omp 会话记录，小规模回放，确实变好了才装上。
  - 侧栏：plugins/omp-sidebar（用户的 omp-sidebar-plugin，已在 main dfe5aaa）。
  - README 中英文写 omp 安装和配置（示例 modelRoles 用 gpt-6.1-sol / opus-5.5，上限 500k）。
  - 端到端在 /tmp 临时仓库里用 kimi-for-coding-highspeed 跑。
Not doing: 不 push、不开 PR；不再做 plugins/omp-workspace（已删）；不改 OpenCode / Claude Code
  两套现有 skill 的行为；不在 omp 里做模型守卫（model guard）；不 fork omp。
Chosen approach: 纯 omp 扩展 + omp 原生 skill/agent 格式，能用原生能力（todo、goal、context_notes、
  task 工具、modelRoles）就不自己造；另一种是把 OpenCode 插件逐个翻译过来，没选，因为 omp 已原生覆盖
  todo/goal/pin，翻译会造重复轮子。
Assumptions the user accepted: 用户用 gpt-6.1-sol 和 opus-5.5（1M），手动限到 500k；
  context_notes 在用户机器已开；本机测试用 Kimi Code 登录的模型；用便宜模型跑 e2e。
Defaults taken from "按你说的": context 范围由实测决定；evolve 形态由我定（要求"总体好用"）；
  worktree 由我定；先提交基线（已提交 dfe5aaa）。
Still open: none
Plan file location: docs/plans/2026-10-16-omp-adaptation.md
```

## Background

- The user moved their work machine to omp 18.11.1 and dropped OpenCode. boss-sdd ships plan-sdd only for Claude Code (`skills/claude-code/`) and OpenCode (`skills/opencode/` plus six OpenCode plugins under `plugins/`). Neither README mentions omp (recon lane A/C: word grep empty).
- omp has native task/wait, `model: "@role"` + `modelRoles`, todo, goal and (experimental) context_notes. Docs: omp clone `scratchpad/src/oh-my-pi/docs/` (`task-agent-discovery.md:25-93`, `tools/todo.md`, `tools/context-notes.md`, `compaction.md`, `extensions.md`, `config-usage.md`).
- `plugins/omp-sidebar/` landed on main in dfe5aaa. Its Pins section reads `customType === "context-pin-state"` (`plugins/omp-sidebar/state.ts:671`); nothing in omp writes that type, so Pins is always empty (lanes B, C). Native notes are `custom` entries with `customType: "experimental_context_notes"`, `data: { version: 1, text }` (omp `session/context-notes.ts:1-60`), reads stop at `reset_boundary`.
- `plugins/omp-sidebar/package.json` declares only `peerDependencies`; `bun test` cannot resolve `@oh-my-pi/*` from the repo (lane A). It passed 31/31 only from a harness with the 18.11.1 packages installed.
- With `compaction.experimentalContextManagement: true` automatic compaction becomes local rollover with no summarizer call, and omp already sends a once-per-window "save your working state" reminder (`compaction.md:156-174`). `session.compacting` context strings only feed the summarizer and are last-one-wins across extensions (`extensions/runner.ts:1661`). Registering `session_before_compact` disables async speculative compaction (`compaction.md:513`).
- omp todo keeps one `in_progress` item (`tools/todo.ts:128` `normalizeInProgressTask`). Goal auto-continue runs only in interactive and RPC modes (`goals/settings.ts:27`; `modes/print-mode.ts` has none).
- The 18.11.1 release binary does not serve `@oh-my-pi/pi-coding-agent/launch/*` to extensions; other deep imports are unproven. New extensions should not deep-import omp internals.
- Run recipe verified by the orchestrator on 2026-10-16 (see Run recipe): project-local `.omp/agents` + `.omp/config.yml` `modelRoles` + `--session-dir` dispatches a `@role` agent with `task` in print mode and writes nothing under `~/.omp/agent/sessions`.
- This machine is a test machine: `~/.omp/agent/config.yml` holds only `setupVersion: 2`; the user's context_notes setting is on their work machine.

## Goals

1. In omp, `/skill:plan-sdd` loads `skills/omp`; the ten roles are omp agents; a node batch goes out in one `task` call and returns through `wait`; model choice is a `@role` alias resolved by `modelRoles`; progress uses native todo; `/goal` keeps an interactive run going.
2. After a compaction or a rollover the orchestrator gets back the user's recent words, the plan's status line and path, and git/worktree state, from the omp-context extension.
3. The sidebar Pins section shows the session's context_notes text.
4. During a plan-sdd run the orchestrator is reminded to read, write and tidy board memory at the same points as `plugins/plan-memory`.
5. An evolve harness reads omp session journals, replays compaction points, and installs new summary guidance only when the score improves by the margin on train and does not drop on holdout.
6. README (EN + ZH) explains installing and configuring all of the above for omp.
7. An end-to-end run in a /tmp repo on `kimi-code/kimi-for-coding-highspeed` exercises the skill, the extensions and the sidebar, with the evidence written down.

## Non-goals

- No port of: `pin_context` and its keyed caps; the OpenCode goal continue loop; `todowrite`/`todoread`; context-keeper's model guard, map-reduce summarization, token estimator, prompt-cache tricks, skill/plan re-attachment (omp never prunes skill reads or the active plan file, `compaction.md:236`). The OpenCode sidebar is not ported.
- No staged clearing of old tool output unless the T9 measurement shows a gap omp's own pruning leaves; if it does, that is parked for the user, not built in this run.
- No replacement of board `plan_memory_*` by omp's own memory backend.
- No change to `skills/claude-code/`, `skills/opencode/`, any OpenCode plugin, the Swift app or the Go MCP server.
- No omp fork, no patch to omp core or its built-in prompts (context_notes / compaction templates).
- Evolve does not run online, does not evolve skill or role prompts, and does not claim an improvement the data does not show; "nothing installed" is a valid result.
- No push, no PR. `plugins/omp-workspace` is gone and stays gone.

## Design decisions already made

1. **`skills/omp/` follows `skills/claude-code/`'s layout** (SKILL.md bindings table + PLAYBOOK.md + roles.md + agents/ + references/ + INSTALL.md), not `skills/opencode/`'s. Reason: its role-per-file layout and single "Model bindings" table map one-to-one onto omp agent files and `@role` + `modelRoles` (lane C). PLAYBOOK.md and the references are carried over with platform wording changed only where a binding differs.
2. **Ten roles, same names as `skills/claude-code/agents/`**, installed to `~/.omp/agent/agents/` (or `<project>/.omp/agents/`), never `.claude/agents` (omp skips it, `task-agent-discovery.md:148`). Each agent file sets `model: "@<alias>"`; aliases are defined by roles.md's binding table and an example `modelRoles` in `skills/omp/config.example.yml`. Names must not collide with omp's bundled agents. omp bundles `reviewer` (omp `task/agents.ts:44-48`; bundled set {scout, reviewer, security-reviewer, task, sonic}) and a user/project agent of the same name silently shadows it (`task-agent-discovery.md:172`), so the reviewer role's agent file is `plan-reviewer`; the other nine keep their role names. Added 2026-10-16 after T4's red-test stop.
3. **Read-only roles are read-only by instruction**, as on Claude Code: they need `bash` for `git log -S`/`git blame`, and omp's read-only policy does not gate writes (`task/read-only-policy.ts`). Their `tools` allowlist leaves out `edit`/`write`.
4. **Worktrees are created by the orchestrator** with `git worktree add` under `<repo>-worktrees/`; omp's `isolated` task option is not used.
5. **Todo mapping respects the one-`in_progress` rule**: the skill must not tell the orchestrator to mark several items `in_progress`; how a parallel batch is shown is the skill's mapping (T3), stated with the omp citation.
6. **Goal**: native `/goal` and the hidden `goal` tool; the skill states that print mode does not auto-continue.
7. **Pins = native context_notes.** The sidebar reads `experimental_context_notes` entries itself, replicating omp's small reader (latest valid entry wins, invalid entries are skipped, stop at `reset_boundary`, `data` has exactly the keys `version` and `text`, `version === 1`, string text, ≤ 16 384 bytes), and does not deep-import `@oh-my-pi/pi-coding-agent/session/context-notes`. Nothing writes context_notes except omp's own tool.
8. **omp-context extension**: re-injects a restore block after a compaction or rollover (through the `context` event on each request, not `pi.sendMessage`), adds summary requirements through `session.compacting` (`context` strings) and does **not** register `session_before_compact`. The near-budget nudge fires only when `experimentalContextManagement` is off (rollover mode already reminds). Summary guidance text comes from a file evolve can replace, with a built-in default.
9. **New extensions avoid deep imports of omp internals**; they use the documented extension API (`pi.on`, `pi.sendMessage`, `pi.exec`, `ctx.sessionManager`, `ctx.getContextUsage`) and `import type` only. Amended 2026-10-16 after an orchestrator probe in the release binary (`/tmp/omp-probe/.omp/extensions/probe/index.ts`): a dynamic import with a **string-literal** specifier `import("@oh-my-pi/pi-coding-agent/config/registry")` loaded, and `lookup("compaction.experimentalContextManagement").get(...)` / `lookup("compaction.thresholdTokens").get(...)` returned the project config's values (`true`, `400000`; `thresholdPercent` `-1`); the same specifier held in a variable failed with `Cannot find package '@oh-my-pi/pi-coding-agent'`. So a deep import is allowed only when docs/extensions.md documents it for extensions or it is already proven loadable by the release binary (as `@oh-my-pi/pi-coding-agent/session/model-compaction-threshold` is: `plugins/omp-sidebar/state.ts` imports `describeModelCompactionPoint` from it statically and the installed sidebar, with no node_modules, loads and renders the Auto-compact line), it is written as a string literal, it sits behind a try/catch with a degraded fallback, and a test covers the fallback.
10. **Extensions are separate directories**: `plugins/omp-context/` (with `evolve/` inside), `plugins/omp-plan-memory/`. Each is a `bun test` package with no package dependency on `@oh-my-pi/*` (tests drive a fake `pi`/`ctx`); the only runtime loads of omp modules are the guarded string-literal dynamic imports decision 9 allows.
11. **Tests and checks never write the user's real omp state.** Unit tests use temp dirs; omp runs in checks use a /tmp repo with project-local `.omp/` and `--session-dir` (Run recipe). Installing the finished extensions/skill into `~/.omp/agent/` on this test machine is a close-out step the orchestrator does, recorded in the decision queue.

## Tasks

Status vocabulary: pending, running, review, blocked, done. Gates for each task are listed in its entry; `(cwd X)` means run from that directory.

### T1 omp-sidebar: tests runnable from the repo  [no-red-test: dependency/lockfile configuration only, no runtime behaviour]
- Status: pending
- depends_on: []
- write_scope: plugins/omp-sidebar/package.json, plugins/omp-sidebar/bun.lock, plugins/omp-sidebar/.gitignore
- exclusive_resources: []
- role: implementer
- Acceptance:
  1. `package.json` keeps its `peerDependencies` and gains `devDependencies` pinning exactly `18.11.1` for `@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-tui`, `@oh-my-pi/pi-utils`, `@oh-my-pi/pi-natives`.
  2. A `bun.lock` is committed; `node_modules/` is ignored by `plugins/omp-sidebar/.gitignore`.
  3. `(cwd plugins/omp-sidebar) bun install --frozen-lockfile` exits 0, then `(cwd plugins/omp-sidebar) bun test` runs all 31 tests and every test passes except, at most, the pre-existing nondeterministic test `running activity indicators > visible running entries animate without a data refresh` (`sidebar-view.test.ts:31`), which T10 makes deterministic. (Amended 2026-10-16: the orchestrator's gate run showed that test failing 1 in 6 runs on code unchanged since dfe5aaa.)
  4. No `.ts` file changes.
- Gates: `(cwd plugins/omp-sidebar) bun install --frozen-lockfile`; `(cwd plugins/omp-sidebar) bun test`
- Risk / rollback: a postinstall blocked by bun; rollback = revert the three files.
- Obstacle ledger: empty. Rounds: 0.

### T2 omp-sidebar: Pins shows context_notes
- Status: done (merged 0debc3e; integration gates install exit 0, bun test exit 0, 40 pass)
- depends_on: [T1, T10]
- write_scope: plugins/omp-sidebar/state.ts, plugins/omp-sidebar/state.test.ts, plugins/omp-sidebar/context-notes.ts, plugins/omp-sidebar/context-notes.test.ts, plugins/omp-sidebar/README.md
- exclusive_resources: []
- role: implementer
- Acceptance:
  1. With a session branch whose latest `custom` entry of `customType: "experimental_context_notes"` has `data: { version: 1, text: "alpha\n\nbeta" }`, the Pins section lists one row per non-empty line (`alpha`, `beta`) and activating a row opens an inspection whose content is the full notebook text.
  2. When several such entries exist, only the latest one before the end of the branch counts; entries before the most recent `reset_boundary` entry are not shown (same semantics as omp `session/context-notes.ts` `getContextNotes`, cited in a comment).
  3. An invalid entry (`version !== 1`, non-string `text`, text over 16 384 UTF-8 bytes, or `data` with keys other than exactly `version` and `text`) is skipped, as omp skips it, so an earlier valid entry after the latest `reset_boundary` still shows; with no valid entry, Pins shows no notes. Nothing throws. Empty or whitespace-only text shows the existing `None` summary. *(Amended at T2 red-test audit: the first wording, "treated as no notes", contradicted criterion 2 and decision 7; omp `session/context-notes.ts` skips invalid entries.)*
  4. `context-pin-state` is no longer read anywhere in `plugins/omp-sidebar/`; no import of `@oh-my-pi/pi-coding-agent/session/context-notes`.
  5. The README's Pins description says it shows omp context_notes and needs `compaction.experimentalContextManagement`.
  6. All earlier sidebar tests still pass.
- Gates: `(cwd plugins/omp-sidebar) bun install --frozen-lockfile`; `(cwd plugins/omp-sidebar) bun test`
- Risk / rollback: omp changes the entry shape in a later release; rollback = revert the node's merge.
- Obstacle ledger: empty. Rounds: 0.

### T10 omp-sidebar: make the spinner animation test deterministic  [no-red-test: test-only change; no runtime behaviour changes]
- Status: pending
- depends_on: [T1]
- write_scope: plugins/omp-sidebar/sidebar-view.test.ts
- exclusive_resources: []
- role: implementer
- Why no red test and no verify/fix pair: the defect is in test code (the product renders correctly); no test can fail first on a runtime behaviour change because there is none. Recorded in the decision queue for the user to overturn.
- Acceptance:
  1. The cause of the intermittent failure of `running activity indicators > visible running entries animate without a data refresh` is stated with evidence (a command and its output), not guessed.
  2. The test still asserts that a running row's spinner frame changes between two renders 80 ms apart without a data refresh, and no longer depends on the wall clock.
  3. `(cwd plugins/omp-sidebar) bun test sidebar-view.test.ts` exits 0 in 50 consecutive runs (the orchestrator runs this loop at the gate), and the full `bun test` exits 0.
  4. No file other than `sidebar-view.test.ts` changes.
- Gates: `(cwd plugins/omp-sidebar) bun install --frozen-lockfile`; `(cwd plugins/omp-sidebar) bun test`; 50 × `(cwd plugins/omp-sidebar) bun test sidebar-view.test.ts`, each exit code recorded
- Risk / rollback: none beyond the test; rollback = revert merge.
- Obstacle ledger: empty. Rounds: 0.

### T4 skills/omp roles: agent files, binding table, example config  [complexity: high]
- Status: done (merged 21bf290; integration gate exit 0, 46 pass)
- depends_on: []
- write_scope: skills/omp/roles.md, skills/omp/agents/, skills/omp/config.example.yml, skills/omp/test/roles.test.ts
- exclusive_resources: []
- role: implementer
- Acceptance:
  1. `skills/omp/agents/` holds exactly ten files, one per role in `skills/claude-code/agents/`: adversary, branch-reviewer, implementer, qa, recon-code, recon-product, recon-rules, plan-reviewer (the reviewer role, renamed because omp bundles `reviewer`), spec-auditor, ui-designer.
  2. Each file has omp agent frontmatter (`docs/task-agent-discovery.md:25-49`): `name` equal to the file stem, a `description`, a `tools` allowlist, and `model: "@<alias>"`. The seven read-only roles (the three recon lanes, reviewer, spec-auditor, branch-reviewer, adversary) list no write-capable tool (`edit`, `write`, `ast_edit`, `memory_edit`, compared case-insensitively as omp does, `tools/builtin-names.ts:47-49`) but do list `bash`; `implementer` and `ui-designer` list `edit` and `write`. Tool names are omp's real tool names from `BUILTIN_TOOL_NAMES` (`tools/builtin-names.ts:1-32`), cited. (Amended 2026-10-16 after T4's red-test audit.)
  3. Each body carries the standing rules of the matching `skills/claude-code/agents/<role>.md`, changed only where a Claude Code mechanism has an omp binding (e.g. `Agent` tool → `task`, `.claude/agents` → `~/.omp/agent/agents`).
  4. `skills/omp/roles.md` is `skills/claude-code/roles.md` with its "Model bindings" table rewritten to map each binding to one omp alias, and the text explaining that the alias resolves through `modelRoles` in `~/.omp/agent/config.yml` (or `<project>/.omp/config.yml`).
  5. `skills/omp/config.example.yml` defines every alias used by the agent files under `modelRoles`, with example models gpt-6.1-sol / opus-5.5 style ids and a comment on the 500k cap via `compaction.modelThresholds` (or `thresholdTokens`) and on `compaction.experimentalContextManagement: true`.
  6. No agent name collides with an omp bundled agent (list taken from omp `task/agents.ts`, cited in roles.md).
  7. `bun test skills/omp/test/roles.test.ts` checks 1; 2 (frontmatter keys, every tool name is in a copy of `BUILTIN_TOOL_NAMES` with its source cited, the read-only and write rules case-insensitively); 3 (every `##` heading of the matching `skills/claude-code/agents/<role>.md` appears in the omp file); 4–5 (every alias in agents and in roles.md's table is defined in config.example.yml; the example ids include a gpt-6.1-sol and an opus-5.5 id; `experimentalContextManagement: true` is set or shown); and 6 (against the bundled list from `task/agents.ts:44-73` plus the reserved names `main`/`sub` from `docs/task-agent-discovery.md:37`, copied into the test with sources cited). (Amended 2026-10-16.)
- Gates: `bun test skills/omp/test/roles.test.ts`
- Risk / rollback: omp tool names or frontmatter keys differ from the docs; the T9 walkthrough loads the agents in a real omp. Rollback = revert merge.
- Obstacle ledger: empty. Rounds: 0.

### T3 skills/omp core: SKILL.md bindings, PLAYBOOK, references, INSTALL  [complexity: high]
- Status: done (merged a0a3942; integration gates skill.test exit 0 / 78 pass, roles.test exit 0 / 46 pass)
- depends_on: [T4]
- write_scope: skills/omp/SKILL.md, skills/omp/PLAYBOOK.md, skills/omp/references/, skills/omp/INSTALL.md, skills/omp/test/skill.test.ts
- exclusive_resources: []
- role: implementer
- Acceptance:
  1. `SKILL.md` frontmatter: `name: plan-sdd` and a `description` (omp `docs/skills.md:52-63`). Its bindings table covers every mechanism the PLAYBOOK names (dispatch a subagent; several at once; where role definitions live; the model binding; resuming a subagent (Form A); acting on each return; per-node worktrees; todo list; goal; prompt-review / message helper / show-me helper skills; board MCP tools; native branch reviewer), each with the omp mechanism and an omp doc or source citation, or an explicit statement that omp has none and what the skill does instead.
  2. Specifically: batch dispatch is one `task` call with several `tasks` entries; returns arrive through async jobs and `wait`; whether a finished subagent can be resumed is established from omp docs/source (cited) and Form A is mapped accordingly (if omp cannot resume, Form A becomes Form B); todo never puts more than one item `in_progress` (`tools/todo.ts:128`); goal is `/goal` / `--goal` and the text states print mode (`-p`) does not auto-continue; board tools come from `~/.omp/agent/mcp.json` and the text says how omp exposes MCP tools; worktrees are made by the orchestrator, `isolated` unused.
  3. `PLAYBOOK.md` and every file in `references/` exist with the same section structure as `skills/claude-code/`'s; Claude-Code-only wording (`Agent` tool, `SendMessage`, `.claude/agents`, `/code-review`) is replaced by the omp binding or removed. `references/native-review.md` states what omp offers for a branch review, cited.
  4. `INSTALL.md` gives copy commands for the skill (`~/.omp/agent/skills/plan-sdd/`) and the agents (`~/.omp/agent/agents/`), and an exact merge procedure for the example `modelRoles` and for the board MCP entry in `~/.omp/agent/mcp.json` (both are merged into files the user may already have, never overwritten); every repo path it names exists. *(Amended at T3 post-repair audit: a copy command would overwrite the user's config.)*
  5. `bun test skills/omp/test/skill.test.ts` checks: frontmatter of SKILL.md; every relative Markdown link under `skills/omp/` resolves to an existing file; no file under `skills/omp/` (outside quoted comparisons) still names `SendMessage`, `subagent_type`, or `.claude/agents` as the mechanism to use.
- Gates: `bun test skills/omp/test/skill.test.ts`; `bun test skills/omp/test/roles.test.ts`
- Risk / rollback: an omp mechanism mis-stated; caught by T9 and review. Rollback = revert merge.
- Obstacle ledger: empty. Rounds: 0.

### T5 omp-context extension  [complexity: high]
- Status: done (merged 462fc6d; integration gate exit 0, 105 pass; 5 rework rounds, real-omp QA x4)
- depends_on: []
- write_scope: plugins/omp-context/ (excluding plugins/omp-context/evolve/)
- exclusive_resources: []
- role: implementer
- Acceptance:
  1. Package: `plugins/omp-context/package.json` with `"omp": { "extensions": ["./index.ts"] }` and `"test": "bun test"`; no package dependency on `@oh-my-pi/*` and no static runtime import of it (type-only imports allowed; guarded string-literal dynamic imports per decision 9 allowed); tests drive a fake `pi`/`ctx`. *(Amended at T5 post-repair audit: the first wording contradicted decision 9 as amended.)*
  2. Working set: the extension keeps, per session, the last user messages verbatim (bounded count and size), the active plan document path and its `Status:` line when a `docs/plans/*.md` file is read or written, the loaded skill names, and git branch + worktree list obtained through `pi.exec` (with timeout).
  3. After a compaction or a rollover (the omp events that signal each, cited), it builds one restore block containing that working set, once per compaction/rollover, and adds it to the model's input through the documented `context` extension event (omp `docs/extensions.md:485`, cited): one synthetic, unpersisted message present on every provider request until the next compaction or rollover replaces it, placed so the summarizer's history prefix is unchanged (cited). In rollover mode the block is thin: user words, plan status/path, git/worktree only. *(Amended at T5 post-repair re-audit: QA in real omp showed `sendMessage` `nextTurn` waits for the next user prompt and `aside` can wake an unrequested turn.)*
  4. On `session.compacting` it returns `context` strings carrying the summary requirements (keep the user's words verbatim, plan status, open nodes, worktrees, pending decisions). The requirements text is read from `plugins/omp-context/guidance.md` when present, else a built-in default; it does not register `session_before_compact`.
  5. Near-budget nudge: when `compaction.experimentalContextManagement` is off and `ctx.getContextUsage()` reaches a configurable fraction of the compaction threshold, one reminder text per compaction window, fixed when first triggered and carried in the same synthetic message on each request until the next compaction; none in rollover mode. The way the extension learns the mode and threshold is cited.
  6. Failures (git missing, `getContextUsage` undefined, unreadable guidance file) degrade to a smaller block, never throw into omp.
  7. README in the package: what it does, install path (`~/.omp/agent/extensions/omp-context/`), settings.
- Gates: `(cwd plugins/omp-context) bun test`
- Risk / rollback: event names or message API differ in the release binary; T9 checks in a real omp. Rollback = revert merge.
- Obstacle ledger: empty. Rounds: 0.

### T6 omp-plan-memory extension
- Status: done (merged 69fee75; integration gate exit 0, 27 pass)
- depends_on: []
- write_scope: plugins/omp-plan-memory/
- exclusive_resources: []
- role: implementer
- Acceptance:
  1. Same reminder rules as `plugins/plan-memory/plan-memory.js` (read / write / tidy, `LIMITS.tidyEvery = 5`, `writeShows = 3`), shown as a per-request block that is not persisted in history, through omp's `context` event (cited).
  2. It recognises the board tools however omp names them in tool events — plain `plan_*`, MCP-prefixed, or reached through omp's MCP discovery path; the forms it accepts are established from omp source/docs and cited, and each has a test.
  3. Per-session state lives under `$XDG_STATE_HOME/omp-plan-memory/` (default `~/.local/state/omp-plan-memory/`), overridable by an env var; tests use a temp dir.
  4. Package as T5 item 1 (own `package.json`, `bun test`, no runtime `@oh-my-pi/*`), plus a README.
  5. The scenarios covered by `plugins/plan-memory/test/plan-memory.test.mjs` are ported as bun tests and pass.
- Gates: `(cwd plugins/omp-plan-memory) bun test`
- Risk / rollback: omp reports MCP tool calls under a name not anticipated; T9 checks in a real omp. Rollback = revert merge.
- Obstacle ledger: empty. Rounds: 0.

### T11 omp-plan-memory: insert the reminder after the compaction summary, not at the tail  [fix: found by T5 adversary C7]
- Status: done (merged ddec267; integration gate exit 0, 36 pass)
- depends_on: [T6]
- write_scope: plugins/omp-plan-memory/
- exclusive_resources: []
- role: implementer
- Acceptance:
  1. The `context` handler inserts its `<memory>` block right after a leading `compactionSummary` message, else at index 0; never at the tail. Cited: omp `session/agent-session.ts:2380-2403` (`buildLiveProviderContext` cuts the transformed history at `len(convert(history))`, so tail insertions misalign the async-compaction summarizer request).
  2. A test simulates that cut: for a history and retained tail, the first `len(handler(history))` messages of `handler(history + retained)` equal `handler(history)`.
  3. The reminder text is stable across requests while the state is unchanged (no per-request varying bytes). The input array is never mutated.
  4. Earlier tests still pass; README states the placement and why.
- Gates: `(cwd plugins/omp-plan-memory) bun test`
- Risk / rollback: revert the node's merge.
- Obstacle ledger: empty. Rounds: 0.

### T7 evolve for omp
- Status: pending
- depends_on: [T5]
- write_scope: plugins/omp-context/evolve/
- exclusive_resources: []
- role: implementer
- Acceptance:
  1. Reads omp session journals (`<dir>/**/*.jsonl`, format per omp `session/session-entries.ts`), copying each file to a temp location before parsing; finds `compaction` entries and builds replay cases (messages before the compaction, the questions to ask).
  2. Scores fact survival like `plugins/context-keeper/evolve/` (verbatim answers, train/holdout split, margin ≥ 1, value-leak rejection), with the scoring code tested on fixture journals.
  3. Generates candidate summaries through a pluggable generator; the default runs `omp -p --model <id> --session-dir <tmp>` with stdin closed; tests use a fake generator.
  4. Installs a candidate guidance file into a target directory (default the installed extension dir `~/.omp/agent/extensions/omp-context/`, overridable) **only** when train improves by the margin and holdout does not drop; otherwise writes nothing there and reports why. Both outcomes tested.
  5. `bun test` in `plugins/omp-context` covers evolve too; a README section documents the command.
- Gates: `(cwd plugins/omp-context) bun test`
- Risk / rollback: too few compaction points to show anything; the honest result is "nothing installed". Rollback = revert merge.
- Obstacle ledger: empty. Rounds: 0.

### T8 README (EN + ZH) for omp  [no-red-test: documentation only]
- Status: pending
- depends_on: [T1, T2, T3, T5, T6, T7]
- write_scope: README.md, README.zh-CN.md
- exclusive_resources: []
- role: implementer
- Acceptance:
  1. Both READMEs gain an omp install section beside the Claude Code and OpenCode ones: skill and agents copy commands, example `config.yml` (`modelRoles` with gpt-6.1-sol / opus-5.5, 500k cap via `compaction.modelThresholds`, `compaction.experimentalContextManagement: true` for context_notes), the three extensions (omp-sidebar, omp-context, omp-plan-memory), board MCP in `~/.omp/agent/mcp.json`, and how to run evolve.
  2. The tests section lists the new commands; the layout table lists `skills/omp/` and the three `plugins/omp-*` directories.
  3. The two READMEs say the same things; every path and command they name exists in the repo; counts stated in prose match the repo (e.g. number of roles / agent files).
- Gates: none runnable (Markdown); the orchestrator checks every named path with `ls`.
- Risk / rollback: drift from the code; rollback = revert merge.
- Obstacle ledger: empty. Rounds: 0.

### T9 end-to-end walkthrough on omp  [no-red-test: evidence report only]
- Status: pending
- depends_on: [T2, T3, T5, T6, T7]
- write_scope: docs/e2e/2026-10-16-omp-e2e.md
- exclusive_resources: [kimi-quota-and-tmux]
- role: qa
- Acceptance (each item recorded with the command and raw observation):
  1. In a /tmp repo set up by the Run recipe, omp lists the ten plan-sdd agents and `/skill:plan-sdd` loads the omp skill.
  2. A plan-sdd run on a tiny change dispatches at least one batch through `task`, collects returns with `wait`, and shows native todo progress.
  3. With a low compaction threshold, after a manual `/compact` and after a rollover (`experimentalContextManagement: true`), the omp-context restore block appears once and carries the user's words and plan status.
  4. A `context_notes` write shows up in the sidebar Pins section (tmux capture).
  5. The plan-memory reminder appears after a board run is opened and disappears after `plan_memory_list`.
  6. evolve runs over the walkthrough's session journals and reports install / no install with its scores.
  7. Measurement for the staged-clearing decision: context usage before and after omp's own pruning across the run, and whether old tool output stays in context.
  8. Sidebar regression (user request, 2026-10-16): the sidebar's automatic Git / Worktree / Directory projection still works with every extension of this run loaded. After the agent edits a file inside a second worktree of the /tmp repo, the Git / Worktree section switches to that checkout and shows its branch and unstaged diff without any manual step (tmux capture before and after).
- Gates: none runnable; the orchestrator reads the report and the raw captures.
- Risk / rollback: Kimi quota; findings of wrong behaviour in landed work become verify/fix pairs.
- Obstacle ledger: empty. Rounds: 0.

## Run recipe

Verified by the orchestrator, 2026-10-16 (`/tmp/omp-probe`): a project-local agent with `model: "@probe"`, `.omp/config.yml` `modelRoles: { probe: kimi-code/kimi-for-coding-highspeed }`, and

```
omp -p --session-dir /tmp/omp-probe/sess --model kimi-code/kimi-for-coding-highspeed "<prompt>" </dev/null
```

returned the subagent's reply (`PONG kimi-code/kimi-for-coding-highspeed`), exit 0; sessions were written only under `--session-dir`. Without `</dev/null` omp waits in `readPipedInput`. Interactive runs (needed for goal continuation and the sidebar) go in tmux: `tmux new-session -d -s <name> -x 200 -y 50 -c <repo> 'omp --session-dir <dir>'`, read with `tmux capture-pane -p`. Extensions load from `<repo>/.omp/extensions/` or `-e <path>`; `--no-extensions` skips the user's installed ones. Auth comes from the default profile (Kimi Code login); a named profile has no credentials and must not be given any.

## Hard rules (quoted by recon lane A)

- `Scripts/verify.sh` header: "The live stage links the very object file the release app links ... so it can never reach the real board at ~/.claude/plan-sdd/board.sqlite3. The script checks that file's timestamp before and after and fails if it moved."
- `Tests/BoardKitTests/StoreTests.swift:5-6`: "Never touches `Store.defaultDirectory` (`~/.claude/plan-sdd`), which holds the user's real board."
- `mcp/client_test.go:16-17`: "so these tests never touch 127.0.0.1:18888 or the app."
- `plugins/{context-keeper,goal,pin,plan-memory}/test/run.sh:2`: "State goes to a throwaway directory, never to ~/.local/state."
- `docs/plans/2026-10-03-delete-memory-escalation.md:508-509`: "**Override with `BOSS_SDD_HOME`** (absolute path) — every walkthrough must do this. The real board is live user data."
- Run rule (design decision 11): tests and checks never write `~/.omp/` or the user's Claude/OpenCode config.

## Risks and open items

- Deep imports from the omp release binary are not guaranteed (launch/* proven missing). Mitigated by decision 9.
- `session.compacting` is last-one-wins across extensions.
- `context`-event blocks (omp-context, omp-plan-memory) sit at index 1 after a leading summary, else right after the first real user message. Residuals from the T5/T11 adversary, not observed in QA: old sessions persisted with legacy Anthropic native compaction get their file metadata emitted before the block; a `tool_result` or `turn_start` between the two conversions of one async-compaction cut can still flip plan-memory's block; a retained tail starting with a `toolResult` was not checked. T9 watches for compaction errors.
- Per-request `context` blocks may cost prompt-cache hits; T9 observes.
- Real models gpt-6.1-sol / opus-5.5 are not available on this machine; only Kimi is exercised.
- The reference clone (commit 9d81cd1, package 18.11.1) is not proven identical to the binary.

## Decision queue

1. Committed the omp-sidebar baseline to main (dfe5aaa) before the run: user said "5 可以 你自己决定".
2. e2e isolation by project-local `.omp/` + `--session-dir` instead of a named profile, because a profile has no credentials and copying them is a secrets action.
3. `skills/omp` split into T4 (roles) then T3 (core), serial, so T3's link check sees the role files.
4. The reviewer role's omp agent is named `plan-reviewer`, because omp bundles `reviewer` and a same-named agent silently shadows it for the user's everyday omp use (T4 found it at `task/agents.ts:44-48`). The other option was to keep `reviewer` and accept the shadowing.
5. T1's gate showed a pre-existing flaky sidebar test (1 failure in 6 runs, code unchanged since dfe5aaa). Treated as a test-only defect: T1's acceptance item 3 was amended to exclude that one test, and T10 makes it deterministic as a `[no-red-test]` task rather than a verify/fix pair, since no runtime behaviour is wrong. T2 waits for T10 so its gates are reliable.

## Needs a decision from the user

(none yet)

## Gates

Per task, run by the orchestrator, one command at a time, never piped (cwd in parentheses):

```
(plugins/omp-sidebar)      bun install --frozen-lockfile
(plugins/omp-sidebar)      bun test
(repo root)                bun test skills/omp/test/roles.test.ts
(repo root)                bun test skills/omp/test/skill.test.ts
(plugins/omp-context)      bun test
(plugins/omp-plan-memory)  bun test
```

Phase 3, on the integration worktree, additionally the existing gates (quoted by lane A from `Scripts/verify.sh` and README "Plugin tests"): `swift build -c release --product BossSDD`; `swift test`; `(cd mcp && go build ./...)`; `(cd mcp && go test -count=1 ./...)`; `sh plugins/context-keeper/test/run.sh`; `sh plugins/pin/test/run.sh`; `sh plugins/goal/test/run.sh`; `sh plugins/plan-memory/test/run.sh`; `(cd plugins/todo && bun test)`; `./Scripts/verify.sh`.
