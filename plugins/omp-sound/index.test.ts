// Driven through a fake `pi` / `ctx`. Event shapes follow omp 18.11.1:
//  - ctx.agent: extensibility/extensions/types.ts ExtensionAgentIdentity ({ kind: "main" | "sub", id, name, depth }).
//  - agent_end: extensibility/shared-events.ts AgentEndEvent ({ messages, willContinue?, awaitingAsyncWork? }).
//  - stopReason: pi-ai/src/types.ts StopReason ("stop" | "length" | "toolUse" | "error" | "aborted").
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = mkdtempSync(path.join(tmpdir(), "omp-sound-test-"))
process.env.PI_CODING_AGENT_DIR = root
delete process.env.OMP_SOUND
delete process.env.OMP_SOUND_CONFIG
delete process.env.OMP_SOUND_LOG

const { default: extension, DEBOUNCE_MS, soundPath, lastStopReason, packNames, PACK_DIR } = await import("./index.ts")

afterAll(() => rmSync(root, { recursive: true, force: true }))

type Handler = (event: any, ctx: any) => any
let clock = 0
function boot() {
  const handlers: Record<string, Handler[]> = {}
  const commands: Record<string, any> = {}
  const played: string[] = []
  const notes: string[] = []
  const pi = {
    on: (name: string, h: Handler) => void (handlers[name] ??= []).push(h),
    registerCommand: (name: string, options: any) => void (commands[name] = options),
  }
  extension(pi as any, { player: (file: string) => void played.push(path.basename(file).replace(/\.(aiff|mp3)$/, "")), now: () => clock })
  const ctxOf = (kind: "main" | "sub", name: string, session: string) => ({
    agent: { kind, id: session, name, depth: kind === "sub" ? 1 : 0 },
    sessionManager: { getSessionId: () => session },
    ui: { notify: (m: string) => void notes.push(m) },
  })
  const fire = async (name: string, event: any, ctx: any) => {
    for (const h of handlers[name] ?? []) await h(event, ctx)
  }
  const end = (stopReason: string, extra: any = {}) => ({
    type: "agent_end",
    messages: [{ role: "user" }, { role: "assistant", stopReason }],
    ...extra,
  })
  return { fire, played, notes, commands, ctxOf, end }
}

beforeEach(() => {
  clock += 10_000 // past any debounce left by the previous test
  rmSync(path.join(root, "omp-sound.json"), { force: true })
})

describe("subagents", () => {
  test("start plays once per session, finish plays done", async () => {
    const t = boot()
    const sub = t.ctxOf("sub", "explore", "s1")
    await t.fire("agent_start", { type: "agent_start" }, sub)
    clock += 1000
    await t.fire("agent_start", { type: "agent_start" }, sub) // continuation inside the same subagent
    await t.fire("agent_end", t.end("stop"), sub)
    expect(t.played).toEqual(["bip-bop-02", "yup-01"])
  })

  test("error and aborted subagents play the failure sound", async () => {
    const t = boot()
    await t.fire("agent_end", t.end("error"), t.ctxOf("sub", "task", "s2"))
    clock += 1000
    await t.fire("agent_end", t.end("aborted"), t.ctxOf("sub", "task", "s3"))
    expect(t.played).toEqual(["nope-03", "nope-03"])
  })

  test("a non-terminal end is silent", async () => {
    const t = boot()
    await t.fire("agent_end", t.end("stop", { willContinue: true, awaitingAsyncWork: true }), t.ctxOf("sub", "task", "s4"))
    expect(t.played).toEqual([])
  })

  test("parallel subagents finishing together play once", async () => {
    const t = boot()
    for (const s of ["a", "b", "c"]) await t.fire("agent_end", t.end("stop"), t.ctxOf("sub", "task", s))
    clock += DEBOUNCE_MS
    await t.fire("agent_end", t.end("stop"), t.ctxOf("sub", "task", "d"))
    expect(t.played).toEqual(["yup-01", "yup-01"])
  })

  test("the advisor is ignored", async () => {
    const t = boot()
    const advisor = t.ctxOf("sub", "advisor", "adv")
    await t.fire("agent_start", { type: "agent_start" }, advisor)
    await t.fire("agent_end", t.end("stop"), advisor)
    expect(t.played).toEqual([])
  })
})

