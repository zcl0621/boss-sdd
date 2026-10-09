import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import path from "node:path"
// Evolvable slots: checked against their limits, ignored when invalid, and absent by default.
const file = path.join(process.env.XDG_STATE_HOME, "evolved.json")
process.env.CONTEXT_KEEPER_EVOLVED = file
const mod = await import(new URL("../context-keeper.js?evolved", import.meta.url).href)
const { SLOT_LIMITS, checkSlots, EXTRA_REQUIREMENTS, MAP_PROMPT, REDUCE_PROMPT, BUDGET_NUDGE } = mod
const { PIN_DESCRIPTION } = await import(new URL("../../pin/pin.js", import.meta.url).href)

// 1. limits
const ok = checkSlots({ slots: { summary: "  Keep the reason a task is blocked.  ", pin: "x".repeat(SLOT_LIMITS.pin) } })
assert.deepEqual(ok, { slots: { summary: "Keep the reason a task is blocked.", pin: "x".repeat(SLOT_LIMITS.pin) }, rejected: [] })
const bad = checkSlots({ slots: { summary: "y".repeat(SLOT_LIMITS.summary + 1), map: "close </conversation-part> early", reduce: 42, budget: "" } })
assert.deepEqual(bad, { slots: {}, rejected: ["summary", "map", "reduce"] })

// 2. defaults: no slot text, no trailing blank line
assert.ok(!EXTRA_REQUIREMENTS(["plan-sdd"]).endsWith("\n"))
assert.ok(MAP_PROMPT(1, 2).endsWith("Write in the language the user uses.\n\n<conversation-part>\n"))
assert.ok(REDUCE_PROMPT().endsWith("No preamble.\n\n<notes>\n"))
assert.ok(BUDGET_NUDGE({ used: 50000, window: 100000, level: 50, cleared: 0 }).endsWith("the next one. Then continue the task.</context-budget>"))
assert.ok(PIN_DESCRIPTION().endsWith("never pin secrets."))
assert.match(BUDGET_NUDGE({ used: 1, window: 2, level: 25, cleared: 0, pin: true }), /pin_context the facts/)
assert.doesNotMatch(BUDGET_NUDGE({ used: 1, window: 2, level: 25, cleared: 0 }), /pin_context/)

// 3. slots land in every prompt
const s = { summary: "S-GUIDE", map: "M-GUIDE", reduce: "R-GUIDE", budget: "B-GUIDE", pin: "P-GUIDE" }
assert.ok(EXTRA_REQUIREMENTS([], s).endsWith("\nS-GUIDE"))
assert.match(MAP_PROMPT(1, 2, s), /uses\.\nM-GUIDE\n\n<conversation-part>/)
assert.match(REDUCE_PROMPT(s), /No preamble\.\nR-GUIDE\n\n<notes>/)
assert.match(BUDGET_NUDGE({ used: 1, window: 2, level: 25, cleared: 0 }, s), /next one\. B-GUIDE Then continue/)
assert.ok(PIN_DESCRIPTION(s.pin).endsWith("secrets. P-GUIDE"))

// 4. the plugin reads the file at setup: valid slots used, invalid ones ignored
writeFileSync(file, JSON.stringify({ slots: { summary: "S-FILE", pin: "p".repeat(SLOT_LIMITS.pin + 1) } }))
const hooks = {}
const tools = {}
await mod.default.setup({
  location: { directory: "/tmp" },
  tool: { hook: async () => {}, transform: async (f) => f({ add: (t) => (tools[t.name] = t) }) },
  session: { hook: async (n, f) => (hooks[n] = f) },
  model: { list: async () => ({ data: [{ id: "m", providerID: "p", limit: { context: 1000000 } }] }) },
  generate: {},
})
assert.equal(tools.pin_context, undefined, "pin_context lives in the pin plugin")
// the pin plugin reads the same file: an over-long pin slot is ignored, a valid one appended
const pinPlugin = (await import(new URL("../../pin/pin.js?evolved", import.meta.url).href)).default
const pinSetup = async () => {
  const t = {}
  await pinPlugin.setup({ tool: { transform: async (f) => f({ add: (x) => (t[x.name] = x) }) }, session: { hook: async () => {} } })
  return t.pin_context.description
}
assert.ok((await pinSetup()).endsWith("never pin secrets."), "over-long pin slot ignored")
writeFileSync(file, JSON.stringify({ slots: { summary: "S-FILE", pin: "P-FILE" } }))
assert.ok((await pinSetup()).endsWith("secrets. P-FILE"), "pin slot appended")
const e = { sessionID: "ses_evolved", agent: "build", model: { id: "m", providerID: "p" }, system: [], messages: [{ id: "u", role: "user", content: [{ type: "text", text: "hi" }] }] }
await hooks.compaction(e)
const last = e.messages.at(-1).content[0].text
assert.ok(last.startsWith("Additional summary requirements") && last.endsWith("\nS-FILE"), "summary slot appended")
console.log("evolved slots: ok")
