// context-keeper v4.4 for opencode 2.x: fewer compactions for long plan-sdd orchestrator sessions (batched
// clearing of re-obtainable tool output + budget nudges), compaction that summarizes instead of deleting, and
// rebuilding the working set afterwards (plan scoreboard, subagent ledger, skills, user messages).
//
// What opencode does on its own: one summary of the whole history, with a prompt that tells the summarizer to
// leave out environment details, and no re-attachment of loaded skills afterwards. The losses seen in local runs
// were things that summary left out (facts learned through tools early on, skill rules). If the summary request
// is rejected as too long it retries on the newest 70% / 50% / 35%; its token
// estimate is chars / 4, which undercounts Chinese, so long Chinese sessions are the ones at risk of that path.
//
// This plugin:
// 1. compaction hook, history fits (CJK-aware estimate): append extra summary requirements at the end of the
//    request. Same prefix as the conversation, so the summary request still hits the prompt cache.
// 2. compaction hook, history does not fit: summarize it in chunks with the session's model and merge the
//    notes (map-reduce), then hand opencode the finished summary via `result`. Nothing is dropped.
// 3. context hook, after a compaction: attach one block to the checkpoint message, computed once per epoch and
//    replayed byte-for-byte (cache-safe): the user's own messages verbatim, git/worktree state,
//    the active plan document's status read from disk, full text of skills loaded earlier, current content of
//    recently read files, and project/global context files (.opencode/context/*.md).
// Pins, the goal and the todo list are not restored here: the pin, goal and todo plugins put their own state on
// every request.
//
// Nothing here touches the system prompt or changes the tool list per request.
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const VERSION = 4.4
const IDLE_MS = Number(process.env.CONTEXT_KEEPER_IDLE_MS) || 60 * 60 * 1000 // provider prompt caches are cold after this
const STATE_DIR = path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"), "opencode-context-keeper")
const CHECKPOINT = "<conversation-checkpoint>"
const DEFAULT_WINDOW = 200_000
const LIMITS = {
  skill: 12_000, // chars per restored skill
  skills: 30_000,
  plan: 8_000,
  file: 8_000, // chars per restored file; larger files are listed by path only
  files: 24_000,
  recentFiles: 8,
  userMessage: 2_000,
  userMessages: 12_000,
  contextFiles: 12_000,
  clearMin: 2_000, // tool outputs shorter than this are never cleared
  ledger: 40, // subagents listed individually in the restored block
  plans: 3, // unfinished plan documents restored
  keepUsers: 200, // user messages kept in the state file once they are out of the context
  keepSubagents: 200, // ledger entries kept in the state file once they are out of the context
}

// Drop what can never be used again, once per compaction epoch. After a compaction the context holds only the
// checkpoint and what followed, so clearing decisions for any other message id will never be replayed; old user
// messages and ledger entries are capped, and the restored block reports how many were dropped.
export function prune(state, messages) {
  const live = new Set()
  for (const m of messages) {
    if (m.id) live.add(m.id)
    for (const p of m.content ?? []) if (p.id) live.add(p.id)
  }
  for (const map of [state.cleared, state.clearedCalls]) for (const id of Object.keys(map)) if (!live.has(id)) delete map[id]
  const dropUsers = state.users.length - LIMITS.keepUsers
  if (dropUsers > 0) {
    const gone = state.users.slice(0, dropUsers).filter((u) => !live.has(u.id))
    state.users = state.users.filter((u) => !gone.includes(u))
    state.usersDropped = (state.usersDropped ?? 0) + gone.length
  }
  const ids = Object.keys(state.subagents)
  for (const id of ids.slice(0, Math.max(0, ids.length - LIMITS.keepSubagents)))
    if (!live.has(id)) (delete state.subagents[id], (state.subagentsDropped = (state.subagentsDropped ?? 0) + 1))
  const kids = Object.keys(state.children)
  for (const id of kids.slice(0, Math.max(0, kids.length - LIMITS.keepSubagents))) if (state.children[id] !== "running") delete state.children[id]
}

// ---------- small helpers ----------

// CJK characters cost roughly a token each; everything else about 3.5 chars per token. Errs high on purpose.
const estimate = (text) => {
  let cjk = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xff00 && c <= 0xffef)) cjk++
  }
  return Math.ceil(cjk + (text.length - cjk) / 3.5)
}

