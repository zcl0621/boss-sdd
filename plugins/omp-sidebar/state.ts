import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type {
  AgentRef,
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  ReadonlySessionManager,
  SessionEntry,
  ToolCallEvent,
  ToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";
import { sessionFileBelongsToRoot } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { describeModelCompactionPoint } from "@oh-my-pi/pi-coding-agent/session/model-compaction-threshold";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import {
  inspectSidebarService,
  readSidebarServices,
  type SidebarService,
  type SidebarServicesSnapshot,
} from "./services";
import { computeContextParts } from "./context-breakdown";
import { getContextNotes } from "./context-notes";
import type { SidebarInspection, SidebarRow, SidebarSection, SidebarSnapshot } from "./types";
import { SidebarWorkspace } from "./workspace";
import type { SidebarWorkspaceChange } from "./workspace";
import { WorkspaceActivity } from "./workspace-activity";

interface WorkspaceBinding {
  tracker: WorkspaceActivity;
  ready: Promise<void>;
  session?: AgentSession;
  unsubscribe?: () => void;
}

function toolInput(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Match OMP's native Git sidebar semantic colors; resolve them through the current UI theme.
function changeTone(kind: SidebarWorkspaceChange["kind"]): SidebarRow["tone"] {
  switch (kind) {
    case "added":
      return "success";
    case "deleted":
    case "conflicted":
      return "error";
    case "untracked":
      return "muted";
    case "renamed":
    case "copied":
      return "accent";
    default:
      return "warning";
  }
}

interface SelectedScope {
  key: string;
  manager: ReadonlySessionManager;
  session?: AgentSession;
  model?: Model;
  cwd: string;
  owner: string;
  activity: WorkspaceBinding;
}

type SidebarAction =
  | { kind: "agent"; root: string; ref?: AgentRef }
  | { kind: "directory" | "file" | "diff"; scope: string; path: string }
  | { kind: "job"; scope: string; id: string }
  | { kind: "service"; scope: string; service: SidebarService }
  | { kind: "inspection"; scope: string; inspection: SidebarInspection };

const SECTION_NAMES: readonly [string, string][] = [
  ["agents", "Agents"],
  ["context", "Context"],
  ["terminal", "Terminal"],
  ["git", "Git / Worktree"],
  ["directory", "Directory"],
  ["todo", "Todo"],
  ["pins", "Pins"],
  ["goal", "Goal"],
];

function emptySnapshot(): SidebarSnapshot {
  return { sections: SECTION_NAMES.map(([id, title]) => ({ id, title, rows: [] })), usage: {} };
}

/** Read-only sidebar selection, independent of native Agent Hub focus and the provider context. */
export class SidebarState {
  readonly api: ExtensionAPI;
  ctx: ExtensionContext;
  onChange: (() => void) | undefined;
  currentSnapshot = emptySnapshot();
  selected: AgentRef | undefined;
  rootId: string;
  rootFile: string | undefined;
  scopeKey = "";
  liveGenerations = new WeakMap<AgentSession, number>();
  nextLiveGeneration = 0;
  revision = 0;
  disposed = false;
  controller = new AbortController();
  workspace: SidebarWorkspace;
  services: SidebarServicesSnapshot = { services: [] };
  actions = new Map<string, SidebarAction>();
  pending: Promise<void> | undefined;
  pendingKey: string | undefined;
  workspaceBindings = new Map<string, WorkspaceBinding>();

  constructor(api: ExtensionAPI, ctx: ExtensionContext, onChange: () => void) {
    this.api = api;
    this.ctx = ctx;
    this.onChange = onChange;
    this.rootId = ctx.sessionManager.getSessionId();
    this.rootFile = ctx.sessionManager.getSessionFile();
    this.workspace = new SidebarWorkspace(() => this.publish());
  }

  setContext(ctx: ExtensionContext): void {
    if (this.disposed) return;
    const sessionChanged = this.rootId !== ctx.sessionManager.getSessionId();
    const changed = sessionChanged || this.rootFile !== ctx.sessionManager.getSessionFile();
    this.ctx = ctx;
    if (changed) {
      if (sessionChanged) this.clearWorkspaceBindings();
      this.rootId = ctx.sessionManager.getSessionId();
      this.rootFile = ctx.sessionManager.getSessionFile();
      this.selected = undefined;
      this.invalidate();
      this.currentSnapshot = emptySnapshot();
      this.onChange?.();
    }
  }

  snapshot(): SidebarSnapshot {
    if (
      this.disposed ||
      this.rootId !== this.ctx.sessionManager.getSessionId() ||
      this.scope().key !== this.scopeKey
    )
      return emptySnapshot();
    return this.currentSnapshot;
  }

  /** Never associate the process-global Main ref with a different extension session. */
  rootSession(): AgentSession | undefined {
    const ref = this.api.pi.AgentRegistry.global().get(this.ctx.agent.id);
    const session = ref?.session;
    if (!session || session.sessionManager.getSessionId() !== this.rootId) return undefined;
    const file = session.sessionManager.getSessionFile();
    if (this.rootFile && (!file || path.resolve(file) !== path.resolve(this.rootFile)))
      return undefined;
    if (
      this.rootFile &&
      ref?.sessionFile &&
      path.resolve(ref.sessionFile) !== path.resolve(this.rootFile)
    )
      return undefined;
    return session;
  }

  clearWorkspaceBindings(): void {
    for (const binding of this.workspaceBindings.values()) {
      binding.unsubscribe?.();
      binding.tracker.dispose();
    }
    this.workspaceBindings.clear();
  }

  activityFor(manager: ReadonlySessionManager, session?: AgentSession): WorkspaceBinding {
    const owner = manager.getSessionId();
    let binding = this.workspaceBindings.get(owner);
    if (binding && session && binding.session && binding.session !== session) {
      binding.unsubscribe?.();
      binding.tracker.dispose();
      this.workspaceBindings.delete(owner);
      binding = undefined;
    }
    if (!binding) {
      const tracker = new WorkspaceActivity(manager.getCwd(), () => {
        queueMicrotask(() => {
          if (!this.disposed) void this.refresh();
        });
      });
      binding = {
        tracker,
        session,
        ready: tracker.restore(manager.getBranch()).catch((error) => {
          this.api.logger.warn("Sidebar workspace restoration failed", { error: String(error) });
        }),
      };
      this.workspaceBindings.set(owner, binding);
      if (session && owner !== this.rootId) {
        const pending = new Map<string, { toolName: string; input: Record<string, unknown> }>();
        for (const message of session.messages) {
          if (message.role === "assistant") {
            for (const part of message.content)
              if (part.type === "toolCall")
                pending.set(part.id, { toolName: part.name, input: toolInput(part.arguments) });
          } else if (message.role === "toolResult") pending.delete(message.toolCallId);
        }
        binding.unsubscribe = session.subscribe((event) => {
          if (event.type === "tool_execution_start") {
            const input = toolInput(event.args);
            pending.set(event.toolCallId, { toolName: event.toolName, input });
            if (pending.size > 256) {
              const oldest = pending.keys().next().value;
              if (oldest !== undefined) pending.delete(oldest);
            }
            tracker.begin(event.toolCallId, event.toolName, input);
          } else if (event.type === "tool_execution_end") {
            const start = pending.get(event.toolCallId);
            pending.delete(event.toolCallId);
            const result = toolInput(event.result);
            void tracker
              .complete({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                input: start?.input ?? {},
                details: result.details,
                isError: event.isError === true || result.isError === true,
              })
              .catch((error) =>
                this.api.logger.warn("Sidebar child workspace update failed", {
                  error: String(error),
                }),
              );
          }
        });
      }
    }
    binding.tracker.syncBase(manager.getCwd());
    return binding;
  }

  recordToolCall(event: ToolCallEvent, ctx: ExtensionContext): void {
    if (this.disposed || ctx.sessionManager.getSessionId() !== this.rootId) return;
    this.activityFor(this.ctx.sessionManager, this.rootSession()).tracker.begin(
      event.toolCallId,
      event.toolName,
      toolInput(event.input),
    );
  }

  async recordToolResult(event: ToolResultEvent, ctx: ExtensionContext): Promise<void> {
    if (this.disposed || ctx.sessionManager.getSessionId() !== this.rootId) return;
    await this.activityFor(this.ctx.sessionManager, this.rootSession()).tracker.complete(event);
  }

  rootedAgents(): AgentRef[] {
    const registry = this.api.pi.AgentRegistry.global();
    const all = registry.list();
    const belongs = (ref: AgentRef): boolean => {
      if (ref.kind === "main" || ref.kind === "advisor" || ref.status !== "running") return false;
      if (
        ref.sessionFile &&
        (!this.rootFile || !sessionFileBelongsToRoot(ref.sessionFile, this.rootFile))
      )
        return false;
      const file = ref.session?.sessionManager.getSessionFile() ?? ref.sessionFile;
      if (file) return this.rootFile !== undefined && sessionFileBelongsToRoot(file, this.rootFile);
      // Fileless refs need an unbroken, current parent chain ending at THIS live root.
      if (!this.rootSession()) return false;
      const seen = new Set<string>([ref.id]);
      let parent = ref.parentId;
      while (parent) {
        if (parent === this.ctx.agent.id) return true;
        if (seen.has(parent)) return false;
        seen.add(parent);
        const ancestor = registry.get(parent);
        if (!ancestor) return false;
        if (
          ancestor.sessionFile &&
          (!this.rootFile || !sessionFileBelongsToRoot(ancestor.sessionFile, this.rootFile))
        )
          return false;
        const ancestorFile =
          ancestor.session?.sessionManager.getSessionFile() ?? ancestor.sessionFile;
        if (
          ancestorFile &&
          (!this.rootFile || !sessionFileBelongsToRoot(ancestorFile, this.rootFile))
        )
          return false;
        parent = ancestor.parentId;
      }
      return false;
    };
    return all
      .filter(belongs)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  scope(): SelectedScope {
    if (this.selected && (!this.selected.session || !this.rootedAgents().includes(this.selected)))
      this.selected = undefined;
    const session = this.selected?.session ?? this.rootSession();
    const manager = this.selected?.session?.sessionManager ?? this.ctx.sessionManager;
    const owner = manager.getSessionId();
    const activity = this.activityFor(manager, session);
    const cwd = activity.tracker.cwd;
    let generation = session ? this.liveGenerations.get(session) : undefined;
    if (session && generation === undefined) {
      generation = ++this.nextLiveGeneration;
      this.liveGenerations.set(session, generation);
    }
    return {
      key: `${this.rootId}/${this.selected?.id ?? "Main"}/${owner}/${generation ?? "unavailable"}/${path.resolve(cwd)}`,
      manager,
      session,
      owner,
      cwd,
      activity,
      model: this.selected ? session?.model : this.ctx.model,
    };
  }

  invalidate(): void {
    this.revision++;
    this.controller.abort();
    this.controller = new AbortController();
    this.workspace.dispose();
    this.workspace = new SidebarWorkspace(() => this.publish());
    this.services = { services: [] };
    this.scopeKey = "";
    this.actions.clear();
    this.pending = undefined;
    this.pendingKey = undefined;
  }

  publish(): void {
    if (this.disposed) return;
    const scope = this.scope();
    if (this.scopeKey !== scope.key) return;
    this.currentSnapshot = this.compose(scope);
    this.onChange?.();
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    // Session switches may mutate the manager before the extension switch event arrives.
    if (
      this.rootId !== this.ctx.sessionManager.getSessionId() ||
      this.rootFile !== this.ctx.sessionManager.getSessionFile()
    )
      this.setContext(this.ctx);
    const rooted = this.rootedAgents();
    for (const [owner, binding] of this.workspaceBindings) {
      if (owner !== this.rootId && !rooted.some((ref) => ref.session === binding.session)) {
        binding.unsubscribe?.();
        binding.tracker.dispose();
        this.workspaceBindings.delete(owner);
      }
    }
    await this.scope().activity.ready;
    if (this.disposed) return;
    const scope = this.scope();
    if (scope.key !== this.scopeKey) {
      this.invalidate();
      this.scopeKey = scope.key;
    }
    this.publish();
    if (this.pending && this.pendingKey === scope.key) {
      // The initiating refresh owns publication/error handling; peers just await its completion.
      await this.pending.catch(() => undefined);
      return;
    }
    const revision = this.revision;
    const signal = this.controller.signal;
    const promise = (async (): Promise<void> => {
      const [, services] = await Promise.all([
        this.workspace.refresh(scope.cwd),
        readSidebarServices(scope.manager.getCwd(), scope.owner, signal),
      ]);
      if (
        this.disposed ||
        signal.aborted ||
        revision !== this.revision ||
        scope.key !== this.scope().key
      )
        return;
      this.services = services;
      this.publish();
    })();
    this.pending = promise;
    this.pendingKey = scope.key;
    try {
      await promise;
    } catch (error) {
      if (!signal.aborted && !this.disposed && revision === this.revision) {
        this.services = {
          services: [],
          error: `Refresh unavailable: ${error instanceof Error ? error.message : String(error)}`,
        };
        this.publish();
      }
    } finally {
      if (this.pending === promise) {
        this.pending = undefined;
        this.pendingKey = undefined;
      }
    }
  }

  compose(scope: SelectedScope): SidebarSnapshot {
    const actions = new Map<string, SidebarAction>();
    const sections: SidebarSection[] = [];
    const action = (id: string, value: SidebarAction): string => {
      const key = `${value.kind === "agent" ? this.rootId : scope.key}:${id}`;
      actions.set(key, value);
      return key;
    };
    const row = (
      id: string,
      text: string,
      value?: SidebarAction,
      running?: boolean,
      presentation?: Pick<SidebarRow, "detail" | "emphasis" | "tail" | "tone" | "prefix">,
    ): SidebarRow => ({
      id,
      text: sanitizeText(text).replace(/[\r\n\t]+/g, " "),
      action: value && action(id, value),
      running,
      ...presentation,
    });
    const inspection = (title: string, content: string): SidebarAction => ({
      kind: "inspection",
      scope: scope.key,
      inspection: { title, content: sanitizeText(content) },
    });
    const add = (id: string, title: string, rows: SidebarRow[], summary?: string): void => {
      sections.push({ id, title, rows, summary });
    };
    const agents = this.rootedAgents();
    const agentRows: SidebarRow[] = [];
    if (!this.ctx.isIdle())
      agentRows.push(
        row("agent:Main", "Main", { kind: "agent", root: this.rootId }, true, {
          detail: "running",
        }),
      );
    for (const ref of agents) {
      agentRows.push(
        row(`agent:${ref.id}`, ref.displayName, { kind: "agent", root: this.rootId, ref }, true, {
          detail: ref.status,
        }),
        row(
          `agent:${ref.id}:model`,
          ref.session?.model?.id ?? ref.history?.resolvedModel ?? "Model unavailable",
          { kind: "agent", root: this.rootId, ref },
          false,
          { tone: "muted", tail: true },
        ),
      );
    }
    add(
      "agents",
      "Agents",
      agentRows,
      agentRows.length ? `${agents.length + (this.ctx.isIdle() ? 0 : 1)} running` : "Idle",
    );
    const contextRows = [
      row("context:model", scope.model?.id ?? "Model unavailable", undefined, false, {
        tone: "muted",
        tail: true,
      }),
    ];
    const usage = this.selected ? scope.session?.getContextUsage() : this.ctx.getContextUsage();
    let compactAt: number | undefined;
    if (scope.session && scope.model) {
      const point = describeModelCompactionPoint(scope.session.settings, scope.model);
      compactAt = point.tokens;
    }
    add(
      "context",
      this.selected ? `Context · ${this.selected.displayName}` : "Context",
      contextRows,
    );

    const terminal: SidebarRow[] = [];
    const jobs = this.selected
      ? scope.session?.getAsyncJobSnapshot()
      : this.ctx.getAsyncJobSnapshot();
    const seenJobs = new Set<string>();
    for (const job of jobs?.running ?? []) {
      // Only running command-bearing bash jobs represent active OS processes.
      if (job.status !== "running" || job.type !== "bash" || !job.command || seenJobs.has(job.id))
        continue;
      seenJobs.add(job.id);
      terminal.push(
        row(
          `job:${job.id}`,
          job.command,
          {
            kind: "job",
            scope: scope.key,
            id: job.id,
          },
          true,
          { detail: job.id },
        ),
      );
    }
    for (const service of this.services.services) {
      const daemon = service.snapshot;
      if (service.saved || (daemon.state !== "running" && daemon.state !== "ready")) continue;
      terminal.push(
        row(
          `service:${daemon.id}`,
          daemon.name,
          { kind: "service", scope: scope.key, service },
          true,
          { detail: `${daemon.state}${daemon.pid === undefined ? "" : ` ${daemon.pid}`}` },
        ),
      );
    }
    if (this.services.error)
      terminal.push(
        row("terminal:error", this.services.error, undefined, false, { tone: "error" }),
      );
    add(
      "terminal",
      "Terminal",
      terminal,
      terminal.length
        ? `${terminal.filter((item) => item.running).length} running`
        : jobs
          ? "Idle"
          : "Unavailable",
    );

    const workspace = this.workspace.snapshot;
    const git: SidebarRow[] = [];
    const directory: SidebarRow[] = [];
    if (workspace.cwd !== path.resolve(scope.cwd)) {
      git.push(row("git:loading", "Loading repository…"));
      directory.push(row("directory:loading", "Loading directory…"));
    } else {
      if (workspace.repositoryState === "absent") git.push(row("git:absent", "No Git repository"));
      else if (workspace.repositoryState === "loading")
        git.push(row("git:loading", "Loading repository…"));
      if (workspace.repoRoot) {
        git.push(
          row(
            "git:branch",
            workspace.branch ?? "detached HEAD",
            inspection(
              "Repository",
              `${workspace.repoRoot}\nBranch: ${workspace.branch ?? "detached HEAD"}\nHEAD: ${workspace.head ?? "unborn or unavailable"}`,
            ),
            false,
            { tone: "accent", emphasis: true, detail: workspace.head?.slice(0, 8) },
          ),
        );
        const tree = workspace.currentWorktree;
        if (tree)
          git.push(
            row(
              `worktree:${tree.path}`,
              tree.path,
              inspection(
                "Active worktree",
                `Path: ${tree.path}\nBranch: ${tree.branch ?? "detached"}\nHEAD: ${tree.head ?? "unavailable"}`,
              ),
              false,
              { tone: "muted", tail: true },
            ),
          );
        for (const change of workspace.changes) {
          const item = row(
            `diff:${change.absolutePath}`,
            `${change.oldPath ? `${change.oldPath} → ` : ""}${change.path}`,
            { kind: "diff", scope: scope.key, path: change.absolutePath },
            false,
            {
              prefix: change.status,
              tail: true,
              detail: change.binary
                ? "binary"
                : change.additions === null || change.deletions === null
                  ? "counts ?"
                  : `+${change.additions} −${change.deletions}`,
            },
          );
          item.tone = changeTone(change.kind);
          git.push(item);
        }
        // Background polling retains the last verified repository state until new data arrives.
        if (!workspace.changes.length && workspace.repositoryState === "ready")
          git.push(row("git:clean", "Working tree clean", undefined, false, { tone: "muted" }));
      }
      directory.push(
        row("directory:root", workspace.directoryRoot, undefined, false, {
          tone: "muted",
          tail: true,
        }),
      );
      for (const entry of workspace.entries) {
        const item = row(
          `directory:${entry.path}`,
          `${"  ".repeat(entry.depth)}${entry.type === "directory" ? (entry.expanded ? "▾" : "▸") : entry.type === "symlink" ? "↗" : "·"} ${entry.name}`,
          {
            kind: entry.type === "directory" ? "directory" : "file",
            scope: scope.key,
            path: entry.path,
          },
        );
        if (entry.change) item.tone = changeTone(entry.change);
        directory.push(item);
      }
      for (const error of workspace.errors)
        (error.source === "directory" ? directory : git).push(
          row(`error:${error.source}:${error.path}`, error.message, undefined, false, {
            tone: "error",
          }),
        );
      if (directory.length === 1)
        directory.push(
          row("directory:empty", workspace.loading ? "Loading directory…" : "Empty directory"),
        );
    }
    add("git", "Git / Worktree", git);
    add("directory", "Directory", directory);

    const branch = scope.manager.getBranch();
    const phases: TodoPhase[] = this.selected
      ? (scope.session?.getTodoPhases() ?? [])
      : this.api.pi.getLatestTodoPhasesFromEntries(branch);
    const todo: SidebarRow[] = [];
    for (const phase of phases) {
      todo.push(row(`todo:phase:${phase.name}`, phase.name, undefined, false, { emphasis: true }));
      for (const task of phase.tasks)
        todo.push(
          row(
            `todo:${phase.name}:${task.content}`,
            `${task.status === "completed" ? "✓" : task.status === "in_progress" ? "●" : task.status === "blocked" ? "!" : task.status === "abandoned" ? "−" : "○"} ${task.content}`,
            inspection(
              `Todo · ${phase.name}`,
              `${task.content}\nStatus: ${task.status}${task.blocker ? `\nBlocked: ${task.blocker}` : ""}${task.details ? `\n\n${task.details}` : ""}${task.notes?.length ? `\n\n${task.notes.join("\n")}` : ""}`,
            ),
            false,
            {
              tone:
                task.status === "completed" || task.status === "abandoned"
                  ? "muted"
                  : task.status === "blocked"
                    ? "warning"
                    : task.status === "in_progress"
                      ? "accent"
                      : "text",
            },
          ),
        );
    }
    const tasks = phases.flatMap((phase) => phase.tasks);
    add(
      "todo",
      "Todo",
      todo,
      tasks.length
        ? `${tasks.filter((task) => task.status === "completed").length}/${tasks.length}`
        : "None",
    );

    const pins: SidebarRow[] = [];
    const notes = getContextNotes(branch)?.text ?? "";
    const seen = new Map<string, number>();
    for (const line of notes.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const text = line.trim().slice(0, 40);
      const n = seen.get(text) ?? 0;
      seen.set(text, n + 1);
      pins.push(row(`pin:${n}:${text}`, line, inspection("Pins · context notes", notes)));
    }
    add("pins", "Pins", pins, pins.length ? String(pins.length) : "None");

    const liveGoal = scope.session?.getGoalModeState();
    const modeEntry = branch.findLast((entry: SessionEntry) => entry.type === "mode_change");
    const savedGoal =
      modeEntry?.type === "mode_change" ? this.api.pi.goalFromModeData(modeEntry.data) : undefined;
    const goal = liveGoal?.goal ?? savedGoal;
    const goalRows: SidebarRow[] = [];
    if (goal) {
      const label = liveGoal
        ? `${liveGoal.enabled ? liveGoal.mode : "disabled"} · ${goal.status}`
        : `saved · ${goal.status}`;
      const content = `${goal.objective}\n${label}\nTokens: ${goal.tokensUsed}${goal.tokenBudget === undefined ? "" : ` / ${goal.tokenBudget}`}\nElapsed: ${goal.timeUsedSeconds}s`;
      goalRows.push(
        row(`goal:${goal.id}`, goal.objective, inspection("Goal (read-only)", content), false, {
          detail: goal.status,
        }),
      );
    }
    add("goal", "Goal", goalRows, goalRows.length ? undefined : "None");
    this.actions = actions;
    return {
      sections,
      usage: {
        tokens: usage?.tokens,
        contextWindow: usage?.contextWindow,
        compactAt,
        estimated: usage !== undefined,
        parts: computeContextParts(scope.session)?.parts,
      },
    };
  }

  async activate(action: string): Promise<SidebarInspection | undefined> {
    if (this.disposed || this.rootId !== this.ctx.sessionManager.getSessionId()) return undefined;
    const operation = this.actions.get(action);
    if (!operation) return undefined;
    if (operation.kind === "agent") {
      if (operation.root !== this.rootId) return undefined;
      if (
        operation.ref &&
        (!this.rootedAgents().includes(operation.ref) || !operation.ref.session)
      ) {
        return {
          title: operation.ref.displayName,
          content:
            "Live transcript unavailable; this agent is parked, removed, or outside the current root session.",
          live: true,
        };
      }
      const requestedSession = operation.ref?.session;
      if (this.selected !== operation.ref) {
        this.selected = operation.ref;
        this.invalidate();
        await this.refresh();
      }
      const selectedScope = this.scope();
      if (
        this.disposed ||
        operation.root !== this.rootId ||
        this.selected !== operation.ref ||
        (operation.ref && selectedScope.session !== requestedSession)
      )
        return undefined;
      const session = selectedScope.session;
      const title = this.selected?.displayName ?? "Main";
      if (!session) return { title, content: "Live session access unavailable.", live: true };
      const messages: AgentMessage[] = session.messages.slice(-200);
      const stream = session.agent.state.streamMessage;
      if (stream && !messages.includes(stream)) messages.push(stream);
      let content = this.api.pi.formatSessionDumpText({ messages, model: session.model });
      if (session.messages.length > 200)
        content = `[Showing the latest 200 messages]\n\n${content}`;
      for (const update of session.activeToolExecutionUpdates())
        content += `\n\nLive tool · ${update.toolName}\n${JSON.stringify(update.partialResult, null, 2)}`;
      return {
        title: `${title} · read-only live transcript`,
        content: sanitizeText(content).slice(-1024 * 1024),
        live: true,
      };
    }
    const scope = this.scope();
    if (operation.scope !== scope.key || scope.key !== this.scopeKey) return undefined;
    const revision = this.revision;
    const signal = this.controller.signal;
    let result: SidebarInspection | undefined;
    try {
      switch (operation.kind) {
        case "directory":
          await this.workspace.toggleDirectory(operation.path);
          return undefined;
        case "file": {
          const preview = await this.workspace.previewFor(operation.path);
          if (preview) result = { ...preview, content: sanitizeText(preview.content) };
          break;
        }
        case "diff": {
          const diff = await this.workspace.diffFor(operation.path);
          if (diff) result = { title: diff.title, content: sanitizeText(diff.text) };
          break;
        }
        case "service":
          result = await inspectSidebarService(operation.service, scope.owner, signal);
          break;
        case "job": {
          const details = scope.session?.inspectAsyncJob(operation.id);
          result = {
            title: `Terminal · ${operation.id}`,
            live: true,
            content: details
              ? sanitizeText(
                  `${details.command ?? operation.id}\nCwd: ${details.cwd ?? "unavailable"}\nPIDs: ${details.pids.join(", ") || "none"}\nExit: ${details.exitCode ?? "not reported"}${details.artifactId ? `\nFull output: ${details.artifactId}` : ""}\n\n${details.output ?? "Output unavailable"}`,
                )
              : "Output unavailable: the host exposes this job snapshot but no matching live owner session inspection.",
          };
          break;
        }
        case "inspection":
          result = operation.inspection;
          break;
      }
    } catch (error) {
      if (signal.aborted) return undefined;
      result = {
        title: "Inspection unavailable",
        content: sanitizeText(error instanceof Error ? error.message : String(error)),
      };
    }
    if (
      this.disposed ||
      signal.aborted ||
      revision !== this.revision ||
      scope.key !== this.scope().key
    )
      return undefined;
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revision++;
    this.controller.abort();
    this.clearWorkspaceBindings();
    this.workspace.dispose();
    this.actions.clear();
    this.services = { services: [] };
    this.onChange = undefined;
  }
}
