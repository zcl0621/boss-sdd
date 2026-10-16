// Ported from plugins/plan-memory/test/plan-memory.test.mjs, driven through a fake `pi` / `ctx`.
//
// Tool events the extension sees (omp 18.11.1 source, commit 9d81cd1):
//  - plain:       toolName "plan_memory_list" (a tool registered under that name).
//  - MCP minted:  packages/coding-agent/src/mcp/tool-bridge.ts:416-429 mintMCPToolName ->
//                 `mcp__<server>_<tool>`, server sanitized to [a-z0-9_], redundant `<server>_` prefix stripped:
//                 server "plan-sdd", tool "plan_memory_list" -> "mcp__plan_sdd_plan_memory_list".
//                 The server key is the user's choice, so any server name is accepted.
//                 Events carry the registered name (packages/coding-agent/src/extensibility/extensions/wrapper.ts:460-466,
//                 `toolName: this.tool.name`).
//  - discovery:   a `write xd://<minted name>` (tools/xdev.ts header) makes TWO tool_result events: the outer
//                 `write` and the inner event with the registered name. The inner one exists because
//                 dispatchXdevTool (xdev.ts:477) runs the tool from the shared registry whose entries are all wrapped
//                 by ExtensionToolWrapper (sdk.ts:3523-3524), and the wrapper emits for nested xd:// dispatches
//                 (wrapper.ts:238-243). Only the inner event counts; the outer write must not, or one call is
//                 counted twice (tidy would fire after 3 tasks instead of 5).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, utimesSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const stateRoot = mkdtempSync(path.join(tmpdir(), "omp-plan-memory-test-"))
// omp's agent directory (PI_CODING_AGENT_DIR, else ~/.omp/agent); never the real one in tests.
process.env.PI_CODING_AGENT_DIR = stateRoot
delete process.env.OMP_PLAN_MEMORY_STATE_DIR

const mod = await import("./index.ts")
const { default: extension, boardCalls, LIMITS, BLOCK } = mod

type Handler = (event: any, ctx: any) => any
function boot(sessionId: string) {
  const handlers: Record<string, Handler[]> = {}
  const logs: { message: string; data?: any }[] = []
  const logger = { warn: (message: string, data?: any) => void logs.push({ message, data }) }
  const pi = { on: (name: string, h: Handler) => void (handlers[name] ??= []).push(h), logger }
  extension(pi as any)
  const ctx = { sessionManager: { getSessionId: () => sessionId } }
  const fire = async (name: string, event: any) => {
    let result: any
    for (const h of handlers[name] ?? []) result = (await h(event, ctx)) ?? result
    return result
  }
  let n = 0
  const ran = (toolName: string, input: any, isError = false) =>
    fire("tool_result", { type: "tool_result", toolCallId: `c${++n}`, toolName, input, content: [], isError })
  const mcp = (name: string, input: any = {}) => ran(`mcp__plan_sdd_${name}`, input)
  const note = async () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "go" }] }]
    const result = await fire("context", { type: "context", messages })
    const out = result?.messages ?? messages
    if (out.length === 1) return ""
    expect(out.length).toBe(2)
    const blk = out[1] // inserted immediately after the first (non-synthetic) user message
    expect(blk.role).toBe("user")
    expect(blk.synthetic).toBe(true)
    const text = typeof blk.content === "string" ? blk.content : blk.content[0].text
    return text as string
  }
  return { fire, ran, mcp, note, handlers, logs, ctx }
}
let seq = 0
const fresh = () => boot(`ses_mem_${Date.now()}_${++seq}`)

afterAll(() => rmSync(stateRoot, { recursive: true, force: true }))

describe("registration", () => {
  test("listens to tool_result and context, nothing else required", () => {
    const { handlers } = fresh()
    expect(handlers.tool_result?.length).toBe(1)
    expect(handlers.context?.length).toBe(1)
    expect(handlers.turn_start?.length).toBe(1)
  })
  test("limits and block match the OpenCode plugin", () => {
    expect(LIMITS.tidyEvery).toBe(5)
    expect(LIMITS.writeShows).toBe(3)
    expect(BLOCK).toBe("<memory>")
  })
})

