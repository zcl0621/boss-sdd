// goal: an unattended objective for an opencode 2 session.
//
// The model calls `goal set` when the user asks it to run without waiting. While the goal is active and the
// session goes idle, the plugin waits a moment and sends a short <goal-continue> message, so the run keeps going
// across turns (and across compactions; context-keeper restores the goal from this plugin's state file).
//
// It stops resuming when
//   - the model calls `goal wait` (something only the user can give) or `goal complete` (with evidence);
//   - the user interrupts, or the turn fails (quota, provider error);
//   - two automatic continues in a row ran no tool;
//   - OPENCODE_GOAL_MAX_CONTINUES is reached.
// A new message from the user turns a waiting goal back to active.
//
// Background subagents report back by themselves (the host wakes the session), so while one is still running the
// plugin waits OPENCODE_GOAL_CHILD_WAIT_MS instead of the short delay before nudging.
//
// State: $XDG_STATE_HOME/opencode-goal/<sessionID>.json (default ~/.local/state). The sidebar plugin reads it.
// Checked against opencode 2.0.23: a turn ends with session.execution.succeeded (older builds: session.status idle).

import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const STATE_DIR = path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"), "opencode-goal")
const CONTINUE = "<goal-continue>"
const DELAY_MS = Number(process.env.OPENCODE_GOAL_DELAY_MS) || 5_000
const MAX_CONTINUES = Number(process.env.OPENCODE_GOAL_MAX_CONTINUES) || 200
const CHILD_WAIT_MS = Number(process.env.OPENCODE_GOAL_CHILD_WAIT_MS) || 30 * 60 * 1000
const RESUME_AFTER_MS = Number(process.env.OPENCODE_GOAL_RESUME_AFTER_MS) || 60_000
const SEEN_MAX = 500
// Messages that are not the user writing: compaction checkpoints, subagent reports, other plugins' notices.
const NOT_USER = ["<conversation-checkpoint>", "<subagent ", "Additional summary requirements", CONTINUE, "<context-budget>"]

