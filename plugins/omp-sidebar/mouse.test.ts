import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { setKittyProtocolActive } from "@oh-my-pi/pi-tui";
import { initThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import sidebarPlugin from "./index";
import { SidebarState } from "./state";

initThemeSync();

// The bytes omp's TUI itself emits around mouse reporting (pi-tui tui.ts).
const TUI_MOUSE_ON = "\x1b[?1000h\x1b[?1003h\x1b[?1006h";
const TUI_MOUSE_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";
const ALT_ENTER = "\x1b[?1049h";
const ALT_EXIT = "\x1b[?1049l";

const COLUMNS = 140;
const ROWS = 30;
const SIDEBAR_WIDTH = 38;
// Main area keeps COLUMNS - width - 1 columns; the divider is one more cell.
const SIDEBAR_COLUMN = COLUMNS - SIDEBAR_WIDTH;

/** Physical terminal: everything that actually reaches the tty lands in `out`. */
class FakeTerminal {
  rows = ROWS;
  tspExpected = false;
  out: string[] = [];
  physicalColumns = COLUMNS;
  get columns(): number {
    return this.physicalColumns;
  }
  write(data: string): void {
    this.out.push(data);
  }
}

type Listener = (data: string) => { consume?: boolean; data?: string } | undefined;
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void };

interface HarnessOptions {
  /** omp's `tui.mouse` setting; when true omp has already turned reporting on. */
  tuiMouse?: boolean;
  /** Files created in the session cwd, so Directory rows carry inspect actions. */
  files?: string[];
  /** ctx.ui.custom (the inspector overlay) rejects instead of resolving. */
  customRejects?: boolean;
}

