/** Token counts of one turn (or a sum of turns), by prompt-cache bucket. */
export type Buckets = {
  /** Uncached input tokens, billed at the full input price. */
  input: number
  /** Tokens written to the prompt cache. */
  write: number
  /** Tokens read from the prompt cache. */
  read: number
  /** Generated tokens. */
  output: number
}

/** One main-loop turn as the pane's table shows it. */
export type Turn = Buckets & {
  /** Turn number in this session (1-based, restarts after a reset). */
  n: number
  turnId: string
  /** When the turn ended, `$.clock.now()` milliseconds. */
  endedAt: number
  durationMs: number
  /** Model id the API reported for the turn's last response. */
  model: string
  /** read / (input + write + read); null when the turn sent no input. */
  hit: number | null
  /** Dollars; null when the model is not in the price table. */
  cost: number | null
  /** What the same tokens would cost if every input token were a cache read. */
  ideal: number | null
  /** cost - ideal. */
  tax: number | null
  isBusted: boolean
  /** Why the cache was likely re-written, set on a busted turn. */
  cause?: string
}

/** Running totals over many turns. Money sums cover priced turns only. */
export type Totals = Buckets & {
  turns: number
  /** Turns whose model had a price (the money sums cover these). */
  priced: number
  cost: number
  ideal: number
  tax: number
  busts: number
  /** Model ids seen that are not in the price table (a few, for the footer). */
  unknown: string[]
}

/** Lifetime totals kept in `$.store` under `lifetime`, across sessions. */
export type Lifetime = Totals & { since: number }

/** What bust detection needs from the previous main-loop turn. */
export type Previous = { endedAt: number; model: string; hit: number | null }

/** Per-request facts of a running turn (main loop or a subagent's), from `turn.step`. */
export type Probe = { turnId: string; requests: number; maxWrite: number }

declare module 'claude-code' {
  interface PluginState {
    'cache-tax': {
      turns: Turn[]
      session: Totals
      subagents: Totals
      lifetime: Lifetime | null
      previous: Previous | null
      probes: Probe[]
    }
  }
}