const emptyState = () => ({ v: VERSION, skills: {}, skillFiles: [], files: [], plan: "", users: [], epochs: {}, nudges: {}, cleared: {}, clearedCalls: {}, subagents: {}, children: {} })
const GOAL_CONTINUE = "<goal-continue>" // sent by the goal plugin; not the user writing
const sessionFile = (sid) => path.join(STATE_DIR, `${sid}.json`)
// A missing file is a fresh session. A corrupt one is kept aside (not overwritten by the next save) and logged;
// null fields fall back to their defaults.
const load = (sid) => {
  let raw
  try {
    raw = readFileSync(sessionFile(sid), "utf8")
  } catch {
    return emptyState()
  }
  try {
    const parsed = JSON.parse(raw)
    const state = emptyState()
    for (const [k, v] of Object.entries(parsed ?? {})) if (v !== null && v !== undefined) state[k] = v
    return state
  } catch (err) {
    const aside = `${sessionFile(sid)}.corrupt-${Date.now()}`
    try {
      renameSync(sessionFile(sid), aside)
    } catch {}
    console.warn(`[context-keeper] unreadable state file moved to ${aside}: ${err?.message ?? err}`)
    return emptyState()
  }
}
// Write-then-rename, so a reader (the sidebar) never sees half a file.
const save = (sid, state) => {
  mkdirSync(STATE_DIR, { recursive: true })
  const tmp = `${sessionFile(sid)}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 1))
  renameSync(tmp, sessionFile(sid))
}

const run = (cwd, cmd, ...args) => {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim()
  } catch {
    return ""
  }
}

const textOf = (value) => {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(textOf).join("\n")
  if (value && typeof value === "object") {
    for (const key of ["output", "content", "text", "value"]) if (key in value) return textOf(value[key])
    return Object.values(value).map(textOf).join("\n")
  }
  return ""
}

const stamp = (ms) => new Date(ms).toLocaleString("sv-SE", { hour12: false }).slice(0, 16)


const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}\n…[${text.length - max} more chars]` : text)

const readIf = (file, max) => {
  try {
    return existsSync(file) && statSync(file).isFile() ? clip(readFileSync(file, "utf8").trim(), max) : ""
  } catch {
    return ""
  }
}

// ---------- environment ----------

