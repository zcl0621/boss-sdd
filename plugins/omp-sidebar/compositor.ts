import { CURSOR_MARKER, fitLayoutLine } from "@oh-my-pi/pi-tui";
import type { Terminal, TUI } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme";

interface SidebarBounds {
  column: number;
  width: number;
  rows: number;
}

interface SidebarOptions {
  width: number;
  getTheme: () => Theme;
  minMainWidth?: number;
  onUnsupported?: (message: string) => void;
  /** omp's `tui.mouse` setting as read at mount; omp already turned reporting on. */
  ompOwnsMouse?: () => boolean;
}

type TerminalWrite = (this: Terminal, data: string) => void;

interface TerminalAdapter {
  readonly terminal: Terminal;
  readonly columnsDescriptor: PropertyDescriptor;
  readonly ownColumns: PropertyDescriptor | undefined;
  readonly ownWrite: PropertyDescriptor | undefined;
  readonly originalWrite: TerminalWrite;
  readonly columnsGetter: (this: Terminal) => number;
  readonly writeWrapper: TerminalWrite;
  dataColumns: number;
  autowrapEnabled: boolean;
  painted: SidebarBounds | undefined;
  /** Row texts as last painted over `painted`. */
  paintedLines: string[] | undefined;
  /** Cursor row the last core write left, when known (see coreEffect). */
  cursorRow: number | undefined;
}

interface SidebarState {
  readonly tui: TUI;
  readonly renderSidebar: (width: number, rows: number) => readonly string[];
  readonly getTheme: () => Theme;
  readonly minMainWidth: number;
  readonly onUnsupported: ((message: string) => void) | undefined;
  width: number;
  enabled: boolean;
  disposed: boolean;
  adapter: TerminalAdapter | undefined;
  bounds: SidebarBounds | undefined;
  lastUnsupported: string | undefined;
  mouse: MouseState;
}

/**
 * Opt-in SGR mouse reporting owned by the sidebar. omp's TUI keeps its own
 * private notion of the mode, so every core write is read for omp's own
 * ON/OFF bytes and the terminal is corrected after it.
 */
interface MouseState {
  /** `/sidebar mouse on` requested it. */
  wanted: boolean;
  /** omp's `tui.mouse` inline tracking owns the terminal: never write mouse bytes. */
  ompOwns: boolean;
  /** omp turned reporting on for the current overlay. */
  overlayOwned: boolean;
  /** Last mode the byte stream left the terminal in, from either side. */
  on: boolean;
  /** The sidebar's own bytes put it there. */
  ours: boolean;
}

