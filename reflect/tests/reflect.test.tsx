import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelForkResult, On } from 'claude-code'

const CANNED = [
  '## Asked',
  'Add a retry to the upload client.',
  '',
  '## Done',
  '- Changed `upload()` in src/upload.ts to retry 3 times.',
  '',
  '## Might be wrong or missed',
  '- `upload()` in src/upload.ts also retries 4xx errors, which never succeed.',
  '- No test covers the retry path.',
  '',
  '## Risky assumptions',
  '- The server accepts a repeated upload without duplicating it.',
  '',
  '## Check next',
  '1. Run `npm test -- upload`.',
  '2. Look at the status check before the retry in src/upload.ts.',
].join('\n')

const USAGE = { input_tokens: 100, output_tokens: 150, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 }
const ANSWERED: ModelForkResult = { isAnswered: true, text: CANNED, usage: USAGE }
const SURFACES = ['terminal', 'desktop'] as const

const pane = <S extends (typeof SURFACES)[number]>(surface: S) =>
  ({
    plugin: 'reflect',
    surface,
    component: 'Pane',
    requestId: 'reflect',
    props: {
      title: 'Reflect',
      isFocused: true,
      bodyColumns: 90,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

const run = (args: string) =>
  ({
    command: 'reflect',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  }) as const

/** The engine beneath the mod: a mocked clock and store, and records of what the mod asked for. */
const world = (on: On, answer: ModelForkResult = ANSWERED) => {
  const clock = mock.clock(on, { now: 1_760_000_000_000 })
  mock.store(on)
  const seen = { forks: [] as string[], toasts: [] as string[], opened: [] as string[] }

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('model.fork', ($, e) => {
    seen.forks.push(e.prompt)
    return { value: answer }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  // An Edit of /x/bad.ts fails, as an Edit whose old_string is not found does.
  on('tool.call', ($, e) =>
    (e.tool === 'Edit' && e.file_path === '/x/bad.ts' ? { isError: true, result: 'no match', text: 'no match' } : { result: {} }) as never,
  )

  return { clock, seen }
}

const start = ($: Engine) =>
  $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

test('/reflect opens the pane on "Reflecting…", then shows the sections', async ($, on) => {
  const { clock, seen } = world(on)
  await start($)

  const said = await $.command.run(run(''))
  expect(said.text).toContain('Reflecting')
  expect(seen.opened).toEqual(['reflect'])
  expect(seen.forks).toHaveLength(0)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect((await ui.find({ key: 'body' }))?.text).toContain('Reflecting…')
    expect((await ui.find({ key: 'header' }))?.text).toContain('Reflection 1 of 1')
    await ui.unmount()
  }

  await clock.settle()
  expect(seen.forks).toHaveLength(1)
  expect(seen.forks[0]).toContain('## Might be wrong or missed')
  expect(seen.forks[0]).not.toContain('Focus on:')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    const body = await ui.find({ key: 'body' })
    expect(body?.type).toBe('Markdown')
    expect(body?.text).toContain('## Might be wrong or missed')
    expect(body?.text).toContain('## Check next')
    const header = (await ui.find({ key: 'header' }))?.text ?? ''
    expect(header).toContain('Reflection 1 of 1')
    expect(header).toContain('1.2k tokens (86% from cache)')
    expect(await ui.find({ key: 'fix' })).toBeDefined()
    expect(await ui.find({ key: 'older' })).toBeUndefined()
    await ui.unmount()
  }
  expect(seen.toasts).toHaveLength(0)
})

test('focus words reach the fork prompt', async ($, on) => {
  const { clock, seen } = world(on)
  await start($)
  await $.command.run(run('the retry tests'))
  await clock.settle()
  expect(seen.forks[0]).toContain('Focus on: the retry tests.')
})

test('nothing to fork shows the friendly line', async ($, on) => {
  const { clock } = world(on, { isAnswered: false, reason: 'nothing-to-fork' })
  await start($)
  await $.command.run(run(''))
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect((await ui.find({ key: 'body' }))?.text).toBe('Nothing to reflect on yet — do some work first.')
    expect(await ui.find({ key: 'fix' })).toBeUndefined()
    await ui.unmount()
  }
})

test('an API error says its status in plain words', async ($, on) => {
  const { clock } = world(on, { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE })
  await start($)
  await $.command.run(run(''))
  await clock.settle()
  const ui = await $.ui.mount(pane('desktop'))
  const body = (await ui.find({ key: 'body' }))?.text ?? ''
  expect(body).toContain('status 529')
  expect(body).toContain('overloaded')
  await ui.unmount()
})

test('the fix Button fills the prompt with the two sections, without sending', async ($, on) => {
  const { clock, seen } = world(on)
  const fills: { text: string; mode: string }[] = []
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    fills.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  await start($)
  await $.command.run(run(''))
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    await ui.press({ key: 'fix' })
    await ui.unmount()
  }

  expect(fills).toHaveLength(2)
  const fill = fills[0]
  expect(fill?.mode).toBe('replace')
  expect(fill?.text.startsWith('Please address these points from your reflection:\n\n')).toBe(true)
  expect(fill?.text).toContain('## Might be wrong or missed')
  expect(fill?.text).toContain('also retries 4xx errors')
  expect(fill?.text).toContain('## Check next')
  expect(fill?.text).toContain('npm test -- upload')
  expect(fill?.text).not.toContain('## Done')
  expect(fill?.text).not.toContain('## Risky assumptions')
  expect(seen.toasts.some(text => text.includes('prompt box'))).toBe(true)
})

test('auto mode is off by default: an editing turn forks nothing', async ($, on) => {
  const { clock, seen } = world(on)
  await start($)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/x/a.ts', old_string: 'a', new_string: 'b' })
  await $.turn.complete({ answer: 'done', durationMs: 5000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(seen.forks).toHaveLength(0)
  expect(seen.toasts).toHaveLength(0)
})

test('auto on: an editing turn forks once in the background and toasts, never opening the pane', async ($, on) => {
  const { clock, seen } = world(on)
  await start($)
  expect((await $.command.run(run('auto on'))).text).toContain('Auto-reflect is on')

  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/x/a.ts' })
  await $.tool.call({ tool: 'Edit', file_path: '/x/a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: '/x/b.ts', content: 'b' })
  await $.turn.complete({ answer: 'done', durationMs: 5000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()

  expect(seen.forks).toHaveLength(1)
  expect(seen.toasts).toEqual(['Reflection ready — /reflect show'])
  expect(seen.opened).toHaveLength(0)

  await $.command.run(run('show'))
  expect(seen.opened).toEqual(['reflect'])
  const ui = await $.ui.mount(pane('terminal'))
  expect((await ui.find({ key: 'header' }))?.text).toContain('auto')
  expect((await ui.find({ key: 'body' }))?.text).toContain('## Check next')
  await ui.unmount()
})

test('auto on: turns without a successful edit, or aborted ones, never reflect', async ($, on) => {
  const { clock, seen } = world(on)
  await start($)
  await $.command.run(run('auto'))

  await $.turn.start({ text: 'look', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/x/a.ts' })
  await $.turn.complete({ answer: 'ok', durationMs: 900, isAborted: false, turnId: 't1', reason: 'answer' })

  await $.turn.start({ text: 'try', turnId: 't2' })
  await $.tool.call({ tool: 'Edit', file_path: '/x/bad.ts', old_string: 'a', new_string: 'b' })
  await $.turn.complete({ answer: 'ok', durationMs: 900, isAborted: false, turnId: 't2', reason: 'answer' })

  await $.turn.start({ text: 'edit', turnId: 't3' })
  await $.tool.call({ tool: 'Edit', file_path: '/x/a.ts', old_string: 'a', new_string: 'b' })
  await $.turn.complete({ answer: '', durationMs: 900, isAborted: true, turnId: 't3', reason: 'aborted' })

  await clock.settle()
  expect(seen.forks).toHaveLength(0)
  expect(seen.toasts).toHaveLength(0)
})

test('auto takes on, off or nothing; other words after auto change nothing', async ($, on) => {
  world(on)
  await start($)
  expect((await $.command.run(run('auto maybe later'))).text).toContain('Nothing changed')
  expect((await $.command.run(run('auto'))).text).toContain('on')
  expect((await $.command.run(run('auto'))).text).toBe('Auto-reflect is off.')
  expect((await $.command.run(run('auto on'))).text).toContain('Auto-reflect is on')
  expect((await $.command.run(run('auto off'))).text).toBe('Auto-reflect is off.')
})

test('older and newer page through the kept reflections', async ($, on) => {
  const { clock, seen } = world(on)
  await start($)
  for (const focus of ['one', 'two', 'three']) {
    await $.command.run(run(focus))
    await clock.settle()
  }
  expect(seen.forks).toHaveLength(3)

  const ui = await $.ui.mount(pane('terminal'))
  expect((await ui.find({ key: 'header' }))?.text).toContain('Reflection 3 of 3')
  expect(await ui.find({ key: 'newer' })).toBeUndefined()
  await ui.press({ key: 'older' })
  expect((await ui.find({ key: 'header' }))?.text).toContain('Reflection 2 of 3')
  expect((await ui.find({ key: 'header' }))?.text).toContain('Focus: two')
  await ui.press({ key: 'newer' })
  expect((await ui.find({ key: 'header' }))?.text).toContain('Reflection 3 of 3')
  await ui.unmount()
})

test('a pane left open follows the fork from "Reflecting…" to the answer', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await $.command.run(run(''))
  const ui = await $.ui.mount(pane('desktop'))
  expect((await ui.find({ key: 'body' }))?.text).toContain('Reflecting…')
  await clock.settle()
  expect((await ui.find({ key: 'body' }))?.text).toContain('## Risky assumptions')
  await ui.unmount()
})

test('copy puts the Markdown on the pressing surface; fix falls back to a copy where no prompt box takes it', async ($, on) => {
  const { clock, seen } = world(on)
  const copies: { text: string; surface: string | undefined }[] = []
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', () => ({ isFilled: false, refusal: 'no_composer' }))
  on('ui.copy', ($, e) => {
    copies.push({ text: e.text, surface: e.surface })
    return { value: { isCopied: true } }
  })
  await start($)
  await $.command.run(run(''))
  await clock.settle()

  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'copy' })
  await ui.press({ key: 'fix' })
  await ui.unmount()

  expect(copies).toHaveLength(2)
  expect(copies[0]).toEqual({ text: CANNED, surface: 'desktop' })
  expect(copies[1]?.text).toContain('Please address these points from your reflection:')
  expect(copies[1]?.surface).toBe('desktop')
  expect(seen.toasts.some(text => text.includes('copied'))).toBe(true)
})
