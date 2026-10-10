/** What this session did to a file: `R` read, `M` modified, `A` added (written new). */
export type Mark = 'R' | 'M' | 'A'

/** Which rows the tree shows: every entry, or only touched files and the folders holding them. */
export type Mode = 'all' | 'touched'

/** One entry of a folder listing; ignored names are already left out. */
export type Entry = { name: string; isDir: boolean }

/** A folder's listing as last loaded: up to 200 entries, sorted, how many more there were, and why it failed. */
export type Listing = { entries: Entry[]; more: number; error: string | null }

declare module 'claude-code' {
  interface PluginState {
    filetree: {
      /** The session's working directory, normalized: the tree's root. */
      root: string
      mode: Mode
      /** Folders shown open, as paths under the root (the root itself is always open). */
      expanded: string[]
      /** Loaded listings by path under the root ('' is the root). */
      listings: Record<string, Listing>
      /** Every file touched this session, by absolute path. */
      touched: Record<string, Mark>
    }
  }
}