const terminalOwners = new Map<Terminal, SidebarState>();
const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
// eslint-disable-next-line no-control-regex -- Match only the host's DEC synchronized-output escape wrappers.
const SYNC_WRAPPERS = /\x1b\[\?2026[hl]/g;
const AUTOWRAP_ON = "\x1b[?7h";
const AUTOWRAP_OFF = "\x1b[?7l";
// Clicks and wheel only (no 1003 any-motion) with SGR coordinates.
const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
// Same bytes as omp's own OFF, so a 1003 set by omp is never left behind.
const MOUSE_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";
const CORE_MOUSE_ON = "\x1b[?1000h";
const CORE_MOUSE_OFF = "\x1b[?1000l";

/** Record what a core write did to mouse reporting. */
function observeCoreMouse(state: SidebarState, data: string): void {
  const on = data.lastIndexOf(CORE_MOUSE_ON);
  const off = data.lastIndexOf(CORE_MOUSE_OFF);
  if (on < 0 && off < 0) return;
  const mouse = state.mouse;
  const overlay = state.tui.hasOverlay();
  mouse.ours = false;
  mouse.on = on > off;
  if (mouse.on) {
    if (overlay) mouse.overlayOwned = true;
    else mouse.ompOwns = true;
  } else {
    mouse.overlayOwned = false;
    if (!overlay) mouse.ompOwns = false;
  }
}

/** Bytes that bring mouse reporting to what the sidebar wants now. */
function mouseCorrection(state: SidebarState): string {
  const mouse = state.mouse;
  if (mouse.ompOwns) return "";
  let want: boolean;
  if (state.tui.hasOverlay()) {
    if (mouse.overlayOwned) return "";
    want = false;
  } else {
    mouse.overlayOwned = false;
    // Only while the sidebar is actually painted: the narrow-terminal rule
    // hides it, and reporting would then swallow every main-area click.
    const adapter = state.adapter;
    want = mouse.wanted && adapter !== undefined && sidebarRegion(state, adapter) !== undefined;
  }
  if (want && !mouse.on) {
    mouse.on = true;
    mouse.ours = true;
    return MOUSE_ON;
  }
  if (!want && mouse.on) {
    mouse.on = false;
    mouse.ours = false;
    return MOUSE_OFF;
  }
  return "";
}

/** Terminal-cell width contract shared by construction and later resizing. */
function clampWidth(width: number): number {
  return Math.min(80, Math.max(16, Math.trunc(Number.isNaN(width) ? 16 : width)));
}

function reportUnsupported(state: SidebarState, message: string): void {
  if (state.lastUnsupported === message) return;
  state.lastUnsupported = message;
  state.onUnsupported?.(message);
}

function nativeSurfaceActive(state: SidebarState): boolean {
  if (!state.tui.nativeRendering && !state.tui.terminal.tspExpected) return false;
  state.bounds = undefined;
  reportUnsupported(
    state,
    "The sidebar supports ANSI viewports, not the Tern Surface Protocol renderer.",
  );
  return true;
}

function physicalColumns(adapter: TerminalAdapter): number {
  const value = adapter.columnsDescriptor.get
    ? adapter.columnsDescriptor.get.call(adapter.terminal)
    : adapter.dataColumns;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function sidebarRegion(state: SidebarState, adapter: TerminalAdapter): SidebarBounds | undefined {
  if (
    !state.enabled ||
    state.disposed ||
    state.tui.nativeRendering ||
    adapter.terminal.tspExpected
  ) {
    return undefined;
  }
  const columns = physicalColumns(adapter);
  const rows = adapter.terminal.rows;
  const mainWidth = columns - state.width - 1;
  if (rows <= 0 || mainWidth < state.minMainWidth) return undefined;
  // The painted region includes the divider; public bounds exclude it.
  return { column: mainWidth, width: state.width + 1, rows };
}

function clearSidebar(adapter: TerminalAdapter, region: SidebarBounds | undefined): string {
  const previous = adapter.painted;
  if (!previous && !region) return "";
  const columns = physicalColumns(adapter);
  const rows = adapter.terminal.rows;
  const column = Math.min(previous?.column ?? columns, region?.column ?? columns);
  const width = Math.max(0, columns - column);
  adapter.painted = undefined;
  if (width === 0 || rows <= 0) return "";
  let buffer = "\x1b7" + SEGMENT_RESET;
  for (let row = 0; row < rows; row++) {
    buffer += `\x1b[${row + 1};${column + 1}H\x1b[${width}X`;
  }
  return buffer + "\x1b8";
}

function sameRegion(a: SidebarBounds | undefined, b: SidebarBounds | undefined): boolean {
  return !!a && !!b && a.column === b.column && a.width === b.width && a.rows === b.rows;
}

/** What one core write does to the rows the sidebar occupies. */
interface CoreEffect {
  /** Upper bound on rows scrolled off the top; Infinity when it cannot be bounded. */
  scrolls: number;
  /** Rows (0-based) whose sidebar cells the write may have erased or shifted; "all" when it cannot say. */
  touched: Set<number> | "all";
  /** Cursor row after the write, when known. */
  row: number | undefined;
}

const ALT_SCREEN_RE = /^\?(?:.*;)?(?:47|1047|1049)(?:;|$)/;

/**
 * Walk one core write the way the terminal will, tracking only the cursor row.
 * `start` is the row the previous write left the cursor on; while the row is
 * unknown it is assumed to be the bottom row, so scrolls are never undercounted,
 * and an erase on an unknown row touches every row. Text never reaches the
 * sidebar (the core sees the narrowed width), so only erases, line inserts and
 * deletes, scrolls and screen switches touch sidebar cells.
 */
function coreEffect(data: string, rows: number, start: number | undefined): CoreEffect {
  const bottom = rows - 1;
  let known = start !== undefined && start >= 0 && start <= bottom;
  let row = known ? (start as number) : bottom;
  let saved = { row, known };
  let scrolls = 0;
  let all = false;
  const touched = new Set<number>();
  const mark = (from: number, to: number) => {
    if (!known) all = true;
    else for (let r = from; r <= to; r++) touched.add(r);
  };
  const lineFeed = () => {
    if (row >= bottom) scrolls++;
    else row++;
  };
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === "\n" || ch === "\v" || ch === "\f") {
      lineFeed();
      continue;
    }
    if (ch !== "\x1b") continue;
    const next = data[++i];
    if (next === "[") {
      let end = i + 1;
      while (end < data.length && (data.charCodeAt(end) < 0x40 || data.charCodeAt(end) > 0x7e)) end++;
      const params = data.slice(i + 1, end);
      const final = data[end];
      i = end;
      if (/^[?<>=]/.test(params)) {
        if ((final === "h" || final === "l") && ALT_SCREEN_RE.test(params)) {
          all = true;
          known = false;
          row = bottom;
        }
        continue;
      }
      const first = Number.parseInt(params.split(";")[0] ?? "", 10);
      const n = Number.isNaN(first) || first < 1 ? 1 : first;
      switch (final) {
        case "H":
        case "f":
        case "d":
          row = Math.min(bottom, n - 1);
          known = true;
          break;
        case "A":
        case "F":
          row = Math.max(0, row - n);
          break;
        case "B":
        case "E":
          row = Math.min(bottom, row + n);
          break;
        case "S":
          scrolls += n;
          break;
        case "T":
          all = true;
          break;
        case "J":
          if (first === 2) return { scrolls: Number.POSITIVE_INFINITY, touched: "all", row: known ? row : undefined };
          if (first === 1) mark(0, row);
          else if (first !== 3) mark(row, bottom);
          break;
        case "K":
        case "X":
        case "P":
        case "@":
          mark(row, row);
          break;
        case "L":
        case "M":
          mark(row, bottom);
          break;
        case "r":
          return { scrolls: Number.POSITIVE_INFINITY, touched: "all", row: undefined };
        case "s":
          saved = { row, known };
          break;
        case "u":
          ({ row, known } = saved);
          break;
      }
    } else if (next === "]" || next === "P" || next === "_" || next === "^") {
      // String sequences end at BEL (OSC only) or ST.
      while (++i < data.length) {
        if (data[i] === "\x07" && next === "]") break;
        if (data[i] === "\x1b" && data[i + 1] === "\\") {
          i++;
          break;
        }
      }
    } else if (next === "7") saved = { row, known };
    else if (next === "8") ({ row, known } = saved);
    else if (next === "D" || next === "E") lineFeed();
    else if (next === "M") {
      // Reverse index on the top row scrolls the screen down.
      if (!known || row === 0) all = true;
      row = Math.max(0, row - 1);
    } else if (next === "c") return { scrolls: Number.POSITIVE_INFINITY, touched: "all", row: undefined };
    else if (next !== undefined && next >= " " && next <= "/") i++; // ESC ( B and friends
  }
  return { scrolls, touched: all || scrolls > 0 ? "all" : touched, row: known ? row : undefined };
}

