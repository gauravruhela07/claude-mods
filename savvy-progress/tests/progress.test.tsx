import { expect, mock, test } from 'claude-code/testing'

const band = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'savvy-progress',
    surface,
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: true,
      maxRows: 10,
      bodyColumns: 100,
      scroll: { offset: 0, bodyRows: 9 },
      view: {},
    },
  }) as const

test('shows the live step, counts, task bar and time left', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let made = 0
  let release = () => {}
  const held = new Promise<void>(resolve => (release = resolve))

  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', async ($, e) => {
    if (e.tool === 'TaskCreate') return { result: { task: { id: String(++made), subject: e.subject } } }
    if (e.tool === 'Read') await held

    return { result: {} } as never
  })

  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Write code', description: 'x', activeForm: 'Writing code' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Test it', description: 'y', activeForm: 'Testing it' })
  await clock.advance(20_000)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })
  await $.tool.call({ tool: 'Edit', file_path: '/a/b/register.tsx', old_string: 'a', new_string: 'b' })

  const reading = $.tool.call({ tool: 'Read', file_path: '/a/b/format.ts' })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(band(surface))
    expect((await ui.find({ key: 'now' }))?.text).toContain('Reading format.ts')
    const line = (await ui.find({ key: 'progress' }))?.text ?? ''
    expect(line).toContain('6 steps')
    expect(line).toContain('1 file changed')
    expect(line).toContain('1/2')
    expect(line).toContain('left')
    expect(line).not.toContain('guess')
    expect(await ui.findAll({ type: 'Box' })).toHaveLength(3)
    await ui.unmount()
  }

  release()
  await reading
})

test('sums up the turn when it ends', async ($, on) => {
  mock.clock(on, { now: 5_000 })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {} }) as never)

  await $.turn.start({ text: 'go', turnId: 't2' })
  await $.tool.call({ tool: 'Write', file_path: '/x/new.ts', content: 'hi' })
  await $.turn.complete({ answer: 'ok', durationMs: 42_000, isAborted: false, turnId: 't2', reason: 'answer' })

  const ui = await $.ui.mount({ ...band('terminal'), props: { ...band('terminal').props, isWorking: false } })
  expect(await ui.find({ key: 'now' })).toBeUndefined()
  const summary = (await ui.find({ key: 'last' }))?.text ?? ''
  expect(summary).toContain('Done in 42s')
  expect(summary).toContain('1 step')
  expect(summary).toContain('1 file changed')
  await ui.unmount()
})

test('draws nothing of its own before any turn', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine band</Text>
  })
  const ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ text: 'engine band' })).toBeDefined()
  expect(await ui.find({ key: 'now' })).toBeUndefined()
  expect(await ui.find({ key: 'last' })).toBeUndefined()
  await ui.unmount()
})

const run = (args: string) =>
  ({
    command: 'savvy-progress',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  }) as const

test('the command takes on, off, or nothing, and ignores other words', async $ => {
  const odd = await $.command.run(run('help me set up mods'))
  expect(odd.text).toContain('Nothing changed')
  expect((await $.command.run(run('off'))).text).toContain('hidden')
  expect((await $.command.run(run('off'))).text).toContain('hidden')
  expect((await $.command.run(run('on'))).text).toContain('shown')
  expect((await $.command.run(run(''))).text).toContain('hidden')
})

const start = {
  cwd: '/work',
  surface: 'terminal',
  isInteractive: true,
} as const

test('without a task list, a time bar guesses from past turns', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { durations: [30_000, 90_000, 120_000, 240_000] })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))

  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 'g1' })
  await clock.advance(45_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(band(surface))
    const text = (await ui.find({ key: 'progress' }))?.text ?? ''
    expect(text).toContain('37%')
    expect(text).toContain('~1m 15s left (guess)')
    expect(text).toContain('45s · 0 steps')
    await ui.unmount()
  }

  await clock.advance(300_000)
  const late = await $.ui.mount(band('terminal'))
  expect((await late.find({ key: 'progress' }))?.text).toContain('longer than usual')
  await late.unmount()

  await $.turn.complete({ answer: 'ok', durationMs: 345_000, isAborted: false, turnId: 'g1', reason: 'answer' })
  await $.turn.start({ text: 'again', turnId: 'g2' })
  const next = await $.ui.mount(band('terminal'))
  expect((await next.find({ key: 'progress' }))?.text).toContain('(guess)')
  await next.unmount()
})

test('with no past turns the bar says it is a rough guess', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  await $.turn.start({ text: 'go', turnId: 'n1' })
  const ui = await $.ui.mount(band('desktop'))
  expect((await ui.find({ key: 'progress' }))?.text).toContain('rough guess')
  await ui.unmount()
})

test('a task list replaces the guess with the real task bar', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', ($, e) => (e.tool === 'TaskCreate' ? { result: { task: { id: '1', subject: e.subject } } } : ({ result: {} } as never)))
  await $.turn.start({ text: 'go', turnId: 'p1' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'One', description: 'x' })
  const ui = await $.ui.mount(band('terminal'))
  const line = (await ui.find({ key: 'progress' }))?.text ?? ''
  expect(line).toContain('0/1')
  expect(line).not.toContain('guess')
  await ui.unmount()
})