describe("board tool name forms", () => {
  const names = (tool: string, input: any) => boardCalls(tool, input).map((c: any) => c[0])
  test("plain plan_* name", () => {
    expect(names("plan_memory_list", { project: "/p" })).toEqual(["plan_memory_list"])
  })
  test("omp minted MCP name mcp__plan_sdd_<tool>", () => {
    expect(names("mcp__plan_sdd_plan_memory_list", {})).toEqual(["plan_memory_list"])
    expect(names("mcp__plan_sdd_plan_set_task", {})).toEqual(["plan_set_task"])
  })
  test("a differently named MCP server key is recognised", () => {
    expect(names("mcp__board_plan_memory_list", {})).toEqual(["plan_memory_list"])
    expect(names("mcp__my_board2_plan_set_tasks", {})).toEqual(["plan_set_tasks"])
  })
  test("server key that makes omp strip the tool prefix: mcp__plan_memory_list", () => {
    // server "plan" + tool "plan_memory_list": the redundant `plan_` prefix is stripped (tool-bridge.ts:421-426)
    expect(names("mcp__plan_memory_list", {})).toEqual(["plan_memory_list"])
    expect(names("mcp__plan_set_tasks", {})).toEqual(["plan_set_tasks"])
  })
  test("server key containing plan_: the longest known tool suffix wins", () => {
    expect(names("mcp__my_plan_board_plan_memory_list", {})).toEqual(["plan_memory_list"])
    expect(names("mcp__my_plan_board_plan_board_status", {})).toEqual(["plan_board_status"])
    expect(names("mcp__x_plan_set_tasks", {})).toEqual(["plan_set_tasks"])
    expect(names("mcp__x_plan_set_task", {})).toEqual(["plan_set_task"])
  })
  test("all 13 board tools are recognised, plain and minted", () => {
    const all = [
      "plan_board_status", "plan_create_run", "plan_delete_run", "plan_delete_task", "plan_get_run", "plan_graph",
      "plan_memory_add", "plan_memory_delete", "plan_memory_get", "plan_memory_list", "plan_set_task",
      "plan_set_tasks", "plan_update_run",
    ]
    for (const t of all) {
      expect(names(t, {})).toEqual([t])
      expect(names(`mcp__plan_sdd_${t}`, {})).toEqual([t])
    }
  })
  test("plan_-looking names that are not board tools are ignored", () => {
    expect(names("mcp__github_plan_search", {})).toEqual([])
    expect(names("plan_search", {})).toEqual([])
    expect(names("mcp__plan_search", {})).toEqual([])
    expect(names("plan_memory_list_all", {})).toEqual([])
  })
  test("MCP tools that are not board tools are ignored", () => {
    expect(names("mcp__github_search_code", {})).toEqual([])
    expect(names("mcp__plan_sdd_status", {})).toEqual([])
  })
  test("the input is carried as text for status matching", () => {
    const calls = boardCalls("mcp__plan_sdd_plan_set_task", { task: { id: "T1", status: "done" } })
    expect(calls[0][1]).toContain('"status":"done"')
  })
  test("the outer `write xd://...` event is not a board call (the inner event is)", () => {
    expect(
      boardCalls("write", { path: "xd://mcp__plan_sdd_plan_set_task", content: '{"task":{"status":"done"}}' }),
    ).toEqual([])
    expect(boardCalls("write", { path: "xd://mcp__plan_sdd_plan_memory_list", content: "help" })).toEqual([])
  })
  test("not board calls: read of device docs, other writes, other tools", () => {
    expect(boardCalls("read", { path: "xd://mcp__plan_sdd_plan_memory_list" })).toEqual([])
    expect(boardCalls("read", { path: "plan_memory_list" })).toEqual([])
    expect(boardCalls("write", { path: "/tmp/plan_memory_list", content: "x" })).toEqual([])
    expect(boardCalls("bash", { command: "echo plan_memory_list" })).toEqual([])
    expect(boardCalls("eval", { code: "tools.plan_memory_list({})" })).toEqual([])
  })
})

describe("reminders (ported scenarios)", () => {
  test("whole flow through the omp-minted MCP names", async () => {
    const { ran, mcp, note, fire } = fresh()
    const turn = () => fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 })
    // no run on the board yet: nothing
    expect(await note()).toBe("")

    // read: a run exists and memory was not listed
    await mcp("plan_create_run", { project: "/p", title: "t" })
    expect(await note()).toMatch(/^<memory>Project memory has not been read for this run: call plan_memory_list/)
    await mcp("plan_memory_list", { project: "/p" })
    expect(await note()).toBe("")

    // write: recon + graph + nothing filed -> shown writeShows times, then dropped
    await ran("task", { agent: "recon-code", task: "recon", solutionSpace: "x" })
    await mcp("plan_set_tasks", { run: "r", tasks: [{ id: "T1", status: "pending" }, { id: "T2", status: "pending" }] })
    // counted per agent turn (turn_start), not per context call: repeated requests inside one turn do not use it up
    expect(await note()).toMatch(/nothing was filed in project memory/)
    expect(await note()).toMatch(/nothing was filed in project memory/)
    // exactly LIMITS.writeShows turns carry it, counting the turn in which it became due
    for (let i = 0; i < LIMITS.writeShows - 1; i++) {
      await turn()
      expect(await note()).toMatch(/nothing was filed in project memory/)
    }
    await turn()
    expect(await note()).toBe("")

    // filing something also clears it (fresh run)
    await mcp("plan_create_run", { project: "/p" })
    await mcp("plan_memory_list", { project: "/p" })
    await ran("task", { agent: "recon-rules", task: "..." })
    await mcp("plan_set_tasks", { run: "r", tasks: [{ id: "T1", status: "pending" }] })
    expect(await note()).toMatch(/nothing was filed/)
    await mcp("plan_memory_add", { project: "/p", key: "gate.test", value: "npm test", kind: "gate", source: "package.json" })
    expect(await note()).toBe("")

    // tidy: five tasks done/blocked after the last listing
    for (const [i, s] of ["done", "done", "blocked", "done"].entries()) await mcp("plan_set_task", { run: "r", id: `T${i + 1}`, status: s })
    expect(await note()).toBe("")
    await mcp("plan_set_task", { run: "r", id: "T5", status: "done" })
    expect(await note()).toMatch(/tidy-up is due \(5 tasks reached done\/blocked since memory was last listed\)/)
    await mcp("plan_memory_list", { project: "/p" })
    expect(await note()).toBe("")

    // tidy at close-out
    await mcp("plan_update_run", { run: "r", status: "review" })
    expect(await note()).toMatch(/tidy-up is due \(the run is closing out\)/)
    await mcp("plan_memory_list", { project: "/p" })
    expect(await note()).toBe("")

    // listing before creating the run counts as read for that run
    await mcp("plan_update_run", { run: "r", status: "done" })
    expect(await note()).toBe("")
    await mcp("plan_memory_list", { project: "/p" })
    await mcp("plan_create_run", { project: "/p", title: "second" })
    expect(await note()).toBe("")
    // after a run is done, the next run must read memory again
    await mcp("plan_update_run", { run: "r2", status: "done" })
    await mcp("plan_create_run", { project: "/p", title: "third" })
    expect(await note()).toMatch(/has not been read for this run/)
  })

  test("a failed call changes nothing", async () => {
    const { ran, note } = fresh()
    await ran("mcp__plan_sdd_plan_create_run", { project: "/q" }, true)
    expect(await note()).toBe("")
  })

  test("batch task dispatch with a recon agent counts as recon", async () => {
    const { ran, mcp, note } = fresh()
    await mcp("plan_create_run", {})
    await mcp("plan_memory_list", {})
    await ran("task", { context: "c", tasks: [{ agent: "recon-product", task: "t", solutionSpace: "s" }] })
    await mcp("plan_set_tasks", { tasks: [{ id: "T1", status: "pending" }] })
    expect(await note()).toMatch(/nothing was filed/)
  })

  test("a non-recon task dispatch does not count as recon", async () => {
    const { ran, mcp, note } = fresh()
    await mcp("plan_create_run", {})
    await mcp("plan_memory_list", {})
    await ran("task", { agent: "implementer", task: "t", solutionSpace: "s" })
    await mcp("plan_set_tasks", { tasks: [{ id: "T1", status: "pending" }] })
    expect(await note()).toBe("")
  })

  test("the block is per request: input messages are not mutated and nothing is stored in history", async () => {
    const { mcp, fire } = fresh()
    await mcp("plan_create_run", {})
    const messages = [{ role: "user", content: [{ type: "text", text: "go" }] }]
    const r1 = await fire("context", { type: "context", messages })
    expect(r1.messages.length).toBe(2)
    expect(r1.messages[1].synthetic).toBe(true)
    expect(r1.messages[0]).toBe(messages[0])
    // the handler gets a copy of history per request; a second request still has a single message
    expect(messages.length).toBe(1)
    const r2 = await fire("context", { type: "context", messages })
    expect(r2.messages.length).toBe(2)
  })
})

