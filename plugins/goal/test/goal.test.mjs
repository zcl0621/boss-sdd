import assert from "node:assert/strict"
process.env.OPENCODE_GOAL_DELAY_MS = "20"
process.env.OPENCODE_GOAL_CHILD_WAIT_MS = "400"
const { default: plugin } = await import(new URL("../goal.js", import.meta.url).href)

// A controllable event stream.
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
const tools = {}
const sent = []
await plugin.setup({
  location: { directory: "/tmp/ck-goal" },
  tool: { hook: async (n, f) => (hooks["tool." + n] = f), transform: async (f) => f({ add: (t) => (tools[t.name] = t) }) },
  session: { hook: async (n, f) => (hooks[n] = f), synthetic: async (x) => sent.push(x) },
  event: { subscribe: () => events },
  model: { list: async () => [] },
  generate: {},
})

const sid = "ses_goal_" + Date.now()
const call = (input) => tools.goal.execute(input, { sessionID: sid })
// 2.0.23: a turn is execution.started ... execution.succeeded; older builds also send session.status idle
const idle = () => {
  emit({ type: "session.execution.started", data: { sessionID: sid } })
  emit({ type: "session.execution.succeeded", data: { sessionID: sid } })
}
const statusIdle = () => emit({ type: "session.status", data: { sessionID: sid, status: { type: "idle" } } })
const toolRan = () => hooks["tool.execute.after"]({ status: "completed", sessionID: sid, tool: "bash", input: {}, result: "ok" })

// 1. tool actions
assert.match((await call({ action: "status" })).content, /no goal/)
assert.match((await call({ action: "set" })).content, /needs `objective`/)
assert.match((await call({ action: "set", objective: "ship feature X" })).content, /goal: active/)

// 2. idle -> continue after delay
idle()
await sleep(80)
assert.equal(sent.length, 1)
statusIdle() // the same turn end reported twice: no second continue
await sleep(80)
assert.equal(sent.length, 1)
assert.ok(sent[0].text.startsWith("<goal-continue>") && sent[0].resume === true && sent[0].sessionID === sid)

