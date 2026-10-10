/** What one reflection cost, from the fork result's `usage`. */
export type Usage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** One reflection: asked by the person (`command`) or run after an editing turn (`auto`). */
export type Reflection = {
  id: number
  /** When it started, ms since the epoch. */
  at: number
  /** Focus words given to /reflect, '' when none. */
  focus: string
  origin: 'command' | 'auto'
  status: 'running' | 'done' | 'failed'
  /** The model's Markdown once done, '' otherwise. */
  markdown: string
  /** Why it failed, in plain words, '' otherwise. */
  error: string
  usage: Usage | null
}

declare module 'claude-code' {
  interface PluginState {
    reflect: {
      /** The last 5 reflections, oldest first. */
      reflections: Reflection[]
      /** The id the pane shows; null follows the newest. */
      shown: number | null
      /** Auto mode, mirrored from $.store key `auto`. */
      isAuto: boolean
      /** A main-loop edit succeeded in the turn that runs now. */
      hasEdited: boolean
    }
  }
}