describe("every form drives the same state machine", () => {
  const forms: Record<string, (b: ReturnType<typeof fresh>, name: string, input: any) => Promise<any>> = {
    plain: (b, name, input) => b.ran(name, input),
    "omp-minted": (b, name, input) => b.ran(`mcp__plan_sdd_${name}`, input),
    // one xd dispatch = outer write event, then the inner minted event
    "xd dispatch (outer write + inner event)": async (b, name, input) => {
      await b.ran("write", { path: `xd://mcp__plan_sdd_${name}`, content: JSON.stringify(input) })
      return b.ran(`mcp__plan_sdd_${name}`, input)
    },
  }
  for (const [label, call] of Object.entries(forms)) {
    test(`read + tidy reminder via ${label}; each call counts once`, async () => {
      const b = fresh()
      await call(b, "plan_create_run", { project: "/p" })
      expect(await b.note()).toMatch(/has not been read/)
      await call(b, "plan_memory_list", { project: "/p" })
      expect(await b.note()).toBe("")
      for (let i = 0; i < LIMITS.tidyEvery - 1; i++) await call(b, "plan_set_task", { run: "r", id: `T${i}`, status: "done" })
      expect(await b.note()).toBe("") // doubled counting would already fire here (after 3)
      await call(b, "plan_set_task", { run: "r", id: "T4", status: "done" })
      expect(await b.note()).toMatch(/5 tasks reached done\/blocked/)
    })
  }
  test("an outer xd write alone (inner never ran) changes nothing", async () => {
    const b = fresh()
    await b.ran("write", { path: "xd://mcp__plan_sdd_plan_create_run", content: "{}" })
    expect(await b.note()).toBe("")
  })
  test("a failed inner call changes nothing", async () => {
    const b = fresh()
    await b.ran("write", { path: "xd://mcp__plan_sdd_plan_create_run", content: "{}" })
    await b.ran("mcp__plan_sdd_plan_create_run", {}, true)
    expect(await b.note()).toBe("")
  })
})

describe("state location", () => {
  test("per-session files under omp's agent directory: $PI_CODING_AGENT_DIR/omp-plan-memory/", async () => {
    const b = fresh()
    await b.mcp("plan_create_run", {})
    const dir = path.join(stateRoot, "omp-plan-memory")
    expect(existsSync(dir)).toBe(true)
    expect(readdirSync(dir).some((f) => /^omp-plan-memory-.*\.json$/.test(f))).toBe(true)
  })
  test("OMP_PLAN_MEMORY_STATE_DIR overrides the directory", async () => {
    const override = mkdtempSync(path.join(tmpdir(), "omp-plan-memory-override-"))
    process.env.OMP_PLAN_MEMORY_STATE_DIR = override
    try {
      const b = fresh()
      await b.mcp("plan_create_run", {})
      expect(readdirSync(override).some((f) => f.endsWith(".json"))).toBe(true)
    } finally {
      delete process.env.OMP_PLAN_MEMORY_STATE_DIR
      rmSync(override, { recursive: true, force: true })
    }
  })
  test("state survives a restart of the extension in the same session", async () => {
    const id = `ses_restart_${Date.now()}`
    const a = boot(id)
    await a.mcp("plan_create_run", {})
    const b = boot(id)
    expect(await b.note()).toMatch(/has not been read/)
  })
})

