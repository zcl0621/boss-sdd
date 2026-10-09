#!/usr/bin/env node
// Evolution harness for context-keeper's evolvable guidance (see SLOT_LIMITS in ../context-keeper.js).
//
// Replays real compactions offline: for each completed compaction in the opencode database, rebuild the history
// the summary request saw, send it with opencode's own compaction prompt plus context-keeper's summary
// requirements (fixed part + the candidate slot), and count how many recall facts the new summary keeps.
// One model request per compaction point and candidate; no tools, no agent loop.
//
//   node evolve.mjs items                      list the compaction points and their eligible questions
//   node evolve.mjs stored                     score the summaries opencode stored at the time (free)
//   node evolve.mjs eval  --model P/M [--slot summary|budget|pin] [--slots f.json] [--split train|holdout|all] [--items id,id] [--limit N] [--max-chars N]
//   node evolve.mjs evolve --model P/M [--slot summary|budget|pin] [--proposer P/M] [--rounds N] [--samples N] [--margin F] [--slots f.json] [--items id,id] [--limit N]
//   add --via deepseek to call DeepSeek directly (DEEPSEEK_API_KEY), or
//   add --via run for OpenCode's free models (through `opencode run`; tests the harness, adds the agent's prompt)
//
// Models go through the running opencode service (POST /api/experimental/generate, stateless), so they use the
// providers configured there. OpenCode's free models refuse that route; use a subscription model.
// Results go to evolve/runs/<timestamp>/. Nothing is installed: copy a winning evolved.json by hand.
import { execFileSync } from "node:child_process"
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { BUDGET_NUDGE, checkSlots, EXTRA_REQUIREMENTS } from "../context-keeper.js"
import { PIN_DESCRIPTION } from "../../pin/pin.js"
import { buildCompactionPrompt } from "./opencode-prompt.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DB = process.env.OPENCODE_DB || path.join(homedir(), ".local", "share", "opencode", "opencode.db")
const BANK = JSON.parse(readFileSync(path.join(HERE, "questions.json"), "utf8"))

// ---------- args ----------
const [cmd, ...rest] = process.argv.slice(2)
const args = {}
for (let i = 0; i < rest.length; i++)
  if (rest[i].startsWith("--")) args[rest[i].slice(2)] = rest[i + 1]?.startsWith("--") || rest[i + 1] === undefined ? true : rest[++i]

// ---------- items ----------
const familyOf = (title) =>
  Object.entries(BANK.families).find(([, f]) => f.titles.some((p) => title.startsWith(p)))?.[0]

const textParts = (content) => (Array.isArray(content) ? content.filter((p) => p?.type === "text").map((p) => p.text).join("\n") : "")

// opencode's flattened transcript format (session/compaction.ts flattenMessage), without the tool-output cut that
// only applies when the history does not fit.
const render = (row) => {
  const d = JSON.parse(row.data)
  if (row.type === "user" || row.type === "synthetic") return d.text ? `[User]: ${d.text}` : ""
  if (row.type !== "assistant") return ""
  const out = []
  for (const p of d.content ?? []) {
    if (p.type === "text" && p.text) out.push(`[Assistant]: ${p.text}`)
    if (p.type !== "tool") continue
    const st = p.state ?? {}
    out.push(`[Assistant tool call]: ${p.name}(${JSON.stringify(st.input ?? {})})`)
    if (st.status === "completed") out.push(`[Tool result]: ${textParts(st.content) || JSON.stringify(st.output ?? "")}`)
    else if (st.status === "error") out.push(`[Tool error]: ${st.error?.message ?? JSON.stringify(st.error ?? "")}`)
  }
  return out.join("\n")
}

const skillsIn = (rows) => {
  const names = new Set()
  for (const r of rows) {
    if (r.type !== "assistant") continue
    for (const p of JSON.parse(r.data).content ?? []) if (p.type === "tool" && p.name === "skill" && p.state?.input?.id) names.add(p.state.input.id)
  }
  return [...names]
}

