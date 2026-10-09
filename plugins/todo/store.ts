import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const
export const TODO_PRIORITIES = ["high", "medium", "low"] as const

export type TodoStatus = (typeof TODO_STATUSES)[number]
export type TodoPriority = (typeof TODO_PRIORITIES)[number]
export type Todo = { id: string; content: string; status: TodoStatus; priority: TodoPriority }

const DAY_MS = 24 * 60 * 60 * 1000
const FINISHED_MAX_AGE_MS = 7 * DAY_MS
const OPEN_MAX_AGE_MS = 180 * DAY_MS

export const TODO_DIR = process.env.OPENCODE_TODO_DIR || join(homedir(), ".config/opencode/state/todos")

const fileOf = (sessionID: string) => join(TODO_DIR, `${sessionID.replace(/[^\w.-]/g, "_")}.json`)

export function normalize(value: unknown): Todo[] {
  if (!Array.isArray(value)) return []
  const out: Todo[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const content = typeof record.content === "string" ? record.content.trim() : ""
    if (!content) continue
    let id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : String(out.length + 1)
    if (seen.has(id)) {
      const base = id
      for (let n = out.length + 1; seen.has(id); n++) id = `${base}-${n}`
    }
    seen.add(id)
    out.push({
      id,
      content,
      status: TODO_STATUSES.includes(record.status as TodoStatus) ? (record.status as TodoStatus) : "pending",
      priority: TODO_PRIORITIES.includes(record.priority as TodoPriority) ? (record.priority as TodoPriority) : "medium",
    })
  }
  return out
}

export function readTodos(sessionID: string): Todo[] {
  try {
    return normalize(JSON.parse(readFileSync(fileOf(sessionID), "utf8")))
  } catch {
    return []
  }
}

export function writeTodos(sessionID: string, input: unknown): Todo[] {
  const todos = normalize(input)
  mkdirSync(TODO_DIR, { recursive: true })
  const file = fileOf(sessionID)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(todos))
  renameSync(tmp, file)
  return todos
}

export function removeTodos(sessionID: string) {
  rmSync(fileOf(sessionID), { force: true })
}

/** Last-modified time of a session's list, or 0 when none exists. Cheap change probe for the sidebar. */
export function todosVersion(sessionID: string): number {
  try {
    return statSync(fileOf(sessionID)).mtimeMs
  } catch {
    return 0
  }
}

/** True when nothing is left to do: empty, or every item completed/cancelled. */
export function isFinished(todos: Todo[]): boolean {
  return todos.every((todo) => todo.status === "completed" || todo.status === "cancelled")
}

/**
 * The session id is only a lookup key, never a lifetime: a long session keeps
 * its open list. Finished lists go quickly, lists with open items very late.
 */
export function pruneOldTodos() {
  try {
    const now = Date.now()
    for (const name of readdirSync(TODO_DIR)) {
      const file = join(TODO_DIR, name)
      try {
        const age = now - statSync(file).mtimeMs
        if (age < FINISHED_MAX_AGE_MS) continue
        const finished = isFinished(normalize(JSON.parse(readFileSync(file, "utf8"))))
        if (finished || age >= OPEN_MAX_AGE_MS) rmSync(file, { force: true })
      } catch {}
    }
  } catch {}
}
