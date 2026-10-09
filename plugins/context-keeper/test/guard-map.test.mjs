import assert from "node:assert/strict"
process.env.CONTEXT_KEEPER_MODEL_MAP = "opus=kimi-code-plan-cn/k3, haiku=kimi-code-plan-cn/kimi-for-coding-highspeed"
process.env.CONTEXT_KEEPER_SUBAGENT_MODELS = "kimi-code-plan-cn/*"
const plugin = (await import(new URL("../context-keeper.js?guard", import.meta.url).href)).default
const hooks = {}
await plugin.setup({ location: { directory: "/tmp" }, tool: { hook: async (n, f) => (hooks[n] = f), transform: async () => {} }, session: { hook: async () => {} }, model: {}, generate: {} })
const run = async (model) => { const e = { tool: "subagent", input: { agent: "reviewer", model } }; await hooks["execute.before"](e); return e.input.model }
assert.equal(await run("haiku"), "kimi-code-plan-cn/kimi-for-coding-highspeed")
assert.equal(await run("anthropic/claude-opus"), undefined)
assert.equal(await run("opus"), "kimi-code-plan-cn/k3")
assert.equal(await run("opencode/space-bunny-free#low"), undefined)
assert.equal(await run("kimi-code-plan-cn/k3-256k"), "kimi-code-plan-cn/k3-256k")
assert.equal(await run("sonnet"), undefined)
console.log("model guard: ok")
