import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Lifetime, Totals, Turn } from '../types'

const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'

type Tokens = { input: number; write: number; read: number; output: number }

/** What the plugin last wrote to its state, as the engine beneath it saw the writes. */
type Seen = { turns: Turn[]; session?: Totals; subagents?: Totals; lifetime?: Lifetime | null }

/** The engine beneath the plugin: clock, store, and the events the plugin passes on or raises. */
const world = (on: On, now = 1_000_000) => {
  const clock = mock.clock(on, { now })
  mock.store(on)
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const seen: Seen = { turns: [] }
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('state.set', ($, e, next) => {
    if (e.plugin === 'cache-tax') {
      if (e.key === 'turns') seen.turns = e.value
      if (e.key === 'session') seen.session = e.value
      if (e.key === 'subagents') seen.subagents = e.value
      if (e.key === 'lifetime') seen.lifetime = e.value
    }
    return next(e)
  })

  return { clock, toasts, statuses, seen }
}

const turn = (
  $: Engine,
  turnId: string,
  t: Tokens,
  options: { model?: string; durationMs?: number; agentId?: string } = {},
) =>
  $.turn.complete({
    answer: 'ok',
    durationMs: options.durationMs ?? 10_000,
    isAborted: false,
    turnId,
    reason: 'answer',
    ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
    usage: {
      model: options.model ?? OPUS,
      input_tokens: t.input,
      cache_creation_input_tokens: t.write,
      cache_read_input_tokens: t.read,
      output_tokens: t.output,
    },
  })

const near = (got: number | null | undefined, want: number) => {
  expect(typeof got).toBe('number')
  expect(Math.abs((got as number) - want)).toBeLessThan(1e-9)
}

const pane = (surface: 'terminal' | 'desktop', bodyColumns = 100) =>
  ({
    plugin: 'cache-tax',
    surface,
    component: 'Pane',
    requestId: 'cache-tax',
    props: {
      title: 'Cache tax',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

const run = (args: string) =>
  ({
    command: 'cache-tax',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  }) as const

// A warm turn on Opus 5.5 ($4 in, $20 out, $5 5m-write, $0.20 read per MTok).
const WARM: Tokens = { input: 1_000, write: 10_000, read: 89_000, output: 2_000 }

test('a turn on Opus gives the right hit %, cost and tax, and the status line', async ($, on) => {
  const { statuses, seen } = world(on)

  await turn($, 't1', WARM)

  const [row] = seen.turns
  near(row?.hit, 0.89)
  // 1000*4 + 10000*5 + 89000*0.2 + 2000*20 = 111,800 micro-dollars
  near(row?.cost, 0.1118)
  // (100000*0.2 + 2000*20) = 60,000 micro-dollars
  near(row?.ideal, 0.06)
  near(row?.tax, 0.0518)
  expect(row?.isBusted).toBe(false)
  expect(statuses[statuses.length - 1]).toBe('cache 89% · tax $0.05')

  await turn($, 't2', { input: 0, write: 0, read: 200_000, output: 0 })
  // session: read 289k of a 300k prompt = 96%; a pure cache read adds no tax
  expect(statuses[statuses.length - 1]).toBe('cache 96% · tax $0.05')
  const totals = seen.session
  expect(totals?.turns).toBe(2)
  near(totals?.tax, 0.0518)
})

test('an unknown model shows tokens and $? for money', async ($, on) => {
  const { statuses, seen } = world(on)

  await turn($, 't1', WARM, { model: 'claude-unheard-9' })

  const [row] = seen.turns
  near(row?.hit, 0.89)
  expect(row?.cost).toBeNull()
  expect(row?.tax).toBeNull()
  expect(statuses[statuses.length - 1]).toBe('cache 89% · tax $?')
})

test('a cache bust after an idle gap raises a toast naming the cause', async ($, on) => {
  const { clock, toasts, seen } = world(on)

  await turn($, 't1', { input: 500, write: 2_000, read: 97_500, output: 500 })
  await clock.advance(400_000)
  await turn($, 't2', { input: 1_000, write: 120_000, read: 0, output: 800 }, { durationMs: 20_000 })
  await clock.settle()

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toBe(
    'Cache busted: 120k tokens re-written (~$0.60). Likely cause: idle past the 5-minute cache life.',
  )
  const rows = seen.turns
  expect(rows[1]?.isBusted).toBe(true)
  expect(seen.session?.busts).toBe(1)
})

test('a bust right after a model switch blames the switch; a cold start is no bust', async ($, on) => {
  const { clock, toasts } = world(on)

  await turn($, 't1', { input: 2_000, write: 90_000, read: 0, output: 500 }, { model: SONNET })
  expect(toasts).toHaveLength(0)
  await turn($, 't2', { input: 500, write: 1_000, read: 95_000, output: 500 }, { model: SONNET })
  await turn($, 't3', { input: 500, write: 96_000, read: 0, output: 500 })
  await clock.settle()

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('96k tokens re-written (~$0.48)')
  expect(toasts[0]).toContain('Likely cause: model switched.')
})

test('a long turn of small writes per request is no bust (turn.step)', async ($, on) => {
  const { clock, toasts, seen } = world(on)
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'tool_use' as const,
      usage: {
        model: OPUS,
        input_tokens: 10,
        cache_creation_input_tokens: 20_000,
        cache_read_input_tokens: 100_000,
        output_tokens: 100,
      },
    }
  })

  await turn($, 't1', { input: 100, write: 1_000, read: 99_000, output: 100 })
  for (let index = 0; index < 3; index++) {
    const stream = $.turn.step({ turnId: 't2', index, model: OPUS, messageCount: 10 + index })
    for await (const chunk of stream) void chunk
    await stream.result
  }
  // Summed, the turn wrote 60k (over the 50k line) after a 99% turn; no single request did.
  await turn($, 't2', { input: 30, write: 60_000, read: 300_000, output: 300 })
  await clock.settle()

  expect(toasts).toHaveLength(0)
  expect(seen.turns[1]?.isBusted).toBe(false)
})

