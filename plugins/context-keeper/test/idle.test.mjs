import assert from "node:assert/strict"
process.env.CONTEXT_KEEPER_IDLE_MS = "50"
const plugin = (await import(new URL("../context-keeper.js?idle", import.meta.url).href)).default
const hooks = {}
await plugin.setup({ location: { directory: "/tmp" }, tool: { hook: async () => {}, transform: async () => {} }, session: { hook: async (n, f) => (hooks[n] = f) }, model: { list: async () => ({ data: [{ id: "m", providerID: "p", limit: { context: 100000 } }] }) }, generate: {} })
const mk = (n) => { const m = [{ id: "u", role: "user", content: [{ type: "text", text: "go" }] }]; for (let i = 0; i < n; i++) { m.push({ id: "a" + i, role: "assistant", content: [{ type: "tool-call", id: "c" + i, name: "shell", input: { command: "ls" } }] }); m.push({ id: "t" + i, role: "tool", content: [{ type: "tool-result", id: "c" + i, name: "shell", result: { type: "text", value: "y".repeat(5000) } }] }) } return m }
const sid = "ses_idle_" + Date.now()
const e1 = { sessionID: sid, agent: "build", model: { id: "m", providerID: "p" }, system: [], messages: mk(25) }
await hooks.context(e1) // ~36K of 100K: crosses 25% → round 1
const e2 = { ...e1, messages: mk(27) }
await hooks.context(e2) // same level, no idle → no round
assert.ok(!JSON.stringify(e2.messages.at(-1)).includes("context-budget"))
await new Promise((r) => setTimeout(r, 80))
const e3 = { ...e1, messages: mk(45) }
await hooks.context(e3) // idle → round again
assert.ok(JSON.stringify(e3.messages.at(-1)).includes("context-budget"))
console.log("idle round fired after pause: ok")
const e4 = { ...e1, messages: mk(46) }
await hooks.context(e4) // right after: no idle, same level → no round
assert.ok(!JSON.stringify(e4.messages.at(-1)).includes("context-budget"))
console.log("no round without pause: ok")
