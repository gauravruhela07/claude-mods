import type { TestBody } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

const SURFACES = ['terminal', 'desktop'] as const

const SPINNER = { word: 'Sauteing', message: null, suffix: '…', mode: 'responding' } as const
const ENGINE_INFO = '(12s · ↓ 300 tokens)'

const run = (args: string) =>
  ({
    command: 'skin',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  }) as const

const spinner = (surface: 'terminal' | 'desktop', word: string = SPINNER.word) =>
  ({ plugin: 'skins', surface, component: 'Spinner', props: { ...SPINNER, word } }) as const

const pane = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'skins',
    surface,
    component: 'Pane',
    requestId: 'skins',
    props: {
      title: 'Skins',
      isFocused: true,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  }) as const

type Found = { text: string }
type Finder = { findAll: (query: { type: string }) => Promise<Found[]> }

/** Every Text of the drawing, in order: what the line reads. */
const line = async (ui: Finder) => (await ui.findAll({ type: 'Text' })).map(one => one.text).join('')

/** The engine beneath the plugin: session start, the command and pane ops, and a store we can read back. */
const opened: { id: string; title?: string }[] = []

const engine = (on: On, stored: Record<string, unknown> = {}) => {
  const store = new Map<string, unknown>(Object.entries(stored))
  opened.length = 0
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    opened.push({ id: e.id, title: e.title })

    return { value: { isPlaced: true as const } }
  })
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })

  return store
}

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

test('/skin lists the skins and opens a picker with a row per skin, the active one marked', async ($, on) => {
  engine(on, { skin: 'zen' })
  mock.clock(on, { now: 0 })
  await $.session.start(START)

  const listed = await $.command.run(run(''))
  for (const name of ['matrix', 'pirate', 'zen', 'retro', 'space', 'off']) expect(listed.text).toContain(name)
  expect(listed.text).toContain('zen (active)')
  expect(opened).toEqual([{ id: 'skins', title: 'Skins' }])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(6)
    expect((await ui.find({ key: 'row-zen' }))?.text).toContain('● zen')
    expect((await ui.find({ key: 'row-matrix' }))?.text).not.toContain('●')
    expect((await ui.find({ key: 'row-matrix' }))?.text).toContain('░▒▓█ Decrypting')
    expect((await ui.find({ key: 'row-retro' }))?.text).toContain('|/-\\ PROCESSING')
    await ui.unmount()
  }
})

test('/skin matrix sets it; the spinner shows a matrix glyph and verb and keeps the engine line', async ($, on) => {
  const store = engine(on)
  mock.clock(on, { now: 0 })
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return (
      <Text>
        ✻ {e.props.word}
        {e.props.suffix} {ENGINE_INFO}
      </Text>
    )
  })
  await $.session.start(START)

  expect((await $.command.run(run('matrix'))).text).toBe('Skin set: matrix')
  expect(store.get('skin')).toBe('matrix')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(spinner(surface, surface === 'desktop' ? 'Working' : SPINNER.word))
    const text = await line(ui)
    expect(text).toContain('░ ')
    expect(text).toContain('Decrypting_')
    expect(text).toContain(ENGINE_INFO)
    expect(text).not.toContain('Sauteing')
    const glyph = await ui.find({ type: 'Text', text: '░ ' })
    expect(glyph?.props.color).toBe('success')
    await ui.unmount()
  }

  // On the desktop a real step description stays; the skin only adds its glyph.
  const step = await $.ui.mount(spinner('desktop', 'Creating notes.md'))
  expect(await line(step)).toContain('Creating notes.md_')
  expect(await line(step)).toContain('░ ')
  await step.unmount()
})

test('the verb rotates and the glyph animates while a turn runs', async ($, on) => {
  engine(on, { skin: 'matrix' })
  const clock = mock.clock(on, { now: 0 })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>✻ {e.props.word}</Text>
  })
  await $.session.start(START)
  await $.turn.start({ text: 'go', turnId: 't1' })

  await clock.advance(250)
  let ui = await $.ui.mount(spinner('terminal'))
  expect(await line(ui)).toContain('▒ ✻ Decrypting')
  await ui.unmount()

  await clock.advance(3750)
  ui = await $.ui.mount(spinner('terminal'))
  expect(await line(ui)).toContain('▓ ✻ Jacking in')
  await ui.unmount()

  await $.turn.complete({ answer: 'ok', durationMs: 4000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(4000)
  ui = await $.ui.mount(spinner('terminal'))
  expect(await line(ui)).toContain('▓ ✻ Jacking in')
  await ui.unmount()
})

