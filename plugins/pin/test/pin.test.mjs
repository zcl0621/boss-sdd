import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
const { default: plugin, LIMITS } = await import(new URL("../pin.js?t=" + Date.now(), import.meta.url).href)
const hooks = {}
const tools = {}
await plugin.setup({
  location: { directory: "/tmp/pin" },
  tool: { hook: async () => {}, transform: async (f) => f({ add: (t) => (tools[t.name] = t) }) },
  session: { hook: async (n, f) => (hooks[n] = f) },
})
const sid = "ses_pins_" + Date.now()
const pin = (input) => tools.pin_context.execute(input, { sessionID: sid }).then((r) => r.content)
const request = async (id = sid) => {
  const e = { sessionID: id, agent: "plan-sdd", system: [], messages: [{ id: "u0", role: "user", content: [{ type: "text", text: "go" }] }] }
  await hooks.context(e)
  return e.messages
}

// no pins: nothing is added to the request
assert.equal((await request()).length, 1)

// pin, then every request carries the block last, as a synthetic notice without an id
assert.match(await pin({ key: "worktree", value: "../app-worktrees/T1" }), /pinned "worktree". 1 pin\(s\)/)
let msgs = await request()
assert.equal(msgs.length, 2)
const last = msgs.at(-1)
assert.equal(last.role, "user")
assert.equal(last.id, undefined)
assert.equal(last.metadata.synthetic, true)
assert.match(last.content[0].text, /^<pins>Your pinned facts \(1\/30\)[\s\S]*\n- worktree \(pinned <1h ago\): \.\.\/app-worktrees\/T1\n<\/pins>$/)

// one call removes several pins and sets another
for (let i = 0; i < 5; i++) await pin({ key: `log${i}-findings`, value: `log ${i}: timeouts` })
const out = await pin({ key: "decision", value: "use optimistic locking", remove: ["log0-findings", "log1-findings", "log2-findings", "missing"] })
assert.match(out, /^removed "log0-findings"; removed "log1-findings"; removed "log2-findings"; pinned "decision". 4 pin\(s\)/)
const block = (await request()).at(-1).content[0].text
assert.doesNotMatch(block, /log[012]-findings|missing/)
assert.match(block, /- log3-findings[\s\S]*- decision \(pinned <1h ago\): use optimistic locking/)

// an empty value still removes; calls without key or remove are rejected
assert.match(await pin({ key: "decision", value: "" }), /removed "decision"/)
assert.match(await pin({}), /Nothing to do/)
assert.match(await pin({ key: "x" }), /No value for "x"/)

// at the cap, new keys are refused but updates and removals still work
for (let i = 0; i < LIMITS.pins - 3; i++) await pin({ key: `k${i}`, value: "v" })
assert.match(await pin({ key: "one-more", value: "v" }), /refused "one-more": already 30 pins/)
assert.match(await pin({ key: "worktree", value: "../app-worktrees/T2" }), /updated "worktree"/)
assert.match(await pin({ key: "one-more", value: "v", remove: ["k0"] }), /removed "k0"; pinned "one-more"/)
assert.equal(tools.pin_context.input.properties.value.maxLength, LIMITS.value)

// a session that pinned with an older context-keeper keeps its pins
const old = "ses_legacy_" + Date.now()
const keeperDir = path.join(process.env.XDG_STATE_HOME, "opencode-context-keeper")
mkdirSync(keeperDir, { recursive: true })
writeFileSync(path.join(keeperDir, `${old}.json`), JSON.stringify({ pins: { deploy: { value: "make deploy ENV=staging", at: Date.now() - 3 * 86_400_000 }, plain: "string pin" } }))
const legacy = (await request(old)).at(-1).content[0].text
assert.match(legacy, /- deploy \(pinned 3d ago\): make deploy ENV=staging/)
assert.match(legacy, /- plain \(pinned <1h ago\): string pin/)
console.log("pin plugin: ok")
