// plan-memory: reminders for the plan-sdd board's project memory (plan_memory_* tools), for opencode 2.x.
//
// The skill already says when to read, write and tidy project memory. In recorded runs the orchestrator nearly
// always read it, almost never wrote what recon had confirmed, and never tidied after five nodes. This plugin only
// reminds; what to read, write or delete is still the skill's call. It watches board calls and, while a reminder is due, adds a short <memory> block as the last message of
// each request (never stored in the history, so the cached prefix is unaffected):
//   - read:  a run is open and plan_memory_list has not been called since the previous run finished;
//   - write: recon was dispatched and the task graph written, and nothing was filed with plan_memory_add;
//            shown for a few requests only, since recon may have found nothing new;
//   - tidy:  five tasks reached done/blocked since memory was last listed, or the run moved to review (close-out).
//
// State: $XDG_STATE_HOME/opencode-plan-memory/<session>.json.
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const STATE_DIR = path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"), "opencode-plan-memory")
export const LIMITS = {
  tidyEvery: 5, // tasks reaching done/blocked between tidy-ups (the skill's rule)
  writeShows: 3, // requests that carry the write reminder before it is dropped
  keepDays: 30,
}
export const BLOCK = "<memory>"

const file = (sid) => path.join(STATE_DIR, `${sid.replace(/[^\w.-]/g, "_")}.json`)
const empty = () => ({ run: false, listed: false, recon: false, graph: false, added: 0, writeShows: 0, closed: 0, tidyDue: false })
const load = (sid) => {
  try {
    return { ...empty(), ...JSON.parse(readFileSync(file(sid), "utf8")) }
  } catch {
    return empty()
  }
}
const save = (sid, state) => {
  mkdirSync(STATE_DIR, { recursive: true })
  const tmp = `${file(sid)}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 1))
  renameSync(tmp, file(sid))
}
const pruneOld = () => {
  try {
    const cutoff = Date.now() - LIMITS.keepDays * 86_400_000
    for (const f of readdirSync(STATE_DIR))
      try {
        if (statSync(path.join(STATE_DIR, f)).mtimeMs < cutoff) unlinkSync(path.join(STATE_DIR, f))
      } catch {}
  } catch {}
}

// The board call in one finished tool call, as [name, input-as-text], or none. In code mode a board call inside
// `execute` fires its own tool event (as "plan-sdd_plan_…") besides the one for `execute`, so only that one counts;
// reading the execute code as well would count every call twice.
export function boardCalls(tool, input) {
  const direct = String(tool ?? "").match(/(plan_[a-z_]+)$/)
  return direct ? [[direct[1], JSON.stringify(input ?? {})]] : []
}

// Update the state for one finished tool call. Returns whether anything changed.
export function observe(state, tool, input) {
  let changed = false
  if (tool === "subagent" && input?.agent === "recon" && !state.recon) (state.recon = true), (changed = true)
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
export function reminder(state) {
  const lines = []
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

export default {
  id: "plan-memory",
  async setup(ctx) {
    pruneOld()
    await ctx.tool.hook("execute.after", async (e) => {
      if (e.status !== "completed") return
      const state = load(e.sessionID)
      if (observe(state, e.tool, e.input)) save(e.sessionID, state)
    })
    await ctx.session.hook("context", async (e) => {
      const state = load(e.sessionID)
      if (!state.run) return
      const before = state.writeShows
      const text = reminder(state)
      if (state.writeShows !== before) save(e.sessionID, state)
      if (text) e.messages.push({ role: "user", metadata: { synthetic: true }, content: [{ type: "text", text }] })
    })
  },
}
