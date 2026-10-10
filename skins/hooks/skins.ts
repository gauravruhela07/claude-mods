import type { Skin, SkinChoice, SkinName } from '../types'

/** The animation tick; every skin's `frameMs` is a multiple of it. */
export const TICK_MS = 250

/** How long one verb stays before the next one rotates in. */
export const VERB_MS = 4000

export const SKINS: readonly Skin[] = [
  {
    name: 'matrix',
    blurb: 'green code rain',
    glyphs: ['░', '▒', '▓', '█', '▓', '▒'],
    frameMs: 250,
    verbs: [
      'Decrypting',
      'Jacking in',
      'Tracing the call',
      'Bending the spoon',
      'Following the white rabbit',
      'Reading the code rain',
      'Dodging agents',
      'Rewriting the construct',
      'Patching the Matrix',
    ],
    suffix: '_',
    color: 'success',
    doneWord: 'Decrypted',
    hints: {
      shortcuts: "? for the operator's manual",
      interrupt: 'esc to jack out',
      background: 'to fork it into the background',
    },
  },
  {
    name: 'pirate',
    blurb: 'high seas, plain ASCII',
    glyphs: ['_', '-', '~', '^', '~', '-'],
    frameMs: 500,
    verbs: [
      'Plundering',
      'Hoisting the sails',
      'Swabbing the deck',
      'Charting a course',
      'Weighing anchor',
      'Splicing the mainbrace',
      'Hunting for treasure',
      'Battening the hatches',
      'Raising the Jolly Roger',
    ],
    suffix: '...',
    color: 'warning',
    doneWord: 'Plundered',
    hints: {
      shortcuts: "? for the ship's charts",
      interrupt: 'esc to drop anchor',
      background: 'to send it below deck',
    },
  },
  {
    name: 'zen',
    blurb: 'slow and quiet',
    glyphs: ['·', '∙', '•', '∙'],
    frameMs: 750,
    verbs: [
      'Breathing',
      'Letting go',
      'Sitting with it',
      'Noticing',
      'Being present',
      'Raking the sand',
      'Listening',
      'Settling',
      'Returning to the breath',
    ],
    suffix: '…',
    color: 'subtle',
    doneWord: 'Breathed',
    hints: {
      shortcuts: '? for gentle guidance',
      interrupt: 'esc to pause and breathe',
      background: 'to let it run quietly in the background',
    },
  },
  {
    name: 'retro',
    blurb: '8-bit, ALL CAPS',
    glyphs: ['|', '/', '-', '\\'],
    frameMs: 250,
    verbs: [
      'PROCESSING',
      'LOADING TAPE',
      'REWINDING',
      'COMPILING',
      'PLEASE WAIT',
      'READING SECTOR',
      'INSERT DISK 2',
      'DIALING UP',
      'POKING MEMORY',
    ],
    suffix: '...',
    color: 'claude',
    doneWord: 'PROCESSED',
    hints: {
      shortcuts: '? FOR SHORTCUTS',
      interrupt: 'ESC TO BREAK',
      background: 'TO RUN IN BACKGROUND',
    },
  },
  {
    name: 'space',
    blurb: 'mission control',
    glyphs: ['·', '✧', '✦', '✧'],
    frameMs: 500,
    verbs: [
      'Launching',
      'Orbiting',
      'Docking',
      'Calibrating thrusters',
      'Plotting a trajectory',
      'Scanning the stars',
      'Reaching escape velocity',
      'Slingshotting the moon',
      'Calling ground control',
    ],
    suffix: '…',
    color: 'suggestion',
    doneWord: 'Landed',
    hints: {
      shortcuts: '? for mission control',
      interrupt: 'esc to abort mission',
      background: 'to put it in a background orbit',
    },
  },
]

export const NAMES: readonly SkinName[] = SKINS.map(skin => skin.name)

/** The skin of that name; undefined for `off` and for any other word. */
export const skinNamed = (name: string): Skin | undefined => SKINS.find(skin => skin.name === name)

/** A stored value read back as a choice; anything unknown is `off`. */
export const asChoice = (value: unknown): SkinChoice =>
  typeof value === 'string' && skinNamed(value) !== undefined ? (value as SkinName) : 'off'

const at = <T>(list: readonly T[], index: number, fallback: T): T =>
  list[((index % list.length) + list.length) % list.length] ?? fallback

/** The glyph frame showing at time `tick`. */
export const glyphAt = (skin: Skin, tick: number): string => at(skin.glyphs, Math.floor(tick / skin.frameMs), '·')

/** The verb showing at time `tick`; it rotates every VERB_MS. */
export const verbAt = (skin: Skin, tick: number): string => at(skin.verbs, Math.floor(tick / VERB_MS), 'Working')

/** The tick a skin's animation stands at, at time `now`. */
export const frameStart = (skin: Skin, now: number): number => now - (now % skin.frameMs)

/** The picker's and the listing's sample: the frames, then the first verb. */
export const preview = (skin: Skin): string => `${skin.glyphs.slice(0, 4).join('')} ${skin.verbs[0] ?? ''}${skin.suffix}`

/**
 * The hint line in the skin's voice, or undefined when it is not one of the
 * plain lines we know: a rewrite replaces the whole line, so a line with pills
 * (live parts) is left to the engine.
 */
export const rewordHint = (skin: Skin, hint: string): string | undefined => {
  const line = hint.trim()

  if (line === '? for shortcuts') return skin.hints.shortcuts
  if (line === 'esc to interrupt') return skin.hints.interrupt

  return undefined
}

/** `(ctrl+b to run in background)` in the skin's voice, the person's key kept. */
export const rewordBackground = (skin: Skin, hint: string): string | undefined => {
  const match = /^\((.+?) to run in background\)$/.exec(hint.trim())

  return match === null ? undefined : `(${match[1]} ${skin.hints.background})`
}

export const USAGE = `Usage: /skin (pick one), /skin <${NAMES.join('|')}>, or /skin off. Nothing changed.`

/** The command's text answer: every skin, its sample, the active one marked. */
export const listing = (active: SkinChoice): string => {
  const rows = SKINS.map(
    skin => `- ${skin.name}${skin.name === active ? ' (active)' : ''}: \`${preview(skin)}\` ${skin.blurb}`,
  )
  rows.push(`- off${active === 'off' ? ' (active)' : ''}: the engine's default look`)

  return [`Skins:`, '', ...rows, '', 'Apply one with /skin <name> or a button in the Skins pane; /skin off goes back.'].join(
    '\n',
  )
}