const gitState = (dir) => {
  const top = run(dir, "git", "rev-parse", "--show-toplevel")
  if (!top) return ""
  const gitDir = path.resolve(dir, run(dir, "git", "rev-parse", "--git-dir"))
  const common = path.resolve(dir, run(dir, "git", "rev-parse", "--git-common-dir"))
  const branch = run(dir, "git", "branch", "--show-current") || `(detached ${run(dir, "git", "rev-parse", "--short", "HEAD")})`
  const worktrees = run(dir, "git", "worktree", "list")
  const status = run(dir, "git", "status", "--short").split("\n").filter(Boolean)
  return [
    `session directory: ${dir}`,
    `git toplevel: ${top}${gitDir !== common ? ` (linked worktree of ${path.dirname(common)})` : ""}`,
    `branch: ${branch}`,
    `uncommitted: ${status.length ? `${status.length} file(s)\n${status.slice(0, 15).join("\n")}` : "none"}`,
    worktrees.includes("\n") ? `git worktree list:\n${worktrees}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

const isPlanDoc = (file) => {
  try {
    if (!file.endsWith(".md") || statSync(file).size > 400_000) return false
    const head = readFileSync(file, "utf8").slice(0, 3000)
    return /^Status:\s*\S/m.test(head) && /^Run id:/m.test(head)
  } catch {
    return false
  }
}

const planStatus = (file) => readFileSync(file, "utf8").slice(0, 3000).match(/^Status:\s*(\S+)/m)?.[1] ?? "?"

const findPlanDocs = (dir) =>
  run(dir, "git", "ls-files", "-co", "--exclude-standard", "--", "*.md")
    .split("\n")
    .filter(Boolean)
    .map((f) => path.resolve(dir, f))
    .filter(isPlanDoc)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

const planDigest = (file) => {
  const text = readFileSync(file, "utf8")
  const header = text.match(/^Status:[\s\S]*?(?=\n\s*\n)/m)?.[0] ?? ""
  const tasks = text.match(/^#+\s*Tasks?\b[\s\S]*?(?=^#{1,2}\s(?!#)|$(?![\s\S]))/im)?.[0] ?? ""
  return clip(`${header}\n\n${tasks}`.trim(), LIMITS.plan)
}

// Paths a tool call touched, including calls made from code mode (`execute` with tools.read({path: ...})).
const touched = (tool, input) => {
  const out = []
  if (!input || typeof input !== "object") return out
  const add = (kind, p) => p && out.push({ kind, path: p })
  const kindOf = (name) => (name === "read" ? "read" : /^(write|edit|patch|apply_patch)$/.test(name) ? "write" : "")
  if (kindOf(tool)) for (const key of ["path", "filePath", "file"]) if (typeof input[key] === "string") add(kindOf(tool), input[key])
  if (typeof input.patch === "string") for (const m of input.patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)) add("write", m[1].trim())
  if (typeof input.code === "string")
    for (const m of input.code.matchAll(/\b(read|write|edit)\s*\(\s*\{[^}]*?\bpath\s*:\s*["'`]([^"'`]+)["'`]/g)) add(kindOf(m[1]), m[2])
  return out
}

// Primary (orchestrating) agents get budget rounds; subagents (plan-sdd roles etc.) are left alone.
const PRIMARY = new Set((process.env.CONTEXT_KEEPER_PRIMARY ?? "build,plan,plan-sdd").split(",").map((s) => s.trim()).filter(Boolean))
const primary = (agent) => PRIMARY.has(String(agent ?? ""))

// Placeholder for a cleared tool output: says what it was and how to get it back.
const stubFor = (tool, input, text, sub) => {
  const head = (n) => text.slice(0, n).trimEnd()
  const tail = (n) => text.slice(-n).trimStart()
  const note = `[context-keeper cleared ${text.length} chars of old ${tool} output`
  if (tool === "read") return `${note}; re-read ${input?.path ?? input?.filePath ?? "the file"} if you need it]`
  if (tool === "subagent")
    return `${head(1200)}\n…\n${note}: rest of the ${sub?.agent ?? "subagent"} report; full report in session ${sub?.session || "(see ledger)"}]`
  const what = input?.command ?? input?.code ?? input?.pattern ?? input?.url ?? ""
  return `${head(600)}\n…\n${tail(400)}\n${note}${what ? `; re-run to see all: ${clip(String(what), 300)}` : ""}]`
}

// Placeholder for the prompt of an old subagent call. plan-sdd keeps each node's brief in a bundle file.
const briefStub = (input, text) =>
  `[context-keeper cleared ${text.length} chars of an old dispatch brief to ${input?.agent ?? "a subagent"}` +
  `${input?.description ? ` (${clip(String(input.description), 120)})` : ""}; the child already has it, and plan-sdd keeps the node's bundle in its scratch dir]`

// ---------- history → transcript text (for chunked summaries) ----------

const transcript = (messages) => {
  const lines = []
  for (const m of messages) {
    for (const p of m.content ?? []) {
      if (p.type === "text") {
        const text = p.text.split("\n\n<restored-context>")[0]
        if (m.role === "user") lines.push(`[user] ${clip(text, 6000)}`)
        else lines.push(`[assistant] ${clip(text, 3000)}`)
      } else if (p.type === "tool-call") lines.push(`[tool call ${p.name}] ${clip(JSON.stringify(p.input ?? {}), 800)}`)
      else if (p.type === "tool-result") lines.push(`[tool result ${p.name}] ${clip(textOf(p.result), 1500)}`)
    }
  }
  return lines
}

const chunkLines = (lines, budget) => {
  const chunks = []
  let cur = []
  let size = 0
  for (const line of lines) {
    const n = estimate(line)
    if (cur.length && size + n > budget) {
      chunks.push(cur.join("\n"))
      cur = []
      size = 0
    }
    cur.push(n > budget ? clip(line, budget * 2) : line)
    size += Math.min(n, budget)
  }
  if (cur.length) chunks.push(cur.join("\n"))
  return chunks
}

// ---------- evolvable guidance ----------
// Each prompt below is a fixed part (the hard rules, never changed automatically) plus one optional evolvable
// slot: extra guidance written by the evolution harness (evolve/) and kept only when it scored better on held-out
// sessions. Slots are capped in length so they stay general guidance instead of memorized facts. A slot that is
// missing, too long, or contains "<" (it could close a tag) is ignored and the fixed prompt runs alone.
export const SLOT_LIMITS = { summary: 800, map: 500, reduce: 500, budget: 500, pin: 300 }
const EVOLVED_FILE = process.env.CONTEXT_KEEPER_EVOLVED || path.join(homedir(), ".config", "opencode", "context-keeper", "evolved.json")
export const checkSlots = (raw) => {
  const slots = {}
  const rejected = []
  for (const [name, limit] of Object.entries(SLOT_LIMITS)) {
    const v = raw?.slots?.[name]
    if (v === undefined || v === null || v === "") continue
    if (typeof v !== "string" || v.trim().length > limit || v.includes("<")) rejected.push(name)
    else slots[name] = v.trim()
  }
  return { slots, rejected }
}
const loadEvolved = (log) => {
  try {
    const { slots, rejected } = checkSlots(JSON.parse(readFileSync(EVOLVED_FILE, "utf8")))
    if (rejected.length) log(`evolved slots ignored (too long, not text, or contain "<"): ${rejected.join(", ")}`)
    return slots
  } catch {
    return {}
  }
}
const extra = (text) => (text ? `\n${text}` : "")

export const MAP_PROMPT = (i, n, slots = {}) => `You are compressing part ${i} of ${n} of a coding-agent conversation so the agent can continue the work later.
Write dense notes (no preamble) covering, for this part only:
- user requests, constraints and corrections (quote short ones verbatim)
- decisions made and why
- what was done: files read/changed with exact paths, commands run and their results, errors and fixes
- environment facts learned: worktree paths, branches, servers/hosts, how to connect, deploy commands and their order, credentials LOCATIONS (never secret values)
- plan/task status and anything still pending
Keep exact paths, commands, identifiers, numbers. Write in the language the user uses.${extra(slots.map)}

<conversation-part>
`

export const REDUCE_PROMPT = (slots = {}) => `Merge these notes (from consecutive parts of one coding-agent conversation, oldest first) into one summary that lets the agent continue the work. Later notes win where they conflict. Use exactly these Markdown sections:
## Objective
## Requirements
## Decisions
## Work State
### Completed
### Active
### Blocked
## Next Move
## Relevant Files
## Important Context
Keep exact paths, commands, identifiers and numbers. Under Important Context keep environment facts (worktrees, branches, hosts, how to connect, deploy steps and order) verbatim. No preamble.${extra(slots.reduce)}

<notes>
`

// `pin` is whether the pin_context tool is available (the pin plugin is installed).
export const BUDGET_NUDGE = ({ used, window, level, cleared, pin = false }, slots = {}) =>
  `<context-budget>Context is about ${Math.round(used / 1000)}K of ${Math.round(window / 1000)}K tokens (crossed ${level}%).` +
  (cleared ? ` Older tool outputs (${Math.round(cleared / 1000)}K chars) were cleared; each placeholder says how to get the content back if you need it.` : "") +
  " The conversation will be compacted automatically later and older details summarized away. Before continuing:" +
  " make sure the plan document's Status header and task list reflect the current state (it is your scoreboard);" +
  (pin
    ? " pin_context the facts you will still need after compaction (worktree paths and branches, how to reach servers, deploy steps, decisions in force, open review findings), not per-file or step notes;" +
      " in the same reply, remove or update every pin in the pins block that no longer holds or is no longer needed (decision reversed, value changed, worktree merged, task finished, finding fixed) and merge related pins under one key."
    : "") +
  " From now on, after each finished sub-task or plan node, record its outcome in the plan document before starting the next one." +
  (slots.budget ? ` ${slots.budget}` : "") +
  " Then continue the task.</context-budget>"


export const EXTRA_REQUIREMENTS = (skills, slots = {}) =>
  [
    "Additional summary requirements (they override 'leave out environment details'):",
    "- Under Important Context keep verbatim: worktree paths and branches, servers/hosts and how to connect, deploy commands and their order, how to run the gates/tests, plan document paths and each task's status, pending verification.",
    "- Keep facts that came from tool output when the remaining work depends on them, including ones learned at the very start of the conversation.",
    skills.length ? `- Skills ${skills.join(", ")} are restored automatically after this summary; name them, do not restate them.` : "",
    "- The user's own messages are restored verbatim after this summary; summarize their intent, do not copy them.",
    slots.summary ?? "",
  ]
    .filter(Boolean)
    .join("\n")

// ---------- plugin ----------

export default {
  id: "context-keeper",
  async setup(ctx) {
    const directory = ctx.location.directory
    const contextDirs = [path.join(directory, ".opencode", "context"), path.join(homedir(), ".config", "opencode", "context")]
    const windows = new Map()
    const logFile = process.env.CONTEXT_KEEPER_LOG
    const log = (...args) => {
      console.warn("[context-keeper]", ...args)
      if (logFile)
        try {
          appendFileSync(logFile, `${new Date().toISOString()} ${args.map((a) => (typeof a === "string" ? a : String(a?.stack ?? JSON.stringify(a)))).join(" ")}\n`)
        } catch {}
    }
    const evolved = loadEvolved(log)
    if (Object.keys(evolved).length) log(`evolved guidance in use: ${Object.keys(evolved).join(", ")}`)

    const windowOf = async (ref) => {
      const key = `${ref.providerID}/${ref.id}`
      if (windows.has(key)) return windows.get(key)
      let size = Number(process.env.CONTEXT_KEEPER_WINDOW) || 0
      if (!size) {
        try {
          const res = await ctx.model.list()
          const m = (res?.data ?? res ?? []).find((x) => x.id === ref.id && (x.providerID ?? x.provider?.id) === ref.providerID)
          size = m?.limit?.input || m?.limit?.context || 0
        } catch {}
      }
      size ||= DEFAULT_WINDOW
      windows.set(key, size)
      return size
    }

    // --- subagent model guard ---
    // plan-sdd routes roles to Claude tiers (haiku/sonnet/opus/fable). opencode rejects those names, and the
    // orchestrator then guesses some "available" model (seen: a rate-limited free model), so whole runs fail at
    // random. Precedence in opencode is: explicit `model` > the agent file's model > the parent session's model.
    // Map known names via CONTEXT_KEEPER_MODEL_MAP ("haiku=prov/model,sonnet=prov/model#variant,..."); keep models
    // listed in CONTEXT_KEEPER_SUBAGENT_MODELS ("prov/model" or "prov/*") or known to opencode's model list (so a
    // registry-resolved, validated model passes untouched); drop anything else so the subagent falls back to its
    // agent file or the orchestrator's own model. CONTEXT_KEEPER_MODEL_GUARD=off disables this.
    const modelMap = Object.fromEntries(
      (process.env.CONTEXT_KEEPER_MODEL_MAP ?? "")
        .split(",")
        .map((pair) => pair.split("=").map((s) => s.trim()))
        .filter(([k, v]) => k && v)
        .map(([k, v]) => [k.toLowerCase(), v]),
    )
    const allowed = (process.env.CONTEXT_KEEPER_SUBAGENT_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    // The registry is cached, but a failed fetch is not (the next dispatch tries again), and a miss on a list older
    // than a minute refetches once, so a provider added while the server runs is picked up.
    let known
    let knownAt = 0
    const isKnown = async (ref) => {
      if (known?.has(ref)) return true
      if (known && Date.now() - knownAt < 60_000) return false
      try {
        const res = await ctx.model.list()
        known = new Set((res?.data ?? res ?? []).map((x) => `${x.providerID ?? x.provider?.id}/${x.id}`))
        knownAt = Date.now()
        return known.has(ref)
      } catch (err) {
        log(`model list unavailable (${err?.message ?? err}); for this dispatch only CONTEXT_KEEPER_SUBAGENT_MODELS is kept`)
        return false
      }
    }
    const isAllowed = async (model) => {
      const ref = model.split("#")[0]
      if (allowed.some((a) => (a.endsWith("/*") ? ref.startsWith(a.slice(0, -1)) : ref === a))) return true
      return ref.includes("/") && (await isKnown(ref))
    }
    if ((process.env.CONTEXT_KEEPER_MODEL_GUARD ?? "on") !== "off")
      await ctx.tool.hook("execute.before", async (e) => {
        if (e.tool !== "subagent" || !e.input || typeof e.input !== "object" || e.input.model === undefined) return
        const asked = String(e.input.model)
        const mapped = modelMap[asked.toLowerCase()] ?? modelMap[asked.toLowerCase().split("/").pop().split("#")[0]]
        if (mapped) e.input.model = mapped
        else if (!(await isAllowed(asked))) delete e.input.model
        log(`subagent ${e.input.agent ?? "?"}: model "${asked}" -> ${e.input.model ?? "(agent file / orchestrator model)"}`)
      })

    // --- tracking ---
    await ctx.tool.hook("execute.after", async (e) => {
      if (e.status !== "completed") return
      const state = load(e.sessionID)
      let changed = false
      if (e.tool === "skill") {
        const text = textOf(e.result).trim()
        if (text) {
          const name = text.match(/<skill_content name="([^"]+)"/)?.[1] ?? e.input?.name ?? e.input?.id ?? "unknown"
          state.skills[name] = { text: clip(text, LIMITS.skill), base: text.match(/Base directory for this skill: (.+)/)?.[1]?.trim() ?? "" }
          changed = true
        }
      }
      for (const t of touched(e.tool, e.input)) {
        const file = path.resolve(directory, t.path)
        const skill = Object.values(state.skills).find((s) => s.base && file.startsWith(s.base + path.sep))
        if (t.kind === "read" && skill) {
          if (!state.skillFiles.includes(file)) state.skillFiles.push(file)
        } else {
          state.files = [file, ...state.files.filter((f) => f !== file)].slice(0, 30)
        }
        if (file !== state.plan && isPlanDoc(file)) state.plan = file
        changed = true
      }
      if (changed) save(e.sessionID, state)
    })

    // --- the restored block (built once per epoch) ---
    const contextFiles = () => {
      const out = []
      let budget = LIMITS.contextFiles
      for (const dir of contextDirs) {
        if (!existsSync(dir)) continue
        for (const name of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
          const text = readIf(path.join(dir, name), budget)
          if (!text) continue
          budget -= text.length
          out.push(`### ${path.join(dir, name)}\n${text}`)
          if (budget <= 0) return out
        }
      }
      return out
    }

    const buildBlock = (state, sid) => {
      const parts = []
      if (state.users.length) {
        const kept = []
        let budget = LIMITS.userMessages
        for (const u of [...state.users].reverse()) {
          if (u.text.length > budget) break
          budget -= u.text.length
          kept.unshift(u.text)
        }
        const skipped = state.users.length - kept.length + (state.usersDropped ?? 0)
        parts.push(`## Your user's messages, verbatim, oldest first${skipped ? ` (${skipped} older ones omitted)` : ""}\n${kept.map((t) => `- ${t.replace(/\n/g, "\n  ")}`).join("\n")}`)
      }
      const ctxFiles = contextFiles()
      if (ctxFiles.length) parts.push(`## Context files\n${ctxFiles.join("\n\n")}`)
      const git = gitState(directory)
      if (git) parts.push(`## Git (read ${stamp(Date.now())}; run git to refresh)\n${git}`)
      const docs = [...new Set([state.plan, ...findPlanDocs(directory)].filter((f) => f && existsSync(f) && isPlanDoc(f)))]
      const open = docs.filter((f) => planStatus(f) !== "done").slice(0, LIMITS.plans)
      const done = docs.filter((f) => planStatus(f) === "done")
      const plan = open[0] ?? ""
      for (const f of open)
        parts.push(`## Plan document (read from disk ${stamp(Date.now())}): ${f}\nIt is the scoreboard; re-read it before acting on the plan.\n${planDigest(f)}`)
      if (done.length) parts.push(`## Finished plans\n${done.map((f) => `- ${f}`).join("\n")}`)
      const names = Object.keys(state.skills)
      if (names.length) {
        let budget = LIMITS.skills
        const bodies = names.map((name) => {
          const { text } = state.skills[name]
          if (text.length > budget) return `(skill "${name}" too large to restore inline; load it again with the skill tool)`
          budget -= text.length
          return text
        })
        parts.push(`## Skills loaded earlier in this session (still in force)\n${bodies.join("\n\n")}`)
      }
      const subs = Object.values(state.subagents)
      if (subs.length) {
        const shown = subs.slice(-LIMITS.ledger)
        const omitted = subs.length - shown.length + (state.subagentsDropped ?? 0)
        parts.push(
          `## Subagents dispatched this session (oldest first${omitted ? `; ${omitted} earlier ones omitted` : ""}; read a session's full report with the opencode session tools if needed)\n` +
            shown.map((s) => `- ${s.agent}: ${s.description} — ${s.status || "?"}${s.session ? ` (session ${s.session})` : ""}${s.at ? `, ${stamp(s.at)}` : ""}`).join("\n"),
        )
      }
      if (state.skillFiles.length) parts.push(`## Skill reference files you had read (re-read the ones the next step needs)\n${state.skillFiles.map((f) => `- ${f}`).join("\n")}`)
      const recent = state.files.filter((f) => existsSync(f) && !state.skillFiles.includes(f) && f !== plan).slice(0, LIMITS.recentFiles)
      if (recent.length) {
        let budget = LIMITS.files
        const shown = recent.map((f) => {
          const size = statSync(f).size
          if (size > LIMITS.file || size > budget) return `### ${f}\n(${size} bytes; re-read when needed)`
          const text = readIf(f, LIMITS.file)
          budget -= text.length
          return `### ${f} (current content)\n${text}`
        })
        parts.push(`## Files you were working with, newest first\n${shown.join("\n\n")}`)
      }
      if (!parts.length) return ""
      return ["", "<restored-context>", `Restored by context-keeper after compaction at ${stamp(Date.now())}. Sections marked as read from disk are current as of that time; the ledger carries its own times. Where this disagrees with the summary, this wins. Uncommitted changes in git are normal work in progress, not a sign that facts are stale.`, ...parts, "</restored-context>"].join("\n\n")
    }

    await ctx.session.hook("context", async (e) => {
      const state = load(e.sessionID)
      const first = e.messages[0]
      const firstText = first?.content?.find?.((p) => p.type === "text")?.text ?? ""
      const compacted = firstText.startsWith(CHECKPOINT)

      // Record the user's own messages (not checkpoints, not synthetic notices) for verbatim replay.
      let changed = false
      const known = new Set(state.users.map((u) => u.id))
      for (const m of e.messages) {
        if (m.role !== "user" || !m.id || known.has(m.id) || m.metadata?.synthetic) continue
        const text = (m.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n").trim()
        if (!text || text.startsWith(CHECKPOINT) || text.startsWith("<subagent ") || text.startsWith("Additional summary requirements") || text.startsWith(GOAL_CONTINUE)) continue
        state.users.push({ id: m.id, text: clip(text, LIMITS.userMessage) })
        changed = true
      }

      // Subagent ledger: which role got which task, its session, its outcome (plan-sdd dispatches many of them).
      const calls = new Map()
      for (const m of e.messages)
        for (const p of m.content ?? []) {
          if (p.type === "tool-call") calls.set(p.id, p)
          if (p.type === "tool-result" && p.name === "subagent" && !state.subagents[p.id]) {
            const call = calls.get(p.id)
            const text = textOf(p.result)
            state.subagents[p.id] = {
              agent: call?.input?.agent ?? "?",
              description: call?.input?.description ?? "",
              session: text.match(/sessionID(?:="|: )(ses_[A-Za-z0-9]+)/)?.[1] ?? "",
              status: text.match(/state="([^"]+)"/)?.[1] ?? (/working in the background/.test(text) ? "running (background)" : ""),
              at: Date.now(),
            }
            changed = true
          }
        }

      // Background children: the ledger shows which are still running.
      // Launch: the subagent tool returns "working in the background (sessionID: ses_…)". Report: a message
      // starting <subagent sessionID="ses_…" state="…">.
      state.children ??= {}
      for (const m of e.messages)
        for (const p of m.content ?? []) {
          const text = p.type === "tool-result" && p.name === "subagent" ? textOf(p.result) : p.type === "text" ? p.text : ""
          if (!text) continue
          if (p.type === "tool-result")
            for (const t of text.matchAll(/working in the background \(sessionID: (ses_[A-Za-z0-9]+)\)/g))
              if (state.children[t[1]] === undefined) (state.children[t[1]] = "running"), (changed = true)
          if (p.type === "text" && text.startsWith("<subagent "))
            for (const t of text.matchAll(/^<subagent sessionID="([^"]+)" state="([^"]+)"/gm)) {
              if (state.children[t[1]] === t[2]) continue
              state.children[t[1]] = t[2]
              for (const sub of Object.values(state.subagents)) if (sub.session === t[1]) sub.status = t[2]
              changed = true
            }
        }

      // Replay earlier clearing decisions byte-for-byte, so the prefix stays identical between clearing rounds.
      const applyCleared = () => {
        for (const m of e.messages)
          for (const p of m.content ?? []) {
            if (p.type === "tool-result" && state.cleared[p.id] !== undefined) p.result = { type: "text", value: state.cleared[p.id] }
            if (p.type === "tool-call" && state.clearedCalls?.[p.id] !== undefined) p.input = { ...p.input, prompt: state.clearedCalls[p.id] }
          }
      }
      applyCleared()

      // Budget rounds (after Context Language Models, arXiv 2609.37725, and "clear old tool results" context
      // editing). At 25/50/75/90% of the window, for the orchestrating (primary) agent only:
      // 1. clear large, re-obtainable tool outputs older than the last few messages, in one batch, so the cache
      //    breaks once per round instead of on every request;
      // 2. append a nudge with the actual token count (models misjudge how full they are, CLM App. G) asking the
      //    model to pin facts and keep the plan document current before compaction summarizes the rest.
      const window = await windowOf(e.model)
      // The restored block (built once per epoch, appended below) and the tool definitions are part of every
      // request too, so they count toward the budget and the meter.
      const blockKey = compacted ? (first.id ?? createHash("sha1").update(firstText).digest("hex")) : undefined
      if (blockKey !== undefined && state.epochs[blockKey] === undefined) {
        prune(state, e.messages)
        state.epochs = { [blockKey]: buildBlock(state, e.sessionID) }
        changed = true
      }
      const block = blockKey !== undefined ? state.epochs[blockKey] : undefined
      const overhead = estimate(JSON.stringify(e.tools ?? [])) + estimate(block ?? "")
      const rawMeasure = () => overhead + estimate(JSON.stringify(e.system ?? [])) + estimate(JSON.stringify(e.messages))
      // Scaled by what the provider reported for earlier steps (see calibration below); 1 until the first report.
      const measure = () => Math.round(rawMeasure() * (state.calib ?? 1))
      let used = measure()
      const epochKey = compacted ? (first.id ?? "c") : "0"
      const level = [90, 75, 50, 25].find((l) => used >= (window * l) / 100) ?? 0
      const fired = state.nudges?.[epochKey] ?? 0
      // Back after a long pause: the provider's prompt cache is cold anyway, so a clearing round costs nothing extra.
      const gap = state.lastAt ? Date.now() - state.lastAt : 0
      const idle = gap > IDLE_MS && level >= 25
      state.lastAt = Date.now()
      changed = true
      if (primary(e.agent) && (level > fired || idle) && e.messages.length) {
        state.nudges = { [epochKey]: Math.max(level, fired) }
        if (idle) log(`back after ${Math.round(gap / 60000)} min idle: clearing round at ${level}%`)
        changed = true
        // Protect only the current turn (from the last user text message on), capped at 10 messages (4 at 90%) so one
        // very long turn still gets cleared. Protecting a fixed 10 left too little to clear when each turn reads a
        // large file: compactions did not drop and the model re-read what had been cleared.
        let lastUser = e.messages.length - 1
        const isTurnStart = (m) => m.role === "user" && m.id && !m.metadata?.synthetic && (m.content ?? []).some((p) => p.type === "text")
        while (lastUser > 0 && !isTurnStart(e.messages[lastUser])) lastUser--
        const keepRecent = Math.min(e.messages.length - lastUser, level >= 90 ? 4 : 10)
        let cleared = 0
        for (const m of e.messages.slice(0, Math.max(0, e.messages.length - keepRecent)))
          for (const p of m.content ?? []) {
            if (p.type === "tool-call" && p.name === "subagent" && typeof p.input?.prompt === "string" && state.clearedCalls[p.id] === undefined && p.input.prompt.length >= LIMITS.clearMin) {
              state.clearedCalls[p.id] = briefStub(p.input, p.input.prompt)
              cleared += p.input.prompt.length
              continue
            }
            if (p.type !== "tool-result" || state.cleared[p.id] !== undefined || p.name === "skill" || p.name === "pin_context" || p.name === "goal") continue
            const text = textOf(p.result)
            if (text.length < LIMITS.clearMin) continue
            state.cleared[p.id] = stubFor(p.name, calls.get(p.id)?.input, text, state.subagents[p.id])
            cleared += text.length
          }
        if (cleared) {
          state.clearedTotal = (state.clearedTotal ?? 0) + cleared
          applyCleared()
          used = measure()
          log(`budget ${level}%: cleared ${cleared} chars of old tool output`)
        }
        e.messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: BUDGET_NUDGE({ used, window, level, cleared, pin: JSON.stringify(e.tools ?? {}).includes("pin_context") }, evolved),
            },
          ],
        })
      }

      // What the sidebar shows: this plugin's own estimate and thresholds (the provider's real count comes from
      // the messages themselves).
      if (primary(e.agent))
        state.meter = {
          used,
          window,
          level: Math.max(level, fired),
          cleared: Object.keys(state.cleared).length + Object.keys(state.clearedCalls).length,
          clearedChars: state.clearedTotal ?? 0,
          at: Date.now(),
        }

      if (block) first.content.push({ type: "text", text: block })
      // The estimate for this request, matched against the provider's count when the step ends.
      state.pending = rawMeasure()
      save(e.sessionID, state)
    })

    // --- compaction: summarize everything, never drop ---
    await ctx.session.hook("compaction", async (e) => {
      const state = load(e.sessionID)
      // Make the summary request's history byte-identical to what the conversation requests sent (cleared
      // outputs, restored block on the checkpoint), so it shares their cached prefix. Without this the summary
      // request diverged at the first message and missed the cache almost entirely (measured: 10–17% vs 96–98%).
      for (const m of e.messages)
        for (const p of m.content ?? []) {
          if (p.type === "tool-result" && state.cleared[p.id] !== undefined) p.result = { type: "text", value: state.cleared[p.id] }
          if (p.type === "tool-call" && state.clearedCalls?.[p.id] !== undefined) p.input = { ...p.input, prompt: state.clearedCalls[p.id] }
        }
      const first = e.messages[0]
      const firstText = first?.content?.find?.((p) => p.type === "text")?.text ?? ""
      if (firstText.startsWith(CHECKPOINT)) {
        const block = state.epochs[first.id ?? createHash("sha1").update(firstText).digest("hex")]
        if (block) first.content.push({ type: "text", text: block })
      }
      const window = await windowOf(e.model)
      const lines = transcript(e.messages)
      // Measure what is actually sent (full tool outputs, tool definitions), not the clipped transcript the
      // map-reduce path works from; the clipped size was far smaller and let oversized requests through.
      const size =
        estimate(JSON.stringify(e.system ?? [])) + estimate(JSON.stringify(e.messages)) + estimate(JSON.stringify(e.tools ?? []))

      if (size <= window * 0.75) {
        e.messages.push({ role: "user", content: [{ type: "text", text: EXTRA_REQUIREMENTS(Object.keys(state.skills), evolved) }] })
        return
      }

      // Too long for one request: map-reduce with the session's model instead of dropping the oldest part.
      try {
        const chunks = chunkLines(lines, Math.floor(window * 0.4))
        log(`history ~${size} tokens > 75% of ${window}; summarizing in ${chunks.length} chunks`)
        let notes = []
        for (let i = 0; i < chunks.length; i++) {
          const res = await ctx.generate.text({ model: e.model, prompt: `${MAP_PROMPT(i + 1, chunks.length, evolved)}${chunks[i]}\n</conversation-part>` })
          notes.push(`### Part ${i + 1}\n${res.text.trim()}`)
        }
        // Merge in rounds if the notes themselves are too long for one request.
        while (estimate(notes.join("\n\n")) > window * 0.5 && notes.length > 1) {
          const merged = []
          for (const group of chunkLines(notes, Math.floor(window * 0.4))) {
            const res = await ctx.generate.text({ model: e.model, prompt: `${REDUCE_PROMPT(evolved)}${group}\n</notes>` })
            merged.push(res.text.trim())
          }
          notes = merged
        }
        const res = await ctx.generate.text({ model: e.model, prompt: `${REDUCE_PROMPT(evolved)}${notes.join("\n\n")}\n</notes>` })
        const summary = res.text.trim()
        if (summary.includes("## ")) {
          e.result = { summary, metadata: { contextKeeper: { version: VERSION, chunks: chunks.length, estimatedTokens: size } } }
          return
        }
        log("merged summary had no sections; falling back to opencode's compaction")
      } catch (error) {
        log("chunked summary failed; falling back to opencode's compaction", error)
      }
      e.messages.push({ role: "user", content: [{ type: "text", text: EXTRA_REQUIREMENTS(Object.keys(state.skills), evolved) }] })
    })

    // --- calibration: the estimate runs high where JSON tokenizes tightly (13% over on DeepSeek in a live run).
    // When a step ends, the provider's input size (input + cache read + cache write) against the estimate made for
    // that request gives a ratio; later estimates are scaled by its running average, clamped to 0.5..1.3. Only the
    // request the context hook measured counts, so a compaction step leaves it alone. The compaction size check
    // stays unscaled, erring towards chunking.
    const abort = new AbortController()
    if (ctx.event?.subscribe)
      (async () => {
        for await (const ev of ctx.event.subscribe({ signal: abort.signal })) {
          if (abort.signal.aborted) break
          if (ev?.type !== "session.step.ended" || !ev.data?.sessionID || !ev.data.tokens) continue
          const state = load(ev.data.sessionID)
          if (!(state.pending > 0)) continue
          const t = ev.data.tokens
          const actual = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
          const ratio = Math.min(1.3, Math.max(0.5, actual / state.pending))
          state.calib = state.calib ? (state.calib + ratio) / 2 : ratio
          state.pending = 0
          save(ev.data.sessionID, state)
        }
      })().catch((err) => log("event loop stopped", err))

    return async () => abort.abort()
  },
}
