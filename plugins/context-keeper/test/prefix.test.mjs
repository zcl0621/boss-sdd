import assert from "node:assert/strict"
const plugin = (await import(new URL("../context-keeper.js?prefix", import.meta.url).href)).default
const hooks = {}
await plugin.setup({ location: { directory: "/tmp" }, tool: { hook: async () => {}, transform: async () => {} }, session: { hook: async (n, f) => (hooks[n] = f) }, model: { list: async () => ({ data: [{ id: "m", providerID: "p", limit: { context: 100000 } }] }) }, generate: {} })
const mk = () => { const m = [{ id: "ck1", role: "user", content: [{ type: "text", text: "<conversation-checkpoint>\nsummary" }] }]; for (let i = 0; i < 40; i++) { m.push({ id: "a" + i, role: "assistant", content: [{ type: "tool-call", id: "c" + i, name: "shell", input: { command: "ls" } }] }); m.push({ id: "t" + i, role: "tool", content: [{ type: "tool-result", id: "c" + i, name: "shell", result: { type: "text", value: "y".repeat(5000) } }] }) } return m }
const sid = "ses_prefix_" + Date.now()
const main = { sessionID: sid, agent: "build", model: { id: "m", providerID: "p" }, system: [], messages: mk() }
await hooks.context(main)
const comp = { sessionID: sid, agent: "build", model: { id: "m", providerID: "p" }, system: [], messages: mk().slice(0, 60) }
await hooks.compaction(comp)
const a = JSON.stringify(main.messages.slice(0, 60)), b = JSON.stringify(comp.messages.slice(0, 60))
assert.equal(a, b, "compaction request must share the conversation prefix")
console.log("compaction prefix identical to main request: ok (", a.length, "chars )")
