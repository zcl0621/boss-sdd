import { TODO_PRIORITIES, TODO_STATUSES, pruneOldTodos, readTodos, removeTodos, writeTodos, type Todo } from "./store"

const WRITE_DESCRIPTION = `Create and maintain a structured task list for the current session. The list is shown to the user in the sidebar.

Use proactively when the work has 3+ distinct steps, is non-trivial, or the user lists multiple tasks. Skip single straightforward edits and purely informational questions.

Each call replaces the whole list, so always send every item, not only the changed ones.
A session can span several unrelated tasks: when the previous list is finished and the user moves on, send a fresh list for the new task, or an empty list to clear it.
States: pending, in_progress, completed, cancelled. Keep one item in_progress at a time, except for work that really runs in parallel (subagents dispatched together): each of those is in_progress until its result is in.
Mark an item in_progress before starting it and completed only after the work, including verification, is done.`

const READ_DESCRIPTION = "Read the current session todo list. Takes no arguments. Returns the full list as JSON."

export const BLOCK = "<todos>"
const CLIP = 200

// Subagent dispatches after the last message that called todowrite. None found (e.g. after a compaction): 0.
export function dispatchesSinceWrite(messages: any[]): number {
  const calls = (m: any, name: string) => (m?.content ?? []).filter((p: any) => p?.type === "tool-call" && p.name === name).length
  let last = -1
  for (let i = messages.length - 1; i >= 0; i--) if (calls(messages[i], "todowrite")) { last = i; break }
  if (last < 0) return 0
  return messages.slice(last + 1).reduce((n, m) => n + calls(m, "subagent"), 0)
}

// The open items, on every request, so the list survives compaction and clearing without being restored.
export function todoBlock(todos: Todo[], dispatches = 0): string {
  const open = todos.filter((t) => t.status !== "completed" && t.status !== "cancelled")
  if (!open.length) return ""
  const clip = (s: string) => (s.length > CLIP ? `${s.slice(0, CLIP)}…` : s)
  return (
    `${BLOCK}Todo list, ${todos.length - open.length}/${todos.length} done (open items below; todowrite replaces the whole list).\n` +
    open.map((t) => `- [${t.status}] ${clip(t.content)}`).join("\n") +
    (dispatches ? `\n${dispatches} subagent dispatch${dispatches === 1 ? "" : "es"} since the last todowrite: bring the list up to date.` : "") +
    "\n</todos>"
  )
}

const ITEM_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    content: { type: "string" },
    status: { type: "string", enum: [...TODO_STATUSES] },
    priority: { type: "string", enum: [...TODO_PRIORITIES] },
  },
  required: ["id", "content", "status", "priority"],
}

const OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: { todos: { type: "array", items: ITEM_OUTPUT } },
  required: ["todos"],
}

const WRITE_INPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    todos: {
      type: "array",
      description: "The updated todo list (replace-all snapshot)",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "Optional stable item id" },
          content: { type: "string", description: "Brief description of the task" },
          status: { type: "string", description: "pending, in_progress, completed, or cancelled", enum: [...TODO_STATUSES] },
          priority: { type: "string", description: "high, medium, or low", enum: [...TODO_PRIORITIES] },
        },
        required: ["content"],
      },
    },
  },
  required: ["todos"],
}

const READ_INPUT = { type: "object", additionalProperties: false, properties: {} }

const result = (todos: Todo[]) => ({
  output: { todos },
  content: JSON.stringify(todos, null, 2),
  metadata: { todos },
})

function sessionOf(context: any): string {
  const id = context?.sessionID
  if (typeof id !== "string" || !id) throw new Error("todo tool context did not provide a sessionID")
  return id
}

function hostHas(draft: any, name: string): boolean {
  try {
    if (typeof draft.get === "function" && draft.get(name)) return true
  } catch {}
  try {
    if (typeof draft.list === "function") return draft.list().some((tool: any) => tool.id === name || tool.name === name)
  } catch {}
  return false
}

// A plain object, like context-keeper: opencode 2 loads it without a plugin SDK import.
export default {
  id: "todo",
  async setup(ctx: any) {
    pruneOldTodos()

    const regs: Array<{ dispose: () => Promise<void> }> = []

    regs.push(
      await ctx.tool.transform((draft: any) => {
        if (!hostHas(draft, "todowrite")) {
          draft.add({
            name: "todowrite",
            description: WRITE_DESCRIPTION,
            input: WRITE_INPUT,
            output: OUTPUT,
            options: { codemode: false },
            execute: async (input: any, context: any) => result(writeTodos(sessionOf(context), input?.todos)),
          })
        }
        if (!hostHas(draft, "todoread")) {
          draft.add({
            name: "todoread",
            description: READ_DESCRIPTION,
            input: READ_INPUT,
            output: OUTPUT,
            options: { codemode: false },
            execute: async (_input: any, context: any) => result(readTodos(sessionOf(context))),
          })
        }
      }),
    )

    // Every request: the open items go last, as a notice rather than the user writing (no id, synthetic).
    await ctx.session?.hook?.("context", async (e: any) => {
      const text = todoBlock(readTodos(e.sessionID), dispatchesSinceWrite(e.messages ?? []))
      if (text) e.messages.push({ role: "user", metadata: { synthetic: true }, content: [{ type: "text", text }] })
    })

    const abort = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          if (String(event?.type ?? "") !== "session.deleted") continue
          const sid = String(event?.data?.sessionID ?? event?.sessionID ?? event?.durable?.aggregateID ?? "")
          if (sid) removeTodos(sid)
        }
      } catch {}
    })()

    return async () => {
      abort.abort()
      await Promise.all(regs.map((reg) => reg.dispose().catch(() => {})))
    }
  },
}
