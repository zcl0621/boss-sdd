import assert from "node:assert/strict"
process.env.CONTEXT_KEEPER_WINDOW = "40000"
const { default: plugin } = await import(new URL("../context-keeper.js?brief=" + Date.now(), import.meta.url).href)
const hooks = {}
await plugin.setup({
  location: { directory: "/tmp/ck-brief" },
  tool: { hook: async (n, f) => (hooks["tool." + n] = f), transform: async () => {} },
  session: { hook: async (n, f) => (hooks[n] = f) },
  model: { list: async () => [] },
  generate: {},
})
const sid = "ses_brief_" + Date.now()
const brief = "You are the implementer for task T1.\n<goal>x</goal>\n" + "背景".repeat(3000)
const build = () => {
  const msgs = [{ id: "u0", role: "user", content: [{ type: "text", text: "start" }] }]
  for (let i = 0; i < 14; i++) {
    msgs.push({ id: "a" + i, role: "assistant", content: [{ type: "tool-call", id: "c" + i, name: "subagent", input: { agent: "implementer", description: "T" + i, prompt: brief } }] })
    msgs.push({ id: "t" + i, role: "tool", content: [{ type: "tool-result", id: "c" + i, name: "subagent", result: { type: "text", value: `<subagent sessionID="ses_${i}" state="completed">\nok\n</subagent>` } }] })
  }
  return msgs
}
const e1 = { sessionID: sid, agent: "plan-sdd", model: { id: "m", providerID: "p" }, system: [], messages: build() }
await hooks.context(e1)
const stubbed = e1.messages.filter((m) => m.content.some((p) => p.type === "tool-call" && p.input.prompt.startsWith("[context-keeper cleared")))
assert.ok(stubbed.length > 0, "old briefs cleared")
// 84K tokens of briefs in a 40K window: the 90% round keeps the last 4 messages (the nudge is appended after them)
const body = e1.messages.slice(0, -1)
assert.ok(body.slice(-4).every((m) => m.content.every((p) => p.type !== "tool-call" || p.input.prompt === brief)), "recent briefs kept")
// replay: same bytes on the next request, and in the compaction request
const e2 = { ...e1, messages: build() }
await hooks.context(e2)
const strip = (msgs) => JSON.stringify(msgs.filter((m) => !m.content.some((p) => p.type === "text" && p.text.startsWith("<context-budget>"))))
assert.equal(strip(e2.messages), strip(e1.messages))
const e3 = { ...e1, messages: build() }
await hooks.compaction(e3)
assert.equal(JSON.stringify(e3.messages.slice(0, e1.messages.length - 1)), JSON.stringify(e1.messages.slice(0, e1.messages.length - 1)))
console.log("brief clearing + replay: ok", stubbed.length, "briefs stubbed")