describe("pruning old state files", () => {
  test("removes only this plugin's own old files; foreign and fresh files survive", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "omp-plan-memory-prune-"))
    const old = new Date(Date.now() - 31 * 86_400_000)
    const put = (name: string, aged: boolean) => {
      writeFileSync(path.join(dir, name), "x")
      if (aged) utimesSync(path.join(dir, name), old, old)
    }
    put("notes.txt", true)
    put("settings.json", true) // a foreign *.json in a shared directory
    put("omp-plan-memory-x.json", true)
    put("omp-plan-memory-z.json.1234.tmp", true)
    put("omp-plan-memory-y.json", false)
    process.env.OMP_PLAN_MEMORY_STATE_DIR = dir
    try {
      boot("ses_prune")
      expect(readdirSync(dir).sort()).toEqual(["notes.txt", "omp-plan-memory-y.json", "settings.json"])
    } finally {
      delete process.env.OMP_PLAN_MEMORY_STATE_DIR
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// omp compact() builds the summarizer request with buildLiveProviderContext (session/agent-session.ts:2380-2403):
// it converts history (-> prefixLength) and history+retained through the `context` handler, then cuts the second
// result at prefixLength. The block's presence must be the same in both conversions and its position fixed.
describe("placement: index 1 after a summary, else after the first real user message", () => {
  const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
  const asst = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] })
  const synthetic = { role: "user", content: [{ type: "text", text: "date/cwd" }], synthetic: true }
  const summary = { role: "compactionSummary", summary: "earlier work", tokensBefore: 10 }
  const textOf = (m: any) => (typeof m.content === "string" ? m.content : m.content?.[0]?.text)
  const isBlock = (m: any) => m?.synthetic === true && String(textOf(m)).startsWith(BLOCK)

  const setup = async () => {
    const b = fresh()
    await b.mcp("plan_create_run", {}) // read reminder due: text depends only on state
    const handler = async (messages: any[]) => (await b.fire("context", { type: "context", messages }))?.messages ?? messages
    return { handler, ...b }
  }

  const shape = (out: any[]) => out.map((m: any) => (isBlock(m) ? "BLOCK" : m.role === "user" ? textOf(m) : m.role))

  test("summary-led history: block at index 1, even when a user message follows later", async () => {
    const { handler } = await setup()
    const out = await handler([summary, asst("x"), user("a"), asst("y"), user("b")])
    expect(shape(out)).toEqual(["compactionSummary", "BLOCK", "assistant", "a", "assistant", "b"])
    expect(out[1].timestamp).toBe(0)
  })

  test("otherwise right after the first non-synthetic user message", async () => {
    const { handler } = await setup()
    const out = await handler([asst("x"), user("a"), asst("y"), user("b")])
    expect(shape(out)).toEqual(["assistant", "a", "BLOCK", "assistant", "b"])
  })

  test("summary-led history with only assistant/tool turns retained still gets the block", async () => {
    const { handler } = await setup()
    const tool = { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "ok" }] }
    const out = await handler([summary, asst("x"), tool, asst("y")])
    expect(shape(out)).toEqual(["compactionSummary", "BLOCK", "assistant", "toolResult", "assistant"])
  })

  test("synthetic user messages are skipped when finding the anchor", async () => {
    const { handler } = await setup()
    const out = await handler([synthetic, user("a"), user("b")])
    expect(out[0]).toBe(synthetic)
    expect(textOf(out[1])).toBe("a")
    expect(isBlock(out[2])).toBe(true)
  })

  test("no user message: nothing is inserted", async () => {
    const { handler, fire } = await setup()
    const messages = [asst("x"), synthetic]
    const r = await fire("context", { type: "context", messages })
    expect(r?.messages ?? messages).toEqual(messages)
    expect((await handler(messages)).some(isBlock)).toBe(false)
  })

  test("simulated buildLiveProviderContext cut: prefix of handler(history+retained) equals handler(history)", async () => {
    const cases: [string, any[]][] = [
      ["user in history", [user("h1"), asst("h2")]],
      ["summary then user", [summary, user("h1"), asst("h2")]],
      ["no user in history", [asst("h1"), asst("h2")]],
      ["summary then assistant turns", [summary, asst("h1"), asst("h2")]],
      ["summary only", [summary]],
    ]
    for (const [name, history] of cases) {
      const { handler } = await setup()
      const retained = [user("r1"), asst("r2")]
      const prefix = await handler(history)
      const full = await handler([...history, ...retained])
      expect(full.slice(0, prefix.length), name).toEqual(prefix)
      expect(full.slice(prefix.length).filter((m: any) => !isBlock(m)).map(textOf), name).toEqual(["r1", "r2"])
      expect(full.filter(isBlock).length, name).toBe(1)
    }
  })

  test("reminder text is identical across requests while state is unchanged; input never mutated", async () => {
    const { handler } = await setup()
    const messages = [summary, user("a")]
    const snapshot = JSON.stringify(messages)
    const first = (await handler(messages)).find(isBlock)
    const second = (await handler([...messages, user("more")])).find(isBlock)
    expect(first).toEqual(second)
    expect(JSON.stringify(messages)).toBe(snapshot)
    expect(messages.length).toBe(2)
  })
})

describe("write reminder is a pure function of state inside `context`", () => {
  test("consecutive context calls with no turn_start in between agree, at every count including the limit", async () => {
    const { ran, mcp, fire } = fresh()
    await mcp("plan_create_run", {})
    await mcp("plan_memory_list", {})
    await ran("task", { agent: "recon-code", task: "r" })
    await mcp("plan_set_tasks", { tasks: [{ id: "T1", status: "pending" }] })
    const messages = [{ role: "user", content: [{ type: "text", text: "go" }] }]
    const ask = async () => (await fire("context", { type: "context", messages }))?.messages ?? messages
    await ask() // an earlier conversion (e.g. /btw or a dump) must not shift where the limit falls
    for (let turn = 0; turn <= LIMITS.writeShows + 1; turn++) {
      const a = await ask()
      const b = await ask() // history conversion, then history+retained conversion
      const c = await ask()
      expect(b).toEqual(a)
      expect(c).toEqual(a)
      await fire("turn_start", { type: "turn_start", turnIndex: turn, timestamp: 0 })
    }
  })

  test("turn_start does not count while the write reminder is not due", async () => {
    const { ran, mcp, fire } = fresh()
    await mcp("plan_create_run", {})
    await mcp("plan_memory_list", {})
    for (let i = 0; i < 10; i++) await fire("turn_start", { type: "turn_start", turnIndex: i, timestamp: 0 })
    await ran("task", { agent: "recon-code", task: "r" })
    await mcp("plan_set_tasks", { tasks: [{ id: "T1", status: "pending" }] })
    const messages = [{ role: "user", content: [{ type: "text", text: "go" }] }]
    const out = (await fire("context", { type: "context", messages }))?.messages ?? messages
    expect(out.length).toBe(2)
  })
})

