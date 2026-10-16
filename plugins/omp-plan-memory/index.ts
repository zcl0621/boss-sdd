// omp-plan-memory: reminders for the plan-sdd board's project memory (plan_memory_* tools), for omp.
//
// Port of plugins/plan-memory/plan-memory.js. The skill already says when to read, write and tidy project memory;
// this only reminds. It watches finished board calls and, while a reminder is due, adds a short <memory> block to
// each provider request: right after a compactionSummary found among the leading custom and synthetic user messages,
// else right after the earliest user turn (first non-synthetic user message or user-attributed skill-prompt custom
// message, whichever comes first), else none (see insertReminder). Never at the tail or index 0. Reasons: omp's
// compact() builds the summarizer request with
// buildLiveProviderContext (session/agent-session.ts:2380-2403), which runs history and history+retained through this
// handler and cuts the second result at len(first); a tail block shifts that cut and can split a tool_use/tool_result
// pair, while this rule keeps the first len(first) messages identical (no user message in history and no summary: the
// block lands in the retained part, after the cut). Index 0 is the date/cwd reminder root (date-cwd-reminder.ts:66).
// A native Anthropic summary is never split from the assistant turn folded into it (see anchorIndex).
// The `context` event returns {messages} per request without touching the stored history (docs/extensions.md
// "context"; types.ts ContextEventResult). Presence and text depend only on state; the timestamp is constant 0.
//
//   - read:  a run is open and plan_memory_list has not been called since the previous run finished;
//   - write: recon was dispatched and the task graph written, and nothing was filed with plan_memory_add;
//            counted in agent turns (turn_start while due), shown while the count is < 3 (3 turns, counting the one in which it became due), since recon may have
//            found nothing new;
//   - tidy:  five tasks reached done/blocked since memory was last listed, or the run moved to review (close-out).
//
// Board calls are recognised by the registered tool name in `tool_result` events: plain `plan_*`, or the name omp
// mints for an MCP tool, `mcp__<server>_<tool>` (mcp/tool-bridge.ts mintMCPToolName), under any server key
// (e.g. `mcp__plan_sdd_plan_memory_list`, `mcp__board_plan_memory_list`, `mcp__plan_memory_list`). A call through
// `write xd://<tool>` fires an outer `write` event and an inner event with the registered name; only the inner one
// counts, so one call is never counted twice. Do not dedupe by toolCallId: the two events share it.
//
// State: $OMP_PLAN_MEMORY_STATE_DIR, else omp-plan-memory/ in omp's agent directory ($PI_CODING_AGENT_DIR, else
// ~/$PI_CONFIG_DIR/agent with PI_CONFIG_DIR defaulting to .omp, as omp's utils/src/dirs.ts resolves it), one
// omp-plan-memory-<session>.json each.
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"

export const LIMITS = {
  tidyEvery: 5, // tasks reaching done/blocked between tidy-ups (the skill's rule)
  writeShows: 3, // agent turns (turn_start) that count toward the write reminder before it is dropped
  keepDays: 30,
}
export const BLOCK = "<memory>"

interface State {
  run: boolean
  listed: boolean
  recon: boolean
  graph: boolean
  added: number
  writeShows: number
  /** Distinct tasks that reached done/blocked since memory was last listed. */
  closedIds: string[]
  tidyDue: boolean
}

const agentDir = () =>
  process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || homedir(), process.env.PI_CONFIG_DIR || ".omp", "agent")
