// omp-plan-memory: reminders for the plan-sdd board's project memory (plan_memory_* tools), for omp.
//
// Port of plugins/plan-memory/plan-memory.js. The skill already says when to read, write and tidy project memory;
// this only reminds. It watches finished board calls and, while a reminder is due, adds a short <memory> block as
// the last message of each provider request. The `context` event returns {messages} per request without touching
// the stored history (docs/extensions.md "context"; types.ts ContextEventResult), so the cached prefix is unaffected.
//   - read:  a run is open and plan_memory_list has not been called since the previous run finished;
//   - write: recon was dispatched and the task graph written, and nothing was filed with plan_memory_add;
//            shown for a few requests only, since recon may have found nothing new;
//   - tidy:  five tasks reached done/blocked since memory was last listed, or the run moved to review (close-out).
//
// Board calls are recognised by the registered tool name in `tool_result` events: plain `plan_*`, or the name omp
// mints for an MCP tool, `mcp__<server>_<tool>` (mcp/tool-bridge.ts mintMCPToolName), under any server key
// (e.g. `mcp__plan_sdd_plan_memory_list`, `mcp__board_plan_memory_list`, `mcp__plan_memory_list`). A call through
// `write xd://<tool>` fires an outer `write` event and an inner event with the registered name; only the inner one
// counts, so one call is never counted twice. Do not dedupe by toolCallId: the two events share it.
//
// State: $OMP_PLAN_MEMORY_STATE_DIR, else $XDG_STATE_HOME/omp-plan-memory/ (default ~/.local/state/omp-plan-memory/),
// one omp-plan-memory-<session>.json each.
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"

export const LIMITS = {
  tidyEvery: 5, // tasks reaching done/blocked between tidy-ups (the skill's rule)
  writeShows: 3, // requests that carry the write reminder before it is dropped
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
  closed: number
  tidyDue: boolean
}

const stateDir = () =>
  process.env.OMP_PLAN_MEMORY_STATE_DIR ||
  path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "omp-plan-memory")
const FILE_PREFIX = "omp-plan-memory-"
const file = (sid: string) => path.join(stateDir(), `${FILE_PREFIX}${sid.replace(/[^\w.-]/g, "_")}.json`)
const empty = (): State => ({ run: false, listed: false, recon: false, graph: false, added: 0, writeShows: 0, closed: 0, tidyDue: false })
const load = (sid: string): State => {
  try {
    return { ...empty(), ...JSON.parse(readFileSync(file(sid), "utf8")) }
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

// The board call in one finished tool call, as [name, input-as-text], or none.
export function boardCalls(tool: unknown, input: unknown): [string, string][] {
  const name = boardTool(String(tool ?? ""))
  return name ? [[name, JSON.stringify(input ?? {})]] : []
}

const isRecon = (input: any): boolean => {
  const agents = [input?.agent, ...(Array.isArray(input?.tasks) ? input.tasks.map((t: any) => t?.agent) : [])]
  return agents.some((a) => typeof a === "string" && /^recon/.test(a))
}

// Update the state for one finished tool call. Returns whether anything changed.
export function observe(state: State, tool: unknown, input: any): boolean {
  let changed = false
  if (tool === "task" && isRecon(input) && !state.recon) (state.recon = true), (changed = true)
  for (const [name, text] of boardCalls(tool, input)) {
    changed = true
    // A new run keeps `listed`: the orchestrator often lists memory just before creating the run. A finished run
    // clears it, so the next run reads memory again.
    if (name === "plan_create_run") Object.assign(state, { run: true, recon: false, graph: false, added: 0, writeShows: 0, closed: 0, tidyDue: false })
    else if (name === "plan_memory_list") Object.assign(state, { listed: true, closed: 0, tidyDue: false })
    else if (name === "plan_memory_add") state.added++
    else if (name === "plan_set_tasks") state.graph = true
    if (name === "plan_set_task" || name === "plan_set_tasks") {
      state.closed += (text.match(/"status":"(done|blocked)"/g) ?? []).length
      if (state.listed && state.closed >= LIMITS.tidyEvery) state.tidyDue = true
    }
    if (name === "plan_update_run" && /"status":"review"/.test(text)) state.tidyDue = true
    if (name === "plan_update_run" && /"status":"done"/.test(text)) Object.assign(state, { run: false, listed: false, tidyDue: false })
  }
  return changed
}

// The reminder for this request, or "" when none is due. Counts the write reminder's showings.
export function reminder(state: State): string {
  const lines: string[] = []
  if (state.run && !state.listed)
    lines.push("Project memory has not been read for this run: call plan_memory_list for the project and hand the entries to recon (references/memory.md, phase 0).")
  if (state.run && state.recon && state.graph && state.added === 0 && state.writeShows < LIMITS.writeShows) {
    state.writeShows++
    lines.push("Recon has reported and the task graph is written, but nothing was filed in project memory. If recon confirmed a gate command, run recipe, hard rule or exclusive resource that memory lacks or has wrong, file it with plan_memory_add (with its source); if there is nothing new, carry on.")
  }
  if (state.tidyDue)
    lines.push(`A project memory tidy-up is due (${state.closed >= LIMITS.tidyEvery ? `${state.closed} tasks reached done/blocked since memory was last listed` : "the run is closing out"}): run it as references/memory.md describes, starting with plan_memory_list.`)
  return lines.length ? `${BLOCK}${lines.join("\n")}</memory>` : ""
}

export default function planMemory(pi: ExtensionAPI): void {
  pruneOld()
  pi.on("tool_result", async (event: any, ctx: any) => {
    if (event.isError) return
    const sid = ctx.sessionManager.getSessionId()
    const state = load(sid)
    if (observe(state, event.toolName, event.input)) save(sid, state)
  })
  pi.on("context", async (event: any, ctx: any) => {
    const sid = ctx.sessionManager.getSessionId()
    const state = load(sid)
    if (!state.run) return
    const before = state.writeShows
    const text = reminder(state)
    if (state.writeShows !== before) save(sid, state)
    if (!text) return
    return {
      messages: [
        ...event.messages,
        { role: "user", content: [{ type: "text", text }], synthetic: true, timestamp: Date.now() },
      ],
    }
  })
}
