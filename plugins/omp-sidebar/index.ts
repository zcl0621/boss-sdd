import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { matchesKey, ScrollView, Text, truncateToWidth } from "@oh-my-pi/pi-tui";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { parseSgrMouse } from "@oh-my-pi/pi-tui/mouse";
import {
  sanitizeDisplayText,
  sanitizeDisplaySingleLine,
} from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { SidebarCompositor } from "./compositor";
import { SidebarState } from "./state";
import { SidebarView } from "./sidebar-view";

const WIDGET_KEY = "omp-sidebar-host";
const SUBCOMMANDS: readonly AutocompleteItem[] = [
  { value: "on", label: "on", description: "Show the sidebar" },
  { value: "off", label: "off", description: "Hide the sidebar" },
  { value: "toggle", label: "toggle", description: "Toggle the sidebar" },
  { value: "focus", label: "focus", description: "Change sidebar focus" },
  { value: "width", label: "width", description: "Set width (16–80 columns)" },
  { value: "refresh", label: "refresh", description: "Refresh sidebar data" },
  { value: "status", label: "status", description: "Show sidebar status" },
];
const WIDTH_COMPLETIONS: readonly AutocompleteItem[] = Array.from({ length: 65 }, (_, index) => {
  const width = index + 16;
  return { value: `width ${width}`, label: String(width), description: `${width} columns` };
});