describe("unwritable state directory", () => {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0
  const t = isRoot ? test.skip : test
  type H = ReturnType<typeof boot>
  // Runs `body` with $OMP_PLAN_MEMORY_STATE_DIR pointing at a temp dir. `prepare` runs while it is still writable;
  // then it is chmod 500 (or, with `missing`, the state dir is a not-yet-created child of a chmod-500 parent,
  // so mkdirSync fails instead of writeFileSync).
  const withReadOnly = async (opts: { missing?: boolean; prepare?: (h: H) => Promise<void> }, body: (h: H) => Promise<void>) => {
    const root = mkdtempSync(path.join(tmpdir(), "omp-plan-memory-ro-"))
    const dir = opts.missing ? path.join(root, "state", "nested") : root
    const prev = process.env.OMP_PLAN_MEMORY_STATE_DIR
    process.env.OMP_PLAN_MEMORY_STATE_DIR = dir
    try {
      const h = fresh()
      await opts.prepare?.(h)
      chmodSync(root, 0o500)
      await body(h)
    } finally {
      chmodSync(root, 0o700)
      if (prev === undefined) delete process.env.OMP_PLAN_MEMORY_STATE_DIR
      else process.env.OMP_PLAN_MEMORY_STATE_DIR = prev
      rmSync(root, { recursive: true, force: true })
    }
  }
  // For the state assertions: a throwing handler must not hide the lost-state failure behind its own exception.
  const quiet = async (f: () => Promise<unknown>) => {
    try {
      await f()
    } catch {}
  }
  const prepareWriteDue = async ({ mcp, ran }: H) => {
    await mcp("plan_create_run", {})
    await mcp("plan_memory_list", {})
    await ran("task", { agent: "recon-code", task: "r" })
    await mcp("plan_set_tasks", { tasks: [{ id: "T1", status: "pending" }] })
  }

  t("tool_result does not throw when the state cannot be saved", async () => {
    await withReadOnly({}, async ({ mcp }) => {
      await mcp("plan_create_run", {}) // changes state -> save() -> EACCES
    })
  })

  t("turn_start does not throw when the state cannot be saved", async () => {
    await withReadOnly({ prepare: prepareWriteDue }, async ({ fire }) => {
      await fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }) // due -> save() -> EACCES
    })
  })

  t("state kept in memory: read reminder appears and clears with the dir read-only from the first event", async () => {
    await withReadOnly({}, async ({ mcp, note }) => {
      await quiet(() => mcp("plan_create_run", {}))
      expect(await note()).toContain("plan_memory_list")
      await quiet(() => mcp("plan_memory_list", {}))
      expect(await note()).toBe("")
    })
  })

  t("state kept in memory: write reminder stops after writeShows turns although saves fail", async () => {
    await withReadOnly({ prepare: prepareWriteDue }, async ({ fire, note }) => {
      expect(await note()).toContain("plan_memory_add") // sanity: due before the dir went read-only
      for (let i = 0; i < LIMITS.writeShows; i++)
        await quiet(() => fire("turn_start", { type: "turn_start", turnIndex: i, timestamp: 0 }))
      expect(await note()).not.toContain("plan_memory_add")
    })
  })

  t("state kept in memory when the state dir cannot even be created (mkdir fails)", async () => {
    await withReadOnly({ missing: true }, async ({ mcp, note }) => {
      await mcp("plan_create_run", {}) // must not throw
      expect(await note()).toContain("plan_memory_list")
    })
  })

  t("context returns undefined, without throwing, when its body fails", async () => {
    const { mcp, handlers, ctx } = fresh()
    await mcp("plan_create_run", {}) // a run is open, so the reminder is due and insertReminder runs
    const result = await handlers.context![0]({ type: "context", messages: undefined }, ctx)
    expect(result).toBeUndefined()
  })

  t("a save error is logged exactly once per session", async () => {
    await withReadOnly({}, async ({ mcp, logs }) => {
      await mcp("plan_create_run", {})
      await mcp("plan_memory_list", {})
      await mcp("plan_memory_add", {})
      expect(logs.length).toBe(1)
      expect(logs[0].message).toContain("omp-plan-memory")
      expect(String(logs[0].data?.error)).toContain("EACCES")
    })
  })
})

describe("handler error logging", () => {
  test("a handler error is logged exactly once per session, and never throws", async () => {
    const { handlers, logs } = fresh()
    const event = { type: "tool_result", toolCallId: "c", toolName: "plan_create_run", input: {}, content: [], isError: false }
    const bad = { sessionManager: { getSessionId: () => { throw new Error("boom") } } }
    expect(await handlers.tool_result![0](event, bad)).toBeUndefined()
    expect(await handlers.tool_result![0](event, bad)).toBeUndefined()
    expect(logs.length).toBe(1)
    expect(String(logs[0].data?.error)).toContain("boom")
  })

  test("a logger that throws, or is missing, cannot make a handler throw", async () => {
    const handlers: Record<string, Handler[]> = {}
    const pi = { on: (n: string, h: Handler) => void (handlers[n] ??= []).push(h), logger: { warn: () => { throw new Error("log") } } }
    extension(pi as any)
    const bad = { sessionManager: { getSessionId: () => { throw new Error("boom") } } }
    expect(await handlers.tool_result![0]({ toolName: "x", input: {} }, bad)).toBeUndefined()
    const handlers2: Record<string, Handler[]> = {}
    extension({ on: (n: string, h: Handler) => void (handlers2[n] ??= []).push(h) } as any)
    expect(await handlers2.turn_start![0]({}, bad)).toBeUndefined()
  })
})