test('subagent turns go to their own total, not the table', async ($, on) => {
  const { seen } = world(on)

  await turn($, 't1', WARM)
  await turn($, 'a1', WARM, { agentId: 'agent-1', model: 'claude-haiku-5-5' })

  expect(seen.turns).toHaveLength(1)
  const subs = seen.subagents
  expect(subs?.turns).toBe(1)
  // Haiku 5.5, a 100k prompt: 1000*0.1 + 10000*0.125 + 89000*0.01 + 2000*0.5 = 3,240 micro-dollars
  near(subs?.cost, 0.00324)
  const life = seen.lifetime
  expect(life?.turns).toBe(2)
})

test('the pane draws the totals and the table on terminal and desktop', async ($, on) => {
  const { clock } = world(on)

  await turn($, 't1', WARM)
  await clock.advance(30_000)
  await turn($, 't2', { input: 1_000, write: 120_000, read: 0, output: 800 })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(pane(surface))
    expect((await ui.find({ key: 'session' }))?.text).toContain('2 turns')
    expect((await ui.find({ key: 'session' }))?.text).toContain('1 cache bust')
    expect((await ui.find({ key: 'turn-1-hit' }))?.text).toBe('89%')
    expect((await ui.find({ key: 'turn-1-cost' }))?.text).toBe('$0.11')
    expect((await ui.find({ key: 'turn-1-tax' }))?.text).toBe('$0.05')
    expect((await ui.find({ key: 'turn-1-read' }))?.text).toBe('89k')
    expect((await ui.find({ key: 'turn-2-write' }))?.text).toBe('120k')
    const busted = await ui.findAll({ type: 'Text', text: '2!' })
    expect(busted[0]?.props.color).toBe('warning')
    expect((await ui.find({ key: 'bust' }))?.text).toContain('the prompt prefix changed')
    const footer = (await ui.find({ key: 'footer' }))?.text ?? ''
    expect(footer).toContain('Lifetime, all sessions and subagents: 2 turns')
    expect(footer).toContain('5-minute rate')
    await ui.unmount()

    const narrow = await $.ui.mount(pane(surface, 30))
    expect(await narrow.find({ key: 'turn-1-tax' })).toBeDefined()
    expect(await narrow.find({ key: 'turn-1-hit' })).toBeDefined()
    expect(await narrow.find({ key: 'turn-1-time' })).toBeUndefined()
    expect(await narrow.find({ key: 'turn-1-output' })).toBeUndefined()
    await narrow.unmount()
  }
})

test('the pane says so before any turn', async ($, on) => {
  world(on)
  const ui = await $.ui.mount(pane('desktop'))
  expect((await ui.find({ key: 'empty' }))?.text).toContain('No turns measured yet')
  await ui.unmount()
})

test('/cache-tax opens the pane, reset clears, other words change nothing', async ($, on) => {
  const { statuses, seen } = world(on)
  await turn($, 't1', WARM)

  expect((await $.command.run(run(''))).text).toContain('Cache tax pane opened')

  for (const odd of ['reset now', 'clear', 'help me']) {
    expect((await $.command.run(run(odd))).text).toContain('Nothing changed')
  }
  expect(seen.turns).toHaveLength(1)
  expect(seen.session?.turns).toBe(1)

  expect((await $.command.run(run('  RESET '))).text).toContain('cleared')
  expect(seen.turns).toHaveLength(0)
  expect(seen.session?.turns).toBe(0)
  expect(statuses[statuses.length - 1]).toBeUndefined()
  // Lifetime stays.
  const life = seen.lifetime
  expect(life?.turns).toBe(1)
})
