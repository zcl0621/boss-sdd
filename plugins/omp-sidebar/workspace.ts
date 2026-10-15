import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VcsGitRepo, VcsNumstatEntry } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { BINARY_SNIFF_BYTES, isProbablyBinaryHeader } from "@oh-my-pi/pi-utils";
import { resolveActiveRepoContext } from "@oh-my-pi/pi-coding-agent/utils/active-repo-context";
import type { SidebarInspection } from "./types";

export interface SidebarWorkspaceWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  current: boolean;
  detached: boolean;
}

export interface SidebarWorkspaceChange {
  /** Repository-relative destination path, without Git's porcelain quoting. */
  path: string;
  absolutePath: string;
  oldPath: string | null;
  /** Porcelain-v1 XY status, including spaces. */
  status: string;
  kind:
    | "modified"
    | "added"
    | "deleted"
    | "renamed"
    | "copied"
    | "untracked"
    | "conflicted"
    | "typechanged";
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  /** Staged plus unstaged line counts; null for binary or unavailable counts. */
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface SidebarDirectoryEntry {
  path: string;
  name: string;
  /** Children of directoryRoot have depth zero. */
  depth: number;
  type: "directory" | "file" | "symlink" | "other";
  expanded: boolean;
  change?: SidebarWorkspaceChange["kind"];
}

export interface SidebarWorkspaceError {
  source: "repository" | "directory";
  path: string;
  message: string;
}

export interface SidebarWorkspaceSnapshot {
  cwd: string;
  /** Actual repository/worktree root, or cwd when no repository is available. */
  directoryRoot: string;
  loading: boolean;
  repositoryState: "loading" | "ready" | "absent" | "error";
  repoRoot: string | null;
  branch: string | null;
  head: string | null;
  currentWorktree: SidebarWorkspaceWorktree | null;
  changes: readonly SidebarWorkspaceChange[];
  entries: readonly SidebarDirectoryEntry[];
  errors: readonly SidebarWorkspaceError[];
}

export interface SidebarWorkspaceDiff {
  path: string;
  title: string;
  text: string;
  binary: boolean;
  truncated: boolean;
  error: string | null;
}

interface RepositorySnapshot {
  repo: VcsGitRepo | null;
  repositoryState: "ready" | "absent" | "error";
  repoRoot: string | null;
  branch: string | null;
  head: string | null;
  currentWorktree: SidebarWorkspaceWorktree | null;
  changes: SidebarWorkspaceChange[];
  errors: SidebarWorkspaceError[];
}

const MAX_TREE_ENTRIES = 4000;
const MAX_TREE_DEPTH = 64;
const MAX_DIFF_BYTES = 1024 * 1024;
// A stable severity order for folders containing several kinds of changes.
const CHANGE_SEVERITY: Record<SidebarWorkspaceChange["kind"], number> = {
  conflicted: 8,
  modified: 7,
  renamed: 6,
  typechanged: 5,
  copied: 4,
  added: 3,
  untracked: 2,
  deleted: 1,
};
const CONFLICT_STATES: Record<string, true> = {
  DD: true,
  AU: true,
  UD: true,
  UA: true,
  DU: true,
  AA: true,
  UU: true,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptySnapshot(cwd: string): SidebarWorkspaceSnapshot {
  return {
    cwd,
    directoryRoot: cwd,
    loading: false,
    repositoryState: "absent",
    repoRoot: null,
    branch: null,
    head: null,
    currentWorktree: null,
    changes: [],
    entries: [],
    errors: [],
  };
}

function changeKind(status: string): SidebarWorkspaceChange["kind"] {
  if (status === "??") return "untracked";
  if (CONFLICT_STATES[status]) return "conflicted";
  if (status.includes("R")) return "renamed";
  if (status.includes("C")) return "copied";
  if (status.includes("D")) return "deleted";
  if (status.includes("A")) return "added";
  if (status.includes("T")) return "typechanged";
  return "modified";
}

function parseChanges(root: string, statusText: string): SidebarWorkspaceChange[] {
  const changes: SidebarWorkspaceChange[] = [];
  const records = statusText.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    const renamed = status.includes("R") || status.includes("C");
    const oldPath = renamed ? (records[++index] ?? null) : null;
    const untracked = status === "??";
    changes.push({
      path: filePath,
      absolutePath: path.join(root, filePath),
      oldPath,
      status,
      kind: changeKind(status),
      staged: !untracked && status[0] !== " ",
      unstaged: untracked || status[1] !== " ",
      untracked,
      additions: null,
      deletions: null,
      binary: false,
    });
  }
  return changes.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

/** Index canonical status once, including changed descendants of collapsed folders. */
function directoryChangeKinds(
  root: string,
  changes: readonly SidebarWorkspaceChange[],
): Map<string, SidebarWorkspaceChange["kind"]> {
  const kinds = new Map<string, SidebarWorkspaceChange["kind"]>();
  const mark = (filePath: string, kind: SidebarWorkspaceChange["kind"]): void => {
    const relative = path.relative(root, filePath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      return;
    for (let current = filePath; current !== root; current = path.dirname(current)) {
      const previous = kinds.get(current);
      if (!previous || CHANGE_SEVERITY[kind] > CHANGE_SEVERITY[previous]) kinds.set(current, kind);
    }
  };
  for (const change of changes) {
    mark(change.absolutePath, change.kind);
    // A rename also changes the source folder, even though the old file is absent.
    if (change.kind === "renamed" && change.oldPath)
      mark(path.dirname(path.resolve(root, change.oldPath)), change.kind);
  }
  return kinds;
}

function lineCount(text: string): number {
  let lines = 0;
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) lines++;
  return lines + (text.length > 0 && !text.endsWith("\n") ? 1 : 0);
}

async function untrackedStats(file: SidebarWorkspaceChange, signal: AbortSignal): Promise<void> {
  const stat = await fs.lstat(file.absolutePath);
  if (stat.isSymbolicLink()) {
    file.additions = lineCount(await fs.readlink(file.absolutePath));
    file.deletions = 0;
    return;
  }
  if (!stat.isFile()) throw new Error("Untracked entry is not a regular file or symlink");
  const handle = await fs.open(
    file.absolutePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("Untracked entry is no longer a regular file");
    const header = Buffer.alloc(Math.min(opened.size, BINARY_SNIFF_BYTES));
    const { bytesRead: headerBytes } = await handle.read(header, 0, header.length, 0);
    file.binary = isProbablyBinaryHeader(header.subarray(0, headerBytes));
    // Periodic refreshes must not stream arbitrarily large untracked files.
    if (file.binary || opened.size > MAX_DIFF_BYTES) return;
    signal.throwIfAborted();
    const buffer = Buffer.alloc(opened.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    let lines = 0;
    for (let index = 0; index < bytesRead; index++) if (buffer[index] === 10) lines++;
    file.additions = lines + (bytesRead > 0 && buffer[bytesRead - 1] !== 10 ? 1 : 0);
    file.deletions = 0;
  } finally {
    await handle.close();
  }
}

/** Async data owner only: rendering reads snapshot and never touches Git or the filesystem. */
export class SidebarWorkspace {
  #snapshot = emptySnapshot("");
  #repo: VcsGitRepo | null = null;
  #expanded = new Set<string>();
  #directoryChanges = new Map<string, SidebarWorkspaceChange["kind"]>();
  #context = 0;
  #refresh = 0;
  #tree = 0;
  #disposed = false;
  #contextController = new AbortController();
  #controller: AbortController | null = null;
  #onChange: (() => void) | undefined;

  constructor(onChange?: () => void) {
    this.#onChange = onChange;
  }

  get snapshot(): SidebarWorkspaceSnapshot {
    return this.#snapshot;
  }

  #publish(snapshot: SidebarWorkspaceSnapshot): void {
    if (this.#disposed) return;
    this.#snapshot = snapshot;
    this.#onChange?.();
  }

  /** Replaces cwd-scoped state synchronously before starting any asynchronous discovery. */
  async refresh(cwd: string): Promise<void> {
    if (this.#disposed) return;
    cwd = path.resolve(cwd);
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    const refresh = ++this.#refresh;
    if (cwd !== this.#snapshot.cwd) {
      this.#context++;
      this.#contextController.abort();
      this.#contextController = new AbortController();
      this.#repo = null;
      this.#expanded.clear();
      this.#directoryChanges.clear();
      this.#tree++;
      this.#publish({ ...emptySnapshot(cwd), loading: true, repositoryState: "loading" });
    } else {
      this.#publish({ ...this.#snapshot, loading: true });
    }
    let context = this.#context;
    const repository = await this.#readRepository(cwd, controller.signal);
    if (this.#disposed || refresh !== this.#refresh || context !== this.#context) return;
    const { repo, errors, ...fields } = repository;
    const directoryRoot = fields.repoRoot ?? cwd;
    const rootChanged = directoryRoot !== this.#snapshot.directoryRoot;
    if (rootChanged) {
      context = ++this.#context;
      this.#contextController.abort();
      this.#contextController = new AbortController();
      this.#expanded.clear();
    }
    // Invalidate in-flight expansions before publishing a new root or status index.
    this.#tree++;
    this.#repo = repo;
    this.#directoryChanges = directoryChangeKinds(directoryRoot, fields.changes);
    const entries = rootChanged
      ? []
      : this.#snapshot.entries.map(({ change: _previous, ...entry }) => ({
          ...entry,
          change: this.#directoryChanges.get(entry.path),
        }));
    this.#publish({
      ...this.#snapshot,
      ...fields,
      directoryRoot,
      entries,
      errors: [
        ...errors,
        ...(rootChanged
          ? []
          : this.#snapshot.errors.filter((error) => error.source === "directory")),
      ],
    });
    await this.#refreshTree(directoryRoot, context);
    if (this.#disposed || refresh !== this.#refresh || context !== this.#context) return;
    this.#publish({ ...this.#snapshot, loading: false });
  }

  async #readRepository(cwd: string, signal: AbortSignal): Promise<RepositorySnapshot> {
    const result: RepositorySnapshot = {
      repo: null,
      repositoryState: "absent",
      repoRoot: null,
      branch: null,
      head: null,
      currentWorktree: null,
      changes: [],
      errors: [],
    };
    const fail = (error: unknown, filePath = cwd): void => {
      result.repositoryState = "error";
      result.errors.push({ source: "repository", path: filePath, message: errorMessage(error) });
    };
    try {
      if (!(await fs.stat(cwd)).isDirectory()) throw new Error("Workspace path is not a directory");
      signal.throwIfAborted();
      let repo = vcs.git(cwd);
      if (!repo) {
        const active = await resolveActiveRepoContext(cwd);
        signal.throwIfAborted();
        if (active) repo = vcs.git(active.repoRoot);
      }
      if (!repo) {
        if (vcs.repo(cwd)) throw new Error("Workspace repository does not provide Git metadata");
        return result;
      }
      result.repo = repo;
      result.repoRoot = path.resolve(repo.info().repoRoot);
      result.repositoryState = "ready";
      const [head, status, stagedStats, unstagedStats] = await Promise.allSettled([
        repo.head(signal),
        repo.statusPorcelain({ untracked: "all", nulTerminated: true }, signal),
        repo.numstat({ cached: true }, signal),
        repo.numstat({}, signal),
      ]);
      signal.throwIfAborted();
      if (head.status === "fulfilled") {
        result.branch = head.value.branch ?? null;
        result.head = head.value.commit ?? null;
      } else fail(head.reason);
      result.currentWorktree = {
        path: result.repoRoot,
        head: result.head,
        branch: result.branch,
        current: true,
        detached: head.status === "fulfilled" && !result.branch && result.head !== null,
      };
      if (status.status === "fulfilled")
        result.changes = parseChanges(result.repoRoot, status.value);
      else fail(status.reason);
      if (stagedStats.status === "rejected") fail(stagedStats.reason);
      if (unstagedStats.status === "rejected") fail(unstagedStats.reason);
      const staged = new Map<string, VcsNumstatEntry>(
        stagedStats.status === "fulfilled"
          ? stagedStats.value.map((entry) => [entry.path, entry])
          : [],
      );
      const unstaged = new Map<string, VcsNumstatEntry>(
        unstagedStats.status === "fulfilled"
          ? unstagedStats.value.map((entry) => [entry.path, entry])
          : [],
      );
      for (const file of result.changes) {
        if (file.untracked) continue;
        const counts = [
          file.staged ? staged.get(file.path) : undefined,
          file.unstaged ? unstaged.get(file.path) : undefined,
        ];
        file.binary = counts.some(
          (count) =>
            count !== undefined && (count.added === undefined || count.removed === undefined),
        );
        if (file.binary || (file.staged && !counts[0]) || (file.unstaged && !counts[1])) continue;
        file.additions = (counts[0]?.added ?? 0) + (counts[1]?.added ?? 0);
        file.deletions = (counts[0]?.removed ?? 0) + (counts[1]?.removed ?? 0);
      }
      // Bound concurrent file reads without materializing all untracked contents in memory.
      const pending = result.changes.filter((file) => file.untracked)[Symbol.iterator]();
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          for (const file of pending) {
            signal.throwIfAborted();
            try {
              await untrackedStats(file, signal);
            } catch (error) {
              signal.throwIfAborted();
              fail(error, file.absolutePath);
            }
          }
        }),
      );
    } catch (error) {
      if (!signal.aborted) fail(error);
    }
    return result;
  }

  /** Only visible real directories can be expanded; symlinks are always leaves. */
  async toggleDirectory(directoryPath: string): Promise<void> {
    if (this.#disposed) return;
    directoryPath = path.resolve(this.#snapshot.directoryRoot, directoryPath);
    const entry = this.#snapshot.entries.find((item) => item.path === directoryPath);
    if (entry?.type !== "directory") return;
    if (this.#expanded.has(directoryPath)) this.#expanded.delete(directoryPath);
    else this.#expanded.add(directoryPath);
    await this.#refreshTree(this.#snapshot.directoryRoot, this.#context);
  }

  async #refreshTree(directoryRoot: string, context: number): Promise<void> {
    const revision = ++this.#tree;
    const expanded = new Set(this.#expanded);
    const changes = this.#directoryChanges;
    const entries: SidebarDirectoryEntry[] = [];
    const errors: SidebarWorkspaceError[] = [];
    const current = (): boolean =>
      !this.#disposed &&
      context === this.#context &&
      revision === this.#tree &&
      directoryRoot === this.#snapshot.directoryRoot;
    const visit = async (directoryPath: string, depth: number): Promise<void> => {
      if (!current()) return;
      try {
        // Recheck expanded entries: a directory may have become a symlink since the last snapshot.
        if (directoryPath !== directoryRoot && !(await fs.lstat(directoryPath)).isDirectory())
          return;
        const children = await fs.readdir(directoryPath, { withFileTypes: true });
        children.sort((left, right) => {
          const directoryOrder = Number(right.isDirectory()) - Number(left.isDirectory());
          return directoryOrder || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
        });
        for (const child of children) {
          if (!current()) return;
          if (entries.length >= MAX_TREE_ENTRIES)
            throw new Error(`Directory view limited to ${MAX_TREE_ENTRIES} entries`);
          const childPath = path.join(directoryPath, child.name);
          const type = child.isSymbolicLink()
            ? "symlink"
            : child.isDirectory()
              ? "directory"
              : child.isFile()
                ? "file"
                : "other";
          const isExpanded = type === "directory" && expanded.has(childPath);
          entries.push({
            path: childPath,
            name: child.name,
            depth,
            type,
            expanded: isExpanded,
            change: changes.get(childPath),
          });
          if (!isExpanded) continue;
          if (depth >= MAX_TREE_DEPTH) {
            errors.push({
              source: "directory",
              path: childPath,
              message: `Directory depth limited to ${MAX_TREE_DEPTH}`,
            });
          } else await visit(childPath, depth + 1);
        }
      } catch (error) {
        errors.push({ source: "directory", path: directoryPath, message: errorMessage(error) });
      }
    };
    await visit(directoryRoot, 0);
    if (!current()) return;
    this.#publish({
      ...this.#snapshot,
      entries,
      errors: [...this.#snapshot.errors.filter((error) => error.source !== "directory"), ...errors],
    });
  }

  /** Null means the request belongs to a previous scope/root, or this owner was disposed. */
  async diffFor(file: SidebarWorkspaceChange | string): Promise<SidebarWorkspaceDiff | null> {
    const repo = this.#repo;
    const root = this.#snapshot.repoRoot;
    if (this.#disposed || !repo || !root) return null;
    const absolutePath = typeof file === "string" ? path.resolve(root, file) : file.absolutePath;
    const change = this.#snapshot.changes.find((entry) => entry.absolutePath === absolutePath);
    if (!change) return null;
    const context = this.#context;
    const signal = this.#contextController.signal;
    const result: SidebarWorkspaceDiff = {
      path: change.path,
      title: change.oldPath ? `${change.oldPath} → ${change.path}` : change.path,
      text: "",
      binary: change.binary,
      truncated: false,
      error: null,
    };
    try {
      if (change.binary) {
        result.text = `Binary file changed: ${change.path}\nText diff is unavailable.\n`;
      } else if (change.untracked) {
        const stat = await fs.lstat(absolutePath);
        if (stat.size > MAX_DIFF_BYTES) {
          result.truncated = true;
          result.text = `Untracked file exceeds the ${MAX_DIFF_BYTES}-byte diff limit: ${change.path}\n`;
        } else {
          result.text = await repo.diffNoIndex(
            process.platform === "win32" ? "NUL" : "/dev/null",
            absolutePath,
            false,
            signal,
          );
        }
      } else {
        const files = [change.path, ...(change.oldPath ? [change.oldPath] : [])].map(
          (filePath) => `:(literal)${filePath}`,
        );
        const parts: string[] = [];
        if (change.staged) {
          const staged = await repo.diffText(
            { cached: true, files, maxBytes: MAX_DIFF_BYTES },
            signal,
          );
          if (staged) parts.push(`Staged changes\n\n${staged}`);
        }
        if (change.unstaged) {
          const unstaged = await repo.diffText({ files, maxBytes: MAX_DIFF_BYTES }, signal);
          if (unstaged) parts.push(`Unstaged changes\n\n${unstaged}`);
        }
        result.text = vcs.joinPatches(parts);
      }
      if (!result.text)
        result.text = `No diff available for ${change.path}; the file may have changed since refresh.\n`;
      // A file can become binary between the status snapshot and activation.
      if (/^Binary files .+ differ$/m.test(result.text)) result.binary = true;
    } catch (error) {
      result.truncated = vcs.isVcsError(error) && error.code === "OutputTooLarge";
      result.error = errorMessage(error);
      result.text = `Unable to load diff for ${change.path}: ${result.error}\n`;
    }
    return this.#disposed || context !== this.#context ? null : result;
  }

  /** Preview only a visible leaf, never following a symlink or opening a device. */
  async previewFor(filePath: string): Promise<SidebarInspection | undefined> {
    filePath = path.resolve(this.#snapshot.directoryRoot, filePath);
    const entry = this.#snapshot.entries.find((item) => item.path === filePath);
    if (this.#disposed || !entry || entry.type === "directory") return undefined;
    const context = this.#context;
    const directoryRoot = this.#snapshot.directoryRoot;
    let content: string;
    try {
      const [root, parent] = await Promise.all([
        fs.realpath(directoryRoot),
        fs.realpath(path.dirname(entry.path)),
      ]);
      const relative = path.relative(root, parent);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new Error("Preview path moved outside the current workspace");
      const stat = await fs.lstat(entry.path);
      if (stat.isSymbolicLink())
        content = `Symlink → ${await fs.readlink(entry.path)}\nTarget is not followed.`;
      else if (!stat.isFile()) content = "Not a regular file; preview unavailable.";
      else {
        const handle = await fs.open(
          entry.path,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        );
        try {
          const opened = await handle.stat();
          if (!opened.isFile()) content = "Not a regular file; preview unavailable.";
          else {
            const buffer = Buffer.alloc(Math.min(opened.size, MAX_DIFF_BYTES));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            const bytes = buffer.subarray(0, bytesRead);
            content = isProbablyBinaryHeader(bytes.subarray(0, BINARY_SNIFF_BYTES))
              ? `Binary file (${opened.size} bytes); text preview unavailable.`
              : bytes.toString("utf8") +
                (opened.size > bytesRead ? "\n[Preview truncated at 1 MiB]" : "");
          }
        } finally {
          await handle.close();
        }
      }
    } catch (error) {
      content = `Unable to preview file: ${errorMessage(error)}`;
    }
    if (this.#disposed || context !== this.#context) return undefined;
    return { title: entry.path, content };
  }

  dispose(): void {
    this.#disposed = true;
    this.#context++;
    this.#tree++;
    this.#controller?.abort();
    this.#contextController.abort();
    this.#controller = null;
    this.#repo = null;
    this.#expanded.clear();
    this.#directoryChanges.clear();
    this.#onChange = undefined;
  }
}
