# omp-sound

opencode's attention sounds for an ordinary `omp` session, on macOS. Tested with omp **18.11.1**.

The sounds in `sounds/` are opencode's own (`packages/ui/src/assets/audio/*.mp3` from [anomalyco/opencode](https://github.com/anomalyco/opencode) at `180fd9d`, MIT, see `sounds/LICENSE-opencode`). The mapping follows opencode's TUI (`packages/tui/src/attention.ts`): done `bip-bop-01`, question `bip-bop-03`, permission `staplebops-06`, error `nope-03`, subagent done `yup-01`. opencode has no subagent-start sound; `bip-bop-02` from the same pack fills in.

| Key | When | Default |
|---|---|---|
| `subagentStart` | a subagent's first `agent_start` | bip-bop-02 |
| `subagentDone` | a subagent's final `agent_end`, last stop reason not error/aborted | yup-01 |
| `subagentFail` | a subagent's final `agent_end` with stop reason `error` or `aborted` | nope-03 |
| `done` | the main agent's final `agent_end` (silent when you pressed Esc) | bip-bop-01 |
| `error` | the main agent's final `agent_end` with stop reason `error` | nope-03 |
| `approval` | `tool_approval_requested`, any session | staplebops-06 |
| `question` | omp's `ask` tool starts, any session | bip-bop-03 |

## Install

```bash
mkdir -p ~/.omp/agent/extensions/omp-sound
rsync -a --exclude node_modules --exclude '*.test.ts' --exclude bun.lock plugins/omp-sound/ ~/.omp/agent/extensions/omp-sound/
```

Start a new `omp` process.

## Use

- `/sound on`, `/sound off`: saved to `~/.omp/agent/omp-sound.json` (omp's agent directory; `$OMP_SOUND_CONFIG` overrides the path).
- `/sound test`, `/sound test subagentDone`: play every key's sound, or one, even while off. `/sound test nope-07` plays any bundled sound by name.
- `/sound list`: the 45 bundled names (alert-*, bip-bop-*, nope-*, staplebops-*, yup-*).
- `/sound status`: what is on and which file each key uses.
- `OMP_SOUND=off omp`: silent for that process only.

Change sounds or volume in the JSON file. A bare name is `sounds/<name>.mp3` when that exists, else a macOS system sound in `/System/Library/Sounds/` (Basso, Glass, Hero, Ping, Pop, Tink, …); anything with a `/` is a path to any file `afplay` plays; `false` mutes that key.

```json
{
  "enabled": true,
  "volume": 0.5,
  "sounds": { "subagentStart": false, "done": "staplebops-02", "error": "Basso" }
}
```

## How it works

omp rebinds extension factories to every subagent session (`ExtensionAgentIdentity` in `extensibility/extensions/types.ts`), so `ctx.agent.kind` tells the main session (`"main"`) from a subagent (`"sub"`). The sounds hang off each session's own `agent_start` / `agent_end`, not off the `task` tool: `async.enabled` defaults to true, and then `task` returns as soon as the background subagents are registered, long before they finish.

An `agent_end` with `willContinue` is not final (an automatic continuation, or the main agent waiting on background subagents) and plays nothing. The same key within 300 ms plays once, so parallel subagents that start or finish together make one sound. The advisor is skipped.

Playback is `afplay`, detached, with errors ignored. On other platforms the extension does nothing audible.

`OMP_SOUND_LOG=<file>` appends one line per event, played or not, for checking what fired:

```
subagentStart scout 01a14660-… -> ~/.omp/agent/extensions/omp-sound/sounds/bip-bop-02.mp3
subagentDone scout 01a14660-… stop=stop -> ~/.omp/agent/extensions/omp-sound/sounds/yup-01.mp3
done main stop=stop -> ~/.omp/agent/extensions/omp-sound/sounds/bip-bop-01.mp3
```

## Test

```bash
bun test
```
