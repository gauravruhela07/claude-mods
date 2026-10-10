import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Playback, Position, Recording, Source, Step } from '../types'
import {
  EMPTY,
  addStep,
  asSaved,
  closeScene,
  countAgentCall,
  finishStep,
  fit,
  holdMs,
  nextFrame,
  nextScene,
  nextSpeed,
  nextStep,
  openScene,
  prevScene,
  prevStep,
  runs,
  script,
  startOf,
  theEnd,
  timeline,
  totals,
} from './film'
import type { Cell } from './film'
import { GLYPH, clip, describe, kindOf, plural, targetOf, took } from './format'

const PANE = 'replay'
const TITLE = 'Replay theatre'
const STORE_KEY = 'last-session'
const NOTHING = 'Nothing to replay yet.'
const USAGE =
  'Usage: /replay opens the theatre, /replay last plays the previous session, /replay copy copies a Markdown script. Nothing changed.'

const STOPPED: Playback = { source: 'live', scene: 0, step: 0, isPlaying: false, speed: 1, since: 0, isEnded: false }

const recording = atom({ plugin: 'replay-theatre', key: 'recording' } as const, EMPTY)
const previous = atom({ plugin: 'replay-theatre', key: 'previous' } as const, null)
const playback = atom({ plugin: 'replay-theatre', key: 'playback' } as const, STOPPED)

type Dollar = EngineInterface

/** The film a source names: this session's, or the previous one (empty when none was loaded). */
const filmOf = async ($: Dollar, source: Source): Promise<Recording> =>
  source === 'last' ? ((await read($, previous)) ?? EMPTY) : read($, recording)

/** The previous session's film: the one kept at session start, else the store's when it is another session's. */
const loadPrevious = async ($: Dollar): Promise<Recording | null> => {
  const held = await read($, previous)

  if (held !== null) return held

  const saved = asSaved(await $.store.get(STORE_KEY))

  if (saved === null || saved.sessionId === (await $.session.id())) return null

  const film: Recording = { scenes: saved.scenes }
  await update($, previous, () => film)

  return film
}

/** Moves the playhead by hand; the frame starts holding anew. */
const move = async ($: Dollar, to: (film: Recording, at: Position) => Position | null) => {
  const held = await read($, playback)
  const film = await filmOf($, held.source)
  const t = await $.clock.now()

  await update($, playback, pb => {
    const at = fit(film, pb)
    const next = at === null ? null : to(film, at)

    return next === null ? pb : { ...pb, ...next, since: t, isEnded: false }
  })
}

const togglePlay = async ($: Dollar) => {
  const held = await read($, playback)
  const film = await filmOf($, held.source)
  const t = await $.clock.now()

  await update($, playback, pb =>
    pb.isEnded ? { ...pb, ...startOf(film), isPlaying: true, isEnded: false, since: t } : { ...pb, isPlaying: !pb.isPlaying, since: t },
  )
}

const restart = async ($: Dollar) => {
  const held = await read($, playback)
  const film = await filmOf($, held.source)
  const t = await $.clock.now()

  await update($, playback, pb => ({ ...pb, ...startOf(film), since: t, isEnded: false }))
}

/** One 100 ms beat of the projector: moves on once the frame has held long enough. */
const beat = async ($: Dollar) => {
  const held = await read($, playback)

  if (!held.isPlaying) return

  const film = await filmOf($, held.source)
  const t = await $.clock.now()
  const at = fit(film, held)

  if (at !== null && t - held.since < holdMs(film, at, held.speed)) return

  const to = at === null ? null : nextFrame(film, at)

  await update($, playback, pb => {
    const isSame = pb.isPlaying && pb.scene === held.scene && pb.step === held.step && pb.since === held.since

    if (!isSame) return pb

    return to === null ? { ...pb, isPlaying: false, isEnded: true } : { ...pb, ...to, since: t }
  })
}

/** Opens the theatre on a film, at the start, paused; says why when the pane waits undrawn. */
const open = async ($: Dollar, source: Source, film: Recording): Promise<string> => {
  const t = await $.clock.now()

  await update($, playback, pb => ({ ...pb, source, ...startOf(film), isPlaying: false, isEnded: false, since: t }))
  const placed = await $.ui.open({ id: PANE, title: TITLE, focus: true, rows: 20 })

  return placed.isPlaced ? '' : ` (The pane waits: ${placed.reason})`
}

