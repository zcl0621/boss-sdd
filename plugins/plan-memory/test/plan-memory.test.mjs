import assert from "node:assert/strict"
const { default: plugin, boardCalls, LIMITS } = await import(new URL("../plan-memory.js?t=" + Date.now(), import.meta.url).href)
const hooks = {}
await plugin.setup({
  tool: { hook: async (n, f) => (hooks["tool." + n] = f) },
  session: { hook: async (n, f) => (hooks[n] = f) },
})
const sid = "ses_mem_" + Date.now()
const ran = (tool, input, status = "completed") => hooks["tool.execute.after"]({ sessionID: sid, tool, input, status, result: "ok" })
const mcp = (name, input = {}) => ran(`plan-sdd_${name}`, input)
const exec = (code) => ran("execute", { code })
const note = async () => {
  const e = { sessionID: sid, messages: [{ id: "u0", role: "user", content: [{ type: "text", text: "go" }] }] }
  await hooks.context(e)
  if (e.messages.length === 1) return ""
  const last = e.messages.at(-1)
  assert.equal(last.id, undefined)
  assert.equal(last.metadata.synthetic, true)
  return last.content[0].text
}

// board calls are the "plan-sdd_plan_…" tool events; the wrapping execute event (code mode) is not counted again
assert.deepEqual(boardCalls("plan-sdd_plan_memory_list", { project: "/p" }).map((c) => c[0]), ["plan_memory_list"])
assert.deepEqual(boardCalls("execute", { code: 'await tools["plan-sdd"].plan_memory_list({ project: "/p" })' }), [])
assert.deepEqual(boardCalls("read", { path: "plan_memory_list" }), [])

// no run on the board yet: nothing
assert.equal(await note(), "")

// read: a run exists and memory was not listed; a failed list call does not count
await mcp("plan_create_run", { project: "/p", title: "t" })
assert.match(await note(), /^<memory>Project memory has not been read for this run: call plan_memory_list/)
await mcp("plan_memory_list", { project: "/p" }).then(() => {})
assert.equal(await note(), "")

// write: recon dispatched + graph written + nothing filed -> shown a few times, then dropped
await ran("subagent", { agent: "recon", description: "recon", prompt: "..." })
await mcp("plan_set_tasks", { run: "r", tasks: [{ id: "T1", status: "pending" }, { id: "T2", status: "pending" }] })
for (let i = 0; i < LIMITS.writeShows; i++) assert.match(await note(), /nothing was filed in project memory/)
assert.equal(await note(), "")

// filing something also clears it (fresh run)
await mcp("plan_create_run", { project: "/p" })
await mcp("plan_memory_list", { project: "/p" })
await ran("subagent", { agent: "recon" })
await mcp("plan_set_tasks", { run: "r", tasks: [{ id: "T1", status: "pending" }] })
assert.match(await note(), /nothing was filed/)
await mcp("plan_memory_add", { project: "/p", key: "gate.test", value: "npm test", kind: "gate", source: "package.json" })
assert.equal(await note(), "")

// tidy: five tasks reach done/blocked after the last listing; listing again clears it
for (const s of ["done", "done", "blocked", "done"]) await mcp("plan_set_task", { run: "r", task: { id: "T", status: s } })
assert.equal(await note(), "")
// in code mode the execute event comes too, and must not count the same call twice
await exec(`await tools["plan-sdd"].plan_set_task({ run: "r", task: { id: "T5", status: "done" } })`)
assert.equal(await note(), "")
await mcp("plan_set_task", { run: "r", task: { id: "T5", status: "done" } })
assert.match(await note(), /tidy-up is due \(5 tasks reached done\/blocked since memory was last listed\)/)
await mcp("plan_memory_list", { project: "/p" })
assert.equal(await note(), "")

// tidy at close-out: the run moves to review
await mcp("plan_update_run", { run: "r", status: "review" })
assert.match(await note(), /tidy-up is due \(the run is closing out\)/)
await mcp("plan_memory_list", { project: "/p" })
assert.equal(await note(), "")

// listing memory before creating the run (phase 0 order in practice) counts as read for that run
await mcp("plan_update_run", { run: "r", status: "done" })
assert.equal(await note(), "", "a finished run carries no reminders")
await mcp("plan_memory_list", { project: "/p" })
await mcp("plan_create_run", { project: "/p", title: "second" })
assert.equal(await note(), "", "memory read just before plan_create_run")
// after a run is done, the next run must read memory again
await mcp("plan_update_run", { run: "r2", status: "done" })
await mcp("plan_create_run", { project: "/p", title: "third" })
assert.match(await note(), /has not been read for this run/)
await mcp("plan_memory_list", { project: "/p" })

// a call that did not complete changes nothing: a failed create_run does not reopen the read reminder
await ran("plan-sdd_plan_create_run", { project: "/q" }, "error")
assert.equal(await note(), "")
console.log("plan-memory: ok")
