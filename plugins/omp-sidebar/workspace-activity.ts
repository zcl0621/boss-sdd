import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { splitPathAndSel } from "@oh-my-pi/pi-tui/tools/read";

export interface WorkspaceToolActivity {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  details?: unknown;
  isError: boolean;
}

interface Checkout {
  root: string;
  commonDir: string;
}

interface Target {
  value: string;
  selectors: boolean;
}

interface Targets {
  paths: Target[];
  relativeTo: string;
  directoryOnly: boolean;
  recursiveScope: boolean;
}

interface StartedCall {
  order: number;
  generation: number;
  baseCwd: string;
  toolName: string;
  settled: boolean;
}

interface HistoricalCall {
  order: number;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  result?: WorkspaceToolActivity;
}

// Denied calls may never settle; retain only a bounded window for overlap deduplication.
const MAX_PENDING_CALLS = 256;
const FILESYSTEM_TOOLS: Record<string, true> = {
  bash: true,
  read: true,
  grep: true,
  write: true,
  edit: true,
  glob: true,
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function unquoteTarget(value: string): string {
  // Native write/edit accept the file anchors emitted by read.
  return /^\[([^\r\n]+)#[0-9a-f]{4}\]$/i.exec(value)?.[1] ?? value;
}

function isLocal(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\0") &&
    !/^[a-z][a-z0-9+.-]*:\//i.test(value) &&
    !value.startsWith("//") &&
    !/^www\./i.test(value) &&
    !/^[^/\s]+@[^/\s:]+:/.test(value) &&
    !/^[^/\s:]+:\d+\//.test(value)
  );
}

function localPath(value: string, cwd: string): string {
  const expanded =
    value === "~"
      ? os.homedir()
      : value.startsWith("~/")
        ? path.join(os.homedir(), value.slice(2))
        : value;
  return path.resolve(cwd, expanded);
}

function inputPaths(input: Record<string, unknown>): string[] | undefined {
  if (input.path === undefined || input.path === null) return [];
  if (typeof input.path !== "string") return undefined;
  const paths = input.path.split(";").map((value) => unquoteTarget(value.trim()));
  return paths.every(isLocal) ? paths : undefined;
}

function metadataTargets(values: readonly unknown[], selectors = false): Target[] | undefined {
  const targets: Target[] = [];
  for (const value of values) {
    if (typeof value !== "string") return undefined;
    const clean = unquoteTarget(value);
    if (!isLocal(clean)) return undefined;
    targets.push({ value: clean, selectors });
  }
  return targets.length > 0 ? targets : undefined;
}

function targetsFor(event: WorkspaceToolActivity, baseCwd: string): Targets | undefined {
  const tool = event.toolName.toLowerCase();
  if (FILESYSTEM_TOOLS[tool] !== true || event.isError) return undefined;
  const details = record(event.details);
  if (tool === "bash") {
    if (
      typeof event.input.cwd !== "string" ||
      !isLocal(event.input.cwd) ||
      details?.timedOut === true ||
      details?.cancelled === true ||
      (typeof details?.exitCode === "number" && details.exitCode !== 0)
    )
      return undefined;
    const asyncState = record(details?.async)?.state;
    if (asyncState !== undefined && asyncState !== "completed") return undefined;
    return {
      paths: [{ value: event.input.cwd, selectors: false }],
      relativeTo: baseCwd,
      directoryOnly: true,
      recursiveScope: false,
    };
  }

  // Check the original resource before trusting a materialized cache path in details.
  const supplied = inputPaths(event.input);
  if (!supplied) return undefined;
  const source = record(record(details?.meta)?.source);
  if (source && source.type !== "path") return undefined;
  let paths: Target[] | undefined;
  let relativeTo = baseCwd;
  if (tool === "read" || tool === "write") {
    const resolved = details?.resolvedPath ?? (tool === "read" ? source?.value : undefined);
    paths =
      resolved !== undefined
        ? metadataTargets([resolved])
        : metadataTargets(supplied, tool === "read");
  } else if (tool === "edit") {
    if (Array.isArray(details?.perFileResults)) {
      const values: unknown[] = [];
      for (const result of details.perFileResults) {
        const file = record(result);
        if (!file) return undefined;
        values.push(file.path);
        if (file.sourcePath !== undefined) values.push(file.sourcePath);
      }
      paths = metadataTargets(values);
    } else if (details?.path !== undefined) {
      paths = metadataTargets(
        details.sourcePath === undefined ? [details.path] : [details.path, details.sourcePath],
      );
    } else {
      // Freeform patches are not parsed. Native per-file result metadata handles them.
      paths = metadataTargets(supplied);
    }
  } else {
    // A wildcard prefix or aggregate searchPath can cover several checkouts.
    // Deliberately support literal scopes only rather than infer from matching text.
    if (supplied.some((value) => /[*?[\]{}]/.test(value))) return undefined;
    if (tool === "grep" && details?.cwd !== undefined) {
      if (typeof details.cwd !== "string" || !isLocal(details.cwd)) return undefined;
      relativeTo = localPath(details.cwd, baseCwd);
    }
    paths =
      tool === "grep" && supplied.length <= 1 && details?.searchPath !== undefined
        ? metadataTargets([details.searchPath])
        : metadataTargets(supplied.length > 0 ? supplied : ["."], tool === "grep");
    // scopePath is a display label, not a resolved filesystem target.
  }
  return paths
    ? {
        paths,
        relativeTo,
        directoryOnly: false,
        recursiveScope: tool === "grep" || tool === "glob",
      }
    : undefined;
}

async function existingTarget(target: Target, cwd: string): Promise<string | undefined> {
  try {
    return await fs.realpath(localPath(target.value, cwd));
  } catch {
    if (!target.selectors) return undefined;
    // A real literal filename wins over selector interpretation.
    const parsed = splitPathAndSel(target.value);
    if (!parsed.sel || parsed.path === target.value || !isLocal(parsed.path)) return undefined;
    try {
      return await fs.realpath(localPath(parsed.path, cwd));
    } catch {
      return undefined;
    }
  }
}

async function checkoutAt(target: string, directoryOnly = false): Promise<Checkout | undefined> {
  try {
    const absolute = await fs.realpath(target);
    const stat = await fs.stat(absolute);
    if (!stat.isDirectory() && (directoryOnly || !stat.isFile())) return undefined;
    const info = vcs.gitInfo(stat.isDirectory() ? absolute : path.dirname(absolute));
    if (!info) return undefined;
    const [root, commonDir, entry, commonStat] = await Promise.all([
      fs.realpath(info.repoRoot),
      fs.realpath(info.commonDir),
      fs.stat(info.gitEntryPath),
      fs.stat(info.commonDir),
    ]);
    if ((!entry.isFile() && !entry.isDirectory()) || !commonStat.isDirectory()) return undefined;
    const relative = path.relative(root, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      return undefined;
    return { root, commonDir };
  } catch {
    return undefined;
  }
}

async function resolveWorkspace(
  event: WorkspaceToolActivity,
  baseCwd: string,
): Promise<string | undefined> {
  const targets = targetsFor(event, baseCwd);
  if (!targets) return undefined;
  const base = await checkoutAt(baseCwd, true);
  if (!base) return undefined;
  let selected: string | undefined;
  for (const target of targets.paths) {
    const absolute = await existingTarget(target, targets.relativeTo);
    if (!absolute) return undefined;
    const checkout = await checkoutAt(absolute, targets.directoryOnly);
    if (!checkout || checkout.commonDir !== base.commonDir) return undefined;
    if (targets.recursiveScope) {
      try {
        if ((await fs.stat(absolute)).isDirectory()) {
          const repo = vcs.git(absolute);
          if (!repo) return undefined;
          for (const worktree of await repo.worktrees()) {
            // Stale registrations do not turn a real single-checkout scope ambiguous.
            const root = await fs.realpath(worktree.path).catch(() => undefined);
            if (!root || root === checkout.root) continue;
            const relative = path.relative(absolute, root);
            if (
              relative === "" ||
              (relative !== ".." &&
                !relative.startsWith(`..${path.sep}`) &&
                !path.isAbsolute(relative))
            )
              return undefined;
          }
        }
      } catch {
        return undefined;
      }
    }
    if (selected !== undefined && selected !== checkout.root) return undefined;
    selected = checkout.root;
  }
  // Preserve the native subdirectory when activity returns to the fallback checkout.
  return selected === base.root ? baseCwd : selected;
}

/**
 * Read-only, per-owner projection. Pass the owner's native cwd, never this.cwd,
 * to syncBase; pair each live complete with begin. Supply only getBranch() entries
 * to restore, once on owner creation. No session data or checkout state is written.
 * Literal glob/search scopes are supported; wildcard expansion, archive/SQLite
 * member syntax without resolved metadata, and deleted targets are intentionally
 * not inferred. Restore also seeds unpaired starts for tools already in flight.
 */
export class WorkspaceActivity {
  private baseCwd: string;
  private projectedCwd: string;
  private generation = 0;
  private nextOrder = 0;
  private committedOrder = 0;
  private restored = false;
  private disposed = false;
  private readonly pending = new Map<string, StartedCall>();

  constructor(
    baseCwd: string,
    private readonly onChange: () => void,
  ) {
    this.baseCwd = path.resolve(baseCwd);
    this.projectedCwd = this.baseCwd;
  }

  get cwd(): string {
    return this.projectedCwd;
  }

  /** A changed native cwd invalidates all earlier activity, including pending resolution. */
  syncBase(cwd: string): void {
    if (this.disposed) return;
    const next = path.resolve(cwd);
    if (next === this.baseCwd) return;
    this.baseCwd = next;
    this.generation++;
    this.pending.clear();
    this.restored = true;
    this.publish(next);
  }

  begin(toolCallId: string, toolName: string, _input: Record<string, unknown>): void {
    if (this.disposed || this.pending.has(toolCallId)) return;
    const name = toolName.toLowerCase();
    if (FILESYSTEM_TOOLS[name] !== true) return;
    this.remember(toolCallId, {
      order: ++this.nextOrder,
      generation: this.generation,
      baseCwd: this.baseCwd,
      toolName: name,
      settled: false,
    });
  }

  async complete(event: WorkspaceToolActivity): Promise<void> {
    if (this.disposed) return;
    const call = this.pending.get(event.toolCallId);
    if (!call || call.settled || call.toolName !== event.toolName.toLowerCase()) return;
    call.settled = true;
    if (event.isError || call.generation !== this.generation) return;
    const cwd = await resolveWorkspace(event, call.baseCwd);
    if (
      cwd === undefined ||
      this.disposed ||
      call.generation !== this.generation ||
      call.order <= this.committedOrder
    )
      return;
    this.committedOrder = call.order;
    this.publish(cwd);
  }

  async restore(entries: readonly SessionEntry[]): Promise<void> {
    if (this.disposed || this.restored) return;
    this.restored = true;
    // An already-started live stream owns chronology when initialization was delayed.
    if (this.nextOrder !== 0) return;
    const generation = this.generation;
    const baseCwd = this.baseCwd;
    const calls = new Map<string, HistoricalCall>();
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role === "assistant") {
        for (const content of message.content) {
          if (content.type !== "toolCall" || FILESYSTEM_TOOLS[content.name.toLowerCase()] !== true)
            continue;
          if (calls.has(content.id)) continue;
          calls.set(content.id, {
            order: ++this.nextOrder,
            toolCallId: content.id,
            toolName: content.name,
            input: content.arguments,
          });
        }
      } else if (message.role === "toolResult") {
        const call = calls.get(message.toolCallId);
        if (call && call.toolName.toLowerCase() === message.toolName.toLowerCase()) {
          call.result = {
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: call.input,
            details: message.details,
            isError: message.isError,
          };
        }
      }
    }
    // A child may already be in a call when selected. Its eventual end must retain
    // the original start order, not look newer than later live starts.
    for (const call of calls.values()) {
      this.remember(call.toolCallId, {
        order: call.order,
        generation,
        baseCwd,
        toolName: call.toolName.toLowerCase(),
        settled: call.result !== undefined,
      });
    }
    // Native history can persist results in call order rather than settlement order.
    const ordered = Array.from(calls.values());
    for (let index = ordered.length - 1; index >= 0; index--) {
      if (
        this.disposed ||
        generation !== this.generation ||
        ordered[index].order <= this.committedOrder
      )
        return;
      const result = ordered[index].result;
      if (!result || result.isError) continue;
      const cwd = await resolveWorkspace(result, baseCwd);
      if (
        this.disposed ||
        generation !== this.generation ||
        ordered[index].order <= this.committedOrder
      )
        return;
      if (cwd !== undefined) {
        this.committedOrder = ordered[index].order;
        this.publish(cwd);
        return;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.pending.clear();
  }

  private remember(toolCallId: string, call: StartedCall): void {
    this.pending.set(toolCallId, call);
    if (this.pending.size > MAX_PENDING_CALLS) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
  }

  private publish(cwd: string): void {
    if (cwd === this.projectedCwd) return;
    this.projectedCwd = cwd;
    this.onChange();
  }
}
