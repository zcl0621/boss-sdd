import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { WorkspaceActivity } from "./workspace-activity";
import type { WorkspaceToolActivity } from "./workspace-activity";

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
  const root = await fs.realpath(await fs.mkdtemp("/tmp/omp-activity-test-"));
  roots.push(root);
  const main = root + "/main";
  await fs.mkdir(main);
  git(main, "init", "-q", "-b", "main");
  await Bun.write(main + "/file.txt", "fixture\n");
  await Bun.write(main + "/.gitignore", ".worktrees/\n");
  git(main, "add", ".");
  git(main, "commit", "-qm", "fixture");
  const active = main + "/.worktrees/active",
    passive = main + "/.worktrees/passive";
  git(main, "worktree", "add", "-q", "-b", "active", active);
  git(main, "worktree", "add", "-q", "-b", "passive", passive);
  const tracker = new WorkspaceActivity(main, () => {});
  return { root, main, active, passive, tracker };
}
const activity = (id: string, cwd: string, isError = false): WorkspaceToolActivity => ({
  toolCallId: id,
  toolName: "bash",
  input: { cwd },
  isError,
});
async function execute(tracker: WorkspaceActivity, event: WorkspaceToolActivity) {
  tracker.begin(event.toolCallId, event.toolName, event.input);
  await tracker.complete(event);
}
function history(events: WorkspaceToolActivity[], pending?: WorkspaceToolActivity): SessionEntry[] {
  const entries: SessionEntry[] = [];
  const calls = pending ? [pending, ...events] : events;
  for (const call of calls) {
    const message: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "toolCall", id: call.toolCallId, name: call.toolName, arguments: call.input },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      stopReason: "toolUse",
      timestamp: 0,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    entries.push({
      type: "message",
      id: call.toolCallId + "-call",
      parentId: entries.at(-1)?.id ?? null,
      timestamp: "2026-10-15T00:00:00.000Z",
      message,
    });
  }
  for (const call of events)
    entries.push({
      type: "message",
      id: call.toolCallId + "-result",
      parentId: entries.at(-1)?.id ?? null,
      timestamp: "2026-10-15T00:00:01.000Z",
      message: {
        role: "toolResult",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        content: [],
        details: call.details,
        isError: call.isError,
        timestamp: 1000,
      },
    });
  return entries;
}

describe("activity workspace", () => {
  test("successful tool cwd selects its real linked checkout, not the session launch directory", async () => {
    const { main, active, tracker } = await fixture();
    await execute(tracker, activity("active", ".worktrees/active"));
    expect(tracker.cwd).toBe(active);
    await execute(tracker, {
      toolCallId: "read-main",
      toolName: "read",
      input: { path: "file.txt:1-1" },
      isError: false,
    });
    expect(tracker.cwd).toBe(main);
  });
  test("failed activity and unrelated repositories cannot hijack the selected workspace", async () => {
    const { root, active, passive, tracker } = await fixture();
    await execute(tracker, activity("active", active));
    await execute(tracker, activity("failed", passive, true));
    expect(tracker.cwd).toBe(active);
    const other = root + "/other";
    await fs.mkdir(other);
    git(other, "init", "-q", "-b", "external");
    await execute(tracker, activity("external", other));
    expect(tracker.cwd).toBe(active);
  });
  test("read selectors and resolved metadata activate the owning checkout, not internal caches", async () => {
    const { main, active, tracker } = await fixture();
    await execute(tracker, {
      toolCallId: "read",
      toolName: "read",
      input: { path: ".worktrees/active/file.txt:1-1:raw" },
      isError: false,
    });
    expect(tracker.cwd).toBe(active);
    await execute(tracker, activity("main", main));
    await execute(tracker, {
      toolCallId: "internal",
      toolName: "read",
      input: { path: "local://file.txt" },
      details: { resolvedPath: active + "/file.txt" },
      isError: false,
    });
    expect(tracker.cwd).toBe(main);
  });
  test("out-of-order successful completions retain the newer invocation's workspace", async () => {
    const { active, passive, tracker } = await fixture();
    const older = activity("older", active),
      newer = activity("newer", passive);
    tracker.begin(older.toolCallId, older.toolName, older.input);
    tracker.begin(newer.toolCallId, newer.toolName, newer.input);
    await tracker.complete(newer);
    await tracker.complete(older);
    expect(tracker.cwd).toBe(passive);
  });
  test("native relocation and disposal invalidate in-flight target resolution", async () => {
    const { main, active, passive, tracker } = await fixture();
    const event = activity("pending", active);
    tracker.begin(event.toolCallId, event.toolName, event.input);
    const completion = tracker.complete(event);
    tracker.syncBase(passive);
    await completion;
    expect(tracker.cwd).toBe(passive);
    const disposed = new WorkspaceActivity(main, () => {});
    disposed.begin("disposed", "bash", { cwd: active });
    const pending = disposed.complete(activity("disposed", active));
    disposed.dispose();
    await pending;
    expect(disposed.cwd).toBe(main);
  });
  test("resume restores the latest successful checkout from the current branch", async () => {
    const { active, passive, tracker } = await fixture();
    await tracker.restore(history([activity("active", active), activity("failed", passive, true)]));
    expect(tracker.cwd).toBe(active);
  });
  test("a historical pending call cannot overtake a later successful call when it ends", async () => {
    const { active, passive, tracker } = await fixture();
    const older = activity("older", active);
    await tracker.restore(history([activity("newer", passive)], older));
    await tracker.complete(older);
    expect(tracker.cwd).toBe(passive);
  });
  test("unrelated live calls do not erase a valid workspace bootstrap", async () => {
    const { active, tracker } = await fixture();
    const restored = tracker.restore(history([activity("active", active)]));
    tracker.begin("todo", "todo", {});
    await restored;
    expect(tracker.cwd).toBe(active);
  });
  test("a newer successful live target wins over an overlapping history restore", async () => {
    const { active, passive, tracker } = await fixture();
    const restored = tracker.restore(history([activity("old", active)]));
    await execute(tracker, activity("new", passive));
    await restored;
    expect(tracker.cwd).toBe(passive);
  });
});
