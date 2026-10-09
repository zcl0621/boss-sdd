import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

process.env.OPENCODE_TODO_DIR = mkdtempSync(path.join(tmpdir(), "todo-test-"))
const store = await import("../store")
const plugin = (await import("../index")).default

test("normalize drops empty items, fills defaults, de-duplicates ids", () => {
  const out = store.normalize([{ content: " a " }, { content: "" }, { id: "x", content: "b", status: "bogus" }, { id: "x", content: "c", status: "in_progress", priority: "high" }])
  expect(out).toEqual([
    { id: "1", content: "a", status: "pending", priority: "medium" },
    { id: "x", content: "b", status: "pending", priority: "medium" },
    { id: "x-3", content: "c", status: "in_progress", priority: "high" },
  ])
})

test("a renamed duplicate id never collides with an existing one", () => {
  const ids = store.normalize([{ id: "a-3", content: "p" }, { id: "a", content: "q" }, { id: "a", content: "r" }]).map((t) => t.id)
  expect(new Set(ids).size).toBe(3)
})

test("tools write and read the session list; several in_progress items are kept", async () => {
  const tools: Record<string, any> = {}
  await plugin.setup({
    tool: { transform: async (f: any) => (f({ add: (t: any) => (tools[t.name] = t), list: () => [] }), { dispose: async () => {} }) },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  })
  const todos = [
    { content: "T1 parser", status: "in_progress" },
    { content: "T2 storage", status: "in_progress" },
    { content: "T3 api" },
  ]
  await tools.todowrite.execute({ todos }, { sessionID: "ses_a" })
  const read = await tools.todoread.execute({}, { sessionID: "ses_a" })
  expect(read.output.todos.map((t: any) => t.status)).toEqual(["in_progress", "in_progress", "pending"])
  expect((await tools.todoread.execute({}, { sessionID: "ses_b" })).output.todos).toEqual([])
  expect(store.isFinished(read.output.todos)).toBe(false)
})

test("every request carries the open items; a dispatch after the last todowrite asks for an update", async () => {
  const hooks: Record<string, any> = {}
  const tools: Record<string, any> = {}
  await plugin.setup({
    tool: { transform: async (f: any) => (f({ add: (t: any) => (tools[t.name] = t), list: () => [] }), { dispose: async () => {} }) },
    session: { hook: async (n: string, f: any) => (hooks[n] = f) },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  })
  const request = async (sid: string, extra: any[] = []) => {
    const e = { sessionID: sid, messages: [{ id: "u0", role: "user", content: [{ type: "text", text: "go" }] }, ...extra] }
    await hooks.context(e)
    return e.messages
  }
  expect((await request("ses_none")).length).toBe(1)
  await tools.todowrite.execute({ todos: [{ content: "T1 parser", status: "completed" }, { content: "T2 storage", status: "in_progress" }, { content: "T3 api" }] }, { sessionID: "ses_c" })
  const write = { id: "a1", role: "assistant", content: [{ type: "tool-call", id: "c1", name: "todowrite", input: {} }, { type: "tool-call", id: "c2", name: "subagent", input: {} }] }
  let msgs = await request("ses_c", [write])
  const last = msgs.at(-1)
  expect(last.id).toBeUndefined()
  expect(last.metadata.synthetic).toBe(true)
  expect(last.content[0].text).toBe("<todos>Todo list, 1/3 done (open items below; todowrite replaces the whole list).\n- [in_progress] T2 storage\n- [pending] T3 api\n</todos>")
  const later = { id: "a2", role: "assistant", content: [{ type: "tool-call", id: "c3", name: "subagent", input: {} }, { type: "tool-call", id: "c4", name: "subagent", input: {} }] }
  msgs = await request("ses_c", [write, later])
  expect(msgs.at(-1).content[0].text).toContain("\n2 subagent dispatches since the last todowrite: bring the list up to date.\n</todos>")
  await tools.todowrite.execute({ todos: [{ content: "T1 parser", status: "completed" }, { content: "T2", status: "cancelled" }] }, { sessionID: "ses_c" })
  expect((await request("ses_c")).length).toBe(1)
})
