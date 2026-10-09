// The evolution loop for one slot (default: summary, the compaction guidance).
//
// Each round: a proposer model sees the fixed prompt (read-only), the current slot text, its length limit, and
// which KINDS of facts the summaries lost on the training items, never the facts themselves. Its candidate must
// pass the plugin's own slot check and must not contain any answer from the question bank; a candidate that does
// is discarded unscored. A candidate replaces the current text only when it keeps more facts on the training
// items AND no fewer on the holdout items. Every round is logged; the result is written, not installed.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { SLOT_LIMITS, checkSlots, EXTRA_REQUIREMENTS, BUDGET_NUDGE } from "../context-keeper.js"
import { PIN_DESCRIPTION } from "../../pin/pin.js"
import { buildCompactionPrompt } from "./opencode-prompt.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BANK = JSON.parse(readFileSync(path.join(HERE, "questions.json"), "utf8"))
const ANSWERS = Object.values(BANK.families)
  .flatMap((f) => f.questions.flatMap((q) => q.facts.flat()))
  .map((s) => s.toLowerCase())

export function leaks(text) {
  const low = text.toLowerCase()
  return ANSWERS.filter((a) => low.includes(a))
}

const proposerPrompt = ({ slot, current, limit, result, history }) => {
  const byKind = {}
  for (const l of result.lost) byKind[l.kind] = (byKind[l.kind] ?? 0) + 1
  const lost = Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `- ${n}× ${k}`)
    .join("\n")
  const tried = history
    .filter((h) => h.candidate)
    .slice(-4)
    .map((h) => `- (${h.outcome}) ${h.candidate}`)
    .join("\n")
  const intro =
    slot === "summary"
      ? `You improve one part of the instructions a coding agent's conversation is summarized with when its context is compacted. After compaction the agent continues the work from the summary alone, so facts it needs and cannot easily look up again must survive.

The instructions are opencode's compaction prompt followed by these additional requirements. Both are fixed; you cannot change them:
<fixed>
${buildCompactionPrompt(false)}

${EXTRA_REQUIREMENTS(["<skill names>"], {})}
</fixed>

You write the "${slot}" guidance, appended right after the additional requirements.`
      : `You improve one part of what a coding agent is told when its context is filling up. At that point it may call pin_context to save facts verbatim; pins survive compaction, while everything else is summarized. The score below is how many of the facts the agent needed later were in its pins.

The fixed texts, which you cannot change: the tool description
<fixed>
${PIN_DESCRIPTION()}
</fixed>
and the budget notice
<fixed>
${BUDGET_NUDGE({ used: 100000, window: 200000, level: 50, cleared: 0, pin: true }, {})}
</fixed>

You write the "${slot}" guidance, appended to the ${slot === "pin" ? "tool description" : "budget notice"}.`
  return `${intro} Current text${current ? "" : " (empty)"}:
<current>
${current}
</current>

On the training conversations the ${slot === "summary" ? "summaries" : "pins"} kept ${result.kept} of ${result.total} facts the agent needed later. Facts lost, by kind:
${lost || "- (none)"}
${tried ? `\nEarlier candidates and what happened to them:\n${tried}\n` : ""}
Write a replacement for the current text. Rules:
- At most ${limit} characters. Shorter is better; every sentence must earn its place.
- General guidance that would help on any project. Do not name hosts, IPs, ports, ticket ids, branch names, file paths, markers or other concrete values; a candidate containing a concrete value from the test conversations is discarded.
- Do not restate what the fixed text already says; add what it is missing or sharpen it where summaries still fail.
- No "<" or ">" characters.
Reply with the new text only, no quotes, no commentary.`
}