describe("main session", () => {
  test("agent_start is silent, terminal end plays done", async () => {
    const t = boot()
    const main = t.ctxOf("main", "main", "m1")
    await t.fire("agent_start", { type: "agent_start" }, main)
    await t.fire("agent_end", t.end("stop"), main)
    expect(t.played).toEqual(["bip-bop-01"])
  })

  test("waiting on background subagents is silent", async () => {
    const t = boot()
    await t.fire("agent_end", t.end("stop", { willContinue: true, awaitingAsyncWork: true }), t.ctxOf("main", "main", "m2"))
    expect(t.played).toEqual([])
  })

  test("user abort is silent, error plays error", async () => {
    const t = boot()
    const main = t.ctxOf("main", "main", "m3")
    await t.fire("agent_end", t.end("aborted"), main)
    await t.fire("agent_end", t.end("error"), main)
    expect(t.played).toEqual(["nope-03"])
  })

  test("ask plays the question sound, other tools do not", async () => {
    const t = boot()
    const main = t.ctxOf("main", "main", "mq")
    await t.fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {} }, main)
    await t.fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "2", toolName: "ask", args: {} }, main)
    expect(t.played).toEqual(["bip-bop-03"])
  })

  test("approval request plays", async () => {
    const t = boot()
    await t.fire("tool_approval_requested", { type: "tool_approval_requested", toolName: "bash" }, t.ctxOf("main", "main", "m4"))
    expect(t.played).toEqual(["staplebops-06"])
  })
})

describe("/sound", () => {
  test("off persists and silences new instances; on restores", async () => {
    const t = boot()
    const main = t.ctxOf("main", "main", "m5")
    await t.commands.sound.handler("off", main)
    expect(JSON.parse(readFileSync(path.join(root, "omp-sound.json"), "utf8")).enabled).toBe(false)
    await t.fire("agent_end", t.end("stop"), main)
    const fresh = boot()
    await fresh.fire("agent_end", fresh.end("stop"), fresh.ctxOf("main", "main", "m6"))
    expect([...t.played, ...fresh.played]).toEqual([])
    await t.commands.sound.handler("on", main)
    clock += 1000
    await t.fire("agent_end", t.end("stop"), main)
    expect(t.played).toEqual(["bip-bop-01"])
  })

  test("a sound set to false is muted, a custom name is used", async () => {
    const t = boot()
    const { writeFileSync } = await import("node:fs")
    writeFileSync(path.join(root, "omp-sound.json"), JSON.stringify({ sounds: { done: false, subagentDone: "Pop" } }))
    const u = boot()
    await u.fire("agent_end", u.end("stop"), u.ctxOf("main", "main", "m7"))
    await u.fire("agent_end", u.end("stop"), u.ctxOf("sub", "task", "s9"))
    expect(u.played).toEqual(["Pop"])
    expect(t.played).toEqual([])
  })

  test("OMP_SOUND=off silences events but not /sound test", async () => {
    process.env.OMP_SOUND = "off"
    try {
      const t = boot()
      const main = t.ctxOf("main", "main", "m8")
      await t.fire("agent_end", t.end("stop"), main)
      expect(t.played).toEqual([])
    } finally {
      delete process.env.OMP_SOUND
    }
  })

  test("unknown test key warns", async () => {
    const t = boot()
    await t.commands.sound.handler("test nope", t.ctxOf("main", "main", "m9"))
    expect(t.notes[0]).toContain("Unknown sound")
  })
})

test("bundled opencode sounds", () => {
  const names = packNames()
  for (const n of ["bip-bop-01", "bip-bop-02", "bip-bop-03", "staplebops-06", "nope-03", "yup-01"]) {
    expect(names).toContain(n)
    expect(soundPath(n)).toBe(path.join(PACK_DIR, `${n}.mp3`))
  }
})

test("/sound test plays a bundled name; list names them", async () => {
  const t = boot()
  const main = t.ctxOf("main", "main", "mt")
  await t.commands.sound.handler("test staplebops-01", main)
  expect(t.played).toEqual(["staplebops-01"])
  await t.commands.sound.handler("list", main)
  expect(t.notes.at(-1)).toContain("yup-01")
})

test("helpers", () => {
  expect(soundPath("Glass")).toBe("/System/Library/Sounds/Glass.aiff")
  expect(soundPath("/tmp/x.wav")).toBe("/tmp/x.wav")
  expect(lastStopReason([{ role: "assistant", stopReason: "stop" }, { role: "toolResult" }])).toBe("stop")
  expect(lastStopReason(undefined)).toBeUndefined()
})
