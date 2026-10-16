// omp-sound: opencode's attention sounds for omp: subagent start / finish, the main agent finishing, questions and
// tool approval prompts.
//
// omp rebinds extension factories to every subagent session (task tool, eval `agent()`, `/tan` clones;
// extensibility/extensions/types.ts ExtensionAgentIdentity), so one handler set sees both sides and tells them apart
// with `ctx.agent.kind` ("main" | "sub"). This matters because `async.enabled` defaults to true
// (tools/settings.ts cfgAsyncEnabled): the `task` tool returns as soon as background spawns are registered, so its
// tool_execution_end says nothing about when a subagent finishes. The subagent's own agent_start / agent_end does.
//
//   subagentStart  first agent_start of a sub session
//   subagentDone   terminal agent_end of a sub session (willContinue false), last assistant stopReason not error/aborted
//   subagentFail   same, stopReason "error" or "aborted"
//   done           terminal agent_end of the main session; silent when the user aborted (Esc)
//   error          same, stopReason "error"
//   approval       tool_approval_requested, any session
//   question       tool_execution_start of omp's `ask` tool (tools/ask.ts), any session
//
// Sounds and their mapping come from opencode (anomalyco/opencode 180fd9d, MIT, packages/ui/LICENSE):
// packages/ui/src/assets/audio/*.mp3, mapped in packages/tui/src/attention.ts / attention-sounds.bun.ts as
// done=bip-bop-01, question=bip-bop-03, permission=staplebops-06, error=nope-03, subagent_done=yup-01.
// opencode has no subagent-start sound; bip-bop-02 from the same pack is used.
//
// The advisor is a sub identity whose tool calls reach the advising session; it is skipped.
// Playback: macOS `afplay`, detached, errors ignored. Other platforms: no sound.
// Config: <agentDir>/omp-sound.json { enabled, volume, sounds: { <key>: "<name>" | "/path/file" | false } }, where a
// bare name is sounds/<name>.mp3 next to this file, else a macOS system sound (/System/Library/Sounds/<name>.aiff);
// toggled with `/sound on|off`. $OMP_SOUND=off disables it for one process. $OMP_SOUND_LOG=<file> appends one line
// per event (played or not), for checking which events fire.
import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"

export type SoundKey = "subagentStart" | "subagentDone" | "subagentFail" | "done" | "error" | "approval" | "question"
export const KEYS: SoundKey[] = ["subagentStart", "subagentDone", "subagentFail", "done", "error", "approval", "question"]

export interface Config {
  enabled: boolean
  /** afplay volume, 0–1. */
  volume: number
  sounds: Record<SoundKey, string | false>
}

export const DEFAULTS: Config = {
  enabled: true,
  volume: 0.5,
  sounds: {
    subagentStart: "bip-bop-02",
    subagentDone: "yup-01",
    subagentFail: "nope-03",
    done: "bip-bop-01",
    error: "nope-03",
    approval: "staplebops-06",
    question: "bip-bop-03",
  },
}

/** Same key within this window plays once: parallel subagents start and finish together. */
export const DEBOUNCE_MS = 300
const SYSTEM_SOUNDS = "/System/Library/Sounds"
export const PACK_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "sounds")

const envAgentDir = () =>
  process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || homedir(), process.env.PI_CONFIG_DIR || ".omp", "agent")
const configFile = (agentDir: string) => process.env.OMP_SOUND_CONFIG || path.join(agentDir, "omp-sound.json")

export function loadConfig(file: string): Config {
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"))
    return {
      enabled: typeof saved.enabled === "boolean" ? saved.enabled : DEFAULTS.enabled,
      volume: typeof saved.volume === "number" ? Math.max(0, Math.min(1, saved.volume)) : DEFAULTS.volume,
      sounds: { ...DEFAULTS.sounds, ...(saved.sounds ?? {}) },
    }
  } catch {
    return { ...DEFAULTS, sounds: { ...DEFAULTS.sounds } }
  }
}

function saveConfig(file: string, config: Config) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n")
  renameSync(tmp, file)
}

/** Anything with a slash is a file path; a bare name is sounds/<name>.mp3 if present, else a macOS system sound. */
export function soundPath(sound: string): string {
  if (sound.includes("/")) return sound
  const packed = path.join(PACK_DIR, `${sound}.mp3`)
  return existsSync(packed) ? packed : path.join(SYSTEM_SOUNDS, `${sound}.aiff`)
}

/** Names of the bundled sounds, sorted. */
export function packNames(): string[] {
  try {
    return readdirSync(PACK_DIR).filter((f) => f.endsWith(".mp3")).map((f) => f.slice(0, -4)).sort()
  } catch {
    return []
  }
}

type Player = (file: string, volume: number) => void
const afplay: Player = (file, volume) => {
  if (process.platform !== "darwin") return
  try {
    const child = spawn("afplay", ["-v", String(volume), file], { stdio: "ignore", detached: true })
    child.on("error", () => {})
    child.unref()
  } catch {}
}

