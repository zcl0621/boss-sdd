import { describe, expect, test } from "bun:test";
import { initThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import { SidebarCompositor } from "./compositor";

initThemeSync();

// Terminals without DEC 2026 (Apple Terminal: omp's terminal-capabilities.ts
// leaves synchronized output off) show every intermediate state of a write.
// Erasing the sidebar before the core and painting it after makes it flash
// on each write, so the sidebar may only erase rows a scroll pushes out.

const COLUMNS = 140;
const ROWS = 20;
const WIDTH = 38;
// The painted region starts at the divider, 0-based; CUP/ECH below are 1-based.
const REGION_COLUMN = COLUMNS - WIDTH - 1;

class FakeTerminal {
  rows = ROWS;
  tspExpected = false;
  out: string[] = [];
  get columns(): number {
    return COLUMNS;
  }
  write(data: string): void {
    this.out.push(data);
  }
}

function setup() {
  const terminal = new FakeTerminal();
  const tui = {
    terminal,
    nativeRendering: false,
    synchronizedOutput: false,
    requestRender() {},
    hasOverlay: () => false,
  };
  const compositor = new SidebarCompositor(
    tui as never,
    (_width, rows) => Array.from({ length: rows }, (_, row) => `side ${row}`),
    { width: WIDTH, getTheme: () => theme },
  );
  // The first core write paints the sidebar; later writes are what we inspect.
  terminal.write("\x1b[1;1Hfirst frame");
  terminal.out.length = 0;
  return { terminal, compositor };
}

/** 1-based rows whose sidebar cells were erased before the core bytes. */
function erasedRows(written: string, core: string): number[] {
  const before = written.slice(0, written.indexOf(core));
  const rows: number[] = [];
  const pattern = new RegExp(`\\x1b\\[(\\d+);${REGION_COLUMN + 1}H\\x1b\\[\\d+X`, "g");
  for (const match of before.matchAll(pattern)) rows.push(Number(match[1]));
  return rows;
}

function paintedAfter(written: string, core: string): boolean {
  const after = written.slice(written.indexOf(core) + core.length);
  return after.includes("side 0") && after.includes(`side ${ROWS - 1}`);
}

describe("sidebar does not flash on writes without synchronized output", () => {
  test("a diff paint (cursor-addressed rows, no line feed) erases nothing and repaints the sidebar", () => {
    const { terminal } = setup();
    const core = "\x1b[?25l\x1b[5;1Hspinner ⠋\x1b[K\x1b[19;1H> prompt\x1b[K\x1b[?25h";
    terminal.write(core);
    const written = terminal.out.join("");
    expect(erasedRows(written, core)).toEqual([]);
    expect(paintedAfter(written, core)).toBe(true);
  });

  test("line feeds that start at a known row and stay on screen erase nothing", () => {
    const { terminal } = setup();
    const core = "\x1b[3;1Ha\nb\nc\nd";
    terminal.write(core);
    expect(erasedRows(terminal.out.join(""), core)).toEqual([]);
  });

  test("line feeds that scroll erase exactly the rows pushed into scrollback", () => {
    const { terminal } = setup();
    // From row 18, five line feeds reach row 20 after two and scroll three times.
    const core = "\x1b[18;1Ha\nb\nc\nd\ne\nf";
    terminal.write(core);
    const written = terminal.out.join("");
    expect(erasedRows(written, core)).toEqual([1, 2, 3]);
    expect(paintedAfter(written, core)).toBe(true);
  });

  test("line feeds before any absolute position assume the cursor is on the bottom row", () => {
    const { terminal } = setup();
    const core = "\r\nx\r\ny";
    terminal.write(core);
    expect(erasedRows(terminal.out.join(""), core)).toEqual([1, 2]);
  });

  test("index, next line and scroll up count as scrolls", () => {
    const { terminal } = setup();
    const core = `\x1b[${ROWS};1H\x1bD\x1bE\x1b[2S`;
    terminal.write(core);
    expect(erasedRows(terminal.out.join(""), core)).toEqual([1, 2, 3, 4]);
  });

  test("a saved and restored cursor is followed", () => {
    const { terminal } = setup();
    // Save at row 2, wander to the bottom, restore: the line feed is on row 3.
    const core = `\x1b[2;1H\x1b7\x1b[${ROWS};1Hstatus\x1b8\nnext`;
    terminal.write(core);
    expect(erasedRows(terminal.out.join(""), core)).toEqual([]);
  });

  test("full-screen erase or a scroll region falls back to erasing every row", () => {
    for (const core of ["\x1b[H\x1b[2J\x1b[3Jframe", "\x1b[2;10rregion"]) {
      const { terminal } = setup();
      terminal.write(core);
      expect(erasedRows(terminal.out.join(""), core)).toHaveLength(ROWS);
    }
  });

  test("a sidebar-only refresh over the same region erases nothing", () => {
    const { terminal, compositor } = setup();
    compositor.requestRender();
    const written = terminal.out.join("");
    expect(written).not.toMatch(/\x1b\[\d+X/);
    expect(written).toContain("side 0");
  });

  test("a width change still erases the old region before painting the new one", () => {
    const { terminal, compositor } = setup();
    compositor.setWidth(WIDTH + 10);
    const core = "\x1b[5;1Hx";
    terminal.write(core);
    const before = terminal.out.join("").slice(0, terminal.out.join("").indexOf(core));
    expect(before.match(/\x1b\[\d+X/g)?.length).toBe(ROWS);
  });
});
