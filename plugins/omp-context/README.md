# omp-context

An omp extension that keeps the working set alive across context compaction.

## What it does

It tracks, per session:

- the user's last few messages, verbatim (at most 8, 1000 characters each). Text starting with `/` or `!` (slash commands, `/skill:...`, shell escapes) and agent-attributed user messages are not recorded; a message seen through both `input` and `message_end` is listed once;
- the active plan document (a `docs/plans/*.md` file that was read, written or edited, with any read selector such as `:raw`, `:5-10,20-30` stripped) and its `Status:` line. A ranged read, or a read without a `Status:` line, re-reads the status from disk and falls back to the previous status of the same plan;
- skills loaded: a `/skill:<name>` invocation (`skill-prompt` custom message), a `skill://<name>` read, or a read of `.../skills/<name>/SKILL.md`;
- git branch and worktree list (`pi.exec`, 3 s timeout).

**After a compaction or rollover** (`session_compact`) it builds one restore block with that set, once per compaction entry id, and keeps it as the pending block. The block is delivered through omp's `context` event (documented in omp `docs/extensions.md:485`: `context` receives the conversation messages and may return `{ messages }`; source: `extensions/types.ts:1480-1482`, `runner.ts:2009`, `sdk.ts:4253-4256`): the extension returns `{messages}` with one synthetic user message inserted (see Placement), so it rides on every provider request (including mid-run steps and print mode, since `context` is called from the session's `transformContext`) until the next compaction replaces it with a block rebuilt from the then-current state. Nothing is persisted and no turn is started; `pi.sendMessage` is not used, because `nextTurn` waits for the next user prompt and `aside` at a post-turn compaction can wake a model turn nobody asked for. A second compaction with identical state still keeps exactly one block in place. After a rollover (`compaction.experimentalContextManagement` on) the block is thin: words, plan, git and worktrees only, since omp keeps skill and plan reads and already reminds the model to save notes.

Placement: the block is one synthetic user message (`timestamp: 0`, no `attribution`). If the request starts with a `compactionSummary`, the block goes at index 1. Otherwise it goes immediately after the first non-synthetic user message. If neither applies, nothing is inserted. It is never put at the tail or at index 0:

- omp builds its summarizer request from `convert(history)` and `convert(history + retained)` and cuts the second at the length of the first (`session/agent-session.ts:2380-2403`). A tail block would move that cut by its own size, could split a tool call from its result and would pull retained messages into the summarized range. With this rule both conversions start with the same summary, so a summary-led request has the block at index 1 in both. Without a summary, a user message in history sits at the same index in both, and a user message only in `retained` lies after the cut. Either way the prefix is exactly `convert(history)`. A looser fallback ("after the summary only when there is no user message") would misalign: history alone would put the block at 1 while history plus retained anchors on a user message inside retained.
- A block at index 0 would become the date/cwd reminder's root (`session/date-cwd-reminder.ts:66`). With a summary first the converted summary is the first user message, so that anchor is unchanged.
- Known cost: after an Anthropic native compaction summary the block sits between the summary and the first retained turn, which stops the converter merging the summary into a following assistant turn (`ai/src/providers/anthropic.ts:6190-6208`). Role alternation stays valid.
- The timestamp is the constant 0 because a real one makes `flushCompactionFiles(msg.timestamp)` (`anthropic.ts:5869`, `ai/src/types.ts:1108-1130`) replay the summary's file metadata in front of the retained tail.

Prompt-cache cost: the block sits after the summary (or the first user message), and its bytes are constant between compactions (the nudge's numbers are frozen when it latches), so it shifts the cached prefix once per compaction or nudge latch and is stable otherwise. What you pay is the block's size (a few hundred tokens) on each request until the next compaction.

**During summarization** (`session.compacting`) it returns summary requirements as `context`: keep the user's words verbatim, plan status, open nodes, worktrees, pending decisions. It does not register `session_before_compact`, so omp's async speculative compaction stays on.

**Near-budget nudge** (legacy compaction mode only): in the `context` handler, when `ctx.getContextUsage().tokens` reaches `nudgeFraction` (default 0.85) of omp's effective compaction trigger for the active model, a reminder (with the numbers frozen at that moment) is added to the same block on every request until the next compaction (it asks the model to restate key words, plan status and open decisions). After a compaction the nudge is not evaluated again until the next `turn_end`, so stale usage cannot re-arm it. No nudge when `compaction.experimentalContextManagement` is on (omp already reminds), when the mode or threshold cannot be read, or when compaction is disabled.

Mode and threshold are read from omp itself (`compaction.experimentalContextManagement` and `describeModelCompactionPoint`), so `compaction.thresholdPercent`, `compaction.thresholdTokens`, `compaction.modelThresholds` and the reserve-based default are all honoured. If those omp modules fail to load, the nudge stays quiet and everything else keeps working.

Every failure (git missing, no context usage, unreadable guidance file, throwing handler) degrades to a smaller block; nothing throws into omp.

## Install

Copy this directory to `~/.omp/agent/extensions/omp-context/` (or a project's `.omp/extensions/omp-context/`). `package.json` declares `"omp": { "extensions": ["./index.ts"] }`. No dependencies to install.

## Settings

- `compaction.experimentalContextManagement`, `compaction.thresholdPercent`, `compaction.thresholdTokens`, `compaction.modelThresholds`: omp's own settings; the extension only reads them.
- `OMP_CONTEXT_NUDGE_FRACTION` (environment variable): fraction of the threshold at which to nudge. Accepted only when it parses to a number with 0 < f < 1; anything else uses the default 0.85. A `nudgeFraction` passed to the factory beats the env.
- Session state is kept for the 32 most recently used sessions.
- `guidance.md` next to `index.ts` (so `~/.omp/agent/extensions/omp-context/guidance.md` once installed): the summary requirements text. When missing, empty or unreadable, a built-in default is used. The `evolve/` tooling replaces this file.

## Tests

`bun test` drives a fake `pi`/`ctx` and temp directories; it never touches `~/.omp`.