// T15 (fix: T9 F1). The request omp builds after a rollover (session/session-context.ts:540-569 summary first, then the
// re-appended user request; :646-670 the context-notes custom message spliced in at index 0) starts, in the T9
// capture (docs/e2e/2026-10-16-omp-e2e.md item 3a): [0] custom notes, [1] compactionSummary, [2] custom skill-prompt,
// [3] custom todo reminder, then assistant/toolResult, with no `user` role. A plan-sdd run started with
// `/skill:plan-sdd <task>` has the skill-prompt custom message (attribution "user", modes/skill-command.ts:63-87) as
// its only user turn, before and after a compaction.
describe("T15 (F1): anchor in the request shapes of a /skill-started run and after a rollover", () => {
  const notes = () => ({ role: "custom", customType: "experimental_context_notes", content: "<experimental-context-notes>\nPIN\n</experimental-context-notes>", display: false })
  const summary = () => ({ role: "compactionSummary", summary: "rolled over", tokensBefore: 69719 })
  const skill = (attribution: string | undefined = "user") => ({
    role: "custom",
    customType: "skill-prompt",
    content: '[IMPORTANT: User invoked the "plan-sdd" skill; follow its instructions. Full skill below.]',
    display: true,
    details: { name: "plan-sdd", path: "/skills/plan-sdd/SKILL.md", args: "Goal mode: add farewell(name)", lineCount: 120 },
    ...(attribution === undefined ? {} : { attribution }),
  })
  const todo = () => ({ role: "custom", customType: "mid-run-todo-nudge", content: "<system-reminder> 4 todo items still open </system-reminder>", display: false, attribution: "agent" })
  const call = () => ({ role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }] })
  const result = () => ({ role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "r" }] })
  const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
  const asst = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] })
  const textOf = (m: any) => (typeof m.content === "string" ? m.content : m.content?.[0]?.text)
  const isBlock = (m: any) => m?.synthetic === true && String(textOf(m)).startsWith(BLOCK)
  const setup = async () => {
    const b = fresh()
    await b.mcp("plan_create_run", {}) // read reminder due
    const handler = async (messages: any[]) => (await b.fire("context", { type: "context", messages }))?.messages ?? messages
    return { handler, ...b }
  }

  test("T9 shape [custom notes, compactionSummary, custom skill-prompt, custom todo, assistant, toolResult]: block right after the summary", async () => {
    const { handler } = await setup()
    const msgs = [notes(), summary(), skill(), todo(), call(), result(), asst("next")]
    expect(msgs.map((m: any) => m.role)).toEqual(["custom", "compactionSummary", "custom", "custom", "assistant", "toolResult", "assistant"])
    const out = await handler(msgs)
    expect(out).toHaveLength(msgs.length + 1)
    expect(out[1]).toBe(msgs[1])
    expect(isBlock(out[2])).toBe(true)
    expect(out.slice(3)).toEqual(msgs.slice(2))
  })

  test("summary after leading custom messages wins over a later user message", async () => {
    const { handler } = await setup()
    for (const lead of [[notes()], [notes(), todo()]]) {
      const out = await handler([...lead, summary(), asst("a"), user("u"), asst("b")])
      expect(out.findIndex(isBlock)).toBe(lead.length + 1)
      expect(out.filter(isBlock)).toHaveLength(1)
    }
  })

  test("a /skill-started run before any compaction (no summary, no user message): right after the skill-prompt", async () => {
    const { handler } = await setup()
    const out = await handler([skill(), call(), result(), asst("next")])
    expect(out.findIndex(isBlock)).toBe(1)
    const withNotes = await handler([notes(), skill(), todo(), call(), result()])
    expect(withNotes.findIndex(isBlock)).toBe(2)
  })

  test("no summary: the skill-prompt anchors when it comes before the first user message", async () => {
    const { handler } = await setup()
    const out = await handler([skill(), asst("a"), user("later"), asst("b")])
    expect(out.findIndex(isBlock)).toBe(1)
  })

  test("regression guard: a user message before the skill-prompt still anchors", async () => {
    const { handler } = await setup()
    const out = await handler([user("first"), skill(), asst("a")])
    expect(out.findIndex(isBlock)).toBe(1)
  })

  test("regression guard: a skill-prompt not attributed to the user is no anchor", async () => {
    const { handler } = await setup()
    for (const a of ["agent", undefined]) {
      const sk: any = skill("agent")
      if (a === undefined) delete sk.attribution // a default parameter would turn undefined back into "user"
      const msgs = [notes(), sk, call(), result()]
      expect((await handler(msgs)).some(isBlock)).toBe(false)
    }
  })

  test("a user-attributed custom of another type (collab-prompt, accepted by omp's isUserTurnInitiator) is no anchor", async () => {
    const { handler } = await setup()
    const collab = { role: "custom", customType: "collab-prompt", content: "peer prompt", details: { args: "collab peer args" }, attribution: "user" }
    expect((await handler([notes(), collab, call(), result()])).some(isBlock)).toBe(false)
  })

  test("simulated buildLiveProviderContext cut for the new shapes: prefix of handler(history+retained) equals handler(history)", async () => {
    // [name, history, retained, history alone holds an anchor]
    const cases: [string, () => any[], () => any[], boolean][] = [
      ["T9 live shape", () => [notes(), summary(), skill(), todo(), call()], () => [result(), asst("done"), user("u2")], true],
      ["summary, skill-prompt, todo, no user anywhere", () => [summary(), skill(), todo(), call()], () => [result(), asst("done")], true],
      ["no summary, skill-prompt in history, user only in retained", () => [skill(), call()], () => [result(), user("u2"), asst("done")], true],
      ["no summary, agent custom in history, skill-prompt only in retained", () => [todo(), call()], () => [result(), skill(), asst("done")], false],
      ["notes then skill-prompt", () => [notes(), skill(), call()], () => [result(), asst("done")], true],
      // What buildLiveProviderContext actually sees after the T9 rollover (summary plus entries after the compaction;
      // notes and the re-appended request come only from buildSessionContext). The notes-at-0 rows are stricter.
      ["cut's own view after the T9 rollover: summary, todo, tool call", () => [summary(), todo(), call()], () => [result(), asst("done")], true],
    ]
    for (const [name, mkHistory, mkRetained, historyAnchored] of cases) {
      const { handler } = await setup()
      const history = mkHistory()
      const retained = mkRetained()
      const prefix = await handler(history)
      const full = await handler([...history, ...retained])
      expect(full.slice(0, prefix.length), name).toEqual(prefix)
      expect(full[prefix.length], name).toBe(retained[0])
      expect(full.filter(isBlock).length, name).toBe(1)
      expect(prefix.filter(isBlock).length, name).toBe(historyAnchored ? 1 : 0)
    }
  })
})

