/**
 * Prices, US dollars per million tokens, Anthropic first-party API rates.
 *
 * Source: the `claude-api` skill bundled with Claude Code 2.1.293 (its model
 * table "cached: 2026-10-06", shared/models.md, the pricing notes in
 * shared/model-migration.md and "Economics" in shared/prompt-caching.md),
 * read on 2026-10-11. Cache writes are 1.25x input (5-minute) and 2x input
 * (1-hour); cache reads 0.1x input, except where the skill names another rate:
 * Fable 5.1 / Mythos 5.1 $0.25, Opus 5.5 $0.20, Fable 5 / Mythos 5 $1.00.
 * Haiku 5.5 has a second card for prompts over 100K tokens ($0.50 / $2.50).
 * Bedrock and Vertex bill their own rates; fast mode and batch are not priced.
 */

export type Card = {
  input: number
  output: number
  write5m: number
  write1h: number
  read: number
}

export type Price = {
  /** Matched against the model id as a whole segment (`opus-5` is not `opus-5-5`). */
  family: string
  name: string
  card: Card
  /** A card that applies when one request's prompt is longer than `above` tokens. */
  long?: { above: number; card: Card }
}

export const PRICES_SOURCE = 'claude-api skill, read 2026-10-11'

// prettier-ignore
export const PRICES: readonly Price[] = [
  { family: 'fable-5-1',  name: 'Fable 5.1',  card: { input: 10,   output: 50,   write5m: 12.5,  write1h: 20,   read: 0.25 } },
  { family: 'mythos-5-1', name: 'Mythos 5.1', card: { input: 10,   output: 50,   write5m: 12.5,  write1h: 20,   read: 0.25 } },
  { family: 'fable-5',    name: 'Fable 5',    card: { input: 10,   output: 50,   write5m: 12.5,  write1h: 20,   read: 1 } },
  { family: 'mythos-5',   name: 'Mythos 5',   card: { input: 10,   output: 50,   write5m: 12.5,  write1h: 20,   read: 1 } },
  { family: 'opus-5-5',   name: 'Opus 5.5',   card: { input: 4,    output: 20,   write5m: 5,     write1h: 8,    read: 0.2 } },
  { family: 'opus-5',     name: 'Opus 5',     card: { input: 5,    output: 25,   write5m: 6.25,  write1h: 10,   read: 0.5 } },
  { family: 'opus-4-8',   name: 'Opus 4.8',   card: { input: 5,    output: 25,   write5m: 6.25,  write1h: 10,   read: 0.5 } },
  { family: 'opus-4-7',   name: 'Opus 4.7',   card: { input: 5,    output: 25,   write5m: 6.25,  write1h: 10,   read: 0.5 } },
  { family: 'opus-4-6',   name: 'Opus 4.6',   card: { input: 5,    output: 25,   write5m: 6.25,  write1h: 10,   read: 0.5 } },
  { family: 'sonnet-5-5', name: 'Sonnet 5.5', card: { input: 2,    output: 10,   write5m: 2.5,   write1h: 4,    read: 0.2 } },
  { family: 'sonnet-5',   name: 'Sonnet 5',   card: { input: 2,    output: 10,   write5m: 2.5,   write1h: 4,    read: 0.2 } },
  { family: 'sonnet-4-6', name: 'Sonnet 4.6', card: { input: 3,    output: 15,   write5m: 3.75,  write1h: 6,    read: 0.3 } },
  { family: 'haiku-5-5',  name: 'Haiku 5.5',  card: { input: 0.1,  output: 0.5,  write5m: 0.125, write1h: 0.2,  read: 0.01 },
    long: { above: 100_000, card:             { input: 0.5,  output: 2.5,  write5m: 0.625, write1h: 1,    read: 0.05 } } },
  { family: 'haiku-4-5',  name: 'Haiku 4.5',  card: { input: 1,    output: 5,    write5m: 1.25,  write1h: 2,    read: 0.1 } },
]

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whether `family` names this model id: the family stands as whole segments,
 * not followed by a further version number (`opus-5` does not match
 * `claude-opus-5-5`, but does match `claude-opus-5-20260101` or `opus-5[1m]`).
 */
const isFamily = (id: string, family: string) =>
  new RegExp(`(^|[^a-z0-9])${escape(family)}(?![-.]\\d{1,2}(?!\\d))(?![a-z0-9])`).test(id)

/** The price row for a model id, or undefined when the table has none. */
export const priceOf = (model: string): Price | undefined => {
  const id = model.toLowerCase()

  return PRICES.find(row => isFamily(id, row.family))
}

/** The card a request of `promptPerRequest` input tokens is billed on. */
export const cardOf = (price: Price, promptPerRequest: number): Card =>
  price.long !== undefined && promptPerRequest > price.long.above ? price.long.card : price.card
