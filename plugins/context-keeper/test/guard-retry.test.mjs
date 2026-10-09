import assert from "node:assert/strict"
// A failed model.list() is not cached: the next dispatch asks again and keeps a registry model.
delete process.env.CONTEXT_KEEPER_SUBAGENT_MODELS
delete process.env.CONTEXT_KEEPER_MODEL_MAP
const { default: plugin } = await import(new URL("../context-keeper.js?retry=" + Date.now(), import.meta.url).href)
const hooks = {}
let calls = 0
const list = async () => {
  if (calls++ === 0) throw new Error("registry not ready")
  return { data: [{ id: "k3", providerID: "kimi-code-plan-cn" }] }
}
await plugin.setup({ location: { directory: "/tmp" }, tool: { hook: async (n, f) => (hooks[n] = f), transform: async () => {} }, session: { hook: async () => {} }, model: { list }, generate: {} })
const run = async (model) => { const e = { tool: "subagent", input: { agent: "reviewer", model } }; await hooks["execute.before"](e); return e.input.model }
assert.equal(await run("kimi-code-plan-cn/k3"), undefined, "first dispatch: list failed, model dropped")
assert.equal(await run("kimi-code-plan-cn/k3"), "kimi-code-plan-cn/k3", "second dispatch: list retried")
assert.equal(calls, 2)
console.log("model guard retries a failed list: ok")