/** Last assistant stopReason of a run, if any. */
export function lastStopReason(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; stopReason?: string }
    if (m?.role === "assistant") return m.stopReason
  }
  return undefined
}

// Module-level, so sessions in one process (main + in-process subagents) share the debounce.
const lastPlayed = new Map<SoundKey, number>()

export default function ompSound(pi: ExtensionAPI, options: { player?: Player; now?: () => number } = {}): void {
  const player = options.player ?? afplay
  const now = options.now ?? Date.now
  const agentDir = () => {
    try {
      return (pi as any).pi?.getAgentDir?.() || envAgentDir()
    } catch {
      return envAgentDir()
    }
  }
  const file = () => configFile(agentDir())
  let config = loadConfig(file())
  const started = new Set<string>()

  const log = (line: string) => {
    const target = process.env.OMP_SOUND_LOG
    if (!target) return
    try {
      appendFileSync(target, `${new Date().toISOString()} ${line}\n`)
    } catch {}
  }

  const play = (key: SoundKey, why: string, force = false) => {
    const sound = config.sounds[key]
    const off = !force && (!config.enabled || process.env.OMP_SOUND === "off")
    const t = now()
    const bounced = !force && t - (lastPlayed.get(key) ?? -Infinity) < DEBOUNCE_MS
    const skip = off ? " (off)" : !sound ? " (muted)" : bounced ? " (debounced)" : ""
    log(`${key} ${why}${skip || ` -> ${soundPath(sound as string)}`}`)
    if (off || !sound || bounced) return
    lastPlayed.set(key, t)
    player(soundPath(sound), config.volume)
  }

  const identity = (ctx: any) => {
    const agent = ctx?.agent ?? { kind: "main", id: "main", name: "main" }
    let session = ""
    try {
      session = ctx?.sessionManager?.getSessionId?.() ?? ""
    } catch {}
    return { kind: agent.kind as "main" | "sub", name: String(agent.name ?? ""), key: session || String(agent.id) }
  }

  pi.on("agent_start", (_event, ctx) => {
    const who = identity(ctx)
    if (who.kind !== "sub" || who.name === "advisor" || started.has(who.key)) return
    started.add(who.key)
    play("subagentStart", `${who.name} ${who.key}`)
  })

  pi.on("agent_end", (event: any, ctx) => {
    if (event?.willContinue) return
    const who = identity(ctx)
    if (who.name === "advisor") return
    const stop = lastStopReason(event?.messages)
    if (who.kind === "sub") {
      started.delete(who.key)
      const failed = stop === "error" || stop === "aborted"
      play(failed ? "subagentFail" : "subagentDone", `${who.name} ${who.key} stop=${stop}`)
      return
    }
    if (stop === "aborted") return log(`done skipped stop=aborted`)
    play(stop === "error" ? "error" : "done", `main stop=${stop}`)
  })

  pi.on("tool_approval_requested", (event: any) => {
    play("approval", String(event?.toolName ?? ""))
  })

  pi.on("tool_execution_start", (event: any) => {
    if (event?.toolName === "ask") play("question", "ask")
  })

  pi.registerCommand("sound", {
    description: "opencode sounds for subagents, finished runs, questions and approvals: on | off | test [key|name] | list | status",
    getArgumentCompletions: (prefix) =>
      ["on", "off", "status", "list", "test", ...KEYS.map((k) => `test ${k}`), ...packNames().map((n) => `test ${n}`)]
        .filter((value) => value.startsWith(prefix.trimStart()))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const [command = "status", argument] = args.trim().split(/\s+/)
      config = loadConfig(file())
      if (command === "on" || command === "off") {
        config.enabled = command === "on"
        saveConfig(file(), config)
        ctx.ui.notify(`Sounds ${command}.`)
      } else if (command === "test") {
        if (argument && !KEYS.includes(argument as SoundKey)) {
          if (!packNames().includes(argument) && !argument.includes("/"))
            return ctx.ui.notify(`Unknown sound: ${argument}. A key (${KEYS.join(", ")}) or a name from /sound list.`, "warning")
          log(`test ${argument}`)
          player(soundPath(argument), config.volume)
          return ctx.ui.notify(`Playing ${argument}.`)
        }
        const keys = argument ? [argument as SoundKey] : KEYS
        for (const [i, key] of keys.entries()) setTimeout(() => play(key, "test", true), i * 900)
        ctx.ui.notify(`Playing ${keys.join(", ")}.`)
      } else if (command === "list") {
        ctx.ui.notify(`Bundled sounds (opencode): ${packNames().join(", ")}. Set one per key in ${file()}.`)
      } else {
        const env = process.env.OMP_SOUND === "off" ? " ($OMP_SOUND=off in this process)" : ""
        const list = KEYS.map((k) => `${k}=${config.sounds[k] || "muted"}`).join(", ")
        ctx.ui.notify(`Sounds ${config.enabled ? "on" : "off"}${env}, volume ${config.volume}. ${list}. Config: ${file()}`)
      }
    },
  })
}
