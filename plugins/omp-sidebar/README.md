# OMP right sidebar

Pure extension for the ordinary `omp` command. Tested with the installed OMP **18.11.1** (release binary); the original baseline was **18.10.4**. Not a fork or replacement launcher. No tmux/Zellij, core-file patches, model requests, or changes to auth/models/session configuration.

## Use

Installed at `~/.omp/agent/extensions/sidebar/`. Start a new `omp` process; the full-height right sidebar is enabled by default.

- `/sidebar on`, `/sidebar off`, `/sidebar toggle`
- `/sidebar width 44` — 16–80 columns; default 38.
- Type `/sidebar ` to open the native subcommand menu. Prefixes filter candidates; ↑/↓ select, Tab completes, and Enter confirms/executes. `/sidebar width ` also offers valid 16–80 column values.
- `/sidebar focus` — switch keyboard focus; `Esc` returns to the editor.
- `/sidebar refresh`, `/sidebar status`
- `Alt+Shift+B` toggles; `Alt+Shift+S` changes focus. `Ctrl+B` remains the editor's cursor-left binding.
- In the sidebar: arrows, Home/End, PgUp/PgDn; Left/Right collapse/expand sections; Enter/Space inspect. Inspectors use OMP's public `ScrollView` and support scrolling and Esc.
- Mouse routing is available when the host already enables mouse reporting; the plugin does not globally capture terminal mouse input.

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

ANSI terminal rendering is supported. Tern Surface Protocol is explicitly unsupported and left unmodified. Native dialogs keep their own input behavior and render within the main width. Before core writes, right-hand cells are cleared so normal application scrolling does not copy sidebar text into history. A physical terminal resize can move already-painted cells into history before application callbacks; that terminal-side boundary cannot be retroactively controlled.

`/sidebar off` restores the original terminal members and full main width. To uninstall, remove `~/.omp/agent/extensions/sidebar/` and restart OMP; no configuration entry or custom launcher needs undoing.

## Verification

`bun test` covers context boundaries, visible-spinner lifecycle, live theme changes on the same view, narrow Unicode paths, diff-count readability, action focus across layout changes, and real temporary Git/worktree projections: nested cwd, changed descendants, branch changes, overlapping refreshes, tool ordering, failed/external targets and journal restoration. Actual installed-CLI PTY walkthroughs additionally exercise native completed/failed/cancelled jobs, running-to-idle agent transitions, animated frames, Main/child worktree switching, native session relocation, successful tool-activity projection with unchanged native cwd, resumed worktree diffs, dark/light theme changes with an inspector open, editor behavior and clean shutdown. Fixture sessions block provider prompts and use isolated temporary homes.

The layout walkthrough checks 16/38/80-column sidebars and theme changes both while navigating and while inspecting a diff. It also reads the real terminal cells to confirm that focused-row backgrounds differ from adjacent rows and change between dark/light themes.