// 3. progress resets stalls; two continues with no tool in between pause it
await toolRan()
idle()
await sleep(80)
assert.equal(sent.length, 2) // ran a tool before this idle: continue
idle()
await sleep(80)
assert.equal(sent.length, 3) // first idle with no tool: stall 1, still continues
idle()
await sleep(80)
assert.equal(sent.length, 3) // stall 2: paused
assert.match((await call({ action: "status" })).content, /waiting \(two automatic continues/)
const msg0 = (id, role, text) => ({ id, role, content: [{ type: "text", text }] })
await hooks.context({ sessionID: sid, agent: "build", model: { id: "m", providerID: "p" }, system: [], messages: [msg0("g1", "user", "<goal-continue>The goal is still active</goal-continue>")] })
assert.match((await call({ action: "status" })).content, /waiting/, "a goal-continue message is not the user writing")

// 4. a user message clears waiting
const msg = (id, role, text) => ({ id, role, content: [{ type: "text", text }] })
await hooks.context({ sessionID: sid, agent: "build", model: { id: "m", providerID: "p" }, system: [], messages: [msg("u1", "user", "继续，别停")] })
assert.match((await call({ action: "status" })).content, /goal: active/)

// 5. a server shutdown keeps the goal active; a user interrupt and an error pause it, no continue
emit({ type: "session.execution.started", data: { sessionID: sid } })
emit({ type: "session.execution.interrupted", data: { sessionID: sid, reason: "shutdown" } })
await sleep(80)
assert.equal(sent.length, 3)
assert.match((await call({ action: "status" })).content, /goal: active/, "shutdown is not the user stopping the run")
idle()
emit({ type: "session.execution.interrupted", data: { sessionID: sid, reason: "user" } })
await sleep(80)
assert.equal(sent.length, 3)
assert.match((await call({ action: "status" })).content, /interrupted by the user/)
await hooks.context({ sessionID: sid, agent: "build", model: { id: "m", providerID: "p" }, system: [], messages: [msg("u2", "user", "go on")] })
emit({ type: "session.execution.failed", data: { sessionID: sid, error: { message: "You've reached your 5-hour usage limit" } } })
await sleep(30)
assert.match((await call({ action: "status" })).content, /stopped on an error: .*usage limit/)

// 6. background child running: continue only after the long wait
await hooks.context({ sessionID: sid, agent: "build", model: { id: "m", providerID: "p" }, system: [], messages: [msg("u3", "user", "resume")] })
const bg = [
  msg("u3", "user", "resume"),
  { id: "a1", role: "assistant", content: [{ type: "tool-call", id: "c1", name: "subagent", input: { agent: "implementer", description: "T1", background: true, prompt: "x" } }] },
  { id: "t1", role: "tool", content: [{ type: "tool-result", id: "c1", name: "subagent", result: { type: "text", value: "The subagent is working in the background (sessionID: ses_child1). You will be notified automatically when it finishes." } }] },
]
await hooks.context({ sessionID: sid, agent: "build", model: { id: "m", providerID: "p" }, system: [], messages: bg })
const before = sent.length
await toolRan()
idle()
await sleep(120)
assert.equal(sent.length, before, "no continue while a background child runs")
await sleep(400)
assert.equal(sent.length, before + 1, "fallback continue after the child wait")
// child reports: back to the short delay
bg.push(msg("s1", "user", '<subagent sessionID="ses_child1" state="completed" description="T1">\ndone\n</subagent>'))
await hooks.context({ sessionID: sid, agent: "build", model: { id: "m", providerID: "p" }, system: [], messages: bg })
await toolRan()
idle()
await sleep(80)
assert.equal(sent.length, before + 2)

// 7. complete stops everything
assert.match((await call({ action: "complete" })).content, /needs `evidence`/)
assert.match((await call({ action: "complete", evidence: "plan done, gates green" })).content, /goal: complete/)
idle()
await sleep(80)
assert.equal(sent.length, before + 2)

// 8. state file: goal-continue ids are not recorded as seen user messages; children tracked
const { readFileSync } = await import("node:fs")
const st = JSON.parse(readFileSync(process.env.XDG_STATE_HOME + "/opencode-goal/" + sid + ".json", "utf8"))
assert.ok(!st.seen.includes("g1"))
assert.equal(st.children.ses_child1, "completed")
// 9. a corrupt state file is moved aside, not silently overwritten; null fields fall back to defaults
const { writeFileSync, readdirSync } = await import("node:fs")
const dir = process.env.XDG_STATE_HOME + "/opencode-goal/"
const bad = "ses_goal_bad_" + Date.now()
writeFileSync(dir + bad + ".json", '{"goal": {"objective": "half')
assert.match((await tools.goal.execute({ action: "status" }, { sessionID: bad })).content, /no goal/)
assert.ok(readdirSync(dir).some((n) => n.startsWith(bad + ".json.corrupt-")), "corrupt file kept aside")
const nul = "ses_goal_null_" + Date.now()
writeFileSync(dir + nul + ".json", '{"goal": null, "seen": null, "children": null}')
await hooks.context({ sessionID: nul, agent: "build", model: { id: "m", providerID: "p" }, system: [], messages: [msg("n1", "user", "hi")] })
assert.deepEqual(JSON.parse(readFileSync(dir + nul + ".json", "utf8")).seen, ["n1"])
// every request carries an unfinished goal last, as a synthetic notice; a finished one is not carried
const blk = "ses_block_" + Date.now()
const req = async () => {
  const e = { sessionID: blk, agent: "build", model: { id: "m", providerID: "p" }, system: [], messages: [msg("b1", "user", "go")] }
  await hooks.context(e)
  return e.messages
}
assert.equal((await req()).length, 1)
await tools.goal.execute({ action: "set", objective: "finish the plan" }, { sessionID: blk })
let carried = (await req()).at(-1)
assert.equal(carried.id, undefined)
assert.equal(carried.metadata.synthetic, true)
assert.match(carried.content[0].text, /^<goal>Goal \(active; set [^)]+\): finish the plan\nStanding record of the objective[\s\S]*<\/goal>$/)
await tools.goal.execute({ action: "wait", reason: "needs the deploy key" }, { sessionID: blk })
assert.match((await req()).at(-1).content[0].text, /^<goal>Goal \(waiting: needs the deploy key;[\s\S]*Waiting on the user/)
await tools.goal.execute({ action: "complete", evidence: "all green" }, { sessionID: blk })
assert.equal((await req()).length, 1)
console.log("goal: ok")
process.exit(0)
