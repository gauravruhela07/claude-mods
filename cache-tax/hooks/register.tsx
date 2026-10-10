import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import type { Buckets, Lifetime, Totals, Turn } from '../types'
import {
  KEEP_TURNS,
  addTurn,
  bucketsOf,
  causeOf,
  duration,
  emptyTotals,
  hitOf,
  isBust,
  moneyOf,
  pct,
  promptOf,
  statusOf,
  tokens,
  totalUsd,
  totalsFrom,
  usd,
} from './math'
import type { Money } from './math'
import { PRICES_SOURCE, cardOf, priceOf } from './prices'

const PANE = 'cache-tax'
const SHOWN_TURNS = 20

const turns = atom({ plugin: 'cache-tax', key: 'turns' } as const, [])
const session = atom({ plugin: 'cache-tax', key: 'session' } as const, emptyTotals())
const subagents = atom({ plugin: 'cache-tax', key: 'subagents' } as const, emptyTotals())
const lifetime = atom({ plugin: 'cache-tax', key: 'lifetime' } as const, null)
const previous = atom({ plugin: 'cache-tax', key: 'previous' } as const, null)
const probes = atom({ plugin: 'cache-tax', key: 'probes' } as const, [])
const KEEP_PROBES = 32

const USAGE = "Usage: /cache-tax opens the pane; /cache-tax reset clears this session's numbers. Nothing changed."

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Prices one turn's tokens; null when the model is not in the table. */
const priced = (usage: TurnUsage, b: Buckets, requests: number): { money: Money | null; write5m: number | null } => {
  const price = priceOf(usage.model)
  if (price === undefined) return { money: null, write5m: null }
  const card = cardOf(price, promptOf(b) / Math.max(1, requests))

  return { money: moneyOf(b, card), write5m: card.write5m }
}

const lifetimeFrom = (raw: unknown, now: number): Lifetime => {
  const since = (raw as { since?: unknown } | undefined)?.since

  return { ...totalsFrom(raw), since: typeof since === 'number' ? since : now }
}

// Lifetime writes go one after another, so a main turn and a subagent's ending
// together do not both read the same old value.
let storeQueue: Promise<unknown> = Promise.resolve()

const addLifetime = ($: EngineInterface, b: Buckets, money: Money | null, model: string, isBusted: boolean, now: number) => {
  const run = storeQueue.then(async () => {
    const was = lifetimeFrom(await $.store.get('lifetime'), now)
    const next: Lifetime = { ...addTurn(was, b, money, model, isBusted), since: was.since }
    await $.store.set('lifetime', next)
    await update($, lifetime, () => next)
  })
  storeQueue = run.catch(() => undefined)

  return run
}

type Column = { id: string; head: string; width: number; rank: number; cell: (t: Turn) => string }

// rank: which columns stay when the pane is narrow (lower stays longer).
const COLUMNS: readonly Column[] = [
  { id: 'n', head: '#', width: 5, rank: 0, cell: t => `${t.n}${t.isBusted ? '!' : ''}` },
  { id: 'time', head: 'time', width: 6, rank: 8, cell: t => duration(t.durationMs) },
  { id: 'input', head: 'input', width: 6, rank: 6, cell: t => tokens(t.input) },
  { id: 'write', head: 'write', width: 6, rank: 3, cell: t => tokens(t.write) },
  { id: 'read', head: 'read', width: 6, rank: 5, cell: t => tokens(t.read) },
  { id: 'output', head: 'output', width: 6, rank: 7, cell: t => tokens(t.output) },
  { id: 'hit', head: 'hit', width: 4, rank: 1, cell: t => pct(t.hit) },
  { id: 'cost', head: 'cost', width: 7, rank: 4, cell: t => usd(t.cost) },
  { id: 'tax', head: 'tax', width: 7, rank: 2, cell: t => usd(t.tax) },
]

/** The columns that fit `width` cells (one cell between columns), in table order. */
const columnsFor = (width: number) => {
  const kept = new Set<string>()
  let used = 0
  for (const col of [...COLUMNS].sort((a, b) => a.rank - b.rank)) {
    const need = col.width + (kept.size === 0 ? 0 : 1)
    if (used + need > width) break
    kept.add(col.id)
    used += need
  }

  return COLUMNS.filter(col => kept.has(col.id))
}

