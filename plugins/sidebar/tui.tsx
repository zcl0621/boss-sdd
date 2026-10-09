/** @jsxImportSource @opentui/solid */
/**
 * OpenCode 2 TUI plugin: one session sidebar with
 *   Context    how full the window is, what context-keeper does next, compactions, cache hits, cost
 *   Goal       the unattended goal (plugins/goal): status, objective, continues
 *   Todo       the list written by the `todowrite` tool (plugins/todo)
 *   Subagents  child sessions still running
 *   Git        branch, worktree, changed files (click one for an Otty preview)
 *
 * Replaces opencode's own Context section. Disable it, and the built-in MCP list, with
 * "-opencode.sidebar.context" and "-opencode.sidebar.mcp" in ~/.config/opencode/cli.json `plugins`. The server plugins run in another process, so goal, meter and todo state are read from
 * their JSON files and re-read when the file's mtime changes. Colours come from `context.theme`.
 */
import { Plugin } from "@opencode/plugin/tui"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"

const PLUGIN_ID = "boss-sdd.sidebar"
const POLL_MS = 1000
const BAR = 30
const LEVELS = [25, 50, 75, 90] // context-keeper's clearing rounds, % of the window
const RESERVE_MIN = 16_000 // opencode compacts at window - max(10%, 16K) unless compaction.buffer is set
const DONE_TTL_MS = 30 * 60 * 1000
const MAX_TODOS = 15
const MAX_FILES = 10
const MAX_SUBAGENTS = 12
const DEFAULT_OTTY_CLI = "/Applications/Otty.app/Contents/MacOS/otty-cli"
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

const STATE_HOME = process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state")
const CK_DIR = path.join(STATE_HOME, "opencode-context-keeper")
const GOAL_DIR = path.join(STATE_HOME, "opencode-goal")
const PIN_DIR = path.join(STATE_HOME, "opencode-pin")
const TODO_DIR = process.env.OPENCODE_TODO_DIR || path.join(homedir(), ".config", "opencode", "state", "todos")
const safeName = (sessionID: string) => sessionID.replace(/[^\w.-]/g, "_")

type Todo = { id: string; content: string; status: "pending" | "in_progress" | "completed" | "cancelled" }
type Goal = {
  objective: string
  status: "active" | "waiting" | "complete"
  reason?: string
  evidence?: string
  continues?: number
  at?: number
}
type Meter = { used: number; window: number; level: number; cleared: number; clearedChars: number; at: number }
type GoalState = { goal?: Goal | null; children?: Record<string, string> }
type Change = { file: string; additions: number; deletions: number; status: "added" | "deleted" | "modified" }
type ModelRef = { id?: string; modelID?: string; providerID: string; variant?: string }

const TODO_MARK: Record<Todo["status"], string> = { pending: "☐", in_progress: "▶", completed: "☑", cancelled: "✗" }

function shorten(value: string, max: number) {
  return value.length <= max ? value : `…${value.slice(1 - max)}`
}

