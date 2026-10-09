import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
// The estimate (CJK-aware chars over the serialized request) runs high on providers that tokenize JSON tightly.
// After each step the provider's real input size calibrates later estimates, so clearing levels and the budget
// notice track what the model actually holds.
process.env.CONTEXT_KEEPER_WINDOW = "100000"
const { default: plugin } = await import(new URL("../context-keeper.js?calib=" + Date.now(), import.meta.url).href)
const queue = []
let wake
const events = {
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (queue.length) yield queue.shift()
      await new Promise((r) => (wake = r))
    }
  },
}
const emit = (ev) => (queue.push(ev), wake?.())
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hooks = {}
const dispose = await plugin.setup({
  location: { directory: "/tmp/ck-calib" },
  tool: { hook: async () => {}, transform: async () => {} },
  session: { hook: async (n, f) => (hooks[n] = f) },
  model: { list: async () => [] },
  event: { subscribe: () => events },
  generate: {},
})
const sid = "ses_calib_" + Date.now()
const meter = () => JSON.parse(readFileSync(path.join(process.env.XDG_STATE_HOME, "opencode-context-keeper", `${sid}.json`), "utf8")).meter
// a short session: one user message and some text, well under every clearing level
const req = () => ({
  sessionID: sid,
  agent: "plan-sdd",
  model: { id: "m", providerID: "p" },
  system: [],
  messages: [{ id: "u0", role: "user", content: [{ type: "text", text: "x".repeat(35000) }] }],
})
await hooks.context(req())
const raw = meter().used
assert.ok(raw > 9000 && raw < 12000, `raw estimate ${raw}`)

// the provider reports 80% of the estimate for that step: the next estimate follows
emit({ type: "session.step.ended", data: { sessionID: sid, tokens: { input: Math.round(raw * 0.3), output: 50, cache: { read: Math.round(raw * 0.5), write: 0 } } } })
await sleep(30)
await hooks.context(req())
const calibrated = meter().used
assert.ok(Math.abs(calibrated - raw * 0.8) <= raw * 0.02, `calibrated ${calibrated} vs ${raw * 0.8}`)

// that request's own step (again 80%), then a step with no estimate pending (a compaction request): ignored
emit({ type: "session.step.ended", data: { sessionID: sid, tokens: { input: Math.round(raw * 0.8), output: 50, cache: { read: 0, write: 0 } } } })
emit({ type: "session.step.ended", data: { sessionID: sid, tokens: { input: 5, output: 1, cache: { read: 0, write: 0 } } } })
await sleep(30)
await hooks.context(req())
assert.ok(Math.abs(meter().used - calibrated) <= raw * 0.02, "unrelated step ignored")

// a wild reading is clamped
emit({ type: "session.step.ended", data: { sessionID: sid, tokens: { input: raw * 10, output: 1, cache: { read: 0, write: 0 } } } })
await sleep(30)
await hooks.context(req())
assert.ok(meter().used <= raw * 1.3 + 1, `clamped ${meter().used}`)
assert.equal(typeof dispose, "function", "setup returns a disposer")
await dispose()
console.log("calibration: ok", raw, calibrated)
process.exit(0)
