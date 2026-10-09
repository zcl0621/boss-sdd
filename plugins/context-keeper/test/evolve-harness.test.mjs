import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
// The evolution harness without a model: fact matching, scoring, prompt assembly, and the accept/reject rules.
const h = await import(new URL("../evolve/evolve.mjs", import.meta.url).href)
const { evolve, leaks } = await import(new URL("../evolve/loop.mjs", import.meta.url).href)

// 1. a changed value: the spelling seen last is expected
assert.equal(h.expected("ssh -p 2222 ... later ... ssh -p 2200", ["-p 2222", "-p 2200"]), "-p 2200")
assert.equal(h.expected("only -p 2222 here", ["-p 2222", "-p 2200"]), "-p 2222")
assert.equal(h.expected("nothing", ["-p 2222"]), undefined)

// 2. scoring is case-insensitive substring presence in the summary
const item = { id: "x#1", update: false, lead: "", transcript: "[User]: hi", skills: ["plan-sdd"], questions: [{ id: "deploy", kind: "commands", facts: ["migrate ENV=staging", "--canary 10"] }, { id: "mark", kind: "id", facts: ["HERON-12"] }] }
const r = h.score(item, "Run MIGRATE env=staging first. heron-12")
assert.deepEqual([r.kept, r.total], [2, 3])
assert.deepEqual(r.lost, [{ question: "deploy", kind: "commands" }])

// 3. the replayed request: transcript, opencode's prompt, fixed requirements, then the slot
const p = h.summaryPrompt(item, { summary: "SLOT-TEXT" })
assert.ok(p.startsWith("[User]: hi"))
assert.match(p, /You MUST summarize the conversation above/)
assert.match(p, /Additional summary requirements/)
assert.ok(p.endsWith("SLOT-TEXT"))
assert.match(h.summaryPrompt({ ...item, update: true, lead: "OLD" }, {}), /^<conversation-checkpoint>\nOLD\n<\/conversation-checkpoint>[\s\S]*Update the existing checkpoint/)

// 4. leak check uses every answer in the bank
assert.deepEqual(leaks("keep ssh ports like -P 2200 and ids"), ["-p 2200"])
assert.deepEqual(leaks("Keep commands that were read from docs verbatim."), [])

// 5. the loop with fake models: scores come from how many "good" words the slot holds
const items = [
  { id: "t#1", split: "train", questions: [] },
  { id: "h#1", split: "holdout", questions: [] },
]
const proposals = [
  "Keep the deploy steps for HERON-12.", // leaks an answer: discarded
  "Keep good things.", // train 1 -> not better than 1: rejected
  "Keep good good things.", // train 2, holdout 0 -> holdout worse: rejected
  "Keep good good good things.", // train 3, holdout 1: accepted
  "Keep crash things.", // the model fails on an item: rejected
]
const good = (slots) => (slots.summary ?? "").split("good").length - 1
const fakeEvaluate = async (its, slots) => {
  const train = its[0]?.split === "train"
  const base = { train: 1, holdout: 1 }
  const g = good(slots)
  const kept = train ? Math.max(base.train, g) : g === 0 ? base.holdout : g === 2 ? 0 : 1
  const failed = (slots.summary ?? "").includes("crash") ? ["t#1"] : []
  return { kept, total: 5, rate: kept / 5, lost: [{ question: "q", kind: "a kind" }], failed }
}
let call = 0
const dir = mkdtempSync(path.join(tmpdir(), "ck-evolve-test-"))
await evolve({
  args: { model: "p/m", rounds: "5" },
  loadItems: () => items,
  pick: (x) => x,
  readSlots: () => ({}),
  evaluate: fakeEvaluate,
  generate: async () => proposals[call++],
  QuotaError: class extends Error {},
  runDir: () => dir,
})
const { readFileSync } = await import("node:fs")
const out = JSON.parse(readFileSync(path.join(dir, "evolved.json"), "utf8"))
assert.equal(out.slots.summary, "Keep good good good things.")
assert.deepEqual(
  out.history.map((x) => x.outcome.split(":")[0]),
  ["discarded", "rejected", "rejected", "accepted", "rejected"],
)
assert.match(out.history[0].outcome, /heron-12/)
assert.match(out.history[4].outcome, /failed on t#1/)
// 6. noise: scores are averaged over --samples, and a gain smaller than --margin is not enough
let calls2 = 0, evals = 0
const noisy = async (its, slots) => {
  evals++
  const g = good(slots)
  // the current text scores 1 or 3 on alternate samples (mean 2); one "good" more scores 2.5 on average
  const kept = its[0]?.split === "holdout" ? 1 : g === 0 ? (evals % 2 ? 1 : 3) : 2.5
  return { kept, total: 5, rate: kept / 5, lost: [], failed: [] }
}
const dir2 = mkdtempSync(path.join(tmpdir(), "ck-evolve-test-"))
await evolve({
  args: { model: "p/m", rounds: "1", samples: "2", margin: "1" },
  loadItems: () => items, pick: (x) => x, readSlots: () => ({}), evaluate: noisy,
  generate: async () => (calls2++, "Keep good things."), QuotaError: class extends Error {}, runDir: () => dir2,
})
const out2 = JSON.parse(readFileSync(path.join(dir2, "evolved.json"), "utf8"))
assert.match(out2.history[0].outcome, /^rejected: train 2.5\/5 vs 2\/5/, "a +0.5 mean gain is below the margin")
assert.equal(evals, 2 * 2 + 2, "baseline train+holdout and the candidate's train, two samples each")
// 7. the pin evaluator: the replayed moment carries the budget notice and the tool description with their
// slots, and only the pinned values are scored
const pp = h.pinPrompt(item, { budget: "BUDGET-SLOT", pin: "PIN-SLOT" })
assert.ok(pp.startsWith("[User]: hi"))
assert.match(pp, /<context-budget>[\s\S]*BUDGET-SLOT/)
assert.match(pp, /pin_context\(key, value\)[\s\S]*PIN-SLOT/)
const pinned = h.pinnedText('Sure:\n[{"key":"deploy","value":"migrate ENV=staging then --canary 10"},{"key":"mark","value":"HERON-12"}]')
assert.deepEqual([h.score(item, pinned).kept, h.score(item, pinned).total], [3, 3])
assert.equal(h.pinnedText("no json here"), "no json here")
console.log("evolve harness: ok")
