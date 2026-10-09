import assert from "node:assert/strict"
process.env.CONTEXT_KEEPER_WINDOW = "40000"
const { default: plugin } = await import(new URL("../context-keeper.js?turn=" + Date.now(), import.meta.url).href)
const hooks = {}
await plugin.setup({
  location: { directory: "/tmp/ck-turn" },
  tool: { hook: async (n, f) => (hooks["tool." + n] = f), transform: async () => {} },
  session: { hook: async (n, f) => (hooks[n] = f) },
  model: { list: async () => [] },
  generate: {},
})
// Four short turns, each reading one large file: all twelve messages sit inside a fixed "last 10" window, so only
// a current-turn rule can clear the earlier reads.
const build = () => {
  const msgs = []
  for (let i = 0; i < 4; i++) {
    msgs.push({ id: "u" + i, role: "user", content: [{ type: "text", text: `read logs/log${i}.md` }] })
    msgs.push({ id: "a" + i, role: "assistant", content: [{ type: "tool-call", id: "c" + i, name: "read", input: { filePath: `logs/log${i}.md` } }] })
    msgs.push({ id: "t" + i, role: "tool", content: [{ type: "tool-result", id: "c" + i, name: "read", result: { type: "text", value: `log ${i}\n` + "x".repeat(22000) } }] })
  }
  return msgs
}
const e = { sessionID: "ses_turn_" + Date.now(), agent: "plan-sdd", model: { id: "m", providerID: "p" }, system: [], messages: build() }
await hooks.context(e)
const value = (id) => e.messages.find((m) => m.id === id).content[0].result.value
for (const id of ["t0", "t1", "t2"]) assert.ok(!value(id).startsWith("log "), `${id} (earlier turn) cleared`)
assert.ok(value("t3").startsWith("log 3"), "current turn kept")
console.log("current-turn clearing: ok")
