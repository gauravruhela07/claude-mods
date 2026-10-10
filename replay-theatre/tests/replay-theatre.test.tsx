import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { MAX_STEPS, addStep, countAgentCall, finishStep, openScene, timeline } from '../hooks/film'
import type { Step } from '../types'
import type { On } from 'claude-code'

const SESSION = 'session-now'

const pane = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'replay-theatre',
    surface,
    component: 'Pane',
    requestId: 'replay',
    props: {
      title: 'Replay theatre',
      isFocused: true,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  }) as const

const run = (args: string) =>
  ({
    command: 'replay',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  }) as const

/** The engine beneath the plugin: answers every event it passes on, and records opens and copies. */
const engine = (on: On) => {
  const opened: string[] = []
  const copied: string[] = []

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SESSION }))
  on('command.register', () => ({ value: undefined }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', ($, e) =>
    String(e.tool) === 'Bash'
      ? ({ isError: true, result: 'boom', text: 'Error: exit code 1\nnpm ERR! test failed' } as never)
      : ({ result: {}, text: `ok from ${String(e.tool)}` } as never),
  )
  on('ui.open', ($, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.copy', ($, e) => {
    copied.push(e.text)

    return { value: { isCopied: true } }
  })

  return { opened, copied }
}

/** Two scenes: Read, Bash (fails), Edit; then one WebFetch. */
const record = async ($: Engine) => {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/work/src/auth.ts' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/src/auth.ts', old_string: 'a', new_string: 'b' })
  await $.turn.complete({ answer: 'Fixed the login bug.', durationMs: 5000, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.turn.start({ text: 'now read the docs', turnId: 't2' })
  await $.tool.call({ tool: 'WebFetch', url: 'https://example.com/docs/page', prompt: 'summarize' })
  await $.turn.complete({ answer: 'Read them.', durationMs: 2000, isAborted: false, turnId: 't2', reason: 'answer' })
}

const textOf = async (ui: { find: (q: { key: string }) => Promise<{ text: string } | undefined> }, key: string) =>
  (await ui.find({ key }))?.text ?? ''

test('/replay opens the pane at scene 1 step 1, paused, on terminal and desktop', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const { opened } = engine(on)
  await record($)

  const answer = await $.command.run(run(''))
  expect(answer.text).toContain('2 scenes')
  expect(answer.text).toContain('4 steps')
  expect(opened).toEqual(['replay'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(pane(surface))
    const header = await textOf(ui, 'header')
    expect(header).toContain('Scene 1/2 · Step 1/3 · 1x · ⏸ paused')
    expect(await textOf(ui, 'prompt')).toContain('You: fix the login bug')
    const card = await textOf(ui, 'card')
    expect(card).toContain('▸')
    expect(card).toContain('Reading auth.ts')
    expect(card).toContain('✓')
    expect(card).toContain('ok from Read')
    const line = await textOf(ui, 'timeline')
    expect(line.length).toBe(80)
    expect(line.startsWith('●')).toBe(true)
    expect(line).toContain('×')
    expect(line).toContain('│')
    expect((await ui.find({ key: 'play' }))?.props.label).toBe('▶ Play')
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(7)
    await ui.unmount()
  }
})

test('next and previous move by step and by scene', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  engine(on)
  await record($)
  await $.command.run(run(''))

  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'next-step' })
  expect(await textOf(ui, 'header')).toContain('Scene 1/2 · Step 2/3')
  const card = await textOf(ui, 'card')
  expect(card).toContain('$')
  expect(card).toContain('Run the tests')
  expect(card).toContain('✗ failed')
  expect(card).toContain('Error: exit code 1 npm ERR! test failed')
  expect(await textOf(ui, 'before-1')).toContain('Reading auth.ts')

  await ui.press({ key: 'next-step' })
  expect(await textOf(ui, 'header')).toContain('Step 3/3')
  expect(await textOf(ui, 'before-1')).toContain('Run the tests')
  expect(await textOf(ui, 'before-1')).toContain('✗')
  expect(await textOf(ui, 'before-2')).toContain('Reading auth.ts')
  expect(await textOf(ui, 'answer')).toContain('Claude: Fixed the login bug.')

  await ui.press({ key: 'next-step' })
  expect(await textOf(ui, 'header')).toContain('Scene 2/2 · Step 1/1')
  expect(await textOf(ui, 'card')).toContain('Fetching example.com')

  await ui.press({ key: 'prev-scene' })
  expect(await textOf(ui, 'header')).toContain('Scene 1/2 · Step 1/3')

  await ui.press({ key: 'next-scene' })
  expect(await textOf(ui, 'header')).toContain('Scene 2/2 · Step 1/1')

  await ui.press({ key: 'prev-step' })
  expect(await textOf(ui, 'header')).toContain('Scene 1/2 · Step 3/3')
  await ui.unmount()
})