const file = (sid) => path.join(STATE_DIR, `${sid}.json`)
const empty = () => ({ goal: null, seen: [], children: {}, childSince: {} })
// A missing file is a fresh session. A corrupt one is kept aside (not overwritten by the next save) and logged.
const load = (sid) => {
  let raw
  try {
    raw = readFileSync(file(sid), "utf8")
  } catch {
    return empty()
  }
  try {
    const parsed = JSON.parse(raw)
    const state = empty()
    for (const [k, v] of Object.entries(parsed ?? {})) if (v !== null && v !== undefined) state[k] = v
    return state
  } catch (err) {
    const aside = `${file(sid)}.corrupt-${Date.now()}`
    try {
      renameSync(file(sid), aside)
    } catch {}
    console.warn(`[goal] unreadable state file moved to ${aside}: ${err?.message ?? err}`)
    return empty()
  }
}
// Write-then-rename, so a reader (the sidebar) never sees half a file.
const save = (sid, state) => {
  mkdirSync(STATE_DIR, { recursive: true })
  const tmp = `${file(sid)}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 1))
  renameSync(tmp, file(sid))
}
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s)
// Children a subagent tool result says are still running: older builds return text ("working in the background
// (sessionID: ses_…)"), 2.0.23 a structured result ({ sessionID, status: "running" }).
export const launchedChildren = (result) => {
  const ids = [...textOf(result).matchAll(/working in the background \(sessionID: (ses_[A-Za-z0-9]+)\)/g)].map((t) => t[1])
  const raw = JSON.stringify(result ?? "")
  for (const t of raw.matchAll(/\\?"sessionID\\?"\s*:\s*\\?"(ses_[A-Za-z0-9]+)\\?"/g)) {
    // the status in the same object (either order); only "running" counts
    const obj = raw.slice(raw.lastIndexOf("{", t.index), raw.indexOf("}", t.index) + 1)
    if (/\\?"status\\?"\s*:\s*\\?"running\\?"/.test(obj) && !ids.includes(t[1])) ids.push(t[1])
  }
  return ids
}
const stamp = (ms) => new Date(ms).toLocaleString("sv-SE", { hour12: false }).slice(0, 16)
export const BLOCK = "<goal>"
export const goalBlock = (goal) => {
  if (!goal || goal.status === "complete") return ""
  const head = `${BLOCK}Goal (${goal.status}${goal.reason ? `: ${goal.reason}` : ""}; set ${stamp(goal.setAt ?? goal.at ?? Date.now())}): ${clip(goal.objective, 600)}\n`
  return (
    head +
    (goal.status === "active"
      ? "Standing record of the objective, repeated on every request; it is not a prompt to act on this one. The goal ends with goal complete (with evidence) once it is met, or goal wait when only the user can unblock it."
      : "Standing record. Waiting on the user; it resumes when they write.") +
    "</goal>"
  )
}
const textOf = (v) => (typeof v === "string" ? v : v?.type === "text" ? String(v.value ?? "") : JSON.stringify(v ?? ""))

export default {
  id: "goal",
  async setup(ctx) {
    const directory = ctx.location.directory
    const logFile = process.env.OPENCODE_GOAL_LOG
    const log = (...args) => {
      console.warn("[goal]", ...args)
      if (logFile)
        try {
          appendFileSync(logFile, `${new Date().toISOString()} ${args.map((a) => (typeof a === "string" ? a : String(a?.stack ?? JSON.stringify(a)))).join(" ")}\n`)
        } catch {}
    }

    await ctx.tool.transform((editor) =>
      editor.add({
        name: "goal",
        description:
          "Unattended objective for this session. set: start working toward `objective` without waiting for the user; while it is active " +
          "and the session goes idle, you are sent a short message to continue. wait: something only the user can give is needed " +
          "(credentials, approval, push/merge/deploy, a product decision, every safe path blocked); give `reason`; nothing resumes until the " +
          "user writes. complete: the objective is met (or the user stopped it); give `evidence`. status: show the goal. " +
          "Only set a goal when the user asked you to run without waiting.",
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["set", "wait", "complete", "status"] },
            objective: { type: "string", maxLength: 2000 },
            reason: { type: "string", maxLength: 1000 },
            evidence: { type: "string", maxLength: 2000 },
          },
          required: ["action"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const state = load(context.sessionID)
          const now = Date.now()
          const g = state.goal
          const show = (x) => (x ? `goal: ${x.status}${x.reason ? ` (${x.reason})` : ""}\nobjective: ${x.objective}` : "no goal set")
          if (input.action === "set") {
            if (!input.objective?.trim()) return { content: "set needs `objective`." }
            state.goal = { objective: input.objective.trim(), status: "active", directory, setAt: now, at: now, continues: 0, tools: 0, stalls: 0 }
            // A new goal starts with only the children that are still running.
            for (const [id, st] of Object.entries(state.children)) if (st !== "running") (delete state.children[id], delete state.childSince[id])
          } else if (input.action === "wait") {
            if (!g) return { content: "no goal set." }
            if (!input.reason?.trim()) return { content: "wait needs `reason`." }
            Object.assign(g, { status: "waiting", reason: input.reason.trim(), at: now })
          } else if (input.action === "complete") {
            if (!g) return { content: "no goal set." }
            if (!input.evidence?.trim()) return { content: "complete needs `evidence`." }
            Object.assign(g, { status: "complete", evidence: input.evidence.trim(), reason: "", at: now })
          } else return { content: show(g) }
          save(context.sessionID, state)
          return { content: show(state.goal) }
        },
      }),
    )

    // Progress: a turn that ran tools is not a stall.
    await ctx.tool.hook("execute.after", async (e) => {
      if (e.status !== "completed" || e.tool === "goal") return
      const state = load(e.sessionID)
      if (state.goal?.status !== "active") return
      state.goal.tools = (state.goal.tools ?? 0) + 1
      save(e.sessionID, state)
    })

    // Every request: notice new user messages and background children.
    await ctx.session.hook("context", async (e) => {
      const state = load(e.sessionID)
      let changed = false
      const seen = new Set(state.seen)
      for (const m of e.messages) {
        if (m.role !== "user" || !m.id || seen.has(m.id) || m.metadata?.synthetic) continue
        const text = (m.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n").trim()
        if (!text || NOT_USER.some((p) => text.startsWith(p))) continue
        seen.add(m.id)
        state.seen.push(m.id)
        if (state.goal?.status === "waiting") Object.assign(state.goal, { status: "active", reason: "", stalls: 0, at: Date.now() })
        changed = true
      }
      if (state.seen.length > SEEN_MAX) state.seen = state.seen.slice(-SEEN_MAX)
      // Launch: the subagent tool returns "working in the background (sessionID: ses_…)".
      // Report: a message starting <subagent sessionID="ses_…" state="…">.
      for (const m of e.messages)
        for (const p of m.content ?? []) {
          if (p.type === "tool-result" && p.name === "subagent")
            for (const id of launchedChildren(p.result))
              if (state.children[id] === undefined) (state.children[id] = "running"), (state.childSince[id] = Date.now()), (changed = true)
          if (p.type === "text" && p.text?.startsWith("<subagent "))
            for (const t of p.text.matchAll(/^<subagent sessionID="([^"]+)" state="([^"]+)"/gm))
              if (state.children[t[1]] !== t[2]) (state.children[t[1]] = t[2]), delete state.childSince[t[1]], (changed = true)
        }
      if (changed) save(e.sessionID, state)
      // An unfinished goal goes last on every request, so it survives compaction without being restored.
      const text = goalBlock(state.goal)
      if (text) e.messages.push({ role: "user", metadata: { synthetic: true }, content: [{ type: "text", text }] })
    })

    if (!ctx.event?.subscribe || !ctx.session?.synthetic) {
      log("this opencode has no event stream or synthetic messages; the goal tool works, automatic continues are off")
      return
    }
    const timers = new Map()
    const ended = new Set()
    const abort = new AbortController()
    let disposed = false
    const pause = (sid, reason) => {
      const state = load(sid)
      if (state.goal?.status !== "active" || state.goal.directory !== directory) return
      Object.assign(state.goal, { status: "waiting", reason, at: Date.now() })
      save(sid, state)
      log(`paused in ${sid}: ${reason}`)
    }
    const onIdle = (sid, afterRestart = false) => {
      const state = load(sid)
      const g = state.goal
      if (g?.status !== "active" || g.directory !== directory) return
      // A restart is not a turn, so it does not count as a stall.
      if (!afterRestart) g.stalls = (g.continues ?? 0) > 0 && (g.tools ?? 0) === 0 ? (g.stalls ?? 0) + 1 : 0
      if (g.stalls >= 2) return void (save(sid, state), pause(sid, "two automatic continues in a row ran no tool"))
      if ((g.continues ?? 0) >= MAX_CONTINUES) return void (save(sid, state), pause(sid, `reached ${MAX_CONTINUES} automatic continues`))
      // A child that has not reported within CHILD_WAIT_MS of its launch is written off, so a missed report does
      // not make every later continue wait the full child delay.
      for (const [id, st] of Object.entries(state.children))
        if (st === "running" && Date.now() - (state.childSince[id] ?? 0) >= CHILD_WAIT_MS) {
          state.children[id] = "unreported"
          delete state.childSince[id]
          log(`child ${id} of ${sid} did not report within ${Math.round(CHILD_WAIT_MS / 60000)} min; no longer waiting for it`)
        }
      save(sid, state)
      clearTimeout(timers.get(sid))
      const waiting = Object.values(state.children).some((st) => st === "running")
      const scheduled = g.continues ?? 0
      timers.set(
        sid,
        setTimeout(async () => {
          timers.delete(sid)
          if (disposed) return
          const now = load(sid)
          if (now.goal?.status !== "active") return
          // Another instance of this plugin (opencode set it up again) already continued this turn end.
          if ((now.goal.continues ?? 0) !== scheduled) return
          now.goal.continues = (now.goal.continues ?? 0) + 1
          now.goal.tools = 0
          save(sid, now)
          const text =
            `${CONTINUE}The goal is still active: ${clip(now.goal.objective, 600)}\n` +
            "Continue with the next step. Re-read the plan document if you are unsure where things stand. " +
            "Call goal with action complete (with evidence) only when the objective is met, or wait (with the reason) when only the user can unblock it.</goal-continue>"
          try {
            await ctx.session.synthetic({ sessionID: sid, text, resume: true })
            log(`continue #${now.goal.continues} sent to ${sid}`)
          } catch (err) {
            pause(sid, `could not resume: ${err?.message ?? err}`)
          }
        }, waiting ? CHILD_WAIT_MS : DELAY_MS),
      )
    }
    // Timers live in memory. After a restart, an active goal whose session stays quiet would never be resumed, so
    // each one gets a turn end of its own once the server has had time to report anything else.
    const heard = new Set()
    const restartTimer = setTimeout(() => {
      if (disposed) return
      let names = []
      try {
        names = readdirSync(STATE_DIR).filter((n) => n.endsWith(".json"))
      } catch {}
      for (const n of names) {
        const sid = n.slice(0, -5)
        if (heard.has(sid)) continue
        const g = load(sid).goal
        if (g?.status === "active" && g.directory === directory) {
          log(`resuming active goal in ${sid} after a restart`)
          ended.add(sid)
          onIdle(sid, true)
        }
      }
    }, RESUME_AFTER_MS).unref?.()
    ;(async () => {
      for await (const ev of ctx.event.subscribe({ signal: abort.signal })) {
        if (disposed) break
        const sid = ev?.data?.sessionID
        if (!sid) continue
        heard.add(sid)
        // A turn's end can be reported twice (execution.succeeded and status idle); handle it once until the next start.
        const st = ev.type === "session.status" ? ev.data.status?.type : undefined
        if (st === "idle" || ev.type === "session.execution.succeeded" || ev.type === "session.idle") {
          if (!ended.has(sid)) (ended.add(sid), onIdle(sid))
        } else if (st === "busy" || ev.type === "session.execution.started") {
          ended.delete(sid)
          clearTimeout(timers.get(sid))
        } else if (ev.type === "session.execution.interrupted") {
          ended.add(sid)
          clearTimeout(timers.get(sid))
          // "shutdown" is the server stopping; core keeps the turn and finishes it after the restart, so the goal
          // stays active. "user" and "inactivity" stop the run.
          const reason = ev.data.reason ?? "shutdown"
          if (reason !== "shutdown") pause(sid, reason === "user" ? "interrupted by the user" : `interrupted (${reason})`)
        } else if (ev.type === "session.execution.failed" || ev.type === "session.error") {
          ended.add(sid)
          clearTimeout(timers.get(sid))
          pause(sid, `stopped on an error: ${clip(textOf(ev.data.error?.message ?? ev.data.error ?? ev.data), 200)}`)
        }
      }
    })().catch((err) => log("event loop stopped", err))

    // opencode may set the plugin up again; without this the old subscription keeps running next to the new one
    // and every turn end is continued twice.
    return async () => {
      disposed = true
      abort.abort()
      clearTimeout(restartTimer)
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  },
}
