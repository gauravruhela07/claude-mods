import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SkinChoice } from '../types'
import {
  asChoice,
  frameStart,
  glyphAt,
  listing,
  preview,
  rewordBackground,
  rewordHint,
  skinNamed,
  SKINS,
  TICK_MS,
  USAGE,
  verbAt,
} from './skins'

const PANE = 'skins'

const chosen = atom({ plugin: 'skins', key: 'skin' } as const, 'off')
const tick = atom({ plugin: 'skins', key: 'tick' } as const, 0)

/** Sets the skin for this session's drawings and for the sessions after it. */
const choose = async ($: Pick<EngineInterface, 'state' | 'store'>, choice: SkinChoice) => {
  await update($, chosen, () => choice)
  await $.store.set('skin', choice)
}

export const register: Register = on => {
  // The animation only ticks while a turn runs; a reload resets this and the next turn sets it again.
  let isTurnRunning = false
  let lastTick = -1

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'skin',
      description: 'Swap the look of Claude Code: pick a skin, or /skin off for the default',
      argumentHint: '[matrix|pirate|zen|retro|space|off]',
      immediate: true,
    })
    const stored = asChoice(await $.store.get('skin'))
    await update($, chosen, () => stored)

    $.clock.every(TICK_MS, async () => {
      if (!isTurnRunning) return
      const skin = skinNamed(await read($, chosen))
      if (skin === undefined) return
      const at = frameStart(skin, await $.clock.now())
      if (at === lastTick) return
      lastTick = at
      await update($, tick, () => at)
    })

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    isTurnRunning = true

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) isTurnRunning = false

    return next(e)
  })

  on('command.run', { command: 'skin' }, async ($, e) => {
    const words = e.args.trim().toLowerCase().split(/\s+/).filter(word => word !== '')

    if (words.length === 0) {
      await $.ui.open({ id: PANE, title: 'Skins' })

      return { text: listing(await read($, chosen)) }
    }

    const word = words.length === 1 ? (words[0] ?? '') : ''

    if (word === 'off') {
      await choose($, 'off')

      return { text: "Skin off: the engine's default look is back." }
    }

    const skin = skinNamed(word)

    if (skin === undefined) return { text: USAGE }

    await choose($, skin.name)

    return { text: `Skin set: ${skin.name}` }
  })

  // The picker: one row per skin, a button to apply it, its name and a sample in its color.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const active = await read($, chosen)
    const width = Math.max(24, e.props.bodyColumns)
    const mark = (isActive: boolean) => (isActive ? '●' : ' ')

    const rows = SKINS.map((skin, i) => {
      const isActive = skin.name === active

      return (
        <Box key={`row-${skin.name}`} flexDirection="row" width={width}>
          <Button key={`use-${skin.name}`} label="Apply" hotkey={String(i + 1)} onPress={() => choose($, skin.name)} />
          <Text bold={isActive}>{` ${mark(isActive)} ${skin.name.padEnd(7)} `}</Text>
          <Text color={skin.color} wrap="truncate-end">
            {preview(skin)}
          </Text>
        </Box>
      )
    })

    return (
      <Box flexDirection="column">
        {rows}
        <Box key="row-off" flexDirection="row" width={width}>
          <Button key="use-off" label="Apply" hotkey="0" onPress={() => choose($, 'off')} />
          <Text bold={active === 'off'}>{` ${mark(active === 'off')} ${'off'.padEnd(7)} `}</Text>
          <Text dimColor wrap="truncate-end">
            the engine's default look
          </Text>
        </Box>
        <Box key="help" width={width}>
          <Text dimColor wrap="truncate-end">
            {'● active · /skin <name> works too · kept for your next sessions'}
          </Text>
        </Box>
      </Box>
    )
  })

  // The spinner. Its glyph and color are no props, and its time and tokens are in no prop either:
  // so the verb and suffix are rewritten as props, and the skin's colored glyph is drawn in front
  // of the engine's own line, which keeps everything it shows.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const skin = skinNamed(await read($, chosen))
    if (skin === undefined) return next(e)

    const t = await read($, tick)
    const { word, message, suffix } = e.props
    // On the desktop the word says what the step does (`Creating notes.md`): real, so kept.
    const isStepWord = e.surface === 'desktop' && word !== 'Working'
    const drawn = await next({
      ...e,
      props: {
        ...e.props,
        word: isStepWord ? word : verbAt(skin, t),
        suffix: message === null ? skin.suffix : suffix,
      },
    })
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row">
        <Text color={skin.color}>{glyphAt(skin, t)} </Text>
        {drawn}
      </Box>
    )
  })

  // `Worked for 12s` -> `Decrypted for 12s`: the word only, the duration stays the engine's.
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const skin = skinNamed(await read($, chosen))
    if (skin === undefined) return next(e)

    return next({ ...e, props: { ...e.props, word: skin.doneWord } })
  })

  // Only a whole line we know is reworded: a rewrite replaces the line, and pills must stay live.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const skin = skinNamed(await read($, chosen))
    const hint = skin === undefined ? undefined : rewordHint(skin, e.props.hint)
    if (hint === undefined) return next(e)

    return next({ ...e, props: { ...e.props, hint } })
  })

  // `(ctrl+b to run in background)` in the skin's voice, the person's own key kept.
  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    const skin = skinNamed(await read($, chosen))
    const hint = skin === undefined ? undefined : rewordBackground(skin, e.props.hint)
    if (hint === undefined) return next(e)

    return next({ ...e, props: { ...e.props, hint } })
  })

  // The footer's mode labels gain the skin's name; the engine's own labels stay first.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const skin = skinNamed(await read($, chosen))
    if (skin === undefined) return next(e)

    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, `${skin.name} skin`] } })
  })
}