test('play advances on the clock and stops at the end', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  engine(on)
  await record($)
  await $.command.run(run(''))

  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'play' })
  expect(await textOf(ui, 'header')).toContain('▶ playing')
  expect((await ui.find({ key: 'play' }))?.props.label).toBe('⏸ Pause')

  await clock.advance(700)
  expect(await textOf(ui, 'header')).toContain('Scene 1/2 · Step 2/3')
  expect((await textOf(ui, 'timeline')).startsWith('●')).toBe(false)

  // Past the scene's last step comes the next scene's title card, then its first step.
  await clock.advance(1200)
  expect(await textOf(ui, 'header')).toContain('Scene 2/2 · Step –/1')
  expect(await textOf(ui, 'card')).toContain('Scene 2 of 2')

  await clock.advance(10_000)
  expect(await textOf(ui, 'header')).toContain('Scene 2/2 · Step 1/1 · 1x · ⏸ paused')
  expect(await textOf(ui, 'end')).toContain('The end · 2 scenes · 4 steps · 1 failed')

  await clock.advance(5_000)
  expect(await textOf(ui, 'header')).toContain('Scene 2/2 · Step 1/1')
  await ui.unmount()
})

test('speed cycles 1x, 2x, 4x and back to 1x', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  engine(on)
  await record($)
  await $.command.run(run(''))

  const ui = await $.ui.mount(pane('terminal'))
  for (const speed of ['2x', '4x', '1x']) {
    await ui.press({ key: 'speed' })
    expect(await textOf(ui, 'header')).toContain(` ${speed} `)
    expect((await ui.find({ key: 'speed' }))?.props.label).toBe(speed)
  }
  await ui.unmount()
})

test('/replay copy puts a Markdown script with ✓ and ✗ on the clipboard', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const { copied } = engine(on)
  await record($)

  const answer = await $.command.run(run('copy'))
  expect(answer.text).toContain('Copied')
  expect(copied).toHaveLength(1)
  const md = copied[0] ?? ''
  expect(md).toContain('# Replay of this session')
  expect(md).toContain('## Scene 1: fix the login bug')
  expect(md).toContain('1. ✓ ▸ Reading auth.ts')
  expect(md).toContain('2. ✗ $ Run the tests `npm test`')
  expect(md).toContain('## Scene 2: now read the docs')
  expect(md).toContain('**Claude:** Fixed the login bug.')
})

test('/replay last plays the previous session from the store', async ($, on) => {
  mock.clock(on, { now: 2_000_000 })
  mock.store(on, {
    'last-session': {
      sessionId: 'session-before',
      savedAt: 1,
      scenes: [
        {
          id: 'old',
          prompt: 'old work',
          startedAt: 0,
          endedAt: 9000,
          answer: 'Old answer.',
          aborted: false,
          steps: [
            {
              id: 's1',
              tool: 'Write',
              label: 'Writing notes.md',
              target: 'notes.md',
              kind: 'edit',
              startedAt: 0,
              durationMs: 1200,
              isRunning: false,
              ok: true,
              result: 'File created',
              agentId: null,
              agentCalls: 0,
            },
          ],
        },
      ],
    },
  })
  const { opened } = engine(on)
  await record($)

  const answer = await $.command.run(run('last'))
  expect(answer.text).toContain('previous session')
  expect(opened).toEqual(['replay'])

  const ui = await $.ui.mount(pane('terminal'))
  expect(await textOf(ui, 'header')).toContain('Scene 1/1 · Step 1/1')
  expect(await textOf(ui, 'header')).toContain('previous session')
  expect(await textOf(ui, 'card')).toContain('Writing notes.md')
  expect(await textOf(ui, 'answer')).toContain('Old answer.')
  await ui.unmount()

  // This session's own saves (one per turn.complete) did not replace the film kept at start.
  expect((await $.command.run(run('last'))).text).toContain('1 scene · 1 step')
})