// Expected spelling of a fact (exported for tests): of the spellings present in the history, the one that appears last.
export const expected = (history, spellings) => {
  const low = history.toLowerCase()
  let best
  let at = -1
  for (const s of spellings) {
    const i = low.lastIndexOf(s.toLowerCase())
    if (i > at) (at = i), (best = s)
  }
  return best
}

const isHoldout = (title) => (BANK.holdout ?? []).some((p) => title.startsWith(p))

export function loadItems() {
  const db = new DatabaseSync(DB, { readOnly: true })
  const sessions = db.prepare("select id, title from session_v2 order by time_created").all()
  const items = []
  for (const s of sessions) {
    const family = familyOf(s.title ?? "")
    if (!family) continue
    const rows = db.prepare("select seq, type, data from session_message where session_id = ? order by seq").all(s.id)
    let lead = ""
    let buf = []
    let n = 0
    for (const row of rows) {
      if (row.type !== "compaction") {
        buf.push(row)
        continue
      }
      const d = JSON.parse(row.data)
      if (d.status !== "completed" || !d.summary) continue
      n++
      const transcript = buf.map(render).filter(Boolean).join("\n\n")
      const history = `${lead}\n${transcript}`
      const questions = []
      for (const q of BANK.families[family].questions) {
        const facts = q.facts.map((sp) => expected(history, sp))
        if (facts.every(Boolean)) questions.push({ id: q.id, kind: q.kind, facts })
      }
      if (questions.length)
        items.push({
          id: `${s.title}#${n}`,
          session: s.id,
          family,
          split: isHoldout(s.title) ? "holdout" : "train",
          update: !!lead,
          lead,
          transcript,
          skills: skillsIn(buf),
          stored: d.summary,
          questions,
        })
      lead = d.summary
      buf = []
    }
  }
  db.close()
  return items
}

// ---------- scoring ----------
export function score(item, summary) {
  const low = (summary ?? "").toLowerCase()
  const lost = []
  let kept = 0
  let total = 0
  for (const q of item.questions)
    for (const f of q.facts) {
      total++
      if (low.includes(f.toLowerCase())) kept++
      else lost.push({ question: q.id, kind: q.kind })
    }
  return { kept, total, lost }
}

export const summaryPrompt = (item, slots) =>
  [
    item.update ? `<conversation-checkpoint>\n${item.lead}\n</conversation-checkpoint>` : "",
    item.transcript,
    buildCompactionPrompt(item.update),
    EXTRA_REQUIREMENTS(item.skills, slots),
  ]
    .filter(Boolean)
    .join("\n\n")

// The budget and pin slots act before compaction: at the budget nudge the model decides what to pin, and pins
// are what survives verbatim. Replay that moment on the same transcript and score the pinned values on the same
// questions the summary is scored on.
export const pinPrompt = (item, slots) =>
  [
    item.update ? `<conversation-checkpoint>\n${item.lead}\n</conversation-checkpoint>` : "",
    item.transcript,
    `You have a tool pin_context(key, value). Its description: ${PIN_DESCRIPTION(slots.pin)}`,
    BUDGET_NUDGE({ used: Math.round(item.transcript.length / 4), window: 200_000, level: 50, cleared: 0, pin: true }, slots),
    'Reply with the pin_context calls you would make now, as a JSON array of {"key": "...", "value": "..."} objects, and nothing else.',
  ]
    .filter(Boolean)
    .join("\n\n")

// The pinned values, as the restored block would carry them; unparsable output scores as written.
export const pinnedText = (reply) => {
  const m = reply.match(/\[[\s\S]*\]/)
  try {
    const pins = JSON.parse(m ? m[0] : reply)
    if (Array.isArray(pins)) return pins.map((p) => `${p?.key ?? ""}: ${String(p?.value ?? "").slice(0, 1500)}`).join("\n")
  } catch {}
  return reply
}

