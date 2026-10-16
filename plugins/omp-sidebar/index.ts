import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isKeyRelease, matchesKey, ScrollView, Text, truncateToWidth } from "@oh-my-pi/pi-tui";
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
  { value: "mouse", label: "mouse", description: "Sidebar mouse clicks and wheel: on | off" },
  { value: "width", label: "width", description: "Set width (16–80 columns)" },
  { value: "refresh", label: "refresh", description: "Refresh sidebar data" },
  { value: "status", label: "status", description: "Show sidebar status" },
];
const WIDTH_COMPLETIONS: readonly AutocompleteItem[] = Array.from({ length: 65 }, (_, index) => {
  const width = index + 16;
  return { value: `width ${width}`, label: String(width), description: `${width} columns` };
});

const MOUSE_COMPLETIONS: readonly AutocompleteItem[] = [
  { value: "mouse on", label: "on", description: "Report clicks and wheel to the sidebar" },
  { value: "mouse off", label: "off", description: "Stop mouse reporting (default)" },
];
const SGR_PREFIX = "\u001b[<";
const OMP_OWNS_MOUSE =
  "Sidebar mouse: omp's tui.mouse already turns mouse reporting on and consumes every report before extensions see it. Turn tui.mouse off to use /sidebar mouse on.";

type RawLayer = { tui?: { mouse?: unknown } } | undefined;
interface SettingsLayers {
  getGlobalSettings?(): RawLayer;
  getProjectSettings?(): RawLayer;
}

/**
 * omp's `tui.mouse` as configured in its global and project layers. Extensions
 * get no settings handle (no `settings` on the context, `cfgTuiMouse` is not
 * exported); `api.pi.settings` is the global singleton. Runtime-only overrides
 * are not visible here; later toggles are seen through omp's own writes.
 */
