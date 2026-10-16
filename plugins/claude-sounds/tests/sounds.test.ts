import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The test's hooks sit beneath the plugin and stand for the engine: they record each clip the plugin plays and
// answer the events the plugin passes on with next(e).
function rig(on: On, store: Record<string, unknown> = {}) {
  const played: string[] = []
  on('audio.play', ($, e) => {
    if ('asset' in e.clip && e.clip.asset !== undefined) played.push(e.clip.asset.replace(/^sounds\/|\.mp3$/g, ''))
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'sound' } }))
  on('session.start', () => ({ cwd: '/tmp' }))
  on('turn.complete', $ => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'test-model', agentId: 'sub-1' }))
  on('tool.call', () => ({ result: 'answered' as never }))
  on('classic.PermissionRequest', () => ({}))
  mock.store(on, store)
  const clock = mock.clock(on, { now: 10_000 })
  return { played, clock }
}

const spawn = (prompt: string, subagentType = 'general-purpose') => ({
  tool_use_id: 'toolu_test',
  prompt,
  description: prompt,
  subagentType,
  provider: { plugin: 'engine', tier: 'core' } as const,
  parentModel: 'test-model',
  background: false,
  fork: false,
})

// /sound typed in the composer.
const sound = (args: string) => ({
  command: 'sound',
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: false, columns: 80 },
})

const end = (reason: 'answer' | 'aborted' | 'error', agentId?: string) => ({
  answer: 'ok',
  durationMs: 5,
  isAborted: reason === 'aborted',
  turnId: `t-${Math.random()}`,
  reason,
  ...(agentId === undefined ? {} : { agentId }),
})

describe('main loop', () => {
  test('an answered turn plays done', async ($, on) => {
    const { played, clock } = rig(on)
    await $.turn.complete(end('answer'))
    await clock.settle()
    expect(played).toEqual(['bip-bop-01'])
  })

  test('an error plays the error sound, an abort is silent', async ($, on) => {
    const { played, clock } = rig(on)
    await $.turn.complete(end('aborted'))
    await $.turn.complete(end('error'))
    await clock.settle()
    expect(played).toEqual(['nope-03'])
  })
})

describe('subagents', () => {
  test('a spawn plays the start sound, its answer plays yup', async ($, on) => {
    const { played, clock } = rig(on)
    await $.agent.spawn(spawn('look around', 'Explore'))
    await clock.settle()
    await $.turn.complete(end('answer', 'sub-1'))
    await clock.settle()
    expect(played).toEqual(['bip-bop-02', 'yup-01'])
  })

  test('a refused spawn is silent', async ($, on) => {
    const played: string[] = []
    on('agent.spawn', () => ({ deny: 'no' }))
    on('audio.play', ($, e) => {
      if ('asset' in e.clip && e.clip.asset !== undefined) played.push(e.clip.asset)
      return { value: undefined }
    })
    mock.store(on)
    const clock = mock.clock(on)
    await $.agent.spawn(spawn('x'))
    await clock.settle()
    expect(played).toEqual([])
  })

  test('a failed subagent plays nope', async ($, on) => {
    const { played, clock } = rig(on)
    await $.turn.complete(end('error', 'sub-2'))
    await clock.settle()
    expect(played).toEqual(['nope-03'])
  })

  test('subagents finishing together play once, later ones again', async ($, on) => {
    const { played, clock } = rig(on)
    for (const id of ['a', 'b', 'c']) await $.turn.complete(end('answer', id))
    await clock.settle()
    await clock.advance(400)
    await $.turn.complete(end('answer', 'd'))
    await clock.settle()
    expect(played).toEqual(['yup-01', 'yup-01'])
  })
})

describe('attention', () => {
  test('the permission dialog plays staplebops', async ($, on) => {
    const { played, clock } = rig(on)
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
    await clock.settle()
    expect(played).toEqual(['staplebops-06'])
  })

  test('AskUserQuestion plays the question sound, other tools do not', async ($, on) => {
    const { played, clock } = rig(on)
    await $.tool.call({ tool: 'Read', file_path: '/tmp/x' })
    await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
    await clock.settle()
    expect(played).toEqual(['bip-bop-03'])
  })
})

describe('/sound', () => {
  test('off silences events, on brings them back', async ($, on) => {
    const { played, clock } = rig(on)
    expect((await $.command.run(sound('off'))).text).toBe('Sounds off.')
    await $.turn.complete(end('answer'))
    await clock.settle()
    expect(played).toEqual([])
    await $.command.run(sound('on'))
    await $.turn.complete(end('answer'))
    await clock.settle()
    expect(played).toEqual(['bip-bop-01'])
  })

  test('off is read from the store a session starts with', async ($, on) => {
    const { played, clock } = rig(on, { off: true })
    await $.turn.complete(end('answer'))
    await clock.settle()
    expect(played).toEqual([])
  })

  test('test plays a key or any bundled name, even while off', async ($, on) => {
    const { played, clock } = rig(on, { off: true })
    await $.command.run(sound('test subagentDone'))
    await $.command.run(sound('test staplebops-01'))
    await clock.settle()
    expect(played).toEqual(['yup-01', 'staplebops-01'])
    const unknown = await $.command.run(sound('test nope-99'))
    expect(unknown.text).toContain('Unknown sound')
  })

  test('test with no argument plays every key in turn', async ($, on) => {
    const { played, clock } = rig(on)
    await $.command.run(sound('test'))
    await clock.advance(7 * 900)
    expect(played).toEqual(['bip-bop-02', 'yup-01', 'nope-03', 'bip-bop-01', 'nope-03', 'staplebops-06', 'bip-bop-03'])
  })

  test('status and list', async ($, on) => {
    rig(on)
    expect((await $.command.run(sound(''))).text).toContain('Sounds on.')
    expect((await $.command.run(sound('list'))).text).toContain('yup-06')
  })
})