const summaryOf = (t: Totals) => {
  const share = t.cost > 0 ? ` (${pct(t.tax / t.cost)} of cost)` : ''

  return `hit ${pct(hitOf(t))} · cost ${totalUsd(t, t.cost)} · tax ${totalUsd(t, t.tax)}${t.priced > 0 ? share : ''}`
}

const bucketsLine = (t: Totals) =>
  `in ${tokens(t.input)} · write ${tokens(t.write)} · read ${tokens(t.read)} · out ${tokens(t.output)}`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cache-tax',
      description: 'Prompt cache hit rate and the cache tax: open the pane, or reset the session numbers',
      argumentHint: '[reset]',
      immediate: true,
    })
    const now = await $.clock.now()
    const raw = await $.store.get('lifetime')
    if (raw !== undefined) await update($, lifetime, () => lifetimeFrom(raw, now))
    const t = await read($, session)
    if (t.turns > 0) $.ui.status(statusOf(t))

    return next(e)
  })

  // A /clear starts a new conversation: its first big write is a cold cache, not a bust.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, previous, () => null)

    return next(e)
  })

  // Per request of a turn: how many requests, and the biggest single cache
  // write. A long turn writes a little on every step; only one request writing
  // a lot is a re-write of the cache. The count also picks Haiku 5.5's card,
  // which is chosen by one request's prompt, not the turn's sum.
  on('turn.step', async function* ($, e, next) {
    const res = yield* next(e)
    if (res.usage !== null) {
      const turnId = e.turnId
      const write = res.usage.cache_creation_input_tokens
      await update($, probes, list => {
        const was = list.find(one => one.turnId === turnId)
        const now = was === undefined
          ? { turnId, requests: 1, maxWrite: write }
          : { turnId, requests: was.requests + 1, maxWrite: Math.max(was.maxWrite, write) }

        return [...list.filter(one => one.turnId !== turnId), now].slice(-KEEP_PROBES)
      })
    }

    return res
  })

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    const usage = e.usage
    if (usage === undefined) return res

    const now = await $.clock.now()
    const b = bucketsOf(usage)
    const step = (await read($, probes)).find(one => one.turnId === e.turnId)
    if (step !== undefined) await update($, probes, list => list.filter(one => one.turnId !== e.turnId))

    if (e.agentId !== undefined) {
      const { money } = priced(usage, b, step?.requests ?? 1)
      await update($, subagents, t => addTurn(t, b, money, usage.model, false))
      await addLifetime($, b, money, usage.model, false, now)

      return res
    }

    const { money, write5m } = priced(usage, b, step?.requests ?? 1)
    const hit = hitOf(b)
    const before = await read($, previous)
    const rewrite = step?.maxWrite ?? b.write
    const isBusted = isBust(rewrite, hit, before)
    let cause: string | undefined

    if (isBusted && before !== null) {
      cause = causeOf(now - e.durationMs - before.endedAt, usage.model, before)
      const price = write5m === null ? null : (rewrite * write5m) / 1e6
      $.ui.toast(`Cache busted: ${tokens(rewrite)} tokens re-written (~${usd(price)}). Likely cause: ${cause}.`, {
        timeoutMs: 8000,
      })
    }

    const totals = await update($, session, t => addTurn(t, b, money, usage.model, isBusted))
    const row: Turn = {
      ...b,
      n: totals.turns,
      turnId: e.turnId,
      endedAt: now,
      durationMs: e.durationMs,
      model: usage.model,
      hit,
      cost: money?.cost ?? null,
      ideal: money?.ideal ?? null,
      tax: money?.tax ?? null,
      isBusted,
      ...(cause === undefined ? {} : { cause }),
    }
    await update($, turns, list => [...list, row].slice(-KEEP_TURNS))
    await update($, previous, () => ({ endedAt: now, model: usage.model, hit }))
    $.ui.status(statusOf(totals))
    await addLifetime($, b, money, usage.model, isBusted, now)

    return res
  })

  on('command.run', { command: 'cache-tax' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === '') {
      const opened = await $.ui.open({ id: PANE, title: 'Cache tax' })
      const t = await read($, session)
      const now = t.turns === 0 ? 'No turns measured yet.' : `This session: ${statusOf(t)} over ${plural(t.turns, 'turn')}.`
      const wait = opened.isPlaced ? '' : ' It shows once the window is wide enough.'

      return { text: `Cache tax pane opened. ${now}${wait}` }
    }

    if (arg === 'reset') {
      await update($, turns, () => [])
      await update($, session, () => emptyTotals())
      await update($, subagents, () => emptyTotals())
      $.ui.status(undefined)

      return { text: "Cache tax: this session's numbers are cleared. Lifetime totals are kept." }
    }

    return { text: USAGE }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns)
    const list = await read($, turns)
    const t = await read($, session)
    const subs = await read($, subagents)
    const life = await read($, lifetime)
    const cols = columnsFor(width)
    const shown = list.slice(-SHOWN_TURNS).reverse()
    const last = list[list.length - 1]
    const rows = []

    if (t.turns === 0) {
      rows.push(
        <Box key="empty" flexDirection="column">
          <Text dimColor wrap="wrap">
            No turns measured yet. The numbers fill in as Claude answers.
          </Text>
        </Box>,
      )
    } else {
      const model = last === undefined ? '' : ` · ${priceOf(last.model)?.name ?? last.model}`
      rows.push(
        <Box key="session" flexDirection="column">
          <Text bold wrap="wrap">
            Session · {plural(t.turns, 'turn')}
            {model}
          </Text>
          <Text wrap="wrap">{summaryOf(t)}</Text>
          <Text dimColor wrap="wrap">
            {bucketsLine(t)}
          </Text>
          {t.busts > 0 && (
            <Text color="warning" wrap="wrap">
              {plural(t.busts, 'cache bust')} this session
            </Text>
          )}
        </Box>,
      )
    }

    if (subs.turns > 0) {
      rows.push(
        <Box key="subagents" flexDirection="column" marginTop={1}>
          <Text wrap="wrap">
            Subagents · {plural(subs.turns, 'turn')} · {summaryOf(subs)}
          </Text>
        </Box>,
      )
    }

    if (shown.length > 0) {
      rows.push(
        <Box key="table-note" marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {list.length > shown.length ? `Last ${shown.length} turns, newest first` : 'Turns, newest first'}
          </Text>
        </Box>,
      )
      rows.push(
        <Box key="head" flexDirection="row">
          {cols.map((col, i) => (
            <Box key={`head-${col.id}`} width={col.width} marginLeft={i === 0 ? 0 : 1} justifyContent="flex-end">
              <Text bold>{col.head}</Text>
            </Box>
          ))}
        </Box>,
      )
      for (const turn of shown) {
        rows.push(
          <Box key={`turn-${turn.n}`} flexDirection="row">
            {cols.map((col, i) => (
              <Box
                key={`turn-${turn.n}-${col.id}`}
                width={col.width}
                marginLeft={i === 0 ? 0 : 1}
                justifyContent="flex-end"
              >
                <Text color={turn.isBusted ? 'warning' : undefined} wrap="truncate-end">
                  {col.cell(turn)}
                </Text>
              </Box>
            ))}
          </Box>,
        )
      }
      const busted = shown.find(turn => turn.isBusted && turn.cause !== undefined)
      if (busted !== undefined) {
        rows.push(
          <Box key="bust" flexDirection="column">
            <Text color="warning" wrap="wrap">
              ! #{busted.n} re-wrote the cache: {busted.cause}
            </Text>
          </Box>,
        )
      }
    }

    const notes = []
    if (life !== null && life.turns > 0) {
      notes.push(`Lifetime, all sessions and subagents: ${plural(life.turns, 'turn')} · ${summaryOf(life)}`)
    }
    notes.push('Cache writes priced at the 5-minute rate: the usage does not split 5-minute from 1-hour writes.')
    notes.push(`Tax = cost - the same tokens with every input token a cache read. Prices: ${PRICES_SOURCE}.`)
    const unknown = [...new Set([...t.unknown, ...subs.unknown])]
    if (unknown.length > 0) notes.push(`$? = no price for ${unknown.join(', ')}.`)

    rows.push(
      <Box key="footer" flexDirection="column" marginTop={1}>
        {notes.map(note => (
          <Text dimColor wrap="wrap">
            {note}
          </Text>
        ))}
      </Box>,
    )

    return <Box flexDirection="column">{rows}</Box>
  })
}
