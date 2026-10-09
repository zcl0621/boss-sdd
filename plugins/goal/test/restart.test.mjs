import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
// After a restart: an active goal in a quiet session is resumed, and a child that never reported is written off
// instead of holding every continue for the full child wait.
process.env.OPENCODE_GOAL_DELAY_MS = "20"
process.env.OPENCODE_GOAL_CHILD_WAIT_MS = "400"
process.env.OPENCODE_GOAL_RESUME_AFTER_MS = "50"
const dir = path.join(process.env.XDG_STATE_HOME, "opencode-goal")
mkdirSync(dir, { recursive: true })
const directory = "/tmp/ck-goal-restart"
const quiet = "ses_restart_quiet_" + Date.now()
const busy = "ses_restart_busy_" + Date.now()
const goal = { objective: "finish", status: "active", directory, setAt: 1, at: 1, continues: 3, tools: 0, stalls: 1 }
writeFileSync(path.join(dir, quiet + ".json"), JSON.stringify({ goal, seen: [], children: { ses_lost: "running" }, childSince: { ses_lost: 1 } }))
writeFileSync(path.join(dir, busy + ".json"), JSON.stringify({ goal, seen: [], children: {}, childSince: {} }))

const queue = []
let wake
const events = { async *[Symbol.asyncIterator]() { for (;;) { while (queue.length) yield queue.shift(); await new Promise((r) => (wake = r)) } } }
const emit = (ev) => (queue.push(ev), wake?.())
const sent = []
const { default: plugin } = await import(new URL("../goal.js?restart", import.meta.url).href)
await plugin.setup({
  location: { directory },
  tool: { hook: async () => {}, transform: async (f) => f({ add: () => {} }) },
  session: { hook: async () => {}, synthetic: async (x) => sent.push(x) },
  event: { subscribe: () => events },
  model: { list: async () => [] },
  generate: {},
})
// The resumed turn of `busy` is reported by the server, so the plugin leaves it to the normal turn-end path.
emit({ type: "session.execution.started", data: { sessionID: busy } })
await new Promise((r) => setTimeout(r, 200))
assert.deepEqual(sent.map((x) => x.sessionID), [quiet], "only the quiet session is resumed")
const st = JSON.parse(readFileSync(path.join(dir, quiet + ".json"), "utf8"))
assert.equal(st.children.ses_lost, "unreported")
assert.equal(st.goal.stalls, 1, "a restart is not counted as a stall")
console.log("goal restart: ok")
process.exit(0)
