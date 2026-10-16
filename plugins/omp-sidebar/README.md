# OMP right sidebar

Pure extension for the ordinary `omp` command. Tested with the installed OMP **18.11.1** (release binary); the original baseline was **18.10.4**. Not a fork or replacement launcher. No tmux/Zellij, core-file patches, model requests, or changes to auth/models/session configuration.

## Use

Installed at `~/.omp/agent/extensions/sidebar/`. Start a new `omp` process; the full-height right sidebar is enabled by default.

- `/sidebar on`, `/sidebar off`, `/sidebar toggle`
- `/sidebar width 44` — 16–80 columns; default 38.
- Type `/sidebar ` to open the native subcommand menu. Prefixes filter candidates; ↑/↓ select, Tab completes, and Enter confirms/executes. `/sidebar width ` also offers valid 16–80 column values.
- `/sidebar focus` — switch keyboard focus; `Esc` returns to the editor.
- `/sidebar mouse on`, `/sidebar mouse off` — opt-in mouse clicks and wheel in the sidebar; off by default. See [Mouse](#mouse).
- `/sidebar refresh`, `/sidebar status`
- `Alt+Shift+B` toggles; `Alt+Shift+S` changes focus. `Ctrl+B` remains the editor's cursor-left binding.
- With explicit focus (`Alt+Shift+S` or `/sidebar focus`): arrows, Home/End, PgUp/PgDn; Left/Right collapse/expand sections; Enter/Space inspect. `Esc` returns focus to the editor (a second `Esc` reaches omp). Any other printable key hands focus back and goes to the editor, so typing `/exit` works. Other unbound input (Tab, function keys, terminal reports) and kitty key-release events pass through without changing focus. `Ctrl+C` and `Ctrl+D` always reach omp. Inspectors use OMP's public `ScrollView` and support scrolling and Esc.
- A mouse click acts on the row (collapse a section, open an inspector) without taking the keyboard: printable keys, Enter and Esc keep going to the editor.

## Mouse

`/sidebar mouse on` shows the sidebar if it is hidden and turns on SGR mouse reporting for clicks and wheel (`ESC[?1000h ESC[?1006h`; no any-motion tracking). Wheel over the sidebar scrolls it, a left click acts on a row, and every other report is swallowed so none reaches the editor as text. It is off by default. Reporting is turned off again (`ESC[?1006l ESC[?1003l ESC[?1000l`) by `/sidebar mouse off`, `/sidebar off`, a session switch and exit. The preference is kept in the process across branch and tree-navigation remounts, but not across a session switch.

Reporting is on only while the sidebar is actually painted: when the narrow-terminal rule hides it, reporting goes off and returns when the sidebar shows again. While any omp overlay is up the sidebar turns its reporting off, unless omp turned reporting on for that overlay itself, and turns it back on when the overlay closes.

Side effects while it is on, as with omp's own `tui.mouse`: native text selection and the terminal's own scrollback wheel need the terminal's modifier (usually Shift; Option on some macOS terminals).

If omp is killed without cleanup (`kill -9`), the shell may keep reporting mouse events as text. Run `printf '\e[?1000l\e[?1006l'` or `reset`. A normal exit or crash path does this already: omp's `Terminal.stop()` and `emergencyTerminalRestore()` always write the mouse-off sequence.

If a session switch is cancelled by another extension, no `session_switch` follows and reporting stays off; run `/sidebar mouse on` again.

### Why not `tui.mouse`

With `tui.mouse: true`, mouse reports never reach extensions (omp 18.11.1 source):

- omp's inline mouse listener is installed in `InputController.setupKeyHandlers()` (`coding-agent/src/modes/controllers/input-controller.ts:465`), which runs at `interactive-mode.ts:2230`, before extension hooks are initialised (`interactive-mode.ts:2404`). Extension `onTerminalInput` handlers join the same listener set later (`extension-ui-controller.ts:1355`).
- The TUI walks that set in insertion order and stops at the first consume (`tui/src/tui.ts:2948-2956`). `#handleInlineMouse` (`input-controller.ts:776-785`) consumes every SGR report while `tui.mouse` is on and no overlay is up.
- No extension hook runs before it. The only earlier step is the focused component's `capturesInput()` (`tui.ts:2936-2945`), which an extension reaches only by owning focus: replacing the editor (`setEditorComponent`) or a modal `ctx.ui.custom`. Neither fits a sidebar.
- With `tui.mouse` off, omp never enables reporting on the main screen (`tui.ts:3754-3761`; the provider is `interactive-mode.ts:1856`), so a real terminal sends nothing.

When `tui.mouse` is on, the sidebar leaves mouse reporting entirely to omp: it writes no mouse bytes and `/sidebar mouse on` says why. Extensions get no settings handle (no `settings` on the context; `cfgTuiMouse` is not exported), so the sidebar reads only the raw global and project layers of `api.pi.settings` (`getGlobalSettings()`, `getProjectSettings()`) when it mounts, and then follows omp's own on/off writes. omp also merges a `--config` overlay layer (`configOverlay`) and runtime overrides (`overrides`) over those two (`config/settings.ts:3900-3903`); a `tui.mouse` set only there, or only on a session's settings, is not seen at mount. If you enable `tui.mouse` that way, do not also run `/sidebar mouse on`.

The sidebar listens with `tui.addInputListener` rather than `ctx.ui.onTerminalInput`. For user-initiated `/new`, `/clear` and resume (`selector-controller.ts:1893-1908` `handleResumeSession`), omp drops extension input listeners in `prepareSessionSwitch` (`interactive-mode.ts:7982-7987`) before `session_before_switch` is emitted; reporting goes off at `session_before_switch`, and a report already in flight is still swallowed by the TUI-level listener. For extension-initiated `newSession`/`switchSession` (`extension-ui-controller.ts:270-275, 331-336, 501-506, 559-564`), omp calls `prepareSessionSwitch` and then `clearHookWidgets()`, both before `session_before_switch`; `clearHookWidgets()` disposes the sidebar's widget (`extension-ui-controller.ts:1364-1367`), and disposal removes the listener and writes the mouse-off sequence in the same step.

At least 60 main columns are retained. Narrow terminals temporarily hide the sidebar. Width and enabled state are in-process preferences, not configuration-file writes.

## Data and boundaries

- **Context:** actual OMP usage estimate, selected model capacity, percentage and progress bar. `19K / 500K` is `3.8%`; unknown data is `?`, never invented zero. The compaction marker appears only when OMP exposes the canonical threshold. Native OMP warning colors are reused. Below the meter, a per-category list (Messages, MCP tools, System tools, System prompt, System context, Skills, Autocompact buffer, Free space) shows tokens and share of the window, from the same estimate as `/context`; the bar is split by the same colors. Empty categories are hidden. omp keeps MCP tools discoverable by default and calls them through `xd://` paths, so their schemas usually cost nothing and the MCP row stays hidden; the server listing counts under System context.
- **Agents:** only currently running Main/child agents are listed. Idle, parked and aborted agents disappear. Entries use the current theme's animated spinner; selecting a live agent opens its read-only, refreshing transcript without redirecting main-editor input. When the selected child stops, sidebar scope returns to Main.
- **Terminal:** only running command-bearing Bash jobs and live running/ready services are listed, with the same animated spinner. Completed, failed, cancelled, stopped and offline/saved entries are hidden. Task/eval jobs are not OS terminals. Inspections display available native output and PIDs; service reads never launch a broker.
- **Git / Worktree:** the selected owner's active checkout, branch and staged/unstaged diffs. Root extension tool hooks and child execution events project successful filesystem-tool activity onto an existing checkout in the same Git repository. Explicit Bash cwd and structured read/write/edit/grep/glob targets are supported; relative paths resolve against native session cwd. Resume restores activity from the current journal branch. Native `/wt` relocation resets the projection; isolated children keep separate scopes. This does not relocate the native session, parse shell commands or require agent-declared branches. Failed calls, external repositories, internal resource URLs and ambiguous multi-checkout targets do not switch scope; pending background Bash results do not activate it.
- **Directory:** follows that checkout/worktree root, including when session cwd is nested below it; outside Git it follows session cwd. Bounded lazy expansion, file previews and binary detection are retained; symlinks remain leaves. File and containing-folder changes reuse native theme roles: success for added, warning for modified, error for deleted/conflicted, accent for renamed, muted for untracked.
- **Todo / Pins / Goal:** current selected scope's native todo journal, omp `context_notes` notebook (one Pins row per non-empty line; selecting a row inspects the full notebook; needs `compaction.experimentalContextManagement`) and goal state. Read-only inspections.

Data refresh runs once per second; visible running indicators animate every 80 ms without rereading Git or the filesystem. Collapsed/offscreen or finished entries do not keep the spinner animation repainting.

Background polling retains the last verified Git result, including `Working tree clean`, until the next repository result arrives. Refresh-in-progress alone does not hide a clean status. Initial workspace discovery, checkout switches and repository errors do not reuse a clean result from another workspace.

Colors are resolved from the live `ctx.ui.theme` getter on each render, including context, spinners, Git/Directory status, divider and inspector chrome/body. Switching OMP themes updates an already-open sidebar or inspector without recreating the plugin.

Layout uses the terminal's own font, quiet bold section headings and a consistent content gutter. Secondary model/path information and right-aligned state/count metadata use `muted`; accent is reserved for the active branch, running indicators and keyboard focus. Native `selectedBg` marks the focused row without replacing Git status colors. Completed/abandoned todos are muted; active tasks use accent and blocked tasks warning.

Empty Agents/Terminal sections show `Idle` in the heading; empty Todo/Pins/Goal show `None` without placeholder body rows. Context keeps its percentage, full-width meter, token ratio and one compaction label; repeated cwd/threshold rows are omitted. Long checkout/file paths retain their trailing components, Git status remains separate, and optional metadata disappears before the primary label becomes unreadable. Keyboard navigation skips decorative and metadata-only rows and retains the selected action across refreshes.

## Compatibility and removal

OMP has no official full-height sidebar slot. The plugin therefore uses a scoped, reversible adaptation of the actual terminal's public `columns` and `write` members, following the community approach in [pi-sidebar-tui](https://github.com/bi0h4z4rd88/pi-sidebar-tui). The main area genuinely reflows rather than being covered by an overlay. Rendering changes in future OMP releases may require a plugin update.

Release binaries do not serve every internal module to extensions: 18.11.1 has no `@oh-my-pi/pi-coding-agent/launch/*`. Those modules, and the context-breakdown helpers, load lazily; when one is missing only its feature drops out (the Terminal section's service status, or the per-category list) and the rest of the sidebar still loads.

ANSI terminal rendering is supported. Tern Surface Protocol is explicitly unsupported and left unmodified. Native dialogs keep their own input behavior and render within the main width. Each core write is followed for the cursor row it leaves (carried across writes until a resize or screen switch makes it unknown). Before a write that can scroll, the sidebar cells of the rows it can push off the top are cleared, so normal application scrolling does not copy sidebar text into history. After the write, the sidebar repaints only the rows the write printed on, erased, inserted or deleted, and rows whose content changed; any scroll, full erase or unknown cursor row repaints everything. A sidebar-only refresh writes nothing when no row changed. Nothing is erased first, so terminals without synchronized output (DEC 2026, e.g. Apple Terminal) do not flash. A physical terminal resize can move already-painted cells into history before application callbacks; that terminal-side boundary cannot be retroactively controlled.

`/sidebar off` restores the original terminal members and full main width. To uninstall, remove `~/.omp/agent/extensions/sidebar/` and restart OMP; no configuration entry or custom launcher needs undoing.

## Verification

`bun test` covers opt-in mouse reporting (on/off bytes, every way out, overlays, session switch and cancelled switch, coexistence with `tui.mouse`, no report reaching the editor), the click/focus keyboard rules, context boundaries, visible-spinner lifecycle, live theme changes on the same view, narrow Unicode paths, diff-count readability, action focus across layout changes, and real temporary Git/worktree projections: nested cwd, changed descendants, branch changes, overlapping refreshes, tool ordering, failed/external targets and journal restoration. Actual installed-CLI PTY walkthroughs additionally exercise native completed/failed/cancelled jobs, running-to-idle agent transitions, animated frames, Main/child worktree switching, native session relocation, successful tool-activity projection with unchanged native cwd, resumed worktree diffs, dark/light theme changes with an inspector open, editor behavior and clean shutdown. Fixture sessions block provider prompts and use isolated temporary homes.

The layout walkthrough checks 16/38/80-column sidebars and theme changes both while navigating and while inspecting a diff. It also reads the real terminal cells to confirm that focused-row backgrounds differ from adjacent rows and change between dark/light themes.
