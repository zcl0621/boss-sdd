import { describe, expect, test } from "bun:test";
import { initThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import { renderContextMeter } from "./context-meter";
import type { SidebarUsage } from "./types";

initThemeSync();
const render = (usage: SidebarUsage) => renderContextMeter(usage, 34, theme).map(Bun.stripANSI);

describe("context progress", () => {
  test("19k of 500k shows the actual ratio and a proportionate bar", () => {
    const rows = render({ tokens: 19000, contextWindow: 500000 });
    expect(rows[0]).toContain("3.8%");
    expect([...rows[1]!].filter((cell) => cell === "█")).toHaveLength(1);
    expect(rows[2]).toMatch(/19(?:\.0)?[kK] \/ 500(?:\.0)?[kK] tokens/);
  });

  test("unknown usage is not presented as zero consumption", () => {
    const rows = render({ contextWindow: 500000 });
    expect(rows[0]).toContain("?");
    expect(rows.join("\n")).not.toContain("0%");
    expect(rows[1]).not.toContain("█");
  });

  test("real zero usage remains distinguishable from unknown", () => {
    const rows = render({ tokens: 0, contextWindow: 500000 });
    expect(rows[0]).toContain("0.0%");
    expect(rows[1]).not.toContain("█");
  });

  test.each([0, -1, Infinity, NaN])(
    "invalid capacity %s never invents a percentage",
    (contextWindow) => {
      const rows = render({ tokens: 19000, contextWindow });
      expect(rows[0]).toContain("?");
      expect(rows.join("\n")).not.toContain("%");
    },
  );

  test("overflow remains visible numerically while the bar stays bounded", () => {
    const rows = render({ tokens: 600000, contextWindow: 500000 });
    expect(rows[0]).toContain("120%");
    expect(rows[1]).not.toContain("░");
    expect(rows[1]!.length).toBeLessThanOrEqual(34);
  });

  test("a canonical compaction point is marked without changing capacity", () => {
    const rows = renderContextMeter(
      { tokens: 19000, contextWindow: 500000, compactAt: 400000 },
      20,
      theme,
    ).map(Bun.stripANSI);
    expect(rows[0]).toContain("3.8%");
    expect(rows[1]![16]).toBe("┃");
  });
});

describe("context breakdown", () => {
  const parts = [
    { id: "messages", label: "Messages", tokens: 238_700, color: "accent" as const },
    { id: "mcpTools", label: "MCP tools", tokens: 20_700, color: "error" as const },
    { id: "systemTools", label: "System tools", tokens: 0, color: "success" as const },
    { id: "buffer", label: "Autocompact buffer", tokens: 33_000, color: "dim" as const, reserved: true },
    { id: "free", label: "Free space", tokens: 207_600, color: "dim" as const, reserved: true },
  ];

  test("lists each non-empty category with tokens and share of the window", () => {
    const rows = render({ tokens: 259_400, contextWindow: 500_000, parts });
    const text = rows.join("\n");
    expect(text).toMatch(/Messages\s+238\.7K\s+48%/);
    expect(text).toMatch(/MCP tools\s+20\.7K\s+4\.1%/);
    expect(text).toMatch(/Free space\s+207\.6K\s+42%/);
    expect(text).not.toContain("System tools");
  });

  test("the stacked bar fills only consumed categories", () => {
    const rows = render({ tokens: 259_400, contextWindow: 500_000, parts });
    const filled = [...rows[1]!].filter((cell) => cell === "█").length;
    expect(filled).toBe(Math.round((259_400 / 500_000) * 34));
    expect(rows[1]).toHaveLength(34);
  });

  test("rows never exceed the sidebar width", () => {
    for (const width of [18, 26, 34]) {
      const rows = renderContextMeter({ tokens: 259_400, contextWindow: 500_000, parts }, width, theme);
      for (const row of rows) expect(Bun.stringWidth(Bun.stripANSI(row))).toBeLessThanOrEqual(width);
    }
  });
});
