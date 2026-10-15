import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { SidebarState } from "./state";

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

test("verified clean status survives background refresh and changes only with repository results", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/omp-sidebar-clean-test-"));
  const repo = `${root}/repo`;
  await fs.mkdir(repo);
  git(repo, "init", "-q", "-b", "main");
  await Bun.write(`${repo}/tracked.txt`, "baseline\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "baseline");

  // Only the idle host boundary is synthetic; Git queries and publication are real.
  const manager = {
    getSessionId: () => "root",
    getSessionFile: () => undefined,
    getBranch: () => [],
  };
  const ctx = {
    sessionManager: manager,
    isIdle: () => true,
    getContextUsage: () => undefined,
    getAsyncJobSnapshot: () => ({ running: [] }),
  } as unknown as ExtensionContext;
  const api = { pi: { getLatestTodoPhasesFromEntries: () => [] } } as unknown as ExtensionAPI;
  const state = new SidebarState(api, ctx, () => {});
  const scope = { key: repo, cwd: repo, owner: "root", manager } as unknown as Parameters<
    SidebarState["compose"]
  >[0];
  state.scope = () => scope;
  state.rootedAgents = () => [];
  state.scopeKey = scope.key;
  const clean = () =>
    state.currentSnapshot.sections
      .find((section) => section.id === "git")
      ?.rows.some((row) => row.id === "git:clean") ?? false;
  try {
    const initial = state.workspace.refresh(repo);
    expect(clean()).toBe(false);
    await initial;
    expect(clean()).toBe(true);

    const published: boolean[] = [];
    state.onChange = () => published.push(clean());
    const poll = state.workspace.refresh(repo);
    expect(clean()).toBe(true);
    await poll;
    expect(published).not.toContain(false);

    await Bun.write(`${repo}/tracked.txt`, "changed\n");
    await state.workspace.refresh(repo);
    expect(clean()).toBe(false);
    expect(
      state.currentSnapshot.sections
        .find((section) => section.id === "git")
        ?.rows.some((row) => row.text === "tracked.txt"),
    ).toBe(true);

    await Bun.write(`${repo}/tracked.txt`, "baseline\n");
    await state.workspace.refresh(repo);
    expect(clean()).toBe(true);

    const other = `${root}/other`;
    await fs.mkdir(other);
    git(other, "init", "-q", "-b", "other");
    scope.cwd = other;
    scope.key = other;
    state.scopeKey = other;
    const switching = state.workspace.refresh(other);
    expect(clean()).toBe(false);
    await switching;
    expect(clean()).toBe(true);
  } finally {
    state.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
