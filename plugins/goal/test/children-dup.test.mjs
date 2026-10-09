import assert from "node:assert/strict"
process.env.OPENCODE_GOAL_DELAY_MS = "20"
process.env.OPENCODE_GOAL_CHILD_WAIT_MS = "400"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// One plugin instance with its own controllable event stream. Two instances over the same state directory stand in
// for opencode setting the plugin up again without the old instance's subscription going away.
const instance = async (tag) => {
  const { default: plugin } = await import(new URL(`../goal.js?${tag}`, import.meta.url).href)
  const queue = []
  let wake
  let stopped = false
  const events = {
    async *[Symbol.asyncIterator]() {
      while (!stopped) {
        while (queue.length) yield queue.shift()
        await new Promise((r) => (wake = r))
      }
    },
  }
  const hooks = {}
  const tools = {}
  const sent = []
  const dispose = await plugin.setup({
    location: { directory: "/tmp/ck-goal-dup" },
    tool: { hook: async (n, f) => (hooks["tool." + n] = f), transform: async (f) => f({ add: (t) => (tools[t.name] = t) }) },
    session: { hook: async (n, f) => (hooks[n] = f), synthetic: async (x) => sent.push(x) },
    event: { subscribe: ({ signal } = {}) => (signal?.addEventListener("abort", () => ((stopped = true), wake?.())), events) },
  })
  const emit = (ev) => (queue.push(ev), wake?.())
  return { hooks, tools, sent, dispose, emit }
}
const idle = (i, sid) => {
  i.emit({ type: "session.execution.started", data: { sessionID: sid } })
  i.emit({ type: "session.execution.succeeded", data: { sessionID: sid } })
}
const req = (sid, messages) => ({ sessionID: sid, agent: "build", model: { id: "m", providerID: "p" }, system: [], messages })

// 1. a background child launched with a structured result ({ sessionID, status: "running" }) is waited for
const a = await instance("a")
const sid = "ses_dup_" + Date.now()
await a.tools.goal.execute({ action: "set", objective: "finish" }, { sessionID: sid })
const launched = [
  { id: "u1", role: "user", content: [{ type: "text", text: "go" }] },
  { id: "a1", role: "assistant", content: [{ type: "tool-call", id: "c1", name: "subagent", input: { agent: "reviewer", prompt: "x" } }] },
  { id: "t1", role: "tool", content: [{ type: "tool-result", id: "c1", name: "subagent", result: { type: "json", value: { sessionID: "ses_kid", status: "running", truncated: false } } }] },
]
await a.hooks.context(req(sid, launched))
await a.hooks["tool.execute.after"]({ status: "completed", sessionID: sid, tool: "bash", input: {}, result: "ok" })
idle(a, sid)
await sleep(150)
assert.equal(a.sent.length, 0, "no continue while the structured-launch child runs")
// a finished child reported the same way does not count as running
const done = [...launched.slice(0, 2), { id: "t1", role: "tool", content: [{ type: "tool-result", id: "c1", name: "subagent", result: { type: "json", value: { sessionID: "ses_kid2", status: "completed", truncated: false } } }] }]
const sid2 = "ses_dup2_" + Date.now()
await a.tools.goal.execute({ action: "set", objective: "finish" }, { sessionID: sid2 })
await a.hooks.context(req(sid2, done))
await a.hooks["tool.execute.after"]({ status: "completed", sessionID: sid2, tool: "bash", input: {}, result: "ok" })
idle(a, sid2)
await sleep(100)
assert.equal(a.sent.filter((x) => x.sessionID === sid2).length, 1, "a completed child is not waited for")

// 2. two instances see the same turn end: only one continue goes out
const b = await instance("b")
const sid3 = "ses_dup3_" + Date.now()
await a.tools.goal.execute({ action: "set", objective: "finish" }, { sessionID: sid3 })
await a.hooks["tool.execute.after"]({ status: "completed", sessionID: sid3, tool: "bash", input: {}, result: "ok" })
idle(a, sid3)
idle(b, sid3)
await sleep(120)
const both = [...a.sent, ...b.sent].filter((x) => x.sessionID === sid3)
assert.equal(both.length, 1, `one continue for one turn end, got ${both.length}`)

// 3. disposing an instance stops its subscription and timers
assert.equal(typeof b.dispose, "function", "setup returns a disposer")
await b.dispose()
const sid4 = "ses_dup4_" + Date.now()
await a.tools.goal.execute({ action: "set", objective: "finish" }, { sessionID: sid4 })
idle(b, sid4)
await sleep(80)
assert.equal(b.sent.filter((x) => x.sessionID === sid4).length, 0, "a disposed instance sends nothing")
console.log("goal children + duplicate instances: ok")
process.exit(0)