// ---------- model calls ----------
let service
const serviceInfo = () => {
  if (service) return service
  const url = execFileSync("opencode", ["service", "status"], { encoding: "utf8" }).trim().split(/\s+/).find((w) => w.startsWith("http"))
  const { password } = JSON.parse(readFileSync(path.join(homedir(), ".config", "opencode", "service.json"), "utf8"))
  if (!url) throw new Error("opencode service is not running (opencode service status printed no URL)")
  service = { url, auth: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
  return service
}
const modelRef = (spec) => {
  const [pm, variant] = spec.split("#")
  const i = pm.indexOf("/")
  return { providerID: pm.slice(0, i), id: pm.slice(i + 1), ...(variant ? { variant } : {}) }
}
export class QuotaError extends Error {}
const quota = /usage limit|quota will reset|insufficient balance|rate limit/i

// --via run: through `opencode run` with the build agent, for OpenCode's free models, which refuse the generate
// route and custom agents. It carries the agent's system prompt and tools, so use it to test the harness, not to
// score candidates.
const RUN_DIR = path.join(tmpdir(), "ck-evolve-run")
function generateViaRun(modelSpec, prompt) {
  mkdirSync(RUN_DIR, { recursive: true })
  try {
    execFileSync("git", ["init", "-q"], { cwd: RUN_DIR })
  } catch {}
  const file = path.join(RUN_DIR, "prompt.txt")
  writeFileSync(file, prompt)
  let out = ""
  let failed = false
  try {
    out = execFileSync("opencode", ["run", "-m", modelSpec, "--format", "json", "--file", file, "Do exactly what the attached file asks, using only its content. Do not call any tools. Reply with the requested text only."], { cwd: RUN_DIR, encoding: "utf8", timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 })
  } catch (e) {
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`
    failed = true
  }
  const texts = out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).filter((e) => e.type === "text")
  // Only a failed run is checked for quota wording; a summary may legitimately mention "rate limit".
  if ((failed || !texts.length) && quota.test(out)) throw new QuotaError(out.slice(-300))
  if (!texts.length) throw new Error(`opencode run returned no text: ${out.slice(-300)}`)
  return texts.at(-1).part.text
}

// --via deepseek: DeepSeek's API directly (OpenAI-compatible), key from DEEPSEEK_API_KEY. --model deepseek/<id>.
// Every call's token usage is added to `usage` and logged, so a run reports what it spent.
export const usage = { calls: 0, prompt: 0, cacheHit: 0, completion: 0 }
async function generateViaDeepSeek(modelSpec, prompt) {
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) throw new Error("DEEPSEEK_API_KEY is not set")
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: modelSpec.replace(/^deepseek\//, ""), messages: [{ role: "user", content: prompt }], max_tokens: 8192, temperature: 0.3 }),
  })
  const body = await res.text()
  if (res.status === 402 || (!res.ok && quota.test(body))) throw new QuotaError(body.slice(0, 300))
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`)
  const d = JSON.parse(body)
  usage.calls++
  usage.prompt += d.usage?.prompt_tokens ?? 0
  usage.cacheHit += d.usage?.prompt_cache_hit_tokens ?? 0
  usage.completion += d.usage?.completion_tokens ?? 0
  return d.choices[0].message.content
}

export async function generate(modelSpec, prompt) {
  if (args.via === "run") return generateViaRun(modelSpec, prompt)
  if (args.via === "deepseek") return generateViaDeepSeek(modelSpec, prompt)
  const { url, auth } = serviceInfo()
  const res = await fetch(new URL("/api/experimental/generate", url), {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ prompt, model: modelRef(modelSpec) }),
  })
  const body = await res.text()
  if (!res.ok && quota.test(body)) throw new QuotaError(body.slice(0, 300))
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`)
  return JSON.parse(body).data.text
}

// ---------- runs ----------
const runDir = () => {
  const d = path.join(HERE, "runs", new Date().toISOString().replace(/[:.]/g, "-"))
  mkdirSync(d, { recursive: true })
  return d
}
const pick = (items) => {
  let out = items
  if (args.split && args.split !== "all") out = out.filter((i) => i.split === args.split)
  if (args["max-chars"]) out = out.filter((i) => summaryPrompt(i, {}).length <= Number(args["max-chars"]))
  if (args.only) out = out.filter((i) => i.id.includes(args.only))
  if (args.items) {
    const want = new Set(String(args.items).split(","))
    out = out.filter((i) => want.has(i.id))
  }
  if (args.limit) out = out.slice(0, Number(args.limit))
  return out
}
const readSlots = (file) => {
  if (!file) return {}
  const { slots, rejected } = checkSlots(JSON.parse(readFileSync(file, "utf8")))
  if (rejected.length) throw new Error(`slots rejected by the plugin's own check: ${rejected.join(", ")}`)
  return slots
}