async function harness(options: HarnessOptions = {}) {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidebar-mouse-")));
  for (const file of options.files ?? []) await Bun.write(path.join(cwd, file), "text\n");
  const terminal = new FakeTerminal();
  // omp paints its first frame (interactive-mode.ts renderNow) before
  // session_start; with tui.mouse that frame already turned reporting on.
  if (options.tuiMouse) terminal.write(`${TUI_MOUSE_ON}first frame`);
  let overlay = false;
  // One ordered listener set, like TUI #inputListeners (tui.ts:2948). Entries
  // added through ctx.ui.onTerminalInput are the extension's, which omp
  // clears in prepareSessionSwitch (interactive-mode.ts:7987).
  const listeners: { listener: Listener; extension: boolean }[] = [];
  const add = (listener: Listener, extension: boolean) => {
    const entry = { listener, extension };
    listeners.push(entry);
    return () => {
      const index = listeners.indexOf(entry);
      if (index >= 0) listeners.splice(index, 1);
    };
  };
  const tui = {
    terminal,
    nativeRendering: false,
    synchronizedOutput: false,
    requestRender() {},
    hasOverlay: () => overlay,
    addInputListener: (listener: Listener) => add(listener, false),
  };
  const notes: string[] = [];
  let widget: { dispose?: () => void } | undefined;
  const commands = new Map<string, Command>();
  const handlers = new Map<string, Handler[]>();
  const manager = {
    getSessionId: () => "root",
    getSessionFile: () => undefined,
    getBranch: () => [],
    getCwd: () => cwd,
  };
  const ctx = {
    hasUI: true,
    mode: "tui",
    cwd,
    sessionManager: manager,
    agent: { id: "main" },
    model: undefined,
    isIdle: () => true,
    getContextUsage: () => undefined,
    getAsyncJobSnapshot: () => ({ running: [] }),
    setInterval: () => undefined,
    ui: {
      theme,
      notify: (message: string) => notes.push(message),
      setWidget: (_key: string, factory: ((tui: unknown) => { dispose?: () => void }) | undefined) => {
        if (!factory) {
          widget?.dispose?.();
          widget = undefined;
          return;
        }
        widget = factory(tui);
      },
      onTerminalInput: (listener: Listener) => add(listener, true),
      custom: async () => {
        if (options.customRejects) throw new Error("custom UI unavailable");
      },
    },
  } as unknown as ExtensionContext;
  // api.pi is the coding-agent module (extensions/types.ts:1607); its global
  // `settings` singleton (index.ts:18) is the only settings view extensions get.
  const rawSettings = options.tuiMouse ? { tui: { mouse: true } } : {};
  const settings = {
    getGlobalSettings: () => structuredClone(rawSettings),
    getProjectSettings: () => ({}),
    rawValue: (setting: { id?: string; segments?: readonly string[] }) =>
      setting.id === "tui.mouse" || setting.segments?.join(".") === "tui.mouse"
        ? options.tuiMouse
        : undefined,
  };
  const api = {
    logger: { warn() {}, debug() {}, info() {}, error() {} },
    pi: {
      AgentRegistry: { global: () => ({ list: () => [], get: () => undefined }) },
      getLatestTodoPhasesFromEntries: () => [],
      settings,
    },
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    registerShortcut() {},
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;

  sidebarPlugin(api);
  const emit = async (event: string) => {
    for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
  };
  await emit("session_start");

  const input = (data: string): boolean => {
    let current = data;
    for (const { listener } of [...listeners]) {
      const result = listener(current);
      if (result?.consume) return true;
      if (result?.data !== undefined) current = result.data;
    }
    return false;
  };

  return {
    terminal,
    notes,
    setOverlay: (value: boolean) => {
      overlay = value;
    },
    /** What omp's TUI writes for a frame; goes through whatever wraps terminal.write. */
    coreWrite: (data: string) => (terminal as unknown as { write(data: string): void }).write(data),
    sidebar: (args: string) => commands.get("sidebar")!.handler(args, ctx),
    emit,
    /** Feed one terminal input chunk to the listeners in order; true when one consumed it. */
    input,
    /**
     * omp's switch order: prepareSessionSwitch clears extension listeners
     * (interactive-mode.ts:7982-7987), then agent-session emits
     * session_before_switch (agent-session.ts:9891), then session_switch.
     * `between` runs after session_before_switch, before session_switch.
     */
    switchSession: async (between?: () => void) => {
      for (const entry of [...listeners]) {
        if (entry.extension) listeners.splice(listeners.indexOf(entry), 1);
      }
      await emit("session_before_switch");
      between?.();
      await emit("session_switch");
    },
    /**
     * A switch another session_before_switch handler cancels: omp has cleared
     * extension listeners and returns `{ cancelled: true }` with no
     * session_switch (extension-ui-controller.ts:270-277, 335-343).
     */
    cancelledSwitch: async () => {
      for (const entry of [...listeners]) {
        if (entry.extension) listeners.splice(listeners.indexOf(entry), 1);
      }
      await emit("session_before_switch");
    },
    /** Raw bytes the terminal received since `mark`. */
    since: (mark: number) => terminal.out.slice(mark).join(""),
    /**
     * Paint a frame and return the sidebar rows as plain text, top to bottom, as
     * the screen shows them: the sidebar repaints only rows that changed or that
     * the core touched, so the latest paint of each row is read from all output.
     */
    sidebarRows: (): string[] => {
      (terminal as unknown as { write(data: string): void }).write("frame");
      const screen = new Map<number, string>();
      const bytes = terminal.out.join("");
      const cup = /\x1b\[(\d+);(\d+)H/g;
      const hits = [...bytes.matchAll(cup)];
      hits.forEach((hit, index) => {
        if (Number(hit[2]) !== SIDEBAR_COLUMN) return;
        const end = index + 1 < hits.length ? hits[index + 1].index : bytes.length;
        const text = Bun.stripANSI(bytes.slice(hit.index + hit[0].length, end).replace(/\x1b[78]/g, ""));
        if (text.startsWith("│")) screen.set(Number(hit[1]), text.slice(1).trimEnd());
      });
      return [...screen.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text);
    },
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** SGR report, 0-based col/row like parseSgrMouse returns. */
const sgr = (button: number, col: number, row: number, release = false) =>
  `\x1b[<${button};${col + 1};${row + 1}${release ? "m" : "M"}`;

/** The last state the byte stream leaves one DEC private mode in. */
function lastMode(bytes: string, mode: number): "on" | "off" | undefined {
  const on = bytes.lastIndexOf(`\x1b[?${mode}h`);
  const off = bytes.lastIndexOf(`\x1b[?${mode}l`);
  if (on < 0 && off < 0) return undefined;
  return on > off ? "on" : "off";
}
const lastMouseMode = (bytes: string) => lastMode(bytes, 1000);
const MOUSE_BYTES = /\x1b\[\?100[036][hl]/g;

const ALT_SHIFT_S = "\x1bS";
const ESC = "\x1b";

describe("opt-in sidebar mouse reporting (tui.mouse off)", () => {
  test("is off by default and `/sidebar mouse on` turns SGR click reporting on", async () => {
    const h = await harness();
    h.coreWrite("frame");
    expect(lastMouseMode(h.since(0))).toBeUndefined();

    const mark = h.terminal.out.length;
    await h.sidebar("mouse on");
    const bytes = h.since(mark);
    expect(bytes).toContain("\x1b[?1000h");
    expect(bytes).toContain("\x1b[?1006h");
  });

  test.each([
    ["/sidebar mouse off", (h: Harness) => h.sidebar("mouse off")],
    ["/sidebar off", (h: Harness) => h.sidebar("off")],
    ["session switch", (h: Harness) => h.switchSession()],
    ["exit", (h: Harness) => h.emit("session_shutdown")],
  ])("%s turns reporting off again (1000 and 1006)", async (_name, leave) => {
    const h = await harness();
    h.coreWrite("frame");
    await h.sidebar("mouse on");
    const mark = h.terminal.out.length;
    await leave(h);
    const bytes = h.since(mark);
    expect({ 1000: lastMode(bytes, 1000), 1006: lastMode(bytes, 1006) }).toEqual({
      1000: "off",
      1006: "off",
    });
  });

  test("a session switch turns reporting off before session_switch, and no report leaks in between", async () => {
    const h = await harness();
    h.coreWrite("frame");
    await h.sidebar("mouse on");
    const mark = h.terminal.out.length;
    let offBeforeSwitch: "on" | "off" | undefined;
    const leaked: string[] = [];
    await h.switchSession(() => {
      offBeforeSwitch = lastMouseMode(h.since(mark));
      // A report the terminal sent before it saw the OFF, arriving after
      // omp already dropped the extension's ctx.ui listeners.
      if (!h.input(sgr(0, 10, 4))) leaked.push("click in main area");
    });
    expect({ offBeforeSwitch, leaked }).toEqual({ offBeforeSwitch: "off", leaked: [] });
  });

  test("a cancelled switch leaves reporting off, nothing leaks, and `/sidebar mouse on` restores it", async () => {
    const h = await harness();
    h.coreWrite("frame");
    await h.sidebar("mouse on");
    let mark = h.terminal.out.length;
    await h.cancelledSwitch();
    h.coreWrite("frame after the cancelled switch");
    expect(lastMouseMode(h.since(mark))).toBe("off");
    expect(h.input(sgr(0, 10, 4))).toBe(true);
    expect(h.input(ALT_SHIFT_S)).toBe(true);

    mark = h.terminal.out.length;
    await h.sidebar("mouse on");
    expect(lastMouseMode(h.since(mark))).toBe("on");
  });

  test("no report leaks into the editor as text while reporting is on", async () => {
    const h = await harness();
    h.coreWrite("frame");
    await h.sidebar("mouse on");
    const main = 10;
    const reports = {
      "click in main area": sgr(0, main, 4),
      "release in main area": sgr(0, main, 4, true),
      "motion in main area": sgr(35, main, 4),
      "wheel in main area": sgr(64, main, 4),
      "right click in sidebar": sgr(2, SIDEBAR_COLUMN + 2, 0),
      "release in sidebar": sgr(0, SIDEBAR_COLUMN + 2, 0, true),
    };
    const leaked = Object.entries(reports)
      .filter(([, data]) => !h.input(data))
      .map(([name]) => name);
    expect(leaked).toEqual([]);
  });

  test("a fullscreen overlay gets plain input, and reporting returns when it closes", async () => {
    const h = await harness();
    h.coreWrite("frame");
    await h.sidebar("mouse on");

    // An overlay that did not ask for the mouse: omp enters the alt screen
    // without turning reporting on, so the sidebar's reporting must go.
    h.setOverlay(true);
    let mark = h.terminal.out.length;
    h.coreWrite(`${ALT_ENTER}overlay frame`);
    expect(lastMouseMode(h.since(mark))).toBe("off");

    // Closing it: omp writes its own OFF (or nothing) with the alt-screen exit;
    // the sidebar's reporting must be back on the same frame.
    h.setOverlay(false);
    mark = h.terminal.out.length;
    h.coreWrite(`${TUI_MOUSE_OFF}${ALT_EXIT}main frame`);
    expect(lastMouseMode(h.since(mark))).toBe("on");
  });

  test("a non-fullscreen overlay turns reporting off while it is up, and it returns after", async () => {
    const h = await harness();
    h.coreWrite("frame");
    await h.sidebar("mouse on");

    h.setOverlay(true);
    let mark = h.terminal.out.length;
    h.coreWrite("frame with an inline overlay");
    expect(lastMouseMode(h.since(mark))).toBe("off");

    h.setOverlay(false);
    mark = h.terminal.out.length;
    h.coreWrite("main frame");
    expect(lastMouseMode(h.since(mark))).toBe("on");
  });

  test("an overlay that asked omp for the mouse keeps it", async () => {
    const h = await harness();
    h.coreWrite("frame");
    await h.sidebar("mouse on");
    h.setOverlay(true);
    const mark = h.terminal.out.length;
    h.coreWrite(`${ALT_ENTER}${TUI_MOUSE_ON}overlay frame`);
    expect(lastMouseMode(h.since(mark))).toBe("on");
  });
});

describe("with tui.mouse: true the sidebar leaves mouse reporting to omp", () => {
  test("`/sidebar mouse on` says why and writes no mouse bytes; leaving writes none either", async () => {
    const h = await harness({ tuiMouse: true });
    const mark = h.terminal.out.length;
    h.coreWrite("frame");
    await h.sidebar("mouse on");
    expect(h.notes.some((note) => note.includes("tui.mouse"))).toBe(true);
    await h.sidebar("mouse off");
    await h.sidebar("off");
    await h.emit("session_shutdown");
    expect(h.since(mark).match(MOUSE_BYTES) ?? []).toEqual([]);
  });
});

describe("a click does not trap the keyboard", () => {
  test("after clicking a row, printable keys, Enter and Esc go to the editor", async () => {
    const h = await harness();
    h.coreWrite("frame");
    // Row 0 is the Context section header; a click collapses it.
    expect(h.input(sgr(0, SIDEBAR_COLUMN + 2, 0))).toBe(true);
    const keys = { a: "a", slash: "/", enter: "\r", escape: ESC };
    const kept = Object.entries(keys)
      .filter(([, data]) => h.input(data))
      .map(([name]) => name);
    expect(kept).toEqual([]);
  });

  test("Alt+Shift+S then Enter runs the selected row", async () => {
    const h = await harness();
    h.coreWrite("frame");
    expect(h.input(ALT_SHIFT_S)).toBe(true);
    expect(h.input("\r")).toBe(true);
    // The first selectable row is the Context header; running it collapses it.
    expect(h.sidebarRows()[0]).toContain("▸");
  });

  test("Alt+Shift+S then a key the sidebar does not bind drops focus and passes through", async () => {
    const h = await harness();
    h.coreWrite("frame");
    expect(h.input(ALT_SHIFT_S)).toBe(true);
    expect({ slash: h.input("/"), downAfterwards: h.input("\x1b[B") }).toEqual({
      slash: false,
      downAfterwards: false,
    });
  });

  test("Esc under explicit focus returns focus to the editor; a second Esc reaches omp", async () => {
    const h = await harness();
    h.coreWrite("frame");
    expect(h.input(ALT_SHIFT_S)).toBe(true);
    expect({ first: h.input(ESC), second: h.input(ESC) }).toEqual({ first: true, second: false });
  });

  test.each([
    ["unfocused", (_h: Harness) => {}],
    ["after a click", (h: Harness) => void h.input(sgr(0, SIDEBAR_COLUMN + 2, 0))],
    ["under explicit focus", (h: Harness) => void h.input(ALT_SHIFT_S)],
  ])("Ctrl+C and Ctrl+D reach omp %s", async (_state, enter) => {
    const h = await harness();
    h.coreWrite("frame");
    enter(h);
    expect({ ctrlC: h.input("\x03"), ctrlD: h.input("\x04") }).toEqual({
      ctrlC: false,
      ctrlD: false,
    });
  });
});


const selectedRow = (rows: string[]) => rows.find((row) => row.startsWith("› "));

describe("rework: key releases and unbound input under explicit focus (kitty flag 2)", () => {
  afterEach(() => setKittyProtocolActive(false));
  // Kitty CSI-u with event type 3 = release.
  const ALT_SHIFT_S_PRESS = "\x1b[115;4u";
  const ALT_SHIFT_S_RELEASE = "\x1b[115;4:3u";
  const DOWN_PRESS = "\x1b[1;1B";
  const DOWN_RELEASE = "\x1b[1;1:3B";
  const ENTER_PRESS = "\x1b[13u";
  const ENTER_RELEASE = "\x1b[13;1:3u";

  test("Alt+Shift+S press then release keeps explicit focus", async () => {
    const h = await harness();
    setKittyProtocolActive(true);
    h.coreWrite("frame");
    h.input(ALT_SHIFT_S_PRESS);
    h.input(ALT_SHIFT_S_RELEASE);
    expect(selectedRow(h.sidebarRows())).toBeDefined();
  });

  test("Down press then release moves the selection once and keeps focus", async () => {
    const once = await harness();
    const twice = await harness();
    setKittyProtocolActive(true);
    for (const h of [once, twice]) {
      h.coreWrite("frame");
      h.input(ALT_SHIFT_S_PRESS);
      h.input(DOWN_PRESS);
    }
    twice.input(DOWN_RELEASE);
    const expected = selectedRow(once.sidebarRows());
    expect(expected).toBeDefined();
    expect(selectedRow(twice.sidebarRows())).toBe(expected);
  });

  test("Enter release does not run the row a second time", async () => {
    const h = await harness();
    setKittyProtocolActive(true);
    h.coreWrite("frame");
    h.input(ALT_SHIFT_S_PRESS);
    h.input(ENTER_PRESS);
    h.input(ENTER_RELEASE);
    // Enter collapsed the Context header; a second run would expand it again.
    expect(h.sidebarRows()[0]).toStartWith("› ▸");
  });

  test("terminal replies, Tab and F-keys pass through without dropping focus", async () => {
    const h = await harness();
    h.coreWrite("frame");
    h.input(ALT_SHIFT_S);
    const unbound = {
      "2031 appearance report": "\x1b[?997;1n",
      "2048 resize report": "\x1b[48;30;140;600;1400t",
      tab: "\t",
      f5: "\x1b[15~",
    };
    const kept = Object.entries(unbound)
      .filter(([, data]) => h.input(data))
      .map(([name]) => name);
    expect({ kept, stillFocused: selectedRow(h.sidebarRows()) !== undefined }).toEqual({
      kept: [],
      stillFocused: true,
    });
  });
});

describe("rework: inspector failure does not wedge input", () => {
  test("after ctx.ui.custom rejects, reports are still swallowed and keys still route", async () => {
    const h = await harness({ files: ["notes.txt"], customRejects: true });
    h.coreWrite("frame");
    await h.sidebar("mouse on");
    let rows: string[] = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      rows = h.sidebarRows();
      if (rows.some((row) => row.includes("notes.txt"))) break;
      await Bun.sleep(50);
    }
    const fileRow = rows.findIndex((row) => row.includes("notes.txt"));
    expect(fileRow).toBeGreaterThan(0);
    expect(h.input(sgr(0, SIDEBAR_COLUMN + 4, fileRow))).toBe(true);
    for (let attempt = 0; attempt < 20 && !h.notes.some((n) => n.includes("custom UI")); attempt++)
      await Bun.sleep(25);
    expect(h.notes.some((note) => note.includes("custom UI unavailable"))).toBe(true);
    expect({
      mainAreaClick: h.input(sgr(0, 10, 4)),
      altShiftS: h.input(ALT_SHIFT_S),
    }).toEqual({ mainAreaClick: true, altShiftS: true });
  }, 10000);
});

describe("rework: preference across remounts and visibility", () => {
  test.each(["session_branch"])("%s remount keeps `/sidebar mouse on`", async (event) => {
    const h = await harness();
    h.coreWrite("frame");
    await h.sidebar("mouse on");
    const mark = h.terminal.out.length;
    await h.emit(event);
    h.coreWrite("frame after remount");
    expect(lastMouseMode(h.since(mark))).toBe("on");
  });

  test("reporting is off while the narrow-terminal rule hides the sidebar, and back when it shows", async () => {
    const h = await harness();
    h.coreWrite("frame");
    await h.sidebar("mouse on");
    h.terminal.physicalColumns = 80;
    let mark = h.terminal.out.length;
    h.coreWrite("narrow frame");
    expect(lastMouseMode(h.since(mark))).toBe("off");
    h.terminal.physicalColumns = COLUMNS;
    mark = h.terminal.out.length;
    h.coreWrite("wide frame");
    expect(lastMouseMode(h.since(mark))).toBe("on");
  });

  test("`/sidebar mouse on` also shows a hidden sidebar", async () => {
    const h = await harness();
    h.coreWrite("frame");
    await h.sidebar("off");
    const mark = h.terminal.out.length;
    await h.sidebar("mouse on");
    h.coreWrite("frame");
    expect(lastMouseMode(h.since(mark))).toBe("on");
    expect(h.sidebarRows().length).toBeGreaterThan(0);
  });

  test("turning reporting off also clears 1003 any-motion that omp may have set", async () => {
    const h = await harness();
    h.coreWrite("frame");
    await h.sidebar("mouse on");
    const mark = h.terminal.out.length;
    await h.sidebar("mouse off");
    expect(lastMode(h.since(mark), 1003)).toBe("off");
  });
});

describe("final round", () => {
  test("the sidebar never turns on 1003 any-motion tracking", async () => {
    const h = await harness();
    h.coreWrite("frame");
    const mark = h.terminal.out.length;
    await h.sidebar("mouse on");
    h.setOverlay(true);
    h.coreWrite(`${ALT_ENTER}overlay frame`);
    h.setOverlay(false);
    h.coreWrite(`${TUI_MOUSE_OFF}${ALT_EXIT}main frame`);
    expect(lastMouseMode(h.since(mark))).toBe("on");
    expect(h.since(mark)).not.toContain("\x1b[?1003h");
  });

  test("when omp owns the mouse, its ON and later frames draw no sidebar OFF", async () => {
    const h = await harness({ tuiMouse: true });
    const mark = h.terminal.out.length;
    h.coreWrite(`${TUI_MOUSE_ON}frame`);
    h.coreWrite("next frame");
    expect(h.since(mark)).not.toContain("\x1b[?1000l");
  });

  test.each([
    ["enter", "\r"],
    ["escape", ESC],
  ])("after a click, %s goes straight to the editor", async (_name, key) => {
    const h = await harness();
    h.coreWrite("frame");
    expect(h.input(sgr(0, SIDEBAR_COLUMN + 2, 0))).toBe(true);
    expect(h.input(key)).toBe(false);
  });

  test("Alt+Shift+B off clears the mouse preference, so a later remount does not re-enable it", async () => {
    const h = await harness();
    h.coreWrite("frame");
    await h.sidebar("mouse on");
    const mark = h.terminal.out.length;
    expect(h.input("\x1bB")).toBe(true);
    expect(h.input("\x1bB")).toBe(true);
    await h.emit("session_branch");
    h.coreWrite("frame after remount");
    expect(lastMouseMode(h.since(mark))).toBe("off");
  });

  test("dispose still turns reporting off when an earlier teardown step throws", async () => {
    const original = SidebarState.prototype.dispose;
    SidebarState.prototype.dispose = () => {
      throw new Error("state teardown failed");
    };
    try {
      const h = await harness();
      h.coreWrite("frame");
      await h.sidebar("mouse on");
      const mark = h.terminal.out.length;
      await h.emit("session_shutdown").catch(() => {});
      expect(lastMouseMode(h.since(mark))).toBe("off");
    } finally {
      SidebarState.prototype.dispose = original;
    }
  });
});
