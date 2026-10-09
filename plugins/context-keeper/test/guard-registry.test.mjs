import assert from "node:assert/strict"
// No env allowlist, no map: the company setup, where plan-sdd passes registry-validated models.
delete process.env.CONTEXT_KEEPER_SUBAGENT_MODELS
delete process.env.CONTEXT_KEEPER_MODEL_MAP
const { default: plugin } = await import(new URL("../context-keeper.js?v=" + Date.now(), import.meta.url).href)
const hooks = {}
const list = async () => ({ data: [{ id: "k3", providerID: "kimi-code-plan-cn" }, { id: "gpt-5.6", providerID: "openai" }] })
await plugin.setup({ location: { directory: "/tmp" }, tool: { hook: async (n, f) => (hooks[n] = f), transform: async () => {} }, session: { hook: async () => {} }, model: { list }, generate: {} })
const run = async (model) => { const e = { tool: "subagent", input: { agent: "reviewer", model } }; await hooks["execute.before"](e); return e.input.model }
assert.equal(await run("kimi-code-plan-cn/k3"), "kimi-code-plan-cn/k3")
assert.equal(await run("openai/gpt-5.6#high"), "openai/gpt-5.6#high")
assert.equal(await run("haiku"), undefined)
assert.equal(await run("anthropic/claude-opus"), undefined)
console.log("model guard, registry models kept: ok")
