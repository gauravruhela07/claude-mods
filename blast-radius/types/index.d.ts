/** Where the dependent search for one edited file stands. */
export type SearchStatus = 'pending' | 'done' | 'failed' | 'outside'

/** One file Claude edited this session, and the files found to depend on it. */
export type Blast = {
  /** The path as the tool call named it, absolute. */
  path: string
  /** The path relative to the project root, for display. */
  rel: string
  status: SearchStatus
  /** How many files reference this file's module (exact). */
  count: number
  /** Those files, relative to the root, sorted; at most MAX_KEPT of them. */
  dependents: string[]
  /** The turn the result (or the search under way) belongs to: the cache key. */
  searchedTurn: number
  /** How many successful edits this session. */
  edits: number
  editedAt: number
}

/** A wide-reaching shell command that ran. */
export type Risky = {
  /** The command, clipped. */
  command: string
  /** The rule it matched, e.g. "git reset --hard". */
  reason: string
  at: number
  turn: number
}

export type View = 'turn' | 'session'

declare module 'claude-code' {
  interface PluginState {
    'blast-radius': {
      root: string
      turn: number
      files: Blast[]
      turnPaths: string[]
      risky: Risky[]
      queue: string[]
      toasted: string[]
      view: View
      shown: string[]
    }
  }
}