function clip(value: string, max: number) {
  const flat = value.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function kilo(value: number) {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${Math.round(value / 1000)}K` : `${value}`
}

function homePath(value: string) {
  const home = process.env.HOME
  return home && value.startsWith(home) ? `~${value.slice(home.length)}` : value
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

/** A JSON file written by another process, re-read whenever its mtime changes. */
function useJsonFile<T>(file: () => string, parse: (raw: unknown) => T, empty: T) {
  const [value, setValue] = createSignal<T>(empty)
  const [mtime, setMtime] = createSignal(-1)
  const [now, setNow] = createSignal(Date.now())
  let seen = -1
  const read = () => {
    setNow(Date.now())
    let next = 0
    try {
      next = statSync(file()).mtimeMs
    } catch {}
    if (next === seen) return
    seen = next
    setMtime(next)
    if (!next) return void setValue(() => empty)
    try {
      setValue(() => parse(JSON.parse(readFileSync(file(), "utf8"))))
    } catch {}
  }
  onMount(() => {
    read()
    const timer = setInterval(read, POLL_MS)
    onCleanup(() => clearInterval(timer))
  })
  createEffect(on(file, () => ((seen = -1), read()), { defer: true }))
  return { value, mtime, now, read }
}

function modelKey(model: ModelRef) {
  return model.id ?? model.modelID
}

function providersFromContext(context: any): readonly any[] {
  const fromState = context.state?.provider
  if (Array.isArray(fromState) && fromState.length > 0) return fromState
  const listed = context.data?.location?.provider?.list?.()
  return Array.isArray(listed) ? listed : []
}

function resolveSessionModel(context: any, sessionID: string, fallback?: { model?: ModelRef }) {
  const session = context.data.session.get(sessionID) ?? fallback
  const fromSession = session?.model as ModelRef | undefined
  if (fromSession && modelKey(fromSession)) return fromSession
  const messages = context.data.session.message?.list?.(sessionID)
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { type?: string; model?: ModelRef }
    if (message.type !== "model-switched" && message.type !== "assistant") continue
    if (message.model && modelKey(message.model)) return message.model
  }
  return undefined
}

function formatModelLabel(model: ModelRef | undefined, providers: readonly any[]) {
  const key = model ? modelKey(model) : undefined
  if (!key) return ""
  const provider = providers.find((item) => item.id === model!.providerID)
  const catalog = provider?.models?.[key] ?? provider?.models?.[model!.id ?? ""]
  const named = catalog?.name
  const base = named && named !== key ? named : key
  const variant = model!.variant ? ` · ${model!.variant}` : ""
  return `${base}${variant}`
}

function openOtty(context: any, directory: string, change: Change) {
  if (change.status === "deleted") {
    context.ui.toast.show({ message: "File was deleted — use /diff to inspect its patch.", variant: "warning" })
    return
  }
  const file = path.resolve(directory, change.file)
  if (!existsSync(file)) {
    context.ui.toast.show({ message: `Not on disk: ${change.file}`, variant: "error" })
    return
  }
  const cli = process.env.OTTY_CLI || DEFAULT_OTTY_CLI
  const socket =
    process.env.OTTY_SOCKET || path.join(process.env.HOME || "", "Library/Application Support/io.appmakes.otty/otty.sock")
  const child = spawn(cli, ["view", file, "--right", "--socket", socket, "-q"], { detached: true, stdio: "ignore" })
  child.once("error", (error) => context.ui.toast.show({ message: `Otty preview failed: ${error.message}`, variant: "error" }))
  child.unref()
}

/** Clickable section title: ▼ Name (detail) */
function Header(props: { theme: () => any; open: () => boolean; toggle: () => void; title: string; detail?: string; detailColor?: any; first?: boolean }) {
  return (
    <box flexDirection="row" gap={1} marginTop={props.first ? 0 : 1} onMouseDown={props.toggle}>
      <text fg={props.theme().text.muted}>{props.open() ? "▼" : "▶"}</text>
      <text fg={props.theme().text.base}>
        <b>{props.title}</b>
      </text>
      <Show when={props.detail}>
        <text fg={props.detailColor ?? props.theme().text.muted}>{props.detail}</text>
      </Show>
    </box>
  )
}

export function Sidebar(props: { context: any; sessionID: string }) {
  const context = props.context
  const theme = () => context.theme
  const [open, setOpen] = createSignal<Record<string, boolean>>({ context: true, goal: true, todo: true, subagents: true, git: true })
  const isOpen = (key: string) => () => open()[key] !== false
  const toggle = (key: string) => () => setOpen((value) => ({ ...value, [key]: value[key] === false }))

  const session = createMemo(() => context.data.session.get(props.sessionID))
  const rootID = createMemo(() => context.data.session.root(props.sessionID))

  // ---------- server-plugin state ----------
  const keeper = useJsonFile<Meter | undefined>(() => path.join(CK_DIR, `${rootID()}.json`), (raw: any) => raw?.meter, undefined)
  const pinFile = useJsonFile<number | undefined>(
    () => path.join(PIN_DIR, `${safeName(rootID())}.json`),
    (raw: any) => (raw?.pins && typeof raw.pins === "object" ? Object.keys(raw.pins).length : undefined),
    undefined,
  )
  const pins = () => pinFile.value()
  const goalFile = useJsonFile<GoalState>(
    () => path.join(GOAL_DIR, `${rootID()}.json`),
    (raw: any) => ({ goal: raw?.goal ?? null, children: raw?.children }),
    {},
  )
  const todoFile = useJsonFile<Todo[]>(
    () => path.join(TODO_DIR, `${safeName(rootID())}.json`),
    (raw) => (Array.isArray(raw) ? (raw as Todo[]).filter((t) => t && typeof t.content === "string") : []),
    [],
  )

  // ---------- Context ----------
  const messages = createMemo<any[]>(() => context.data.session.message.list(rootID()) ?? [])
  const compactions = createMemo(() => messages().filter((m) => m.type === "compaction" && m.status === "completed").length)
  // The provider's own count for the last request since the last compaction.
  const usage = createMemo(() => {
    const list = messages()
    const boundary = list.findLastIndex((m) => m.type === "compaction" && m.status === "completed")
    const last = list.findLast((m, i) => m.type === "assistant" && m.tokens && i > boundary)
    if (!last) return undefined
    const t = last.tokens
    const prompt = t.input + t.cache.read + t.cache.write
    const total = prompt + t.output + t.reasoning
    return total > 0 ? { total, prompt, cacheRead: t.cache.read, model: last.model as ModelRef } : undefined
  })
  const modelWindow = createMemo(() => {
    const ref = usage()?.model ?? (session()?.model as ModelRef | undefined)
    if (!ref) return 0
    const model = context.data.location.model.list(session()?.location)?.find((m: any) => m.providerID === ref.providerID && m.id === modelKey(ref))
    return model?.limit?.input || model?.limit?.context || 0
  })
  const meter = () => keeper.value()
  const window = createMemo(() => meter()?.window || modelWindow())
  const used = createMemo(() => usage()?.total ?? meter()?.used ?? 0)
  const estimated = () => !usage() && !!meter()
  const percent = createMemo(() => (window() ? Math.min(100, Math.round((used() / window()) * 100)) : undefined))
  const compactAt = createMemo(() => {
    const w = modelWindow()
    return w > 0 ? w - Math.max(Math.floor(w * 0.1), w >= 2 * RESERVE_MIN ? RESERVE_MIN : 0) : 0
  })
  const nextLevel = createMemo(() => LEVELS.find((l) => l > (meter()?.level ?? 0) && (percent() ?? 0) < l))
  const cacheRate = createMemo(() => {
    const u = usage()
    return u && u.prompt > 0 ? Math.round((u.cacheRead / u.prompt) * 100) : undefined
  })
  const cost = createMemo(() => context.data.session.cost(rootID()))
  const zone = () => {
    const p = percent() ?? 0
    return p >= 80 ? theme().text.feedback.error.base : p >= 60 ? theme().text.feedback.warning.base : theme().text.feedback.success.base
  }
  const bar = createMemo(() => {
    const filled = Math.round(((percent() ?? 0) / 100) * BAR)
    const mark = window() && compactAt() ? Math.min(BAR - 1, Math.floor((compactAt() / window()) * BAR)) : -1
    const rest = BAR - filled
    if (mark < filled || mark < 0) return { filled: "█".repeat(filled), before: "░".repeat(rest), mark: "", after: "" }
    return { filled: "█".repeat(filled), before: "░".repeat(mark - filled), mark: "┃", after: "░".repeat(rest - (mark - filled) - 1) }
  })

  // ---------- Goal ----------
  const goal = () => goalFile.value().goal ?? undefined
  const runningChildren = createMemo(() => Object.values(goalFile.value().children ?? {}).filter((s) => s === "running").length)
  const goalVisible = createMemo(() => {
    const g = goal()
    return !!g && (g.status !== "complete" || goalFile.now() - (g.at ?? 0) < DONE_TTL_MS)
  })
  const goalColor = () => {
    const s = goal()?.status
    return s === "active" ? theme().text.feedback.success.base : s === "waiting" ? theme().text.feedback.warning.base : theme().text.muted
  }

  // ---------- Todo ----------
  const todos = () => todoFile.value()
  const todosDone = createMemo(() => todos().filter((t) => t.status === "completed").length)
  const todosFinished = createMemo(() => todos().every((t) => t.status === "completed" || t.status === "cancelled"))
  const todoVisible = createMemo(() => todos().length > 0 && !(todosFinished() && todoFile.now() - todoFile.mtime() > DONE_TTL_MS))
  const clearTodos = () => {
    try {
      mkdirSync(TODO_DIR, { recursive: true })
      writeFileSync(path.join(TODO_DIR, `${safeName(rootID())}.json`), "[]")
    } catch {}
    todoFile.read()
  }
  const todoColor = (status: Todo["status"]) =>
    status === "completed" ? theme().text.feedback.success.base : status === "in_progress" ? theme().text.base : theme().text.muted

  // ---------- Subagents ----------
  const providers = createMemo(() => providersFromContext(context))
  const isRunning = (sessionID: string) => context.data.session.status(sessionID) === "running"
  const subagents = createMemo(() =>
    context.data.session
      .list()
      .filter((item: any) => item.parentID === rootID() && isRunning(item.id))
      .sort((a: any, b: any) => a.time.created - b.time.created),
  )
  const [frame, setFrame] = createSignal(0)
  createEffect(() => {
    if (subagents().length === 0) return
    const timer = setInterval(() => setFrame((value) => (value + 1) % FRAMES.length), 80)
    onCleanup(() => clearInterval(timer))
  })

  // ---------- Git ----------
  const [changes, setChanges] = createSignal<Change[]>([])
  const [branch, setBranch] = createSignal<string | undefined>()
  const [base, setBase] = createSignal<string | undefined>()
  const [loading, setLoading] = createSignal(false)
  const directory = createMemo(() => session()?.directory || context.location?.directory || context.data.location.default().directory)
  const totals = createMemo(() =>
    changes().reduce(
      (sum, change) => ({ files: sum.files + 1, additions: sum.additions + change.additions, deletions: sum.deletions + change.deletions }),
      { files: 0, additions: 0, deletions: 0 },
    ),
  )
  const branchLabel = createMemo(() => {
    const current = branch()
    if (!current) return ""
    const baseName = base()
    return baseName && baseName !== current ? `${current} · base ${baseName}` : current
  })
  // One request at a time. A refresh asked for while one runs is not dropped: it runs once the current one
  // ends, and a result for a directory that is no longer the session's is discarded.
  let again = false
  const refresh = async (requestedDirectory = directory()): Promise<void> => {
    if (!requestedDirectory) return
    if (loading()) {
      again = true
      return
    }
    setLoading(true)
    try {
      const location = { directory: requestedDirectory }
      const [info, status] = await Promise.all([context.client.vcs.get({ location }), context.client.vcs.status({ location })])
      if (requestedDirectory === directory()) {
        setBranch(info.data?.branch?.current)
        setBase(info.data?.branch?.default)
        setChanges(Array.isArray(status.data) ? status.data : [])
      }
    } catch {
      if (requestedDirectory === directory()) {
        setBranch(undefined)
        setBase(undefined)
        setChanges([])
      }
    } finally {
      setLoading(false)
    }
    if (again || requestedDirectory !== directory()) {
      again = false
      return refresh()
    }
  }
  // `on` keeps the callback untracked, so finishing a request does not trigger another.
  createEffect(on(directory, (cwd) => void refresh(cwd)))
  onMount(() => {
    const stop = context.data.listen(({ details }: any) => {
      const type = details?.type ?? ""
      if (type.startsWith("vcs.") || type === "session.created" || type === "session.deleted") void refresh()
    })
    onCleanup(stop)
  })

  return (
    <box flexDirection="column" gap={0} paddingTop={1}>
      {/* Context */}
      <Show when={used() > 0 || cost() > 0}>
        <Header
          theme={theme}
          first
          open={isOpen("context")}
          toggle={toggle("context")}
          title="Context"
          detail={percent() !== undefined ? `${estimated() ? "≈" : ""}${percent()}%` : undefined}
          detailColor={zone()}
        />
        <Show when={isOpen("context")()}>
          <Show when={percent() !== undefined}>
            <box flexDirection="row">
              <text fg={zone()}>{bar().filled}</text>
              <text fg={theme().text.muted}>{bar().before}</text>
              <text fg={theme().text.feedback.warning.base}>{bar().mark}</text>
              <text fg={theme().text.muted}>{bar().after}</text>
            </box>
          </Show>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme().text.base}>
              {estimated() ? "≈" : ""}
              {kilo(used())}
              {window() ? ` / ${kilo(window())}` : ""} tokens
            </text>
            <Show when={cacheRate() !== undefined}>
              <text fg={theme().text.muted}>cache {cacheRate()}%</text>
            </Show>
          </box>
          <Show when={meter() && nextLevel() && window()}>
            <text fg={theme().text.muted}>
              Next clearing at {nextLevel()}% ({kilo((window() * nextLevel()!) / 100)})
            </text>
          </Show>
          <Show when={compactAt() > 0}>
            <box flexDirection="row" gap={1}>
              <text fg={theme().text.feedback.warning.base}>┃</text>
              <text fg={theme().text.muted}>auto-compact at {kilo(compactAt())}</text>
            </box>
          </Show>
          <text fg={theme().text.muted}>
            Compacted {compactions()}×{pins() !== undefined ? ` · ${pins()} pin${pins() === 1 ? "" : "s"}` : ""}
          </text>
          <Show when={(meter()?.cleared ?? 0) > 0}>
            <text fg={theme().text.muted}>
              Cleared {meter()!.cleared} old output{meter()!.cleared === 1 ? "" : "s"} ({kilo(meter()!.clearedChars)} chars)
            </text>
          </Show>
          <Show when={cost() > 0}>
            <text fg={theme().text.muted}>{money.format(cost())} spent</text>
          </Show>
        </Show>
      </Show>

      {/* Goal */}
      <Show when={goalVisible()}>
        <Header
          theme={theme}
          open={isOpen("goal")}
          toggle={toggle("goal")}
          title="Goal"
          detail={`${goal()!.status}${goal()!.continues ? ` · ${goal()!.continues} continue${goal()!.continues === 1 ? "" : "s"}` : ""}`}
          detailColor={goalColor()}
        />
        <Show when={isOpen("goal")()}>
          <text wrapMode="word" fg={theme().text.base}>
            {clip(goal()!.objective, 240)}
          </text>
          <Show when={goal()!.status === "waiting" && goal()!.reason}>
            <text wrapMode="word" fg={theme().text.feedback.warning.base}>
              Waiting: {clip(goal()!.reason!, 160)}
            </text>
          </Show>
          <Show when={goal()!.status === "active" && runningChildren() > 0}>
            <text fg={theme().text.muted}>
              {runningChildren()} background subagent{runningChildren() === 1 ? "" : "s"} still running
            </text>
          </Show>
          <Show when={goal()!.status === "complete" && goal()!.evidence}>
            <text wrapMode="word" fg={theme().text.muted}>
              Done: {clip(goal()!.evidence!, 160)}
            </text>
          </Show>
        </Show>
      </Show>

      {/* Todo */}
      <Show when={todoVisible()}>
        <box flexDirection="row" gap={1} marginTop={1}>
          <box flexDirection="row" gap={1} onMouseDown={toggle("todo")}>
            <text fg={theme().text.muted}>{isOpen("todo")() ? "▼" : "▶"}</text>
            <text fg={theme().text.base}>
              <b>Todo</b>
            </text>
            <text fg={theme().text.muted}>
              {todosDone()}/{todos().length}
            </text>
          </box>
          <Show when={todosFinished()}>
            <text fg={theme().text.muted} onMouseDown={clearTodos}>
              ✕ clear
            </text>
          </Show>
        </box>
        <Show when={isOpen("todo")()}>
          <For each={todos().slice(0, MAX_TODOS)}>
            {(todo) => (
              <box flexDirection="row" gap={1}>
                <text fg={todoColor(todo.status)}>{TODO_MARK[todo.status] ?? "☐"}</text>
                <box flexGrow={1} flexShrink={1}>
                  <text wrapMode="word" fg={todoColor(todo.status)}>
                    {todo.status === "in_progress" ? <b>{todo.content}</b> : todo.content}
                  </text>
                </box>
              </box>
            )}
          </For>
          <Show when={todos().length > MAX_TODOS}>
            <text fg={theme().text.muted}>… {todos().length - MAX_TODOS} more</text>
          </Show>
        </Show>
      </Show>

      {/* Subagents */}
      <Header theme={theme} open={isOpen("subagents")} toggle={toggle("subagents")} title="Subagents" detail={`${subagents().length} running`} />
      <Show when={isOpen("subagents")()}>
        <Show when={subagents().length > 0} fallback={<text fg={theme().text.muted}>None running.</text>}>
          <For each={subagents().slice(0, MAX_SUBAGENTS)}>
            {(item: any) => {
              const child = () => context.data.session.get(item.id) ?? item
              const modelLabel = () => shorten(formatModelLabel(resolveSessionModel(context, item.id, item), providers()), 26)
              return (
                <box flexDirection="column" gap={0} onMouseDown={() => context.ui.tabs.focus(item.id)}>
                  <box flexDirection="row" gap={1}>
                    <text fg={theme().text.feedback.success.base}>{FRAMES[frame()]}</text>
                    <text wrapMode="none" fg={theme().text.base}>
                      {shorten(child().title || child().id, 30)}
                    </text>
                  </box>
                  <Show when={modelLabel()}>
                    <box paddingLeft={2}>
                      <text wrapMode="none" fg={theme().text.muted}>
                        {modelLabel()}
                      </text>
                    </box>
                  </Show>
                </box>
              )
            }}
          </For>
          <Show when={subagents().length > MAX_SUBAGENTS}>
            <text fg={theme().text.muted}>… {subagents().length - MAX_SUBAGENTS} more</text>
          </Show>
        </Show>
      </Show>

      {/* Git */}
      <box flexDirection="row" gap={1} marginTop={1}>
        <box flexDirection="row" gap={1} onMouseDown={toggle("git")}>
          <text fg={theme().text.muted}>{isOpen("git")() ? "▼" : "▶"}</text>
          <text fg={theme().text.base}>
            <b>Git</b>
          </text>
        </box>
        <text fg={theme().text.muted} onMouseDown={() => void refresh()}>
          {loading() ? "refreshing…" : "refresh"}
        </text>
      </box>
      <Show when={isOpen("git")()}>
        <text fg={theme().text.base}>{branch() ? branchLabel() : "No Git metadata for this directory."}</text>
        <Show when={directory()}>
          {(cwd) => (
            <text wrapMode="word" fg={theme().text.muted}>
              {homePath(cwd())}
            </text>
          )}
        </Show>
        <Show
          when={totals().files > 0}
          fallback={
            <Show when={branch()}>
              <text fg={theme().text.muted}>Clean working tree</text>
            </Show>
          }
        >
          <box flexDirection="row" gap={1}>
            <text fg={theme().text.base}>
              {totals().files} changed file{totals().files === 1 ? "" : "s"}
            </text>
            <text fg={theme().diff.text.added}>+{totals().additions}</text>
            <text fg={theme().diff.text.removed}>−{totals().deletions}</text>
          </box>
          <For each={changes().slice(0, MAX_FILES)}>
            {(change) => (
              <box flexDirection="row" justifyContent="space-between" gap={1} onMouseDown={() => openOtty(context, directory(), change)}>
                <text
                  wrapMode="none"
                  fg={
                    change.status === "added"
                      ? theme().text.feedback.success.base
                      : change.status === "deleted"
                        ? theme().text.feedback.error.base
                        : theme().text.base
                  }
                >
                  {shorten(change.file, 26)}
                </text>
                <box flexDirection="row" gap={1}>
                  <text fg={theme().diff.text.added}>+{change.additions}</text>
                  <text fg={theme().diff.text.removed}>−{change.deletions}</text>
                </box>
              </box>
            )}
          </For>
          <Show when={changes().length > MAX_FILES}>
            <text fg={theme().text.muted}>… {changes().length - MAX_FILES} more files</text>
          </Show>
        </Show>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup(context) {
    return context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => <Sidebar context={context} sessionID={sessionID} />,
    })
  },
})
