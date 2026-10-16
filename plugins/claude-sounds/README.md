# opencode-sounds

opencode's attention sounds for Claude Code (CLI and the desktop app's Code tab), on macOS. Built and tested on Claude Code 2.1.299.

| Key | When | Sound |
|---|---|---|
| `subagentStart` | `agent.spawn` started a subagent | bip-bop-02 |
| `subagentDone` | a subagent's `turn.complete`, answered | yup-01 |
| `subagentFail` | a subagent's `turn.complete`, error or refusal | nope-03 |
| `done` | the main loop's `turn.complete`, answered | bip-bop-01 |
| `error` | the main loop's `turn.complete`, error or refusal (Esc is silent) | nope-03 |
| `approval` | `classic.PermissionRequest`: the permission dialog is up | staplebops-06 |
| `question` | `AskUserQuestion` is called | bip-bop-03 |

The sounds are opencode's own (`packages/ui/src/assets/audio/*.mp3`, anomalyco/opencode `180fd9d`, MIT, `sounds/LICENSE-opencode`), mapped as opencode's TUI maps them (`packages/tui/src/attention.ts`). opencode has no subagent-start sound; `bip-bop-02` fills in.

`/sound on|off` (kept across sessions), `/sound test [key|name]`, `/sound list` (all 45 bundled names), `/sound status`.

Playback is `$.audio.play`, which uses `afplay` on macOS; a Linux or Windows terminal plays nothing. Sounds never hold an event: each is started and left to play, and a hook that fails is skipped. The same key within 300 ms plays once.

Where an organization manages Claude Code, `classic.PermissionRequest` hooks of a plugin the person installed do not run (`claude plugin validate` says so), so `approval` stays silent there.

## Load it

Add the folder to `env` in `~/.claude/settings.json`; new sessions (CLI and the desktop app's Code tab) load it:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/boss-sdd/plugins/claude-sounds" } }
```

`claude plugin list` then shows `opencode-sounds@inline`, loaded. Several folders are joined with `:`.

## Check

`claude plugin validate .`, `claude plugin test .` (Claude Code 2.1.299 or later has `plugin test`).
