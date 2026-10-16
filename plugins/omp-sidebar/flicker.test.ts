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

function setup(lines: string[] = Array.from({ length: ROWS }, (_, row) => `side ${row}`)) {
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
    (_width, rows) => lines.slice(0, rows),
    { width: WIDTH, getTheme: () => theme },
  );
  // The first core write paints the sidebar; later writes are what we inspect.
  terminal.write("\x1b[1;1Hfirst frame");
  terminal.out.length = 0;
  return { terminal, compositor, lines };
}

/** 1-based rows of the sidebar painted after the core bytes (all of `written` when core is ""). */
function paintedRows(written: string, core: string): number[] {
  const after = core ? written.slice(written.indexOf(core) + core.length) : written;
  const rows: number[] = [];
  const pattern = new RegExp(`\\x1b\\[(\\d+);${REGION_COLUMN + 1}H\\x1b\\[0m`, "g");
  for (const match of after.matchAll(pattern)) rows.push(Number(match[1]));
  return rows;
}
const allRows = Array.from({ length: ROWS }, (_, i) => i + 1);

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
  test("a diff paint (cursor-addressed rows, no line feed) erases nothing and repaints only the rows it erased into", () => {
    const { terminal } = setup();
    const core = "\x1b[?25l\x1b[5;1Hspinner ⠋\x1b[K\x1b[19;1H> prompt\x1b[K\x1b[?25h";
    terminal.write(core);
    const written = terminal.out.join("");
    expect(erasedRows(written, core)).toEqual([]);
    expect(paintedRows(written, core)).toEqual([5, 19]);
  });

  test("a core write that touches no sidebar cell repaints nothing", () => {
    const { terminal } = setup();
    const core = "\x1b[3;1Hplain text";
    terminal.write(core);
    expect(paintedRows(terminal.out.join(""), core)).toEqual([]);
  });

  test("erase below repaints from the cursor row down; a full erase repaints everything", () => {
    const { terminal } = setup();
    const below = "\x1b[15;1H\x1b[J";
    terminal.write(below);
    expect(paintedRows(terminal.out.join(""), below)).toEqual([15, 16, 17, 18, 19, 20]);
    terminal.out.length = 0;
    const full = "\x1b[H\x1b[2Jframe";
    terminal.write(full);
    expect(paintedRows(terminal.out.join(""), full)).toEqual(allRows);
  });

  test("an erase on an unknown cursor row repaints every row", () => {
    const { terminal } = setup();
    terminal.write("\x1b[?1049h");
    terminal.out.length = 0;
    const core = "text\x1b[K";
    terminal.write(core);
    expect(paintedRows(terminal.out.join(""), core)).toEqual(allRows);
  });

  test("a sidebar line that changed is repainted even where the core did not touch", () => {
    const { terminal, lines } = setup();
    lines[7] = "side 7 changed";
    const core = "\x1b[3;1Hplain text";
    terminal.write(core);
    expect(paintedRows(terminal.out.join(""), core)).toEqual([8]);
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
    expect(paintedRows(written, core)).toEqual(allRows);
  });

  test("the cursor row is carried across writes: a standalone line feed mid-screen erases nothing", () => {
    const { terminal } = setup();
    // omp places its cursor and then writes "\r\n" as a separate write (tui.ts:2680).
    terminal.write("\x1b[10;1Hprompt");
    terminal.out.length = 0;
    terminal.write("\r\n");
    expect(erasedRows(terminal.out.join(""), "\r\n")).toEqual([]);
  });

  test("line feeds with no known cursor row (after an alt-screen switch) assume the bottom row", () => {
    const { terminal } = setup();
    terminal.write("\x1b[?1049l");
    terminal.out.length = 0;
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

  test("a sidebar-only refresh with nothing changed writes nothing", () => {
    const { terminal, compositor } = setup();
    compositor.requestRender();
    compositor.requestRender();
    expect(terminal.out.join("")).toBe("");
  });

  test("a sidebar-only refresh repaints only the changed rows and erases nothing", () => {
    const { terminal, compositor, lines } = setup();
    lines[2] = "side 2 now";
    lines[11] = "side 11 now";
    compositor.requestRender();
    const written = terminal.out.join("");
    expect(written).not.toMatch(/\x1b\[\d+X/);
    expect(paintedRows(written, "")).toEqual([3, 12]);
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
