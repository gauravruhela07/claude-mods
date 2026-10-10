/** The skins this mod ships. */
export type SkinName = 'matrix' | 'pirate' | 'zen' | 'retro' | 'space'

/** What `/skin` can be set to: a skin, or `off` for the engine's own look. */
export type SkinChoice = SkinName | 'off'

/** The theme keys a skin draws in (they follow the person's theme). */
export type SkinColor = 'success' | 'warning' | 'subtle' | 'claude' | 'suggestion'

/** One skin: how the spinner, the closing line and the hints look and talk. */
export type Skin = {
  name: SkinName
  /** One line for the picker and the listing. */
  blurb: string
  /** The spinner's frames, single-cell glyphs (no emoji). */
  glyphs: readonly string[]
  /** How long one frame shows, in ms (a multiple of the 250 ms tick). */
  frameMs: number
  /** Present-tense verbs the spinner rotates through (8 or more). */
  verbs: readonly string[]
  /** Drawn right after the verb in place of the engine's ellipsis. */
  suffix: string
  color: SkinColor
  /** Past-tense word of the closing line: `<doneWord> for 12s`. */
  doneWord: string
  /** Hint lines reworded in the skin's voice; the key named stays the same. */
  hints: {
    /** Replaces the whole `? for shortcuts` line. */
    shortcuts: string
    /** Replaces the whole `esc to interrupt` line. */
    interrupt: string
    /** `(<key> <background>)` replaces `(<key> to run in background)`. */
    background: string
  }
}

declare module 'claude-code' {
  interface PluginState {
    'skins': {
      /** The skin in use, mirrored from `$.store` key `skin`. */
      skin: SkinChoice
      /** The animation clock: ms since the epoch, floored to the skin's frame. */
      tick: number
    }
  }
}
