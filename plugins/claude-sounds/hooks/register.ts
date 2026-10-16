// opencode's attention sounds for Claude Code.
//
// Sounds: opencode's packages/ui/src/assets/audio/*.mp3 (anomalyco/opencode 180fd9d, MIT, sounds/LICENSE-opencode).
// Mapping as opencode's TUI (packages/tui/src/attention.ts): done bip-bop-01, question bip-bop-03,
// permission staplebops-06, error nope-03, subagent_done yup-01. opencode has no subagent-start sound;
// bip-bop-02 from the same pack fills in.
//
//   subagentStart  agent.spawn that started a subagent (not refused)
//   subagentDone   turn.complete with agentId, reason answer
//   subagentFail   turn.complete with agentId, reason error or refusal
//   done           turn.complete of the main loop, reason answer
//   error          turn.complete of the main loop, reason error or refusal (aborted: silent, you pressed Esc)
//   approval       classic.PermissionRequest: the permission dialog is up
//   question       tool.call of AskUserQuestion
//
// Playback is fire-and-forget, so no event waits on a clip. The same key within 300 ms plays once (parallel
// subagents starting or finishing together). /sound on|off is kept in $.store, across sessions.
import type { EngineInterface as Engine, Register } from 'claude-code'

export const SOUNDS = {
  subagentStart: 'bip-bop-02',
  subagentDone: 'yup-01',
  subagentFail: 'nope-03',
  done: 'bip-bop-01',
  error: 'nope-03',
  approval: 'staplebops-06',
  question: 'bip-bop-03',
} as const
export type SoundKey = keyof typeof SOUNDS
export const KEYS = Object.keys(SOUNDS) as SoundKey[]

// Every mp3 in sounds/, for /sound test <name>.
export const NAMES = [
  'alert-01', 'alert-02', 'alert-03', 'alert-04', 'alert-05', 'alert-06', 'alert-07', 'alert-08', 'alert-09', 'alert-10',
  'bip-bop-01', 'bip-bop-02', 'bip-bop-03', 'bip-bop-04', 'bip-bop-05', 'bip-bop-06', 'bip-bop-07', 'bip-bop-08',
  'bip-bop-09', 'bip-bop-10',
  'nope-01', 'nope-02', 'nope-03', 'nope-04', 'nope-05', 'nope-06', 'nope-07', 'nope-08', 'nope-09', 'nope-10',
  'nope-11', 'nope-12',
  'staplebops-01', 'staplebops-02', 'staplebops-03', 'staplebops-04', 'staplebops-05', 'staplebops-06', 'staplebops-07',
  'yup-01', 'yup-02', 'yup-03', 'yup-04', 'yup-05', 'yup-06',
]

export const DEBOUNCE_MS = 300
const GAIN = 0.5
const OFF = 'off'

// Module state: starts over on a reload, which only loses a debounce window.
const lastPlayed = new Map<SoundKey, number>()

const clip = (name: string) => ({ asset: `sounds/${name}.mp3` })

function playName($: Engine, name: string): void {
  void $.audio.play(clip(name), { gain: GAIN }).catch(() => {})
}

async function play($: Engine, key: SoundKey): Promise<void> {
  if ((await $.store.get(OFF)) === true) return
  const now = await $.clock.now()
  if (now - (lastPlayed.get(key) ?? -Infinity) < DEBOUNCE_MS) return
  lastPlayed.set(key, now)
  playName($, SOUNDS[key])
}

/** Starts a sound without holding the event: errors are swallowed, the chain goes on. */
const cue = ($: Engine, key: SoundKey) => void play($, key).catch(() => {})

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sound',
      description: "opencode's sounds: on | off | test [key|name] | list | status",
    })
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny === undefined) cue($, 'subagentStart')
    return started
  })

  on('turn.complete', ($, e, next) => {
    const failed = e.reason === 'error' || e.reason === 'refusal'
    if (e.agentId !== undefined) cue($, failed ? 'subagentFail' : 'subagentDone')
    else if (e.reason !== 'aborted') cue($, failed ? 'error' : 'done')
    return next(e)
  })

  on('classic.PermissionRequest', ($, e, next) => {
    cue($, 'approval')
    return next(e)
  })

  on('tool.call', { tool: 'AskUserQuestion' }, ($, e, next) => {
    cue($, 'question')
    return next(e)
  })

  on('command.run', { command: 'sound' }, async ($, e) => {
    const [word = 'status', argument] = e.args.trim().split(/\s+/)
    if (word === 'on' || word === 'off') {
      await $.store.set(OFF, word === 'off')
      return { text: `Sounds ${word}.` }
    }
    if (word === 'test') {
      if (argument === undefined) {
        KEYS.forEach((key, i) => void $.clock.after(i * 900, () => playName($, SOUNDS[key])))
        return { text: `Playing ${KEYS.map(k => `${k} (${SOUNDS[k]})`).join(', ')}.` }
      }
      const name = (SOUNDS as Record<string, string>)[argument] ?? (NAMES.includes(argument) ? argument : undefined)
      if (name === undefined) return { text: `Unknown sound: ${argument}. A key (${KEYS.join(', ')}) or a name from /sound list.` }
      playName($, name)
      return { text: `Playing ${name}.` }
    }
    if (word === 'list') return { text: `Bundled sounds (opencode): ${NAMES.join(', ')}.` }
    const off = (await $.store.get(OFF)) === true
    return { text: `Sounds ${off ? 'off' : 'on'}. ${KEYS.map(k => `${k}=${SOUNDS[k]}`).join(', ')}.` }
  })
}
