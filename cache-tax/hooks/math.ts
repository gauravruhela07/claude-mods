import type { ModelUsage } from 'claude-code'

import type { Buckets, Previous, Totals } from '../types'
import type { Card } from './prices'

/** A turn re-wrote the cache when one request wrote more than this many tokens. */
export const BUST_TOKENS = 50_000
/** How many turns the session keeps for the table. */
export const KEEP_TURNS = 200
const FIVE_MIN = 5 * 60_000
const HOUR = 60 * 60_000
const UNKNOWN_KEPT = 5

export type Money = { cost: number; ideal: number; tax: number }

export const bucketsOf = (usage: ModelUsage): Buckets => ({
  input: usage.input_tokens,
  write: usage.cache_creation_input_tokens,
  read: usage.cache_read_input_tokens,
  output: usage.output_tokens,
})

/** Every input token of the prompt, cached or not. */
export const promptOf = (b: Buckets) => b.input + b.write + b.read

/** Share of the prompt the cache served; null when there was no prompt. */
export const hitOf = (b: Buckets): number | null => {
  const prompt = promptOf(b)

  return prompt > 0 ? b.read / prompt : null
}

/**
 * What the tokens cost on `card`, what they would cost if every input token
 * were a cache read (`ideal`), and the difference (`tax`). Cache writes are
 * priced at the 5-minute rate: the usage does not split 5m from 1h writes.
 */
export const moneyOf = (b: Buckets, card: Card): Money => {
  const cost = (b.input * card.input + b.write * card.write5m + b.read * card.read + b.output * card.output) / 1e6
  const ideal = (promptOf(b) * card.read + b.output * card.output) / 1e6

  return { cost, ideal, tax: cost - ideal }
}

export const emptyTotals = (): Totals => ({
  turns: 0,
  input: 0,
  write: 0,
  read: 0,
  output: 0,
  priced: 0,
  cost: 0,
  ideal: 0,
  tax: 0,
  busts: 0,
  unknown: [],
})

/** Totals with one more turn added. */
export const addTurn = (t: Totals, b: Buckets, money: Money | null, model: string, isBusted: boolean): Totals => ({
  turns: t.turns + 1,
  input: t.input + b.input,
  write: t.write + b.write,
  read: t.read + b.read,
  output: t.output + b.output,
  priced: t.priced + (money === null ? 0 : 1),
  cost: t.cost + (money?.cost ?? 0),
  ideal: t.ideal + (money?.ideal ?? 0),
  tax: t.tax + (money?.tax ?? 0),
  busts: t.busts + (isBusted ? 1 : 0),
  unknown:
    money !== null || model === '' || t.unknown.includes(model)
      ? t.unknown
      : [...t.unknown, model].slice(-UNKNOWN_KEPT),
})

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** A Totals from whatever JSON the store held (a missing or odd field reads as 0). */
export const totalsFrom = (raw: unknown): Totals => {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const unknown = Array.isArray(o.unknown) ? o.unknown.filter((m): m is string => typeof m === 'string') : []

  return {
    turns: num(o.turns),
    input: num(o.input),
    write: num(o.write),
    read: num(o.read),
    output: num(o.output),
    priced: num(o.priced),
    cost: num(o.cost),
    ideal: num(o.ideal),
    tax: num(o.tax),
    busts: num(o.busts),
    unknown: unknown.slice(-UNKNOWN_KEPT),
  }
}

/**
 * A busted turn re-wrote a large part of the cache it should have read: the
 * biggest write is over 50k tokens, and the turn mostly missed or the turn
 * before mostly hit. The first turn after a start is a cold cache, not a bust.
 */
export const isBust = (write: number, hit: number | null, previous: Previous | null) =>
  previous !== null &&
  hit !== null &&
  write > BUST_TOKENS &&
  (hit < 0.5 || (previous.hit !== null && previous.hit > 0.8))

/** Why a busted turn likely re-wrote the cache. */
export const causeOf = (gapMs: number, model: string, previous: Previous) => {
  const causes: string[] = []
  if (gapMs > HOUR) causes.push('idle past the 1-hour cache life')
  else if (gapMs > FIVE_MIN) causes.push('idle past the 5-minute cache life')
  if (previous.model !== '' && previous.model !== model) causes.push('model switched')

  return causes.length > 0 ? causes.join(' and ') : 'the prompt prefix changed (system prompt, tools, or compaction)'
}

/** 950, 1.2k, 45k, 3.4M. */
export const tokens = (n: number) => {
  if (n < 1000) return String(Math.round(n))
  if (n < 9_950) return `${(n / 1000).toFixed(1)}k`
  if (n < 999_500) return `${Math.round(n / 1000)}k`
  if (n < 9_950_000) return `${(n / 1e6).toFixed(1)}M`

  return `${Math.round(n / 1e6)}M`
}

/** $0.12, $0.004, $12.30, $123; $? when unknown. */
export const usd = (v: number | null) => {
  if (v === null) return '$?'
  const a = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (a === 0) return '$0.00'
  if (a < 0.01) return `${sign}$${a.toFixed(3)}`
  if (a < 100) return `${sign}$${a.toFixed(2)}`

  return `${sign}$${Math.round(a)}`
}

/** 94%; – when there is nothing to measure. */
export const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`)

/** 42s, 3m05s, 1h02m. */
export const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`

  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** A sum of money over totals: `$?` when nothing was priced, `+?` when part was not. */
export const totalUsd = (t: Totals, v: number) => {
  if (t.turns > 0 && t.priced === 0) return '$?'

  return t.priced < t.turns ? `${usd(v)}+?` : usd(v)
}

/** The status line: `cache 94% · tax $0.12`. */
export const statusOf = (t: Totals) => `cache ${pct(hitOf(t))} · tax ${totalUsd(t, t.tax)}`