// T15 acceptance 5: native Anthropic summary fold (omp session/session-context.ts:651-662: the notes go after the
// summary, a directly following assistant turn and its tool results; the native cut, agent/src/compaction/
// anthropic.ts:137-171, never separates a tool call from its results).
describe("T15 acceptance 5: the native Anthropic summary fold is never split", () => {
  const native = { role: "compactionSummary", summary: "s", providerPayload: { type: "anthropicCompaction", provider: "anthropic", content: "c" } }
  const plain = { role: "compactionSummary", summary: "s" }
  const notes = { role: "custom", customType: "experimental_context_notes", content: "<experimental-context-notes>\nPIN\n</experimental-context-notes>", display: false }
  const call2 = { role: "assistant", content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }, { type: "toolCall", id: "b", name: "read", arguments: {} }] }
  const res = (id: string) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: "r" }] })
  const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
  const asst = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] })
  const textOf = (m: any) => (typeof m.content === "string" ? m.content : m.content?.[0]?.text)
  const isBlock = (m: any) => m?.synthetic === true && String(textOf(m)).startsWith(BLOCK)
  const setup = async () => {
    const b = fresh()
    await b.mcp("plan_create_run", {})
    return async (messages: any[]) => (await b.fire("context", { type: "context", messages }))?.messages ?? messages
  }

  test("[native summary, assistant, toolResult, toolResult, notes custom, ...]: block after the tool results and the notes", async () => {
    const handler = await setup()
    const msgs = [native, call2, res("a"), res("b"), notes, asst("next")]
    const out = await handler(msgs)
    expect(out.findIndex(isBlock)).toBe(5)
    expect(out.slice(0, 5)).toEqual(msgs.slice(0, 5))
  })

  test("native summary, plain assistant, user: block right after the assistant turn; directly a user: index 1", async () => {
    const handler = await setup()
    expect((await handler([native, asst("kept"), user("u")])).findIndex(isBlock)).toBe(2)
    expect((await handler([native, user("u"), asst("b")])).findIndex(isBlock)).toBe(1)
  })

  test("regression guard: a non-native summary keeps the block right after it", async () => {
    const handler = await setup()
    expect((await handler([plain, call2, res("a"), res("b"), notes, asst("next")])).findIndex(isBlock)).toBe(1)
  })

  test("cut alignment for the native shape, including the retained assistant turn in history", async () => {
    const cases: [string, any[], any[]][] = [
      ["retained assistant turn with its tool results in history", [native, call2, res("a"), res("b")], [asst("next"), user("u2")]],
      ["retained plain assistant turn in history", [native, asst("kept")], [user("u2"), asst("done")]],
      ["assistant turn and results, then more turns in history", [native, call2, res("a"), res("b"), asst("x"), user("u1")], [asst("y")]],
      ["native summary then a user message", [native, user("u1"), asst("a1")], [user("u2"), asst("a2")]],
    ]
    for (const [name, history, retained] of cases) {
      const handler = await setup()
      const prefix = await handler(history)
      const full = await handler([...history, ...retained])
      expect(full.slice(0, prefix.length), name).toEqual(prefix)
      expect(full[prefix.length], name).toBe(retained[0])
      expect(prefix.filter(isBlock).length, name).toBe(1)
      if (history[1]?.role === "assistant") expect(prefix[1], name).toBe(history[1])
    }
  })
})