/** Erase the sidebar cells of the top `count` rows, the ones a scroll pushes into scrollback. */
function clearScrolledRows(
  adapter: TerminalAdapter,
  region: SidebarBounds,
  count: number,
): string {
  if (count <= 0) return "";
  if (count >= region.rows) return clearSidebar(adapter, region);
  const width = physicalColumns(adapter) - region.column;
  if (width <= 0) return "";
  let buffer = "\x1b7" + SEGMENT_RESET;
  for (let row = 0; row < count; row++) {
    buffer += `\x1b[${row + 1};${region.column + 1}H\x1b[${width}X`;
  }
  return buffer + "\x1b8";
}

function paintSidebar(
  state: SidebarState,
  adapter: TerminalAdapter,
  region: SidebarBounds | undefined,
  touched: Set<number> | "all" = "all",
): string {
  state.bounds = undefined;
  if (!region) {
    adapter.paintedLines = undefined;
    return "";
  }
  const width = region.width - 1;
  const lines = state.renderSidebar(width, region.rows);
  const divider = state.getTheme().fg("borderMuted", "│");
  const blank = fitLayoutLine("", width);
  // Rows already on screen with the same content are skipped unless the core touched them.
  const previous = sameRegion(adapter.painted, region) ? adapter.paintedLines : undefined;
  const painted: string[] = [];
  let buffer = "";
  for (let row = 0; row < region.rows; row++) {
    const line = lines[row];
    const text = divider + (line === undefined ? blank : fitLayoutLine(line.replaceAll(CURSOR_MARKER, ""), width));
    painted.push(text);
    if (previous && touched !== "all" && !touched.has(row) && previous[row] === text) continue;
    buffer += `\x1b[${row + 1};${region.column + 1}H` + SEGMENT_RESET + text + SEGMENT_RESET;
  }
  adapter.painted = region;
  adapter.paintedLines = painted;
  state.bounds = { column: region.column + 1, width, rows: region.rows };
  if (!buffer) return "";
  // No newline, even at the bottom-right cell. Restore the app's cursor,
  // rendition and its last emitted autowrap mode, not a sidebar cursor.
  return "\x1b7" + AUTOWRAP_OFF + buffer + "\x1b8" + (adapter.autowrapEnabled ? AUTOWRAP_ON : AUTOWRAP_OFF);
}