const stateDir = () => process.env.OMP_PLAN_MEMORY_STATE_DIR || path.join(agentDir(), "omp-plan-memory")
const FILE_PREFIX = "omp-plan-memory-"
const file = (sid: string) => path.join(stateDir(), `${FILE_PREFIX}${sid.replace(/[^\w.-]/g, "_")}.json`)
const empty = (): State => ({ run: false, listed: false, recon: false, graph: false, added: 0, writeShows: 0, closedIds: [], tidyDue: false })
const load = (sid: string): State => {
  try {
    const saved = { ...empty(), ...JSON.parse(readFileSync(file(sid), "utf8")) }
    if (!Array.isArray(saved.closedIds)) saved.closedIds = []
    return saved
  } catch {
    return empty()
  }
}
const save = (sid: string, state: State) => {
  mkdirSync(stateDir(), { recursive: true })
  const tmp = `${file(sid)}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 1))
  renameSync(tmp, file(sid))
}
const pruneOld = () => {
  try {
    const dir = stateDir()
    const cutoff = Date.now() - LIMITS.keepDays * 86_400_000
    for (const f of readdirSync(dir))
      // only files this plugin writes (omp-plan-memory-<session>.json and its .<pid>.tmp); the directory may be shared
      if (f.startsWith(FILE_PREFIX) && (f.endsWith(".json") || /\.json\.\d+\.tmp$/.test(f)))
        try {
          if (statSync(path.join(dir, f)).mtimeMs < cutoff) unlinkSync(path.join(dir, f))
        } catch {}
  } catch {}
}

// The board's tools (mcp/main.go). Matching a fixed set, not a pattern, because omp's minted name can lose or gain
// `plan_` text: a server key `plan` strips the tool's `plan_` prefix (`mcp__plan_memory_list`), and a key such as
// `my_plan_board` puts `plan_` into the server part.
const BOARD_TOOLS = [
  "plan_board_status", "plan_create_run", "plan_delete_run", "plan_delete_task", "plan_get_run", "plan_graph",
  "plan_memory_add", "plan_memory_delete", "plan_memory_get", "plan_memory_list", "plan_set_task", "plan_set_tasks",
  "plan_update_run",
]
const boardTool = (name: string): string | undefined => {
  if (BOARD_TOOLS.includes(name)) return name
  if (!name.startsWith("mcp__")) return undefined
  const rest = name.slice("mcp__".length)
  let best: string | undefined
  for (const t of BOARD_TOOLS)
    if ((rest === t || rest.endsWith(`_${t}`)) && (!best || t.length > best.length)) best = t
  return best
}

// Tasks a plan_set_task / plan_set_tasks input writes, as [id, status]. plan_set_task carries id and status at the
// top level (mcp/main.go setTaskInput); a nested `task` object is accepted too.
const taskWrites = (name: string, input: any): [string, string][] => {
  const entries = name === "plan_set_tasks" ? (Array.isArray(input?.tasks) ? input.tasks : []) : [input?.task ?? input]
  return entries
    .filter((t: any) => t && typeof t.status === "string")
    .map((t: any) => [String(t.id ?? JSON.stringify(t)), t.status] as [string, string])
}

// The board call in one finished tool call, as [name, input-as-text], or none.
export function boardCalls(tool: unknown, input: unknown): [string, string][] {
  const name = boardTool(String(tool ?? ""))
  return name ? [[name, JSON.stringify(input ?? {})]] : []
}

const isRecon = (input: any): boolean => {
  const agents = [input?.agent, ...(Array.isArray(input?.tasks) ? input.tasks.map((t: any) => t?.agent) : [])]
  return agents.some((a) => typeof a === "string" && /^recon/.test(a))
}

// The task ids a plan_set_tasks result says landed (`written`, mcp/main.go batchOutput), or undefined when the
// result is not readable. A batch the board refuses lands nothing: written is empty, failed lists every task.
// omp keeps the server's structured result in details.structuredContent for programmatic use and only renders it
// into the text content (mcp/tool-bridge.ts:237-300), so that copy is read first, the text JSON second.
const writtenIds = (content: unknown, details?: any): Set<string> | undefined => {
  const structured = details?.structuredContent?.written
  if (Array.isArray(structured)) return new Set(structured.map(String))
  const text = Array.isArray(content) ? content.find((b: any) => b?.type === "text" && typeof b.text === "string")?.text : undefined
  if (typeof text !== "string") return undefined
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed?.written) ? new Set(parsed.written.map(String)) : undefined
  } catch {
    return undefined
  }
}

// Update the state for one finished tool call. Returns whether anything changed. `content` is the tool result.
export function observe(state: State, tool: unknown, input: any, content?: unknown, details?: unknown): boolean {
  let changed = false
  if (tool === "task" && isRecon(input) && !state.recon) (state.recon = true), (changed = true)
  for (const [name, text] of boardCalls(tool, input)) {
    changed = true
    // A new run keeps `listed`: the orchestrator often lists memory just before creating the run. A finished run
    // clears it, so the next run reads memory again.
    if (name === "plan_create_run") Object.assign(state, { run: true, recon: false, graph: false, added: 0, writeShows: 0, closedIds: [], tidyDue: false })
    else if (name === "plan_memory_list") Object.assign(state, { listed: true, closedIds: [], tidyDue: false })
    else if (name === "plan_memory_add") state.added++
    else if (name === "plan_set_tasks") state.graph = true
    if (name === "plan_set_task" || name === "plan_set_tasks") {
      // Distinct ids: a batch that re-sends tasks already done does not count them again. For a batch, only tasks
      // the board reports as written count.
      const landed = name === "plan_set_tasks" ? writtenIds(content, details) : undefined
      for (const [id, status] of taskWrites(name, input))
        if ((status === "done" || status === "blocked") && (!landed || landed.has(id)) && !state.closedIds.includes(id))
          state.closedIds.push(id)
      if (state.listed && state.closedIds.length >= LIMITS.tidyEvery) state.tidyDue = true
    }
    if (name === "plan_update_run" && /"status":"review"/.test(text)) state.tidyDue = true
    if (name === "plan_update_run" && /"status":"done"/.test(text)) Object.assign(state, { run: false, listed: false, tidyDue: false })
  }
  return changed
}

const writeDue = (s: State) => s.run && s.recon && s.graph && s.added === 0

// The reminder for this request, or "" when none is due. A pure function of the state: the `context` event fires once
// per conversion (compaction converts twice, /btw and dumps convert too), so nothing may be counted here.
export function reminder(state: State): string {
  const lines: string[] = []
  if (state.run && !state.listed)
    lines.push("Project memory has not been read for this run: call plan_memory_list for the project and hand the entries to recon (references/memory.md, phase 0).")
  if (writeDue(state) && state.writeShows < LIMITS.writeShows) {
    lines.push("Recon has reported and the task graph is written, but nothing was filed in project memory. If recon confirmed a gate command, run recipe, hard rule or exclusive resource that memory lacks or has wrong, file it with plan_memory_add (with its source); if there is nothing new, carry on.")
  }
  if (state.tidyDue)
    lines.push(`A project memory tidy-up is due (${state.closedIds.length >= LIMITS.tidyEvery ? `${state.closedIds.length} tasks reached done/blocked since memory was last listed` : "the run is closing out"}): run it as references/memory.md describes, starting with plan_memory_list.`)
  return lines.length ? `${BLOCK}${lines.join("\n")}</memory>` : ""
}

// Where the block goes: right after a compactionSummary found among the leading custom (or synthetic user) messages;
// else right after the earliest user turn: the first non-synthetic user message or user-attributed `skill-prompt`
// custom message (omp's isUserInvokedSkillPrompt, tui/src/chat/messages.ts:273-275), whichever comes first; else
// nowhere (null). Not the tail (see the header). After a rollover omp's buildSessionContext puts the summary first
// (session/session-context.ts:540-545), re-appends the latest user request, for a /skill-started run the skill-prompt
// (:547-569), and splices the context-notes custom message in at index 0 (:646-670); T9 saw [custom notes,
// compactionSummary, custom skill-prompt, custom todo, assistant, toolResult] with no user role. A run started with
// /skill:plan-sdd has the skill-prompt as its only user turn even before any compaction. Why not "user only": the
// retained part may hold no user message and the reminder would vanish; a summary-only fallback taken when no user
// message exists, or a "user first, skill-prompt second" order, would misalign the cut. This rule gives the same
// position for history and history+retained in every case (the cut's history is the rebuilt summary plus entries after
// the previous compaction, agent/src/compaction/compaction.ts:2051-2070). After a native Anthropic summary
// (providerPayload.type "anthropicCompaction") the anchor moves past a directly following assistant turn, its
// toolResults and the notes message, where omp puts the notes (session/session-context.ts:651-662), so the summary's
// fold into that turn is never split; the native cut never separates a tool call from its results
// (agent/src/compaction/anthropic.ts:137-171), so history and history+retained still agree. Index 0 is omp's date/cwd
// reminder root.
// Returns a new array; the input is never mutated. timestamp is constant: Date.now() would make otherwise identical
// requests differ.
// Same body as anchorIndex in plugins/omp-context/index.ts; keep the two identical.
function anchorIndex(messages: any[]): number {
  const isSyntheticUser = (m: any): boolean => m?.role === "user" && m.synthetic === true
  const isUserTurn = (m: any): boolean =>
    (m?.role === "user" && m.synthetic !== true) ||
    (m?.role === "custom" && m.customType === "skill-prompt" && m.attribution === "user")
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m?.role !== "compactionSummary") {
      if (m?.role === "custom" || isSyntheticUser(m)) continue
      break
    }
    // A native Anthropic summary is folded into a directly following assistant turn (signed thinking bound to that
    // prefix): never split it. Mirror omp's notes placement (session/session-context.ts:651-662): past one assistant
    // message, then its toolResults, then past the notes message omp put there.
    let at = i
    if (m.providerPayload?.type === "anthropicCompaction") {
      if (messages[at + 1]?.role === "assistant") at++
      while (messages[at + 1]?.role === "toolResult") at++
      const next = messages[at + 1]
      if (next?.role === "custom" && next.customType === "experimental_context_notes") at++
    }
    return at
  }
  return messages.findIndex(isUserTurn)
}

export function insertReminder(messages: any[], text: string): any[] | null {
  const anchor = anchorIndex(messages)
  if (anchor < 0) return null
  const block = { role: "user", content: [{ type: "text", text }], synthetic: true, timestamp: 0 }
  return [...messages.slice(0, anchor + 1), block, ...messages.slice(anchor + 1)]
}

export default function planMemory(pi: ExtensionAPI): void {
  pruneOld()
  // Per-session state is read from disk once, then kept here: a failed save (unwritable state dir) must not lose a
  // transition. Saving is best-effort; the disk copy only lets a restarted omp pick the session up again.
  const sessions = new Map<string, State>()
  const stateOf = (sid: string): State => {
    let state = sessions.get(sid)
    if (!state) sessions.set(sid, (state = load(sid)))
    return state
  }
  // Failures are logged through omp's extension logger, once per session per kind. Logging itself never throws.
  const logged = new Set<string>()
  const logOnce = (kind: "handler" | "save", sid: string, error: unknown) => {
    try {
      const key = `${kind}:${sid}`
      if (logged.has(key)) return
      logged.add(key)
      pi.logger?.warn(kind === "save" ? "omp-plan-memory: state not saved" : "omp-plan-memory: handler failed", { error: String(error) })
    } catch {}
  }
  const sidOf = (ctx: any): string => {
    try {
      return String(ctx.sessionManager.getSessionId())
    } catch {
      return "?"
    }
  }
  const trySave = (sid: string, state: State) => {
    try {
      save(sid, state)
    } catch (error) {
      logOnce("save", sid, error)
    }
  }
  pi.on("tool_result", async (event: any, ctx: any) => {
    try {
      if (event.isError) return
      const sid = ctx.sessionManager.getSessionId()
      const state = stateOf(sid)
      if (observe(state, event.toolName, event.input, event.content, event.details)) trySave(sid, state)
    } catch (error) {
      logOnce("handler", sidOf(ctx), error)
    }
  })
  pi.on("context", async (event: any, ctx: any) => {
    try {
      const state = stateOf(ctx.sessionManager.getSessionId())
      if (!state.run) return
      const text = reminder(state)
      if (!text) return
      const messages = insertReminder(event.messages, text)
      return messages ? { messages } : undefined
    } catch (error) {
      logOnce("handler", sidOf(ctx), error)
      return undefined
    }
  })
  // One agent turn. Counts the write reminder's turns, only while that reminder is due.
  pi.on("turn_start", async (_event: any, ctx: any) => {
    try {
      const sid = ctx.sessionManager.getSessionId()
      const state = stateOf(sid)
      if (!writeDue(state) || state.writeShows >= LIMITS.writeShows) return
      state.writeShows++
      trySave(sid, state)
    } catch (error) {
      logOnce("handler", sidOf(ctx), error)
    }
  })
}