export async function evolve({ args, loadItems, pick, readSlots, evaluate, generate, QuotaError, runDir }) {
  const slot = args.slot ?? "summary"
  if (!["summary", "budget", "pin"].includes(slot)) throw new Error(`no offline evaluator for the "${slot}" slot`)
  const kind = slot === "summary" ? "summary" : "pin"
  if (!args.model) throw new Error("--model provider/model is required")
  const proposer = args.proposer ?? args.model
  const rounds = Number(args.rounds ?? 3)
  // One sample at non-zero temperature is noisy: every score is the mean of --samples runs, and a candidate must
  // beat the current text on training items by at least --margin facts on average.
  const samples = Math.max(1, Number(args.samples ?? 2))
  const margin = Number(args.margin ?? 1)
  const evalN = async (items, slots, model, logFn) => {
    let kept = 0, total = 0
    const lost = [], failed = new Set()
    for (let i = 0; i < samples; i++) {
      const r = await evaluate(items, slots, model, (x) => logFn({ sample: i + 1, ...x }), kind)
      kept += r.kept
      total = r.total
      lost.push(...r.lost)
      for (const f of r.failed) failed.add(f)
    }
    return { kept: kept / samples, total, rate: total ? kept / samples / total : 0, lost, failed: [...failed] }
  }
  const limit = SLOT_LIMITS[slot]
  const dir = runDir()
  const log = (x) => appendFileSync(path.join(dir, "evolve.jsonl"), JSON.stringify(x) + "\n")
  const say = (s) => (console.log(s), appendFileSync(path.join(dir, "evolve.txt"), s + "\n"))

  const all = loadItems()
  let train = pick(all.filter((i) => i.split === "train"))
  let holdout = pick(all.filter((i) => i.split === "holdout"))
  // An empty holdout would make the "not worse on holdout" guard pass vacuously.
  if (!train.length || !holdout.length) throw new Error(`need both splits; got train ${train.length}, holdout ${holdout.length} (check --split/--items/--limit)`)
  let slots = readSlots(args.slots)
  say(`slot ${slot} (limit ${limit}); train ${train.length} items, holdout ${holdout.length}; model ${args.model}, proposer ${proposer}; ${samples} samples, margin ${margin}`)

  const history = []
  try {
    let cur = await evalN(train, slots, args.model, (x) => log({ phase: "baseline-train", ...x }))
    let curHold = await evalN(holdout, slots, args.model, (x) => log({ phase: "baseline-holdout", ...x }))
    // Items the model could not take at baseline are left out of every comparison.
    const dropped = [...cur.failed, ...curHold.failed]
    if (dropped.length) {
      train = train.filter((i) => !dropped.includes(i.id))
      holdout = holdout.filter((i) => !dropped.includes(i.id))
      say(`left out (failed at baseline): ${dropped.join(", ")}`)
    }
    say(`start: train ${cur.kept}/${cur.total}, holdout ${curHold.kept}/${curHold.total}`)
    for (let r = 1; r <= rounds; r++) {
      const raw = (await generate(proposer, proposerPrompt({ slot, current: slots[slot] ?? "", limit, result: cur, history }))).trim()
      const { slots: checked, rejected } = checkSlots({ slots: { [slot]: raw } })
      const leaked = leaks(raw)
      if (rejected.length || leaked.length || !checked[slot]) {
        const why = rejected.length ? `failed the slot check (${raw.length} chars, limit ${limit}, or contains "<")` : leaked.length ? `contains test values: ${leaked.join(", ")}` : "empty"
        history.push({ round: r, candidate: raw.slice(0, 300), outcome: `discarded: ${why}` })
        log({ phase: "candidate", round: r, candidate: raw, outcome: "discarded", why })
        say(`round ${r}: discarded, ${why}`)
        continue
      }
      const cand = { ...slots, [slot]: checked[slot] }
      const t = await evalN(train, cand, args.model, (x) => log({ phase: `round${r}-train`, ...x }))
      if (t.failed.length) {
        history.push({ round: r, candidate: checked[slot], outcome: `rejected: failed on ${t.failed.join(", ")}` })
        log({ phase: "candidate", round: r, candidate: checked[slot], outcome: "rejected-error", failed: t.failed })
        say(`round ${r}: rejected, the model failed on ${t.failed.join(", ")}`)
        continue
      }
      if (t.kept < cur.kept + margin) {
        history.push({ round: r, candidate: checked[slot], outcome: `rejected: train ${t.kept}/${t.total} vs ${cur.kept}/${cur.total}` })
        log({ phase: "candidate", round: r, candidate: checked[slot], outcome: "rejected-train", train: t.kept })
        say(`round ${r}: rejected, train ${t.kept}/${t.total} (current ${cur.kept}/${cur.total})`)
        continue
      }
      const h = await evalN(holdout, cand, args.model, (x) => log({ phase: `round${r}-holdout`, ...x }))
      if (h.failed.length || h.kept < curHold.kept) {
        history.push({ round: r, candidate: checked[slot], outcome: `rejected: better on train but holdout ${h.kept}/${h.total} vs ${curHold.kept}/${curHold.total}` })
        log({ phase: "candidate", round: r, candidate: checked[slot], outcome: "rejected-holdout", train: t.kept, holdout: h.kept })
        say(`round ${r}: rejected on holdout, train ${t.kept}/${t.total}, holdout ${h.kept}/${h.total} (current ${curHold.kept}/${curHold.total})`)
        continue
      }
      slots = cand
      cur = t
      curHold = h
      history.push({ round: r, candidate: checked[slot], outcome: `accepted: train ${t.kept}/${t.total}, holdout ${h.kept}/${h.total}` })
      log({ phase: "candidate", round: r, candidate: checked[slot], outcome: "accepted", train: t.kept, holdout: h.kept })
      say(`round ${r}: accepted, train ${t.kept}/${t.total}, holdout ${h.kept}/${h.total}`)
    }
  } catch (e) {
    if (!(e instanceof QuotaError)) throw e
    say(`stopped on quota: ${e.message}`)
  }
  const out = { slots, model: args.model, at: new Date().toISOString(), history }
  writeFileSync(path.join(dir, "evolved.json"), JSON.stringify(out, null, 2))
  say(`written ${path.join(dir, "evolved.json")} (not installed; copy it to ~/.config/opencode/context-keeper/evolved.json to use it)`)
}
