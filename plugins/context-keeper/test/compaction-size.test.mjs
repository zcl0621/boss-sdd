import assert from "node:assert/strict"
import { readdirSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
// 1. Whether the history fits one summary request is judged on what is sent, not on the clipped transcript.
// 2. A corrupt state file is moved aside instead of being silently replaced by an empty state.
const plugin = (await import(new URL("../context-keeper.js?size", import.meta.url).href)).default
const hooks = {}
const prompts = []
const generate = { text: async ({ prompt }) => (prompts.push(prompt), { text: "## Objective\n- x\n## Progress\n- y" }) }
await plugin.setup({ location: { directory: "/tmp" }, tool: { hook: async () => {}, transform: async () => {} }, session: { hook: async (n, f) => (hooks[n] = f) }, model: { list: async () => ({ data: [{ id: "m", providerID: "p", limit: { context: 100000 } }] }) }, generate })

// 20 tool outputs of 20K chars: ~100K tokens sent, but only ~7.5K tokens once each is clipped to 1500 chars.
const msgs = [{ id: "u0", role: "user", content: [{ type: "text", text: "start" }] }]
for (let i = 0; i < 20; i++) {
  msgs.push({ id: "a" + i, role: "assistant", content: [{ type: "tool-call", id: "c" + i, name: "shell", input: { command: "cat big" } }] })
  msgs.push({ id: "t" + i, role: "tool", content: [{ type: "tool-result", id: "c" + i, name: "shell", result: { type: "text", value: "y".repeat(20000) } }] })
}
await hooks.compaction({ sessionID: "ses_size_" + Date.now(), agent: "build", model: { id: "m", providerID: "p" }, system: [], messages: msgs })
assert.ok(prompts.length >= 2, `oversized history must be summarized in chunks (generate calls: ${prompts.length})`)

const dir = path.join(process.env.XDG_STATE_HOME, "opencode-context-keeper")
mkdirSync(dir, { recursive: true })
const bad = "ses_corrupt_" + Date.now()
writeFileSync(path.join(dir, bad + ".json"), '{"pins": {"k": ')
await hooks.context({ sessionID: bad, agent: "build", model: { id: "m", providerID: "p" }, system: [], messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }] }] })
assert.ok(readdirSync(dir).some((n) => n.startsWith(bad + ".json.corrupt-")), "corrupt state kept aside")
console.log("compaction size and corrupt state: ok")