// An item the model cannot take (too long for its window, provider error) is reported in `failed`, not scored.
// Quota errors still stop the whole run.
export async function evaluate(items, slots, model, log, kind = "summary") {
  let kept = 0
  let total = 0
  const lost = []
  const failed = []
  for (const it of items) {
    const prompt = kind === "pin" ? pinPrompt(it, slots) : summaryPrompt(it, slots)
    const t0 = Date.now()
    let summary
    try {
      summary = await generate(model, prompt)
    } catch (e) {
      if (e instanceof QuotaError) throw e
      failed.push(it.id)
      log({ item: it.id, split: it.split, error: String(e.message ?? e).slice(-300), promptChars: prompt.length, ms: Date.now() - t0 })
      continue
    }
    const r = score(it, kind === "pin" ? pinnedText(summary) : summary)
    kept += r.kept
    total += r.total
    lost.push(...r.lost)
    log({ item: it.id, split: it.split, kept: r.kept, total: r.total, promptChars: prompt.length, summaryChars: summary.length, ms: Date.now() - t0, summary })
  }
  return { kept, total, rate: total ? kept / total : 0, lost, failed }
}

const table = (rows) => rows.map((r) => r.join("\t")).join("\n")

const main = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (!main) {
  // imported by a test
} else if (cmd === "items") {
  const items = pick(loadItems())
  console.log(table([["item", "split", "update", "promptChars", "questions"], ...items.map((i) => [i.id, i.split, i.update, summaryPrompt(i, {}).length, i.questions.map((q) => q.id).join(",")])]))
  console.log(`${items.length} items; train ${items.filter((i) => i.split === "train").length}, holdout ${items.filter((i) => i.split === "holdout").length}`)
} else if (cmd === "stored") {
  const items = pick(loadItems())
  let k = 0
  let t = 0
  const rows = items.map((i) => {
    const r = score(i, i.stored)
    k += r.kept
    t += r.total
    return [i.id, i.split, `${r.kept}/${r.total}`, r.lost.map((l) => l.question).join(",")]
  })
  console.log(table([["item", "split", "kept", "lost"], ...rows]))
  console.log(`stored summaries keep ${k}/${t} facts`)
} else if (cmd === "eval") {
  if (!args.model) throw new Error("--model provider/model is required")
  const dir = runDir()
  const log = (x) => appendFileSync(path.join(dir, "eval.jsonl"), JSON.stringify(x) + "\n")
  const items = pick(loadItems())
  const slots = readSlots(args.slots)
  try {
    const r = await evaluate(items, slots, args.model, (x) => (log(x), console.log(x.error ? `${x.item}\tFAILED\t${x.error}` : `${x.item}\t${x.kept}/${x.total}\t${x.promptChars} chars in\t${x.ms} ms`)), args.slot === "budget" || args.slot === "pin" ? "pin" : "summary")
    if (usage.calls) console.log(`usage: ${usage.calls} calls, ${usage.prompt} prompt tokens (${usage.cacheHit} cache hits), ${usage.completion} completion tokens`)
    console.log(`kept ${r.kept}/${r.total} (${(r.rate * 100).toFixed(1)}%) over ${items.length - r.failed.length} items${r.failed.length ? `; failed: ${r.failed.join(", ")}` : ""}; log ${dir}`)
  } catch (e) {
    if (e instanceof QuotaError) console.log(`stopped: quota (${e.message}); partial log ${dir}`)
    else throw e
  }
} else if (cmd === "evolve") {
  const { evolve } = await import("./loop.mjs")
  await evolve({ args, loadItems, pick, readSlots, evaluate, generate, QuotaError, runDir })
  if (usage.calls) console.log(`usage: ${usage.calls} calls, ${usage.prompt} prompt tokens (${usage.cacheHit} cache hits), ${usage.completion} completion tokens`)
} else {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 17).join("\n"))
}
