import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SidebarWorkspace } from "./workspace";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync([
    "git",
    "-C",
    cwd,
    "-c",
    "user.name=Sidebar QA",
    "-c",
    "user.email=sidebar@example.invalid",
    ...args,
  ]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/omp-sidebar-workspace-test-"));
  roots.push(root);
  const repo = path.join(root, "main");
  await fs.mkdir(repo);
  git(repo, "init", "-q", "-b", "main");
  await fs.mkdir(path.join(repo, "folder"));
  await fs.mkdir(path.join(repo, "old"));
  await Bun.write(path.join(repo, "folder/MOD.txt"), "baseline\n");
  await Bun.write(path.join(repo, "folder/DEL.txt"), "delete baseline\n");
  await Bun.write(path.join(repo, "old/REN.txt"), "rename baseline\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "baseline");
  const active = path.join(root, "active");
  const passive = path.join(root, "passive");
  git(repo, "worktree", "add", "-q", "-b", "feature-active", active);
  git(repo, "worktree", "add", "-q", "-b", "feature-passive", passive);
  await fs.mkdir(path.join(active, "nested/deep"), { recursive: true });
  await Bun.write(path.join(repo, "MAIN_ONLY.txt"), "main-only content\n");
  await Bun.write(path.join(active, "ACTIVE_ONLY.txt"), "active-only content\n");
  await Bun.write(path.join(passive, "PASSIVE_ONLY.txt"), "passive-only content\n");
  return { repo, active, passive };
}

describe("active workspace projection", () => {
  test("a nested cwd resolves only its active checkout and directory root", async () => {
    const { active, repo } = await fixture();
    const workspace = new SidebarWorkspace();
    try {
      await workspace.refresh(path.join(active, "nested/deep"));
      expect(workspace.snapshot.directoryRoot).toBe(active);
      expect(workspace.snapshot.currentWorktree?.path).toBe(active);
      expect(workspace.snapshot.branch).toBe("feature-active");
      const names = workspace.snapshot.entries.map((entry) => entry.name);
      expect(names).toContain("ACTIVE_ONLY.txt");
      expect(names).not.toContain("MAIN_ONLY.txt");
      expect(names).not.toContain("PASSIVE_ONLY.txt");
      expect((await workspace.previewFor(path.join(active, "ACTIVE_ONLY.txt")))?.content).toContain(
        "active-only content",
      );
      expect(await workspace.previewFor(path.join(repo, "MAIN_ONLY.txt"))).toBeUndefined();
    } finally {
      workspace.dispose();
    }
  });

  test("native file changes propagate into collapsed directory entries", async () => {
    const { active } = await fixture();
    const workspace = new SidebarWorkspace();
    try {
      await Bun.write(path.join(active, "folder/MOD.txt"), "changed\n");
      await fs.unlink(path.join(active, "folder/DEL.txt"));
      await fs.mkdir(path.join(active, "new"));
      await Bun.write(path.join(active, "new/ADDED.txt"), "added\n");
      git(active, "add", "new/ADDED.txt");
      git(active, "mv", "old/REN.txt", "new/REN.txt");
      await workspace.refresh(active);
      const change = (name: string) =>
        workspace.snapshot.entries.find((entry) => entry.name === name)?.change;
      expect(change("folder")).toBe("modified");
      expect(change("new")).toBe("renamed");
      expect(change("old")).toBe("renamed");
      expect(change("ACTIVE_ONLY.txt")).toBe("untracked");
      expect(
        workspace.snapshot.changes.find((entry) => entry.path === "folder/DEL.txt")?.kind,
      ).toBe("deleted");
      await workspace.toggleDirectory(path.join(active, "folder"));
      expect(change("MOD.txt")).toBe("modified");
      expect(workspace.snapshot.entries.some((entry) => entry.name === "DEL.txt")).toBe(false);
    } finally {
      workspace.dispose();
    }
  });

  test("branch changes and overlapping root refreshes cannot retain another checkout", async () => {
    const { active, repo } = await fixture();
    const workspace = new SidebarWorkspace();
    try {
      await workspace.refresh(active);
      git(active, "switch", "-q", "-c", "next-active");
      await workspace.refresh(active);
      expect(workspace.snapshot.branch).toBe("next-active");
      await Promise.all([workspace.refresh(repo), workspace.refresh(active)]);
      expect(workspace.snapshot.directoryRoot).toBe(active);
      expect(workspace.snapshot.branch).toBe("next-active");
      expect(workspace.snapshot.entries.map((entry) => entry.name)).not.toContain("MAIN_ONLY.txt");
    } finally {
      workspace.dispose();
    }
  });
});