test('the stored skin comes back at session start and rewords the closing line, hints and footer', async ($, on) => {
  engine(on, { skin: 'pirate' })
  mock.clock(on, { now: 0 })
  const words: string[] = []
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    if (e.component === 'TurnDuration') return <Text>{`${e.props.word} for ${e.props.durationMs / 1000}s`}</Text>
    if (e.component === 'PromptHint') return <Text>{e.props.hint}</Text>
    if (e.component === 'SessionMode') return <Text>{e.props.modes.join(' & ')}</Text>
    if (e.component === 'ToolProgress') return <Text>{e.props.hint}</Text>
    if (e.component === 'Spinner') words.push(e.props.word)

    return <Text>engine</Text>
  })
  await $.session.start(START)

  const done = await $.ui.mount({
    plugin: 'skins',
    surface: 'terminal',
    component: 'TurnDuration',
    props: { word: 'Baked', durationMs: 12_000 },
  })
  expect(await line(done)).toBe('Plundered for 12s')
  await done.unmount()

  const hint = (text: string) =>
    $.ui.mount({
      plugin: 'skins',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: true, hint: text },
    })
  let ui = await hint('esc to interrupt')
  expect(await line(ui)).toBe('esc to drop anchor')
  await ui.unmount()
  // A line with other parts (live pills) is left to the engine.
  ui = await hint('⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt')
  expect(await line(ui)).toBe('⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt')
  await ui.unmount()

  for (const surface of SURFACES) {
    const modes = await $.ui.mount({ plugin: 'skins', surface, component: 'SessionMode', props: { modes: ['focus'] } })
    expect(await line(modes)).toBe('focus & pirate skin')
    await modes.unmount()
  }

  const pill = await $.ui.mount({
    plugin: 'skins',
    surface: 'terminal',
    component: 'ToolProgress',
    props: { tool_use_id: 'toolu_1', kind: 'background_hint', hint: '(ctrl+b to run in background)' },
  })
  expect(await line(pill)).toBe('(ctrl+b to send it below deck)')
  await pill.unmount()

  const spin = await $.ui.mount(spinner('terminal'))
  expect(words.at(-1)).toBe('Plundering')
  await spin.unmount()
})

test('/skin off passes every drawing through untouched', async ($, on) => {
  const store = engine(on, { skin: 'retro' })
  mock.clock(on, { now: 0 })
  const reached: unknown[] = []
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    reached.push(e.props)

    return <Text>{`engine ${e.component}`}</Text>
  })
  await $.session.start(START)

  expect((await $.command.run(run('off'))).text).toContain('default look')
  expect(store.get('skin')).toBe('off')

  const cases = [
    { component: 'Spinner', props: { ...SPINNER } },
    { component: 'TurnDuration', props: { word: 'Baked', durationMs: 3000 } },
    { component: 'PromptHint', props: { isDraft: false, isWorking: true, hint: 'esc to interrupt' } },
    { component: 'SessionMode', props: { modes: ['focus'] } },
    {
      component: 'ToolProgress',
      props: { tool_use_id: 'toolu_1', kind: 'background_hint', hint: '(ctrl+b to run in background)' },
    },
  ] as const

  for (const surface of SURFACES) {
    for (const one of cases) {
      if (surface === 'desktop' && (one.component === 'TurnDuration' || one.component === 'ToolProgress')) continue
      reached.length = 0
      const ui = await $.ui.mount({ plugin: 'skins', surface, ...one } as never)
      expect(await ui.drawn()).toEqual({ type: 'Text', children: [`engine ${one.component}`] })
      expect(reached).toEqual([one.props])
      await ui.unmount()
    }
  }
})

test('/skin banana, or extra words, changes nothing', async ($, on) => {
  const store = engine(on, { skin: 'space' })
  mock.clock(on, { now: 0 })
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>✻ {e.props.word}</Text>
  })
  await $.session.start(START)

  for (const args of ['banana', 'matrix please', 'off now', 'constructor']) {
    const said = (await $.command.run(run(args))).text ?? ''
    expect(said).toContain('Usage: /skin')
    expect(said).toContain('Nothing changed')
  }

  const ui = await $.ui.mount(spinner('terminal'))
  expect(await line(ui)).toContain('Launching')
  await ui.unmount()
  expect(store.get('skin')).toBe('space')
})

test('pressing a picker Button applies that skin and keeps it in the store', async ($, on) => {
  const store = engine(on)
  mock.clock(on, { now: 0 })
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>✻ {e.props.word}</Text>
  })
  await $.session.start(START)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect((await ui.find({ key: 'row-off' }))?.text).toContain('● off')

    await ui.press({ key: 'use-retro' })
    expect((await ui.find({ key: 'row-retro' }))?.text).toContain('● retro')
    expect((await ui.find({ key: 'row-off' }))?.text).not.toContain('●')
    expect(store.get('skin')).toBe('retro')

    const spin = await $.ui.mount(spinner(surface, 'Working'))
    expect(await line(spin)).toContain('| ✻ PROCESSING')
    await spin.unmount()

    await ui.press({ key: 'use-off' })
    expect((await ui.find({ key: 'row-off' }))?.text).toContain('● off')
    expect(store.get('skin')).toBe('off')
    await ui.unmount()
  }
})
