import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
// The todo and goal plugins put their own state on every request, so the restored block no longer repeats them;
// every primary request leaves a meter for the sidebar.
const plugin = (await import(new URL("../context-keeper.js?todo", import.meta.url).href)).default
const hooks = {}
await plugin.setup({
  location: { directory: "/tmp" },
  tool: { hook: async () => {}, transform: async () => {} },
  session: { hook: async (n, f) => (hooks[n] = f) },
  model: { list: async () => ({ data: [{ id: "m", providerID: "p", limit: { context: 100000 } }] }) },
  generate: {},
})
const sid = "ses_todo_" + Date.now()
mkdirSync(process.env.OPENCODE_TODO_DIR, { recursive: true })
writeFileSync(
  path.join(process.env.OPENCODE_TODO_DIR, `${sid}.json`),
  JSON.stringify([
    { id: "1", content: "T1 parser", status: "completed", priority: "high" },
    { id: "2", content: "T2 storage", status: "in_progress", priority: "high" },
    { id: "3", content: "T3 api", status: "pending", priority: "medium" },
  ]),
)
mkdirSync(path.join(process.env.XDG_STATE_HOME, "opencode-goal"), { recursive: true })
writeFileSync(
  path.join(process.env.XDG_STATE_HOME, "opencode-goal", `${sid}.json`),
  JSON.stringify({ goal: { objective: "finish the plan", status: "active", setAt: Date.now() }, seen: [], children: {} }),
)
const body = []
for (let i = 0; i < 12; i++) {
  body.push({ id: "a" + i, role: "assistant", content: [{ type: "tool-call", id: "c" + i, name: "shell", input: { command: "ls" } }] })
  body.push({ id: "t" + i, role: "tool", content: [{ type: "tool-result", id: "c" + i, name: "shell", result: { type: "text", value: "y".repeat(10000) } }] })
}
const e = {
  sessionID: sid,
  agent: "build",
  model: { id: "m", providerID: "p" },
  system: [],
  messages: [{ id: "ck1", role: "user", content: [{ type: "text", text: "<conversation-checkpoint>\nsummary" }] }, ...body],
}
await hooks.context(e)
const block = e.messages[0].content.map((p) => p.text).join("\n")
assert.doesNotMatch(JSON.stringify(e.messages), /## Todo list|## Goal|T2 storage|finish the plan/)

const st = JSON.parse(readFileSync(path.join(process.env.XDG_STATE_HOME, "opencode-context-keeper", `${sid}.json`), "utf8"))
assert.equal(st.meter.window, 100000)
assert.ok(st.meter.level >= 25, `level ${st.meter.level}`)
assert.ok(st.meter.cleared > 0 && st.meter.clearedChars >= 2000, "clearing recorded")
assert.ok(st.meter.used > 0 && st.meter.used < st.meter.window)
console.log("no todo/goal in restored block + meter: ok", JSON.stringify(st.meter))