function repaintSidebar(state: SidebarState): void {
  const adapter = state.adapter;
  if (!adapter || nativeSurfaceActive(state)) return;
  const region = sidebarRegion(state, adapter);
  // Over an unchanged region only rows whose content changed are written:
  // erasing first would flash where DEC 2026 is off, and rewriting unchanged
  // rows on every data refresh is wasted output.
  const same = sameRegion(adapter.painted, region);
  const clear = same ? "" : clearSidebar(adapter, region);
  const buffer = clear + paintSidebar(state, adapter, region, same ? new Set() : "all");
  if (!buffer) return;
  // Preserve the host's explicit opt-out on terminals with broken DEC 2026.
  const synchronized = state.tui.synchronizedOutput !== false;
  adapter.originalWrite.call(
    adapter.terminal,
    synchronized ? SYNC_BEGIN + buffer + SYNC_END : buffer,
  );
}

function restoreAdapter(state: SidebarState): void {
  const adapter = state.adapter;
  if (!adapter) return;
  state.adapter = undefined;
  state.bounds = undefined;
  if (state.mouse.ours && state.mouse.on && !state.mouse.ompOwns) {
    state.mouse.on = false;
    state.mouse.ours = false;
    adapter.originalWrite.call(adapter.terminal, MOUSE_OFF);
  }
  if (!state.tui.nativeRendering && !adapter.terminal.tspExpected) {
    const clear = clearSidebar(adapter, undefined);
    if (clear) {
      const synchronized = state.tui.synchronizedOutput !== false;
      adapter.originalWrite.call(
        adapter.terminal,
        synchronized ? SYNC_BEGIN + clear + SYNC_END : clear,
      );
    }
  }
  const terminal = adapter.terminal;
  // Never overwrite a replacement another extension installed after us.
  if (Object.getOwnPropertyDescriptor(terminal, "columns")?.get === adapter.columnsGetter) {
    try {
      if (adapter.ownColumns) {
        const original = adapter.ownColumns;
        Object.defineProperty(
          terminal,
          "columns",
          "value" in original ? { ...original, value: adapter.dataColumns } : original,
        );
      } else {
        Reflect.deleteProperty(terminal, "columns");
      }
    } catch (error) {
      reportUnsupported(
        state,
        `Could not restore terminal.columns: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (Object.getOwnPropertyDescriptor(terminal, "write")?.value === adapter.writeWrapper) {
    try {
      if (adapter.ownWrite) Object.defineProperty(terminal, "write", adapter.ownWrite);
      else Reflect.deleteProperty(terminal, "write");
    } catch (error) {
      reportUnsupported(
        state,
        `Could not restore terminal.write: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (terminalOwners.get(terminal) === state) terminalOwners.delete(terminal);
}

function installAdapter(state: SidebarState): string | undefined {
  const terminal = state.tui.terminal;
  if (terminalOwners.has(terminal))
    return "A sidebar compositor is already attached to this terminal.";
  const ownColumns = Object.getOwnPropertyDescriptor(terminal, "columns");
  const ownWrite = Object.getOwnPropertyDescriptor(terminal, "write");
  let owner: object | null = terminal;
  let columnsDescriptor: PropertyDescriptor | undefined;
  while (owner && !columnsDescriptor) {
    columnsDescriptor = Object.getOwnPropertyDescriptor(owner, "columns");
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  if (
    !columnsDescriptor ||
    (!columnsDescriptor.get && (!ownColumns || typeof columnsDescriptor.value !== "number")) ||
    ownColumns?.configurable === false ||
    ownWrite?.configurable === false ||
    (!Object.isExtensible(terminal) && (!ownColumns || !ownWrite)) ||
    typeof terminal.write !== "function"
  ) {
    return "This terminal does not expose replaceable public columns and write properties.";
  }
  const originalWrite = terminal.write as TerminalWrite;
  const originalColumns = columnsDescriptor;
  const adapter: TerminalAdapter = {
    terminal,
    columnsDescriptor,
    ownColumns,
    ownWrite,
    originalWrite,
    dataColumns: terminal.columns,
    // OMP's completed ANSI paints restore autowrap before returning.
    autowrapEnabled: true,
    painted: undefined,
    paintedLines: undefined,
    cursorRow: undefined,
    columnsGetter: function () {
      // An externally retained wrapper is inert after detach/disposal.
      const region = state.adapter === adapter ? sidebarRegion(state, adapter) : undefined;
      return region?.column ?? physicalColumns(adapter);
    },
    writeWrapper: function (data) {
      if (this !== terminal || state.adapter !== adapter || state.disposed) {
        originalWrite.call(this, data);
        return;
      }
      if (nativeSurfaceActive(state)) {
        adapter.painted = undefined;
        adapter.cursorRow = undefined;
        originalWrite.call(this, data);
        return;
      }
      observeCoreMouse(state, data);
      const region = sidebarRegion(state, adapter);
      // The cursor row survives only while the geometry does: a resize reflows the screen.
      const same = region !== undefined && sameRegion(adapter.painted, region);
      const effect = coreEffect(data, adapter.terminal.rows, same || !region ? adapter.cursorRow : undefined);
      adapter.cursorRow = effect.row;
      if (!region && !adapter.painted) {
        state.bounds = undefined;
        originalWrite.call(this, data + mouseCorrection(state));
        return;
      }
      const wrapOn = data.lastIndexOf(AUTOWRAP_ON);
      const wrapOff = data.lastIndexOf(AUTOWRAP_OFF);
      if (wrapOn >= 0 || wrapOff >= 0) adapter.autowrapEnabled = wrapOn > wrapOff;
      // Clear existing sidebar cells BEFORE the core emits any newline or
      // scroll. Otherwise yesterday's sidebar becomes native scrollback. Over
      // an unchanged region only the rows this write can scroll off the top
      // are cleared: the paint below overwrites the rest, and erasing them
      // first makes the sidebar flash where DEC 2026 is off (Apple Terminal).
      const clear = same
        ? clearScrolledRows(adapter, region, effect.scrolls)
        : clearSidebar(adapter, region);
      const synchronized = state.tui.synchronizedOutput !== false;
      const core =
        synchronized && data.includes("\x1b[?2026") ? data.replace(SYNC_WRAPPERS, "") : data;
      // Only rows the core erased or shifted, plus rows whose content changed.
      const sidebar = paintSidebar(state, adapter, region, effect.touched);
      const buffer = clear + core + sidebar + mouseCorrection(state);
      originalWrite.call(this, synchronized ? SYNC_BEGIN + buffer + SYNC_END : buffer);
    },
  };
  try {
    Object.defineProperty(terminal, "columns", {
      configurable: true,
      enumerable: ownColumns?.enumerable ?? columnsDescriptor.enumerable ?? false,
      get: adapter.columnsGetter,
      set: originalColumns.set
        ? function (this: Terminal, value: number) {
            originalColumns.set?.call(this, value);
          }
        : ownColumns && "value" in ownColumns && ownColumns.writable
          ? function (value: number) {
              adapter.dataColumns = value;
            }
          : undefined,
    });
    Object.defineProperty(terminal, "write", {
      configurable: true,
      enumerable: ownWrite?.enumerable ?? false,
      writable: true,
      value: adapter.writeWrapper,
    });
  } catch (error) {
    state.adapter = adapter;
    restoreAdapter(state);
    return `Could not adapt this terminal: ${error instanceof Error ? error.message : String(error)}`;
  }
  state.adapter = adapter;
  terminalOwners.set(terminal, state);
  return undefined;
}

/**
 * Community-style ANSI adapter for the captured, already-running terminal.
 * Bundled OMP need not expose its Composer class or its private frame provider.
 */
export class SidebarCompositor {
  readonly state: SidebarState;

  constructor(
    tui: TUI,
    renderSidebar: (width: number, rows: number) => readonly string[],
    options: SidebarOptions,
  ) {
    this.state = {
      tui,
      renderSidebar,
      getTheme: options.getTheme,
      width: clampWidth(options.width),
      minMainWidth: Number.isFinite(options.minMainWidth)
        ? Math.max(60, Math.trunc(options.minMainWidth ?? 60))
        : 60,
      onUnsupported: options.onUnsupported,
      enabled: false,
      disposed: false,
      adapter: undefined,
      bounds: undefined,
      lastUnsupported: undefined,
      mouse: {
        wanted: false,
        ompOwns: options.ompOwnsMouse?.() === true,
        overlayOwned: false,
        on: false,
        ours: false,
      },
    };
    if (typeof tui.requestRender !== "function") {
      reportUnsupported(this.state, "This TUI does not expose a public render scheduler.");
      return;
    }
    this.setEnabled(true);
  }

  setEnabled(enabled: boolean): void {
    const state = this.state;
    if (state.disposed || (state.enabled === enabled && (!enabled || state.adapter))) return;
    state.enabled = enabled;
    state.bounds = undefined;
    if (!enabled) restoreAdapter(state);
    else {
      if (nativeSurfaceActive(state)) return;
      const error = installAdapter(state);
      if (error) {
        reportUnsupported(state, error);
        return;
      }
    }
    // A non-destructive full paint repairs the old layout without changing
    // focus or invalidating the application's component tree.
    state.tui.requestRender(true);
  }

  setWidth(width: number): void {
    const state = this.state;
    const next = clampWidth(width);
    if (state.disposed || state.width === next) return;
    state.width = next;
    state.bounds = undefined;
    if (state.adapter) state.tui.requestRender(true);
  }

  requestRender(): void {
    const state = this.state;
    if (state.disposed || !state.enabled || nativeSurfaceActive(state)) return;
    if (!state.adapter) {
      const error = installAdapter(state);
      if (error) {
        reportUnsupported(state, error);
        return;
      }
      state.tui.requestRender(true);
    }
    // Data-only updates must paint even if the core's unchanged-frame diff
    // emits no terminal.write at all.
    repaintSidebar(state);
    state.tui.requestRender();
  }

  dispose(): void {
    const state = this.state;
    if (state.disposed) return;
    const attached = state.adapter !== undefined;
    state.disposed = true;
    state.enabled = false;
    restoreAdapter(state);
    if (attached) state.tui.requestRender(true);
  }

  /**
   * Request or drop the sidebar's own mouse reporting. Returns false when
   * omp's `tui.mouse` owns reporting, in which case nothing is written.
   */
  setMouseReporting(wanted: boolean): boolean {
    const state = this.state;
    if (state.disposed) return false;
    state.mouse.wanted = wanted;
    if (state.mouse.ompOwns) return false;
    if (!wanted && !state.mouse.ours) return true;
    if (wanted && !state.adapter) this.requestRender();
    const adapter = state.adapter;
    if (!adapter) return !wanted;
    const bytes = mouseCorrection(state);
    if (bytes) adapter.originalWrite.call(adapter.terminal, bytes);
    return true;
  }

  /** omp's own inline tracking (`tui.mouse`) owns the terminal. */
  get ompOwnsMouse(): boolean {
    return this.state.mouse.ompOwns;
  }

  /** The sidebar's reporting is wanted and omp does not own the terminal. */
  get mouseReporting(): boolean {
    return this.state.mouse.wanted && !this.state.mouse.ompOwns;
  }

  getSidebarBounds(): SidebarBounds | undefined {
    const state = this.state;
    const adapter = state.adapter;
    const bounds = state.bounds;
    if (
      state.disposed ||
      !state.enabled ||
      !adapter ||
      !bounds ||
      nativeSurfaceActive(state) ||
      state.tui.hasOverlay() ||
      bounds.width !== state.width ||
      bounds.column + bounds.width !== physicalColumns(adapter) ||
      bounds.rows !== adapter.terminal.rows
    ) {
      return undefined;
    }
    return { ...bounds };
  }
}