test('each turn.complete saves the film under last-session', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const saves: { key: string; value: unknown }[] = []
  on('store.get', () => ({ value: undefined }))
  on('store.set', ($, e) => {
    saves.push({ key: e.key, value: e.value })

    return { value: undefined }
  })
  engine(on)
  await record($)

  expect(saves.map(save => save.key)).toEqual(['last-session', 'last-session'])
  const first = saves[0]?.value as { sessionId: string; scenes: { steps: unknown[] }[] }
  const second = saves[1]?.value as { sessionId: string; scenes: { answer: string; steps: { ok: boolean }[] }[] }
  expect(first.scenes).toHaveLength(1)
  expect(second.sessionId).toBe(SESSION)
  expect(second.scenes).toHaveLength(2)
  expect(second.scenes[0]?.answer).toBe('Fixed the login bug.')
  expect(second.scenes[0]?.steps.map(step => step.ok)).toEqual([true, false, true])
})

test('with nothing recorded it says so and opens nothing', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  const { opened, copied } = engine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  expect((await $.command.run(run(''))).text).toBe('Nothing to replay yet.')
  expect((await $.command.run(run('copy'))).text).toBe('Nothing to replay yet.')
  expect((await $.command.run(run('last'))).text).toContain('Nothing to replay yet.')
  expect(opened).toHaveLength(0)
  expect(copied).toHaveLength(0)
})

test('unknown words answer with usage and change nothing', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const { opened, copied } = engine(on)
  await record($)
  await $.command.run(run(''))

  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'next-step' })
  expect(await textOf(ui, 'header')).toContain('Step 2/3')

  for (const args of ['play fast', 'copy everything', 'LAST please', 'help']) {
    const answer = await $.command.run(run(args))
    expect(answer.text).toContain('Usage')
    expect(answer.text).toContain('Nothing changed')
  }

  expect(await textOf(ui, 'header')).toContain('Scene 1/2 · Step 2/3 · 1x · ⏸ paused')
  expect(opened).toEqual(['replay'])
  expect(copied).toHaveLength(0)
  await ui.unmount()
})

const fakeStep = (id: string, startedAt: number, kind: Step['kind'] = 'read'): Step => ({
  id,
  tool: kind === 'agent' ? 'Agent' : 'Read',
  label: id,
  target: '',
  kind,
  startedAt,
  durationMs: 0,
  isRunning: true,
  ok: true,
  result: '',
  agentId: null,
  agentCalls: 0,
})

test('subagent calls count on the Agent step running at that time; the film keeps 500 steps', async () => {
  let film = openScene({ scenes: [] }, 't1', 'spawn helpers', 0)
  film = addStep(film, fakeStep('agent-a', 10, 'agent'))
  film = countAgentCall(film, 'sub-1', 20)
  film = countAgentCall(film, 'sub-1', 30)
  film = finishStep(film, 'agent-a', { durationMs: 100, ok: true, result: 'done' })
  film = countAgentCall(film, 'sub-2', 500)
  const agent = film.scenes[0]?.steps[0]
  expect(agent?.agentId).toBe('sub-1')
  expect(agent?.agentCalls).toBe(2)

  for (let i = 0; i < 3; i++) {
    film = openScene(film, `t${i + 2}`, `turn ${i + 2}`, 1000 * (i + 1))
    for (let j = 0; j < 200; j++) film = addStep(film, fakeStep(`s${i}-${j}`, 1000 * (i + 1) + j))
  }
  const steps = film.scenes.reduce((n, scene) => n + scene.steps.length, 0)
  expect(steps).toBeLessThanOrEqual(MAX_STEPS)
  expect(film.scenes[0]?.prompt).toBe('turn 3')
  expect(timeline(film, { scene: 0, step: 0 }, 40)).toHaveLength(40)
})
