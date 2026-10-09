import assert from "node:assert/strict"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
// Once per compaction epoch the state file sheds what can never be used again: clearing decisions for messages
// that left the context, and user messages / ledger entries beyond the cap. The restored block still reports
// how many earlier ones there were.
const { default: plugin, prune } = await import(new URL("../context-keeper.js?prune=" + Date.now(), import.meta.url).href)
const hooks = {}
await plugin.setup({ location: { directory: "/tmp" }, tool: { hook: async () => {}, transform: async () => {} }, session: { hook: async (n, f) => (hooks[n] = f) }, model: { list: async () => ({ data: [{ id: "m", providerID: "p", limit: { context: 1000000 } }] }) }, generate: {} })

const dir = path.join(process.env.XDG_STATE_HOME, "opencode-context-keeper")
mkdirSync(dir, { recursive: true })
const sid = "ses_prune_" + Date.now()
const cleared = {}, users = [], subagents = {}
for (let i = 0; i < 500; i++) cleared["old" + i] = "[cleared]"
cleared.live1 = "[cleared live]"
for (let i = 0; i < 260; i++) users.push({ id: "u" + i, text: "message " + i })
for (let i = 0; i < 230; i++) subagents["call" + i] = { agent: "reviewer", description: "d" + i, status: "completed" }
writeFileSync(path.join(dir, sid + ".json"), JSON.stringify({ v: 4, cleared, clearedCalls: { oldc: "x" }, users, subagents, children: {} }))

const messages = [
  { id: "ck", role: "user", content: [{ type: "text", text: "<conversation-checkpoint>\nsummary" }] },
  { id: "a1", role: "assistant", content: [{ type: "tool-call", id: "live1", name: "read", input: {} }] },
  { id: "t1", role: "tool", content: [{ type: "tool-result", id: "live1", name: "read", result: { type: "text", value: "x" } }] },
  { id: "u259", role: "user", content: [{ type: "text", text: "message 259" }] },
]
await hooks.context({ sessionID: sid, agent: "build", model: { id: "m", providerID: "p" }, system: [], messages })
const st = JSON.parse(readFileSync(path.join(dir, sid + ".json"), "utf8"))
assert.deepEqual(Object.keys(st.cleared), ["live1"], "only clearing decisions for messages still in context survive")
assert.deepEqual(st.clearedCalls, {})
assert.equal(st.users.length, 200)
assert.equal(st.usersDropped, 60)
assert.equal(Object.keys(st.subagents).length, 200)
assert.equal(st.subagentsDropped, 30)
const block = Object.values(st.epochs)[0]
assert.match(block, /older ones omitted/)
assert.match(block, /\d+ earlier ones omitted/)
assert.equal(messages[2].content[0].result.value, "[cleared live]", "a live clearing decision is still replayed")
assert.equal(typeof prune, "function")
console.log("prune: ok")
