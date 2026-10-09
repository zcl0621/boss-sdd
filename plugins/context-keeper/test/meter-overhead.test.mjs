import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
// The meter counts what every request carries besides the messages: tool definitions and, after a compaction,
// the restored block.
const { default: plugin } = await import(new URL("../context-keeper.js?overhead=" + Date.now(), import.meta.url).href)
const hooks = {}
await plugin.setup({ location: { directory: "/tmp" }, tool: { hook: async () => {}, transform: async () => {} }, session: { hook: async (n, f) => (hooks[n] = f) }, model: { list: async () => ({ data: [{ id: "m", providerID: "p", limit: { context: 1000000 } }] }) }, generate: {} })
const meter = (sid) => JSON.parse(readFileSync(path.join(process.env.XDG_STATE_HOME, "opencode-context-keeper", sid + ".json"), "utf8")).meter
const msgs = () => [{ id: "u1", role: "user", content: [{ type: "text", text: "hello" }] }]
const base = { agent: "build", model: { id: "m", providerID: "p" }, system: [] }

const a = "ses_ov_a_" + Date.now(), b = "ses_ov_b_" + Date.now()
await hooks.context({ ...base, sessionID: a, messages: msgs() })
await hooks.context({ ...base, sessionID: b, messages: msgs(), tools: [{ name: "big", description: "x".repeat(40000) }] })
assert.ok(meter(b).used - meter(a).used >= 8000, `tool definitions counted (${meter(a).used} vs ${meter(b).used})`)

const c = "ses_ov_c_" + Date.now()
const checkpoint = [{ id: "ck", role: "user", content: [{ type: "text", text: "<conversation-checkpoint>\nsummary" }] }, ...msgs()]
await hooks.context({ ...base, sessionID: c, messages: checkpoint })
const st = JSON.parse(readFileSync(path.join(process.env.XDG_STATE_HOME, "opencode-context-keeper", c + ".json"), "utf8"))
const block = Object.values(st.epochs)[0]
assert.ok(block && block.length > 100, "restored block built")
assert.ok(meter(c).used > meter(a).used + block.length / 6, `restored block counted (${meter(c).used})`)
console.log("meter counts tools and the restored block: ok")