export default function sidebarPlugin(api: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let state: SidebarState | undefined;
  let view: SidebarView | undefined;
  let compositor: SidebarCompositor | undefined;
  let refreshTimer: Timer | undefined;
  let animationTimer: Timer | undefined;
  let unsubscribeInput: (() => void) | undefined;
  let inspectionAbort: AbortController | undefined;
  let enabled = true;
  let width = 38;
  let generation = 0;
  let refreshing = false;

  const refresh = async (): Promise<void> => {
    if (!state || refreshing) return;
    refreshing = true;
    try {
      await state.refresh();
    } catch (error) {
      api.logger.warn("Sidebar refresh failed", { error: String(error) });
    } finally {
      refreshing = false;
    }
  };

  const dispose = (): void => {
    generation++;
    clearInterval(refreshTimer);
    refreshTimer = undefined;
    clearInterval(animationTimer);
    animationTimer = undefined;
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    inspectionAbort?.abort();
    inspectionAbort = undefined;
    state?.dispose();
    state = undefined;
    compositor?.dispose();
    compositor = undefined;
    view = undefined;
    context = undefined;
  };

  const inspect = async (action: string): Promise<void> => {
    const active = state;
    const ctx = context;
    const stamp = generation;
    if (!active || !ctx) return;
    try {
      const result = await active.activate(action);
      compositor?.requestRender();
      if (!result || state !== active || generation !== stamp) return;
      view?.setFocused(false);
      inspectionAbort?.abort();
      const abort = new AbortController();
      inspectionAbort = abort;
      await ctx.ui.custom<void>(
        (tui, _theme, _keys, done) => {
          const getTheme = () => ctx.ui.theme;
          let content = sanitizeDisplayText(result.content);
          let paintedTheme = getTheme();
          const body = new Text(paintedTheme.fg("text", content), 0, 0);
          const scroller = new ScrollView(body, {
            height: Math.max(1, tui.terminal.rows - 2),
            scrollbar: "auto",
            theme: {
              track: (value) => getTheme().fg("dim", value),
              thumb: (value) => getTheme().fg("accent", value),
            },
          });
          let busy = false;
          const timer = result.live
            ? ctx.setInterval(() => {
                if (busy || abort.signal.aborted || state !== active) return;
                busy = true;
                void active
                  .activate(action)
                  .then((next) => {
                    if (next && !abort.signal.aborted && state === active) {
                      content = sanitizeDisplayText(next.content);
                      paintedTheme = getTheme();
                      body.setText(paintedTheme.fg("text", content));
                      scroller.invalidate();
                      tui.requestRender();
                    }
                  })
                  .catch((error) =>
                    api.logger.warn("Sidebar output unavailable", { error: String(error) }),
                  )
                  .finally(() => {
                    busy = false;
                  });
              }, 1000)
            : undefined;
          return {
            render: (size) => {
              const theme = getTheme();
              if (theme !== paintedTheme) {
                paintedTheme = theme;
                body.setText(theme.fg("text", content));
                scroller.invalidate();
              }
              scroller.setHeight(Math.max(1, tui.terminal.rows - 2));
              return [
                truncateToWidth(
                  theme.fg("text", theme.bold(sanitizeDisplaySingleLine(result.title))),
                  size,
                ),
                ...scroller.render(size),
                truncateToWidth(theme.fg("dim", "↑↓ / PgUp PgDn scroll · Esc close"), size),
              ];
            },
            handleInput: (data) => {
              if (matchesKey(data, "escape")) done();
              else {
                const mouse = parseSgrMouse(data);
                if (mouse?.wheel !== undefined && mouse.wheel !== null)
                  scroller.scroll(mouse.wheel * 3);
                else scroller.handleScrollKey(data);
                tui.requestRender();
              }
            },
            invalidate: () => scroller.invalidate(),
            dispose: () => {
              clearInterval(timer);
              scroller.dispose();
            },
          };
        },
        {
          overlay: true,
          overlayOptions: { fullscreen: true, width: "100%", maxHeight: "100%", margin: 0 },
          signal: abort.signal,
        },
      );
      if (inspectionAbort === abort) inspectionAbort = undefined;
    } catch (error) {
      if (generation === stamp && !inspectionAbort?.signal.aborted)
        ctx.ui.notify(`Sidebar: ${String(error)}`, "warning");
    }
  };

  const mount = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    context?.ui.setWidget(WIDGET_KEY, undefined);
    dispose();
    context = ctx;
    ctx.ui.setWidget(WIDGET_KEY, (tui) => {
      const mountedGeneration = generation;
      const getTheme = () => ctx.ui.theme;
      state = new SidebarState(api, ctx, () => compositor?.requestRender());
      view = new SidebarView(
        () => state!.snapshot(),
        getTheme,
        (action) => {
          void inspect(action);
        },
        () => compositor?.requestRender(),
      );
      compositor = new SidebarCompositor(tui, (columns, rows) => view!.render(columns, rows), {
        width,
        getTheme,
        minMainWidth: 60,
        onUnsupported: (message) => ctx.ui.notify(message, "warning"),
      });
      compositor.setEnabled(enabled);
      unsubscribeInput = ctx.ui.onTerminalInput((data) => {
        if (inspectionAbort || tui.hasOverlay()) return;
        if (matchesKey(data, "alt+shift+b")) {
          toggle();
          return { consume: true };
        }
        if (matchesKey(data, "alt+shift+s")) {
          focus();
          return { consume: true };
        }
        if (!enabled) return;
        const bounds = compositor?.getSidebarBounds();
        if (!bounds) {
          if (view?.focused) view.setFocused(false);
          return;
        }
        if (data.startsWith("\u001b[<")) {
          const mouse = parseSgrMouse(data);
          if (mouse && mouse.col >= bounds.column && mouse.row >= 0 && mouse.row < bounds.rows) {
            if (mouse.wheel !== null) view?.scroll(mouse.wheel * 3);
            else if (mouse.leftClick) view?.click(mouse.row);
            return { consume: true };
          }
        }
        if (view?.handleInput(data)) return { consume: true };
      });
      refreshTimer = ctx.setInterval(() => {
        void refresh();
      }, 1000);
      animationTimer = ctx.setInterval(() => {
        if (enabled && view?.hasRunningRows && compositor?.getSidebarBounds())
          compositor.requestRender();
      }, 80);
      void refresh();
      // The zero-height widget supplies the supported TUI/lifecycle bridge;
      // the actual full-height sidebar is composed at the terminal boundary.
      return {
        render: () => [],
        invalidate() {},
        dispose: () => {
          if (generation === mountedGeneration) dispose();
        },
      };
    });
  };

  const focus = (): void => {
    if (!enabled) {
      enabled = true;
      compositor?.setEnabled(true);
    }
    view?.setFocused(!view.focused);
  };
  const toggle = (): void => {
    enabled = !enabled;
    if (!enabled) view?.setFocused(false);
    compositor?.setEnabled(enabled);
  };

  api.registerCommand("sidebar", {
    description:
      "Full-height right status sidebar: on | off | toggle | focus | width N | refresh | status",
    getArgumentCompletions: (prefix) => {
      const argument = prefix.trimStart().replace(/\s+/g, " ");
      const candidates = argument.startsWith("width ") ? WIDTH_COMPLETIONS : SUBCOMMANDS;
      return candidates.filter((item) => item.value.startsWith(argument));
    },
    handler: async (args, ctx) => {
      if (!context && ctx.hasUI) mount(ctx);
      const [command = "toggle", argument] = args.trim().split(/\s+/);
      if (command === "toggle" || command === "") toggle();
      else if (command === "on" || command === "off") {
        enabled = command === "on";
        if (!enabled) view?.setFocused(false);
        compositor?.setEnabled(enabled);
      } else if (command === "focus") focus();
      else if (command === "refresh") await refresh();
      else if (
        command === "width" &&
        argument &&
        /^\d+$/.test(argument) &&
        Number(argument) >= 16 &&
        Number(argument) <= 80
      ) {
        width = Number(argument);
        compositor?.setWidth(width);
      } else if (command === "status")
        ctx.ui.notify(
          `Sidebar ${enabled ? "on" : "off"}, width ${width}; pure extension, normal OMP`,
          "info",
        );
      else
        ctx.ui.notify("Usage: /sidebar on|off|toggle|focus|width 16..80|refresh|status", "warning");
    },
  });
  api.registerShortcut("alt+shift+b", {
    description: "Toggle right status sidebar",
    handler: toggle,
  });
  api.registerShortcut("alt+shift+s", {
    description: "Focus right status sidebar",
    handler: focus,
  });
  api.on("session_start", (_event, ctx) => mount(ctx));
  api.on("session_switch", (_event, ctx) => mount(ctx));
  api.on("session_branch", (_event, ctx) => mount(ctx));
  api.on("tool_call", (event, ctx) => {
    state?.recordToolCall(event, ctx);
  });
  api.on("tool_result", (event, ctx) => {
    void state
      ?.recordToolResult(event, ctx)
      .catch((error) =>
        api.logger.warn("Sidebar workspace activity update failed", { error: String(error) }),
      );
  });
  api.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") dispose();
  });
}
