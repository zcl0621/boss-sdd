// pin: durable facts the agent keeps for a session (worktree, how to reach a server, decisions in force).
//
// The pin_context tool adds, updates and removes pins. Every request then carries a short <pins> block at the end,
// so pins survive compaction without being restored, and the agent always sees what it is carrying, with ages, and
// can drop what no longer holds. The block is added per request and never stored in the history, so the cached
// prefix of the conversation is unaffected.
//
// State: $XDG_STATE_HOME/opencode-pin/<session>.json. Sessions that pinned with an older context-keeper (which owned
// pin_context) are taken over from its state file on first use.
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const STATE_HOME = process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state")
const STATE_DIR = path.join(STATE_HOME, "opencode-pin")
const KEEPER_DIR = path.join(STATE_HOME, "opencode-context-keeper")
const EVOLVED_FILE = process.env.CONTEXT_KEEPER_EVOLVED || path.join(homedir(), ".config", "opencode", "context-keeper", "evolved.json")
export const LIMITS = {
  pins: 30, // new keys are refused beyond this; updates and removals always work
  value: 500, // chars per pin; every request carries all of them
  slot: 300, // evolved guidance appended to the tool description
  keepDays: 30, // state files untouched this long are deleted at startup
}
export const BLOCK = "<pins>"

const file = (sid) => path.join(STATE_DIR, `${sid.replace(/[^\w.-]/g, "_")}.json`)
const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"))
  } catch {
    return undefined
  }
}

// A missing file is a fresh session (or one an older context-keeper pinned for). A corrupt one is kept aside.
const load = (sid) => {
  let raw
  try {
    raw = readFileSync(file(sid), "utf8")
  } catch {
    const legacy = readJson(path.join(KEEPER_DIR, `${sid}.json`))?.pins
    const pins = {}
    for (const [k, v] of Object.entries(legacy ?? {})) pins[k] = typeof v === "string" ? { value: v, at: Date.now() } : v
    return { pins }
  }
  try {
    const parsed = JSON.parse(raw)
    return { pins: parsed?.pins && typeof parsed.pins === "object" ? parsed.pins : {} }
  } catch {
    try {
      renameSync(file(sid), `${file(sid)}.corrupt-${Date.now()}`)
    } catch {}
    return { pins: {} }
  }
}
// Write-then-rename, so a reader (the sidebar) never sees half a file.
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

const age = (ms) => {
  const h = (Date.now() - ms) / 3_600_000
  return h < 1 ? "<1h ago" : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`
}

// The evolvable "pin" slot of context-keeper's evolved.json, checked the same way: a string, short, no "<".
const loadSlot = () => {
  const s = readJson(EVOLVED_FILE)?.slots?.pin
  return typeof s === "string" && s.trim() && s.length <= LIMITS.slot && !s.includes("<") ? s.trim() : ""
}

export const PIN_DESCRIPTION = (slot = "") =>
  "Pin a durable fact you will need after compaction: worktree path/branch, how to reach a server, deploy target/steps, decisions in force, user constraints, open review findings. " +
  "Not progress notes or per-file findings; those go in the plan document. key+value pins or updates; empty value or remove: [keys] unpins. " +
  "When a pin no longer holds (decision reversed, value changed, worktree merged, task done, finding fixed), remove or update it; merge related pins under one key. " +
  "Calls are round trips: make all pin changes in one reply, with remove alongside the new key. Max 30 pins; never pin secrets." +
  (slot ? ` ${slot}` : "")

export const pinBlock = (pins) => {
  const lines = Object.entries(pins ?? {}).map(([k, v]) => `- ${k} (pinned ${age(v.at)}): ${v.value}`)
  if (!lines.length) return ""
  return (
    `${BLOCK}Your pinned facts (${lines.length}/${LIMITS.pins}), carried on every request. ` +
    "Remove or update any that no longer hold or are no longer needed; re-check a days-old pin before acting on it (connect, deploy, merge).\n" +
    `${lines.join("\n")}\n</pins>`
  )
}

export function applyPin(state, { key, value, remove = [] }) {
  if (key === undefined && !remove.length) return "Nothing to do: pass key and value to pin, or remove: [keys] to unpin."
  if (key !== undefined && typeof value !== "string") return `No value for "${key}": pass value to pin it, or an empty value to remove it.`
  const done = []
  for (const k of remove) if (k in state.pins) (delete state.pins[k], done.push(`removed "${k}"`))
  if (key !== undefined) {
    if (!value.trim()) {
      if (key in state.pins) (delete state.pins[key], done.push(`removed "${key}"`))
    } else if (!(key in state.pins) && Object.keys(state.pins).length >= LIMITS.pins) {
      done.push(`refused "${key}": already ${LIMITS.pins} pins. Remove pins that no longer hold, or merge related ones under one key, then pin again`)
    } else {
      done.push(`${key in state.pins ? "updated" : "pinned"} "${key}"`)
      state.pins[key] = { value: value.trim(), at: Date.now() }
    }
  }
  return `${done.join("; ") || "no change"}. ${Object.keys(state.pins).length} pin(s); the <pins> block lists them.`
}

export default {
  id: "pin",
  async setup(ctx) {
    pruneOld()
    const description = PIN_DESCRIPTION(loadSlot())

    await ctx.tool.transform((editor) =>
      editor.add({
        name: "pin_context",
        description,
        input: {
          type: "object",
          properties: {
            key: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,60}$" },
            value: { type: "string", maxLength: LIMITS.value },
            remove: { type: "array", items: { type: "string" }, maxItems: 50 },
          },
          additionalProperties: false,
        },
        async execute(input, context) {
          const state = load(context.sessionID)
          const content = applyPin(state, input ?? {})
          save(context.sessionID, state)
          return { content }
        },
      }),
    )

    // Every request: the current pins go last, as a notice rather than the user writing (no id, synthetic).
    await ctx.session.hook("context", async (e) => {
      const text = pinBlock(load(e.sessionID).pins)
      if (text) e.messages.push({ role: "user", metadata: { synthetic: true }, content: [{ type: "text", text }] })
    })
  },
}
