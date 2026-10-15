import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { getThemeByName, initThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import { SidebarView } from "./sidebar-view";
import type { SidebarSnapshot } from "./types";

initThemeSync();
afterEach(() => setSystemTime());

function fixture() {
  const snapshot: SidebarSnapshot = {
    usage: { tokens: 1000, contextWindow: 500000 },
    sections: [
      {
        id: "agents",
        title: "Agents",
        rows: [{ id: "worker", text: "Worker · running", running: true }],
      },
    ],
  };
  const view = new SidebarView(
    () => snapshot,
    () => theme,
    () => {},
    () => {},
  );
  return { snapshot, view };
}
const plain = (view: SidebarView, rows = 12) => view.render(40, rows).map(Bun.stripANSI);

describe("running activity indicators", () => {
  test("visible running entries animate without a data refresh", () => {
    const { view } = fixture();
    setSystemTime(new Date(0));
    const first = plain(view).find((line) => line.includes("Worker"));
    setSystemTime(new Date(80));
    const next = plain(view).find((line) => line.includes("Worker"));
    expect(first).toContain("Worker · running");
    expect(next).toContain("Worker · running");
    expect(next).not.toBe(first);
    expect(view.hasRunningRows).toBe(true);
  });

  test("removing the last active entry stops animation", () => {
    const { snapshot, view } = fixture();
    plain(view);
    snapshot.sections = [{ id: "agents", title: "Agents", rows: [] }];
    setSystemTime(new Date(0));
    const first = plain(view);
    setSystemTime(new Date(80));
    expect(plain(view)).toEqual(first);
    expect(view.hasRunningRows).toBe(false);
    expect(first.join("\n")).not.toContain("Worker");
  });

  test("collapsed and offscreen activity does not request animation", () => {
    const { view } = fixture();
    const lines = plain(view);
    view.click(lines.findIndex((line) => line.includes("Agents")));
    expect(plain(view).join("\n")).not.toContain("Worker");
    expect(view.hasRunningRows).toBe(false);
    view.click(lines.findIndex((line) => line.includes("Agents")));
    plain(view, 3);
    expect(view.hasRunningRows).toBe(false);
  });
});

test("an existing sidebar resolves colors from the current theme on every paint", async () => {
  const dark = await getThemeByName("dark");
  const light = await getThemeByName("light");
  if (!dark || !light) throw new Error("Built-in themes unavailable");
  let active = dark;
  const snapshot: SidebarSnapshot = {
    usage: { tokens: 1000, contextWindow: 500000 },
    sections: [
      { id: "git", title: "Git", rows: [{ id: "modified", text: "MOD.txt", tone: "warning" }] },
    ],
  };
  const view = new SidebarView(
    () => snapshot,
    () => active,
    () => {},
    () => {},
  );
  const before = view.render(40, 12);
  active = light;
  const after = view.render(40, 12);
  expect(after.map(Bun.stripANSI)).toEqual(before.map(Bun.stripANSI));
  expect(after.find((line) => line.includes("MOD.txt"))).not.toBe(
    before.find((line) => line.includes("MOD.txt")),
  );
  expect(after.find((line) => line.includes("MOD.txt"))).toContain(light.getFgAnsi("warning"));
});

test("narrow paths retain the checkout name and wide rows retain diff counts", () => {
  const snapshot: SidebarSnapshot = {
    usage: { tokens: 19000, contextWindow: 500000 },
    sections: [
      {
        id: "git",
        title: "Git",
        rows: [
          { id: "path", text: "/very/long/路径/.worktrees/checkout", tail: true, tone: "muted" },
          { id: "diff", text: " M 超宽文件.ts", detail: "+8 −3", action: "diff" },
        ],
      },
    ],
  };
  const view = new SidebarView(
    () => snapshot,
    () => theme,
    () => {},
    () => {},
  );
  const narrow = view.render(16, 15).map(Bun.stripANSI);
  expect(narrow.find((line) => line.includes("checkout"))).toBeDefined();
  expect(narrow[0]).toContain("3.8%");
  const wide = view.render(38, 15).map(Bun.stripANSI);
  expect(wide.find((line) => line.includes("超宽文件.ts"))?.trimEnd()).toEndWith("+8 −3");
});

test("keyboard focus skips decoration and stays on the same action when preceding rows change", () => {
  const activated: string[] = [];
  const snapshot: SidebarSnapshot = {
    usage: {},
    sections: [
      { id: "agents", title: "Agents", rows: [] },
      {
        id: "git",
        title: "Git",
        rows: [
          { id: "metadata", text: "/some/worktree", tone: "muted" },
          { id: "file", text: "changed.ts", action: "inspect-file" },
        ],
      },
    ],
  };
  const view = new SidebarView(
    () => snapshot,
    () => theme,
    (action) => activated.push(action),
    () => {},
  );
  view.setFocused(true);
  view.render(38, 20);
  view.handleInput("\x1b[B");
  view.handleInput("\x1b[B");
  view.handleInput("\x1b[B");
  view.render(38, 20);
  expect(
    view
      .render(38, 20)
      .map(Bun.stripANSI)
      .find((line) => line.startsWith("› ")),
  ).toContain("changed.ts");
  snapshot.sections[0]!.rows = [
    { id: "new-agent", text: "Worker", running: true, action: "agent" },
  ];
  view.render(38, 20);
  view.handleInput("\r");
  expect(activated).toEqual(["inspect-file"]);
});
