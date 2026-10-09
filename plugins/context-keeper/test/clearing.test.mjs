import assert from "node:assert/strict"
import { createHash } from "node:crypto"
const plugin = (await import(new URL("../context-keeper.js", import.meta.url).href)).default
const hooks = {}
const ctx = {
  location: { directory: (await import("node:os")).tmpdir() },
  tool: { hook: async (n, f) => (hooks["tool." + n] = f), transform: async () => {} },
  session: { hook: async (n, f) => (hooks[n] = f) },
  model: { list: async () => ({ data: [{ id: "m", providerID: "p", limit: { context: 40000 } }] }) },
  generate: { text: async ({ prompt }) => ({ text: "## Objective\n- x\n" + prompt.length }) },
}
await plugin.setup(ctx)
const big = (n, c = "x") => c.repeat(n)
const msgs = () => {
  const m = [{ id: "u1", role: "user", content: [{ type: "text", text: "build the thing" }] }]
  for (let i = 0; i < 12; i++) {
    m.push({ id: "a" + i, role: "assistant", content: [{ type: "tool-call", id: "c" + i, name: i % 3 === 0 ? "read" : i % 3 === 1 ? "subagent" : "shell", input: i % 3 === 0 ? { path: "/x/f" + i + ".md" } : i % 3 === 1 ? { agent: "implementer", description: "T" + i } : { command: "npm test" } }] })
    m.push({ id: "t" + i, role: "tool", content: [{ type: "tool-result", id: "c" + i, name: i % 3 === 0 ? "read" : i % 3 === 1 ? "subagent" : "shell", result: { type: "text", value: (i % 3 === 1 ? `<subagent sessionID="ses_${i}" state="completed">` : "") + big(9000, "ab") } }] })
  }
  return m
}
const run = async (sid, agent = "build") => {
  const e = { sessionID: sid, agent, model: { id: "m", providerID: "p" }, system: [{ type: "text", text: "sys" }], messages: msgs() }
  await hooks.context(e)
  return e
}
const h = (x) => createHash("sha1").update(JSON.stringify(x)).digest("hex").slice(0, 10)
const sid = "ses_unit_" + Date.now()
const r1 = await run(sid)
const last = r1.messages.at(-1).content[0].text
assert.match(last, /context-budget/); assert.match(last, /cleared/)
const clearedParts = r1.messages.flatMap((m) => m.content).filter((p) => p.type === "tool-result" && p.result.value.includes("context-keeper cleared"))
console.log("round1 nudge:", last.slice(0, 160)); console.log("cleared parts:", clearedParts.length, "e.g.", clearedParts[0].result.value.slice(-120))
const r2 = await run(sid)
const body = (r) => r.messages.filter((m) => !JSON.stringify(m).includes("context-budget"))
assert.equal(h(body(r1)), h(body(r2)), "replay must be byte-identical")
console.log("replay identical:", h(body(r1)) === h(body(r2)), "| second nudge?", JSON.stringify(r2.messages.at(-1)).includes("context-budget"))
const sub = await run("ses_unit_sub_" + Date.now(), "implementer")
assert.ok(!JSON.stringify(sub.messages).includes("context-keeper cleared") && !JSON.stringify(sub.messages).includes("context-budget"))
console.log("subagent untouched: ok")
const { readFileSync } = await import("node:fs")
const st = JSON.parse(readFileSync(process.env.XDG_STATE_HOME + "/opencode-context-keeper/" + sid + ".json", "utf8"))
console.log("ledger:", JSON.stringify(Object.values(st.subagents).slice(0, 2)))