const CELL_STYLE: Record<Cell, { color?: 'claude' | 'error' | 'subtle'; dimColor?: boolean; bold?: boolean }> = {
  '●': { color: 'claude', bold: true },
  '×': { color: 'error' },
  '│': { color: 'subtle' },
  '─': { dimColor: true },
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'replay',
      description: 'Play back what Claude did this session, scene by scene, in a pane',
      argumentHint: '[last|copy]',
      immediate: true,
    })

    try {
      // A new session keeps the previous one's film before its own first save replaces it;
      // a resumed session (same id, nothing recorded yet) picks its own film back up.
      const saved = asSaved(await $.store.get(STORE_KEY))
      const id = await $.session.id()

      if (saved !== null && saved.sessionId !== id) {
        await update($, previous, () => ({ scenes: saved.scenes }))
      } else if (saved !== null && (await read($, recording)).scenes.length === 0) {
        await update($, recording, () => ({ scenes: saved.scenes }))
      }
    } catch {
      // The store is a nicety: the theatre works on this session's film without it.
    }

    $.clock.every(100, () => {
      void beat($).catch(() => {})
    })

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    try {
      const t = await $.clock.now()
      await update($, recording, film => openScene(film, e.turnId, e.text, t))
    } catch {
      // Recording never stands in the turn's way.
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>

    if (e.agentId !== undefined) {
      const agentId = e.agentId

      try {
        const t = await $.clock.now()
        const film = await read($, recording)

        if (countAgentCall(film, agentId, t) !== film) {
          await update($, recording, was => countAgentCall(was, agentId, t))
        }
      } catch {
        // A subagent call that cannot be matched is simply not counted.
      }

      return next(e)
    }

    const id = e.tool_use_id
    let startedAt = 0

    try {
      startedAt = await $.clock.now()
      const step: Step = {
        id,
        tool,
        label: clip(describe(tool, input), 120),
        target: targetOf(tool, input),
        kind: kindOf(tool),
        startedAt,
        durationMs: 0,
        isRunning: true,
        ok: true,
        result: '',
        agentId: null,
        agentCalls: 0,
      }
      await update($, recording, film => addStep(film, step))
    } catch {
      // Recording never stands in the call's way.
    }

    const ran = await next(e)

    try {
      const t = await $.clock.now()
      const ok = ran.deny === undefined && ran.isError !== true
      const text = ran.deny ?? ran.text ?? (typeof ran.result === 'string' ? ran.result : '')
      await update($, recording, film =>
        finishStep(film, id, { durationMs: Math.max(0, t - startedAt), ok, result: clip(text, 120) }),
      )
    } catch {
      // The step stays as it started.
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    try {
      const t = await $.clock.now()
      const film = await update($, recording, was => closeScene(was, e.answer, e.isAborted, t))
      const sessionId = await $.session.id()
      await $.store.set(STORE_KEY, { sessionId, savedAt: t, scenes: film.scenes })
    } catch {
      // The film stays in $.state even when the store refuses it.
    }

    return next(e)
  })

  on('command.run', { command: 'replay' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg !== '' && arg !== 'last' && arg !== 'copy') return { text: USAGE }

    if (arg === 'copy') {
      const held = await read($, playback)
      const isLast = held.source === 'last' && (await read($, previous)) !== null
      const film = await filmOf($, isLast ? 'last' : 'live')

      if (film.scenes.length === 0) return { text: NOTHING }

      const which = isLast ? 'the previous session' : 'this session'
      const copied = await $.ui.copy({ text: script(film, `Replay of ${which}`) })
      const sum = totals(film)

      return {
        text: copied.isCopied
          ? `Copied the script of ${which} as Markdown: ${plural(sum.scenes, 'scene')}, ${plural(sum.steps, 'step')}.`
          : `Could not copy the script (${copied.reason}).`,
      }
    }

    if (arg === 'last') {
      const film = await loadPrevious($)

      if (film === null || film.scenes.length === 0) return { text: `${NOTHING} No earlier session was recorded.` }

      const waits = await open($, 'last', film)
      const sum = totals(film)

      return {
        text: `Replay theatre: the previous session · ${plural(sum.scenes, 'scene')} · ${plural(sum.steps, 'step')}. Press k to play.${waits}`,
      }
    }

    const film = await read($, recording)

    if (film.scenes.length === 0) return { text: NOTHING }

    const waits = await open($, 'live', film)
    const sum = totals(film)

    return {
      text: `Replay theatre: this session · ${plural(sum.scenes, 'scene')} · ${plural(sum.steps, 'step')}. Press k to play.${waits}`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const pb = await read($, playback)
    const film = await filmOf($, pb.source)
    const width = Math.max(24, e.props.bodyColumns)
    const at = fit(film, pb)

    if (at === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{NOTHING}</Text>
        </Box>
      )
    }

    const scene = film.scenes[at.scene]

    if (scene === undefined) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{NOTHING}</Text>
        </Box>
      )
    }

    const step = at.step < 0 ? undefined : scene.steps[at.step]
    const isSceneEnd = at.step === scene.steps.length - 1 || scene.steps.length === 0
    const state = pb.isPlaying ? '▶ playing' : '⏸ paused'
    const where = `Step ${at.step < 0 ? '–' : at.step + 1}/${scene.steps.length}`
    const header = `Scene ${at.scene + 1}/${film.scenes.length} · ${where} · ${pb.speed}x · ${state}${pb.source === 'last' ? ' · previous session' : ''}`
    const inner = Math.max(10, width - 4)
    const rows = []

    rows.push(
      <Box key="header" flexDirection="row">
        <Text color={pb.isPlaying ? 'claude' : 'subtle'}>{clip(header, width)}</Text>
      </Box>,
      <Box key="prompt" flexDirection="row">
        <Text bold>{clip(`You: ${scene.prompt || '(no prompt)'}`, width)}</Text>
      </Box>,
    )

    // The stage keeps one height (4 rows before, the card, 2 answer rows, the end row), so the
    // controls below it stay put while the film plays.
    for (let n = 4; n >= 1; n--) {
      const i = at.step - n
      const was = i >= 0 ? scene.steps[i] : undefined
      const mark = was === undefined ? '' : was.isRunning ? '…' : was.ok ? '✓' : '✗'
      const line = was === undefined ? ' ' : clip(`  ${GLYPH[was.kind]} ${was.label} · ${took(was.durationMs)} ${mark}`, width)

      rows.push(
        <Box key={`before-${n}`} flexDirection="row">
          <Text dimColor>{line}</Text>
        </Box>,
      )
    }

    if (step === undefined) {
      const length = scene.endedAt === null ? 'still running' : took(scene.endedAt - scene.startedAt)
      const kinds = (Object.keys(GLYPH) as (keyof typeof GLYPH)[])
        .map(kind => ({ kind, n: scene.steps.filter(one => one.kind === kind).length }))
        .filter(one => one.n > 0)
        .map(one => `${GLYPH[one.kind]} ${one.n}`)
      const failed = scene.steps.filter(one => !one.ok && !one.isRunning).length
      const mix = kinds.length === 0 ? 'no tool calls' : `${kinds.join('  ')}${failed > 0 ? `  · ${failed} failed` : ''}`

      rows.push(
        <Box key="card" flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold color="claude">
            {clip(`Scene ${at.scene + 1} of ${film.scenes.length}`, inner)}
          </Text>
          <Text>{clip(`${plural(scene.steps.length, 'step')} · ${length}${scene.aborted ? ' · stopped' : ''}`, inner)}</Text>
          <Text dimColor>{clip(mix, inner)}</Text>
        </Box>,
      )
    } else {
      const extra = step.agentCalls > 0 ? ` · ${plural(step.agentCalls, 'agent call')}` : ''
      const meta = `${step.target === '' ? step.tool : step.target} · ${step.isRunning ? 'running' : took(step.durationMs)}${extra} ·`
      const verdict = step.isRunning ? ' … running' : step.ok ? ' ✓ ok' : ' ✗ failed'

      rows.push(
        <Box key="card" flexDirection="column" borderStyle="round" paddingX={1}>
          <Box flexDirection="row">
            <Text color="claude">{GLYPH[step.kind]} </Text>
            <Text bold>{clip(step.label, inner - 2)}</Text>
          </Box>
          <Box flexDirection="row">
            <Text color="subtle">{clip(meta, inner - verdict.length)}</Text>
            <Text color={step.isRunning ? 'warning' : step.ok ? 'success' : 'error'}>{verdict}</Text>
          </Box>
          <Text dimColor>{clip(step.result || '(no output)', inner)}</Text>
        </Box>,
      )
    }

    const answer = !isSceneEnd
      ? ' '
      : scene.endedAt === null
        ? 'Claude is still working…'
        : `Claude: ${scene.aborted ? '(stopped) ' : ''}${scene.answer || '(no answer)'}`

    rows.push(
      <Box key="answer" flexDirection="row" height={2} overflow="hidden">
        <Text wrap="wrap" dimColor={scene.endedAt === null}>
          {clip(answer, width * 2 - 4)}
        </Text>
      </Box>,
      <Box key="end" flexDirection="row">
        <Text bold color="claude">
          {pb.isEnded ? clip(theEnd(film), width) : ' '}
        </Text>
      </Box>,
    )

    rows.push(
      <Box key="timeline" flexDirection="row">
        {runs(timeline(film, at, width)).map(run => (
          <Text {...CELL_STYLE[run.mark]}>{run.text}</Text>
        ))}
      </Box>,
      <Box key="controls" flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button key="prev-scene" label="⏮" hotkey="h" onPress={() => move($, prevScene)} />
        <Button key="prev-step" label="◀" hotkey="j" onPress={() => move($, prevStep)} />
        <Button
          key="play"
          label={pb.isPlaying ? '⏸ Pause' : '▶ Play'}
          hotkey="k"
          variant="primary"
          onPress={() => togglePlay($)}
        />
        <Button key="next-step" label="▶" hotkey="l" onPress={() => move($, nextStep)} />
        <Button key="next-scene" label="⏭" hotkey="n" onPress={() => move($, nextScene)} />
        <Button key="speed" label={`${pb.speed}x`} hotkey="s" onPress={() => update($, playback, was => ({ ...was, speed: nextSpeed(was.speed) }))} />
        <Button key="restart" label="Restart" hotkey="r" onPress={() => restart($)} />
      </Box>,
    )

    if (e.surface === 'terminal') {
      const keys = 'keys: h ⏮ · j ◀ · k play · l ▶ · n ⏭ · s speed · r restart'
      rows.push(
        <Box key="keys" flexDirection="row">
          <Text dimColor>{clip(e.props.isFocused ? keys : `${keys} · ctrl+x tab to focus`, width)}</Text>
        </Box>,
      )
    }

    return <Box flexDirection="column">{rows}</Box>
  })
}