describe("review fixes (2026-10-16)", () => {
  test("a task re-sent as done counts once toward the tidy-up", async () => {
    const { mcp, note } = fresh()
    await mcp("plan_create_run", { project: "/p" })
    await mcp("plan_memory_list", { project: "/p" })
    // The orchestrator re-sends T1-T3 with each new batch: still only 4 distinct tasks closed.
    await mcp("plan_set_tasks", { run: "r", tasks: [{ id: "T1", status: "done" }, { id: "T2", status: "done" }, { id: "T3", status: "done" }] })
    await mcp("plan_set_tasks", { run: "r", tasks: [{ id: "T1", status: "done" }, { id: "T2", status: "done" }, { id: "T3", status: "done" }, { id: "T4", status: "done" }] })
    await mcp("plan_set_task", { run: "r", id: "T4", status: "done" })
    expect(await note()).toBe("")
    await mcp("plan_set_task", { run: "r", id: "T5", status: "blocked" })
    expect(await note()).toMatch(/5 tasks reached done\/blocked/)
  })

  test("listing memory restarts the distinct count", async () => {
    const { mcp, note } = fresh()
    await mcp("plan_create_run", { project: "/p" })
    await mcp("plan_memory_list", { project: "/p" })
    await mcp("plan_set_tasks", { run: "r", tasks: ["T1", "T2", "T3", "T4", "T5"].map((id) => ({ id, status: "done" })) })
    expect(await note()).toMatch(/tidy-up is due/)
    await mcp("plan_memory_list", { project: "/p" })
    await mcp("plan_set_tasks", { run: "r", tasks: ["T1", "T2", "T3", "T4"].map((id) => ({ id, status: "done" })) })
    expect(await note()).toBe("")
    await mcp("plan_set_task", { run: "r", id: "T1", status: "done" })
    expect(await note()).toBe("")
  })

  test("with no override, state goes under ~/.omp/agent, not ~/.local/state", async () => {
    const saved = { agent: process.env.PI_CODING_AGENT_DIR, xdg: process.env.XDG_STATE_HOME, home: process.env.HOME }
    const home = mkdtempSync(path.join(tmpdir(), "omp-plan-memory-home-"))
    delete process.env.PI_CODING_AGENT_DIR
    process.env.XDG_STATE_HOME = path.join(home, "xdg")
    process.env.HOME = home
    try {
      const b = fresh()
      await b.mcp("plan_create_run", {})
      const dir = path.join(home, ".omp", "agent", "omp-plan-memory")
      expect(existsSync(dir) && readdirSync(dir).some((f) => /^omp-plan-memory-.*\.json$/.test(f))).toBe(true)
      expect(existsSync(path.join(home, "xdg"))).toBe(false)
    } finally {
      process.env.PI_CODING_AGENT_DIR = saved.agent
      if (saved.xdg === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = saved.xdg
      process.env.HOME = saved.home
      rmSync(home, { recursive: true, force: true })
    }
  })
  test("a batch the board refused counts nothing; only tasks in `written` count", async () => {
    const { mcp, note, fire } = fresh()
    await mcp("plan_create_run", { project: "/p" })
    await mcp("plan_memory_list", { project: "/p" })
    const batch = (ids: string[], written: string[]) =>
      fire("tool_result", {
        type: "tool_result",
        toolCallId: `b${ids.join("")}${written.length}`,
        toolName: "mcp__plan_sdd_plan_set_tasks",
        input: { run: "r", tasks: ids.map((id) => ({ id, status: "done" })) },
        content: [{ type: "text", text: JSON.stringify({ written, failed: Object.fromEntries(ids.filter((id) => !written.includes(id)).map((id) => [id, "exclusive resource held"])), graph: {} }) }],
        isError: false,
      })
    await batch(["T1", "T2"], ["T1", "T2"])
    await batch(["T3", "T4", "T5"], []) // refused as a whole: nothing landed
    expect(await note()).toBe("")
    await batch(["T3", "T4", "T5"], ["T3", "T4", "T5"])
    expect(await note()).toMatch(/5 tasks reached done\/blocked/)
  })
  test("`written` is read from details.structuredContent, omp's programmatic copy, not from the text rendering", async () => {
    const { mcp, note, fire } = fresh()
    await mcp("plan_create_run", { project: "/p" })
    await mcp("plan_memory_list", { project: "/p" })
    const batch = (ids: string[], written: string[]) =>
      fire("tool_result", {
        type: "tool_result",
        toolCallId: `s${ids.join("")}${written.length}`,
        toolName: "mcp__plan_sdd_plan_set_tasks",
        input: { run: "r", tasks: ids.map((id) => ({ id, status: "done" })) },
        // A rendered form (mcp/tool-bridge.ts:297-300), not JSON.
        content: [{ type: "text", text: `written: ${written.join(", ") || "(none)"}` }],
        details: { structuredContent: { written, graph: {} } },
        isError: false,
      })
    await batch(["T1", "T2"], ["T1", "T2"])
    await batch(["T3", "T4", "T5"], [])
    expect(await note()).toBe("")
    await batch(["T3", "T4", "T5"], ["T3", "T4", "T5"])
    expect(await note()).toMatch(/5 tasks reached done\/blocked/)
  })
  test("state goes to the agent dir omp reports (pi.pi.getAgentDir), ahead of PI_CODING_AGENT_DIR", async () => {
    const ompDir = mkdtempSync(path.join(tmpdir(), "omp-plan-memory-profile-"))
    try {
      const handlers: Record<string, Handler[]> = {}
      const pi = {
        on: (name: string, h: Handler) => void (handlers[name] ??= []).push(h),
        logger: { warn() {} },
        // A named profile: omp's own resolver, not the env rule.
        pi: { getAgentDir: () => path.join(ompDir, "profiles", "work", "agent") },
      }
      extension(pi as any)
      const ctx = { sessionManager: { getSessionId: () => `ses_profile_${Date.now()}` } }
      for (const h of handlers.tool_result ?? [])
        await h({ type: "tool_result", toolCallId: "p1", toolName: "mcp__plan_sdd_plan_create_run", input: {}, content: [], isError: false }, ctx)
      const dir = path.join(ompDir, "profiles", "work", "agent", "omp-plan-memory")
      expect(existsSync(dir) && readdirSync(dir).some((f) => /^omp-plan-memory-.*\.json$/.test(f))).toBe(true)
    } finally {
      rmSync(ompDir, { recursive: true, force: true })
    }
  })
})
