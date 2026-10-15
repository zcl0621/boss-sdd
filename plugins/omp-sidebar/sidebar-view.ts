import { matchesKey, sliceWithWidth, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { sanitizeDisplaySingleLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { renderContextMeter } from "./context-meter";
import type { SidebarRow, SidebarSnapshot } from "./types";

interface ViewRow extends SidebarRow {
  styled?: string;
  header?: boolean;
}

export class SidebarView {
  #snapshot: () => SidebarSnapshot;
  #getTheme: () => Theme;
  #activate: (action: string) => void;
  #invalidate: () => void;
  #collapsed = new Set<string>();
  #selected = 0;
  #offset = 0;
  #focused = false;
  #visible: ViewRow[] = [];
  #all: ViewRow[] = [];
  #height = 0;
  #hasRunningRows = false;

  constructor(
    snapshot: () => SidebarSnapshot,
    getTheme: () => Theme,
    activate: (action: string) => void,
    invalidate: () => void,
  ) {
    this.#snapshot = snapshot;
    this.#getTheme = getTheme;
    this.#activate = activate;
    this.#invalidate = invalidate;
  }

  setFocused(focused: boolean): void {
    this.#focused = focused;
    this.#invalidate();
  }

  get focused(): boolean {
    return this.#focused;
  }
  get hasRunningRows(): boolean {
    return this.#hasRunningRows;
  }

  render(width: number, rows: number): readonly string[] {
    const contentWidth = Math.max(0, width - 5);
    const snapshot = this.#snapshot();
    const theme = this.#getTheme();
    const selectedId = this.#all[this.#selected]?.id;
    const output: ViewRow[] = [];
    const context = snapshot.sections.find((section) => section.id === "context");
    const meter = renderContextMeter(snapshot.usage, contentWidth, theme);
    output.push({
      id: "section:context",
      text: context?.title ?? "Context",
      action: "section:context",
      styled: `${theme.fg("muted", this.#collapsed.has("context") ? "▸" : "▾")} ${meter[0]}`,
    });
    if (!this.#collapsed.has("context")) {
      for (let index = 1; index < meter.length; index++)
        output.push({ id: `meter:${index}`, text: "", styled: meter[index] });
      for (const row of context?.rows ?? []) output.push(row);
    }
    let previousHasBody = !this.#collapsed.has("context");
    for (const section of snapshot.sections) {
      if (section.id === "context") continue;
      if (previousHasBody) output.push({ id: `space:${section.id}`, text: "" });
      output.push({
        id: `section:${section.id}`,
        text: section.title,
        detail: section.summary,
        action: `section:${section.id}`,
        header: true,
        emphasis: true,
      });
      previousHasBody = !this.#collapsed.has(section.id) && section.rows.length > 0;
      if (previousHasBody) output.push(...section.rows);
    }
    this.#all = output;
    this.#height = Math.max(0, rows - 1);
    const retained = selectedId ? output.findIndex((row) => row.id === selectedId) : -1;
    this.#selected = Math.max(
      0,
      Math.min(retained >= 0 ? retained : this.#selected, output.length - 1),
    );
    if (!output[this.#selected]?.action)
      this.#selected = Math.max(
        0,
        output.findIndex((row) => row.action),
      );
    this.#offset = Math.max(0, Math.min(this.#offset, output.length - this.#height));
    this.#visible = output.slice(this.#offset, this.#offset + this.#height);
    const frames = theme.spinnerFrames;
    const spinner = theme.fg("accent", frames[Math.floor(Date.now() / 80) % frames.length]!);
    this.#hasRunningRows = false;
    const lines = this.#visible.map((row, index) => {
      const selected = this.#focused && this.#offset + index === this.#selected;
      const marker =
        row.id === "section:context"
          ? ""
          : row.header
            ? theme.fg("muted", this.#collapsed.has(row.id.slice("section:".length)) ? "▸ " : "▾ ")
            : row.running
              ? `${spinner} `
              : row.prefix
                ? theme.fg(row.tone ?? "text", `${sanitizeDisplaySingleLine(row.prefix)} `)
                : "  ";
      const available = Math.max(0, width - 3 - visibleWidth(marker));
      const text = row.styled ?? this.#formatRow(row, available, theme);
      if (row.running) this.#hasRunningRows = true;
      const prefix = selected ? theme.fg("accent", "› ") : "  ";
      const value = truncateToWidth(`${prefix}${marker}${text}`, width);
      const padded = value + " ".repeat(Math.max(0, width - visibleWidth(value)));
      return selected ? theme.bg("selectedBg", padded) : padded;
    });
    while (lines.length < this.#height) lines.push(" ".repeat(width));
    if (rows > 0) {
      const hint = this.#focused
        ? width < 32
          ? "↑↓ Enter · Esc"
          : "↑↓ move  Enter inspect  Esc back"
        : width < 26
          ? "⌥⇧S focus"
          : "⌥⇧S focus  ⌥⇧B toggle";
      lines.push(truncateToWidth(theme.fg("dim", `  ${hint}`), width, ""));
    }
    return lines;
  }

  #formatRow(row: ViewRow, width: number, theme: Theme): string {
    let text = sanitizeDisplaySingleLine(row.text);
    const detail = row.detail ? sanitizeDisplaySingleLine(row.detail) : "";
    // Retain a useful primary label even in a 16-column sidebar.
    const suffix =
      detail && width >= Math.min(row.header ? 6 : 9, visibleWidth(text)) + visibleWidth(detail) + 1
        ? detail
        : "";
    const textWidth = Math.max(0, width - (suffix ? visibleWidth(suffix) + 1 : 0));
    if (row.tail && visibleWidth(text) > textWidth && textWidth > 1) {
      let tail = sliceWithWidth(text, visibleWidth(text) - textWidth + 1, textWidth - 1, true).text;
      const boundary = tail.indexOf("/");
      if (boundary >= 0 && boundary < tail.length - 1) tail = tail.slice(boundary);
      text = `…${tail}`;
    } else text = truncateToWidth(text, textWidth);
    const label = theme.fg(row.tone ?? "text", row.emphasis ? theme.bold(text) : text);
    return suffix
      ? label +
          " ".repeat(Math.max(1, width - visibleWidth(text) - visibleWidth(suffix))) +
          theme.fg("muted", suffix)
      : label;
  }

  handleInput(data: string): boolean {
    if (!this.#focused) return false;
    if (matchesKey(data, "escape")) this.setFocused(false);
    else if (matchesKey(data, "up")) this.#move(this.#selected - 1);
    else if (matchesKey(data, "down")) this.#move(this.#selected + 1);
    else if (matchesKey(data, "home")) this.#move(0);
    else if (matchesKey(data, "end")) this.#move(this.#all.length - 1);
    else if (matchesKey(data, "pageUp")) this.#move(this.#selected - this.#height);
    else if (matchesKey(data, "pageDown")) this.#move(this.#selected + this.#height);
    else if (matchesKey(data, "left")) this.#setCollapsed(true);
    else if (matchesKey(data, "right")) this.#setCollapsed(false);
    else if (matchesKey(data, "enter") || data === " ") this.#run(this.#all[this.#selected]);
    return true;
  }

  click(row: number): void {
    const target = this.#visible[row];
    if (!target?.action) return;
    this.#focused = true;
    this.#selected = this.#offset + row;
    this.#run(target);
  }

  scroll(lines: number): void {
    this.#offset = Math.max(
      0,
      Math.min(Math.max(0, this.#all.length - this.#height), this.#offset + lines),
    );
    this.#selected = Math.max(
      this.#offset,
      Math.min(this.#selected, this.#offset + Math.max(0, this.#height - 1)),
    );
    this.#invalidate();
  }

  #move(index: number): void {
    const direction = index >= this.#selected ? 1 : -1;
    let target = Math.max(0, Math.min(Math.max(0, this.#all.length - 1), index));
    while (target >= 0 && target < this.#all.length && !this.#all[target]?.action)
      target += direction;
    if (target < 0 || target >= this.#all.length) return;
    this.#selected = target;
    if (this.#selected < this.#offset) this.#offset = this.#selected;
    if (this.#selected >= this.#offset + this.#height)
      this.#offset = this.#selected - this.#height + 1;
    this.#invalidate();
  }

  #setCollapsed(collapsed: boolean): void {
    const row = this.#all[this.#selected];
    if (!row?.action?.startsWith("section:")) return;
    const id = row.action.slice("section:".length);
    if (collapsed) this.#collapsed.add(id);
    else this.#collapsed.delete(id);
    this.#invalidate();
  }

  #run(row: ViewRow | undefined): void {
    if (!row?.action) return;
    if (row.action.startsWith("section:")) {
      const id = row.action.slice("section:".length);
      if (this.#collapsed.has(id)) this.#collapsed.delete(id);
      else this.#collapsed.add(id);
      this.#invalidate();
    } else this.#activate(row.action);
  }
}