function readOmpMouseSetting(api: ExtensionAPI): boolean {
  try {
    const settings = (api.pi as unknown as { settings?: SettingsLayers }).settings;
    const project = settings?.getProjectSettings?.()?.tui?.mouse;
    if (typeof project === "boolean") return project;
    return settings?.getGlobalSettings?.()?.tui?.mouse === true;
  } catch {
    return false;
  }
}

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
  // In-process preference: survives remounts (branch, tree), cleared by
  // `/sidebar mouse off`, `/sidebar off` and session switches.
  let mouseWanted = false;
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
    try {
      inspectionAbort?.abort();
      inspectionAbort = undefined;
      state?.dispose();
    } finally {
      state = undefined;
      // Restores the terminal and writes mouse-off; must run even if a step above throws.
      compositor?.dispose();
      compositor = undefined;
      view = undefined;
      context = undefined;
    }
  };

  const inspect = async (action: string): Promise<void> => {
    const active = state;
    const ctx = context;
    const stamp = generation;
    if (!active || !ctx) return;
    let abort: AbortController | undefined;
    try {
      const result = await active.activate(action);
      compositor?.requestRender();
      if (!result || state !== active || generation !== stamp) return;
      view?.setFocused(false);
      inspectionAbort?.abort();
      const current = new AbortController();
      abort = current;
      inspectionAbort = current;
      try {
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
            signal: current.signal,
          },
        );
      } finally {
        // Also on rejection, or every later key would be ignored as "inspecting".
        if (inspectionAbort === current) inspectionAbort = undefined;
      }
    } catch (error) {
      if (generation === stamp && !abort?.signal.aborted)
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
        ompOwnsMouse: () => readOmpMouseSetting(api),
      });
      compositor.setEnabled(enabled);
      if (mouseWanted) compositor.setMouseReporting(true);
      const onInput = (data: string): { consume?: boolean; data?: string } | undefined => {
        if (tui.hasOverlay()) return;
        // Reports first: none may reach the editor, even while an inspection starts.
        if (data.startsWith(SGR_PREFIX)) return routeMouse(data);
        // Kitty flag-2 releases: the press already acted; the editor ignores them.
        if (inspectionAbort || isKeyRelease(data)) return;
        if (matchesKey(data, "alt+shift+b")) {
          toggle();
          return { consume: true };
        }
        if (matchesKey(data, "alt+shift+s")) {
          focus();
          return { consume: true };
        }
        if (!enabled) return;
        if (!compositor?.getSidebarBounds()) {
          if (view?.focused) view.setFocused(false);
          return;
        }
        if (view?.handleInput(data)) return { consume: true };
      };
      // Registered on the TUI itself, not ctx.ui.onTerminalInput: omp drops
      // extension listeners in prepareSessionSwitch (interactive-mode.ts:7987)
      // before session_before_switch, and a report already in flight must
      // still be consumed rather than typed into the editor.
      unsubscribeInput =
        typeof tui.addInputListener === "function"
          ? tui.addInputListener(onInput)
          : ctx.ui.onTerminalInput(onInput);
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

  /**
   * SGR reports while no overlay is up. When omp's tui.mouse owns reporting its
   * own listener consumes them first; otherwise every report is the sidebar's
   * (or a late one after it turned reporting off) and none may reach the editor.
   */
  const routeMouse = (data: string): { consume: true } | undefined => {
    if (compositor?.ompOwnsMouse) return;
    const mouse = parseSgrMouse(data);
    const bounds = enabled ? compositor?.getSidebarBounds() : undefined;
    if (mouse && bounds && mouse.col >= bounds.column && mouse.row >= 0 && mouse.row < bounds.rows) {
      if (mouse.wheel !== null) view?.scroll(mouse.wheel * 3);
      else if (mouse.leftClick) view?.click(mouse.row);
    }
    return { consume: true };
  };

  const setMouse = (on: boolean, ctx: ExtensionContext): void => {
    mouseWanted = on;
    if (on && !enabled) {
      enabled = true;
      compositor?.setEnabled(true);
    }
    const applied = compositor?.setMouseReporting(on) ?? false;
    if (on && !applied)
      ctx.ui.notify(
        compositor?.ompOwnsMouse ? OMP_OWNS_MOUSE : "Sidebar mouse: the sidebar is not shown.",
        "warning",
      );
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
    if (!enabled) {
      view?.setFocused(false);
      mouseWanted = false;
      compositor?.setMouseReporting(false);
    }
    compositor?.setEnabled(enabled);
  };

  api.registerCommand("sidebar", {
    description:
      "Full-height right status sidebar: on | off | toggle | focus | mouse on|off | width N | refresh | status",
    getArgumentCompletions: (prefix) => {
      const argument = prefix.trimStart().replace(/\s+/g, " ");
      const candidates = argument.startsWith("width ")
        ? WIDTH_COMPLETIONS
        : argument.startsWith("mouse ")
          ? MOUSE_COMPLETIONS
          : SUBCOMMANDS;
      return candidates.filter((item) => item.value.startsWith(argument));
    },
    handler: async (args, ctx) => {
      if (!context && ctx.hasUI) mount(ctx);
      const [command = "toggle", argument] = args.trim().split(/\s+/);
      if (command === "toggle" || command === "") toggle();
      else if (command === "on" || command === "off") {
        enabled = command === "on";
        if (!enabled) {
          view?.setFocused(false);
          mouseWanted = false;
          compositor?.setMouseReporting(false);
        }
        compositor?.setEnabled(enabled);
      } else if (command === "focus") focus();
      else if (command === "mouse" && (argument === "on" || argument === "off"))
        setMouse(argument === "on", ctx);
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
          `Sidebar ${enabled ? "on" : "off"}, width ${width}, mouse ${
            compositor?.ompOwnsMouse ? "owned by tui.mouse" : compositor?.mouseReporting ? "on" : "off"
          }; pure extension, normal OMP`,
          "info",
        );
      else
        ctx.ui.notify(
          "Usage: /sidebar on|off|toggle|focus|mouse on|off|width 16..80|refresh|status",
          "warning",
        );
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
  // omp has already dropped extension input listeners by now; turn reporting
  // off before the switch. A cancelled switch leaves it off (no event follows);
  // `/sidebar mouse on` turns it back on.
  api.on("session_before_switch", () => {
    mouseWanted = false;
    compositor?.setMouseReporting(false);
  });
  api.on("session_switch", (_event, ctx) => {
    mouseWanted = false;
    mount(ctx);
  });
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
