import type { Position, Recording, SavedSession, Scene, Speed, Step } from '../types'
import { GLYPH, clip, plural, took } from './format'

export const MAX_STEPS = 500
export const TITLE_MS = 1500
export const STEP_MIN_MS = 600
export const STEP_MAX_MS = 3000

export const EMPTY: Recording = { scenes: [] }

// ---------------------------------------------------------------- recording

const stepCount = (scenes: readonly Scene[]): number => scenes.reduce((n, scene) => n + scene.steps.length, 0)

/** Keeps at most MAX_STEPS steps, dropping the oldest scenes first. */
export const cap = (rec: Recording): Recording => {
  let scenes = rec.scenes
  let total = stepCount(scenes)

  if (total <= MAX_STEPS) return rec

  while (total > MAX_STEPS && scenes.length > 1) {
    total -= scenes[0]?.steps.length ?? 0
    scenes = scenes.slice(1)
  }

  const only = scenes[0]

  if (total > MAX_STEPS && only !== undefined) {
    scenes = [{ ...only, steps: only.steps.slice(total - MAX_STEPS) }]
  }

  return { scenes }
}

const isOpen = (scene: Scene | undefined): scene is Scene => scene !== undefined && scene.endedAt === null

/** A new scene for a turn that starts; a scene left open (no turn.complete) is closed at `t`. */
export const openScene = (rec: Recording, id: string, prompt: string, t: number): Recording => {
  const scenes = rec.scenes.map(scene => (isOpen(scene) ? { ...scene, endedAt: t } : scene))
  const scene: Scene = { id, prompt: clip(prompt, 200), startedAt: t, endedAt: null, answer: '', aborted: false, steps: [] }

  return cap({ scenes: [...scenes, scene] })
}

/** The step joins the open scene; with none open (a reload mid-turn), a scene without a prompt. */
export const addStep = (rec: Recording, step: Step): Recording => {
  const last = rec.scenes[rec.scenes.length - 1]
  const scenes = isOpen(last)
    ? [...rec.scenes.slice(0, -1), { ...last, steps: [...last.steps, step] }]
    : [
        ...rec.scenes,
        { id: `scene-${step.startedAt}`, prompt: '', startedAt: step.startedAt, endedAt: null, answer: '', aborted: false, steps: [step] },
      ]

  return cap({ scenes })
}

const mapStep = (rec: Recording, isIt: (step: Step) => boolean, change: (step: Step) => Step): Recording => {
  for (let s = rec.scenes.length - 1; s >= 0; s--) {
    const scene = rec.scenes[s]

    if (scene === undefined) continue

    const i = scene.steps.findIndex(isIt)

    if (i < 0) continue

    const steps = scene.steps.map((step, j) => (j === i ? change(step) : step))
    const scenes = rec.scenes.map((one, k) => (k === s ? { ...scene, steps } : one))

    return { scenes }
  }

  return rec
}

export const finishStep = (
  rec: Recording,
  id: string,
  done: { durationMs: number; ok: boolean; result: string },
): Recording => mapStep(rec, step => step.id === id, step => ({ ...step, ...done, isRunning: false }))

/**
 * A subagent's tool call, counted on the Agent step that spawned it: the step it
 * was matched to before, else the latest Agent step running at `t` with no agent yet.
 */
export const countAgentCall = (rec: Recording, agentId: string, t: number): Recording => {
  const known = mapStep(rec, step => step.agentId === agentId, step => ({ ...step, agentCalls: step.agentCalls + 1 }))

  if (known !== rec) return known

  const isCandidate = (step: Step) =>
    step.kind === 'agent' &&
    step.agentId === null &&
    step.startedAt <= t &&
    (step.isRunning || step.startedAt + step.durationMs >= t)
  let latest: Step | undefined

  for (const scene of rec.scenes) {
    for (const step of scene.steps) {
      if (isCandidate(step) && (latest === undefined || step.startedAt >= latest.startedAt)) latest = step
    }
  }

  if (latest === undefined) return rec

  const id = latest.id

  return mapStep(rec, step => step.id === id, step => ({ ...step, agentId, agentCalls: step.agentCalls + 1 }))
}

export const closeScene = (rec: Recording, answer: string, aborted: boolean, t: number): Recording => {
  const last = rec.scenes[rec.scenes.length - 1]

  if (!isOpen(last)) return rec

  const steps = last.steps.map(step => (step.isRunning ? { ...step, isRunning: false, durationMs: Math.max(0, t - step.startedAt) } : step))

  return { scenes: [...rec.scenes.slice(0, -1), { ...last, endedAt: t, answer: clip(answer, 300), aborted, steps }] }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** What `$.store` held under `last-session`, when it is a saved session. */
export const asSaved = (value: unknown): SavedSession | null => {
  if (!isRecord(value) || !Array.isArray(value.scenes)) return null

  const scenes = (value.scenes as unknown[]).filter(
    (scene): scene is Scene => isRecord(scene) && Array.isArray(scene.steps) && typeof scene.prompt === 'string',
  )

  return {
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : '',
    savedAt: typeof value.savedAt === 'number' ? value.savedAt : 0,
    scenes,
  }
}

// ---------------------------------------------------------------- playback

const firstStop = (scene: Scene | undefined): number => (scene !== undefined && scene.steps.length > 0 ? 0 : -1)
const lastStop = (scene: Scene | undefined): number => (scene === undefined ? -1 : scene.steps.length - 1)

/** The start: scene 1, step 1 (or its title card when it has no steps). */
export const startOf = (rec: Recording): Position => ({ scene: 0, step: firstStop(rec.scenes[0]) })

/** The position made to fit the recording (scenes may have been dropped); null when it is empty. */
export const fit = (rec: Recording, at: Position): Position | null => {
  if (rec.scenes.length === 0) return null

  const scene = Math.min(Math.max(0, at.scene), rec.scenes.length - 1)
  const step = Math.min(Math.max(-1, at.step), lastStop(rec.scenes[scene]))

  return { scene, step }
}

/** One step on, by hand: the next step, or the next scene's first. */
export const nextStep = (rec: Recording, at: Position): Position | null => {
  if (at.step < lastStop(rec.scenes[at.scene])) return { scene: at.scene, step: at.step + 1 }
  if (at.scene + 1 < rec.scenes.length) return { scene: at.scene + 1, step: firstStop(rec.scenes[at.scene + 1]) }

  return null
}

/** One step back, by hand: the step before, or the previous scene's last. */
export const prevStep = (rec: Recording, at: Position): Position | null => {
  if (at.step > firstStop(rec.scenes[at.scene])) return { scene: at.scene, step: at.step - 1 }
  if (at.scene > 0) return { scene: at.scene - 1, step: lastStop(rec.scenes[at.scene - 1]) }

  return null
}

export const nextScene = (rec: Recording, at: Position): Position | null =>
  at.scene + 1 < rec.scenes.length ? { scene: at.scene + 1, step: firstStop(rec.scenes[at.scene + 1]) } : null

export const prevScene = (rec: Recording, at: Position): Position | null => {
  const scene = Math.max(0, at.scene - 1)
  const to = { scene, step: firstStop(rec.scenes[scene]) }

  return to.scene === at.scene && to.step === at.step ? null : to
}

/** The frame playback shows next: the next step, or the next scene's title card; null at the end. */
export const nextFrame = (rec: Recording, at: Position): Position | null => {
  if (at.step < lastStop(rec.scenes[at.scene])) return { scene: at.scene, step: at.step + 1 }
  if (at.scene + 1 < rec.scenes.length) return { scene: at.scene + 1, step: -1 }

  return null
}

/** How long a frame holds: a title card 1500 ms, a step its real time within 600–3000 ms; over the speed. */
export const holdMs = (rec: Recording, at: Position, speed: Speed): number => {
  const step = at.step < 0 ? undefined : rec.scenes[at.scene]?.steps[at.step]
  const ms = step === undefined ? TITLE_MS : Math.min(STEP_MAX_MS, Math.max(STEP_MIN_MS, step.durationMs))

  return ms / speed
}

export const nextSpeed = (speed: Speed): Speed => (speed === 1 ? 2 : speed === 2 ? 4 : 1)

export const totals = (rec: Recording) => {
  let steps = 0
  let failed = 0

  for (const scene of rec.scenes) {
    steps += scene.steps.length
    failed += scene.steps.filter(step => !step.ok && !step.isRunning).length
  }

  return { scenes: rec.scenes.length, steps, failed }
}

export const theEnd = (rec: Recording): string => {
  const sum = totals(rec)

  return `The end · ${plural(sum.scenes, 'scene')} · ${plural(sum.steps, 'step')} · ${sum.failed} failed`
}

// ---------------------------------------------------------------- timeline

export type Cell = '●' | '│' | '×' | '─'

const RANK: Record<Cell, number> = { '●': 4, '×': 3, '│': 2, '─': 1 }

/**
 * The whole session across `width` cells: every step (or step-less scene) a unit
 * scaled to the width, `│` where a scene starts, `×` on a failed step, `●` at the
 * playhead, `─` elsewhere. Where several units share a cell, the strongest mark wins.
 */
export const timeline = (rec: Recording, at: Position | null, width: number): Cell[] => {
  type Unit = { isSceneStart: boolean; isFailed: boolean; isHere: boolean }
  const units: Unit[] = []

  rec.scenes.forEach((scene, s) => {
    if (scene.steps.length === 0) {
      units.push({ isSceneStart: true, isFailed: false, isHere: at !== null && at.scene === s })

      return
    }

    scene.steps.forEach((step, i) => {
      const isHere = at !== null && at.scene === s && (at.step === i || (at.step < 0 && i === 0))
      units.push({ isSceneStart: i === 0, isFailed: !step.ok && !step.isRunning, isHere })
    })
  })

  const cells: Cell[] = Array.from({ length: Math.max(0, width) }, () => '─')
  const total = units.length

  if (total === 0 || width <= 0) return cells

  units.forEach((unit, u) => {
    const from = Math.floor((u * width) / total)
    const to = Math.max(from + 1, Math.floor(((u + 1) * width) / total))

    for (let c = from; c < to && c < width; c++) {
      const isFirst = c === from
      const mark: Cell =
        isFirst && unit.isHere ? '●' : isFirst && unit.isSceneStart ? '│' : unit.isFailed ? '×' : '─'

      if (RANK[mark] > RANK[cells[c] ?? '─']) cells[c] = mark
    }
  })

  return cells
}

/** Runs of the same mark, so each run is one Text. */
export const runs = (cells: readonly Cell[]): { mark: Cell; text: string }[] => {
  const out: { mark: Cell; text: string }[] = []

  for (const cell of cells) {
    const last = out[out.length - 1]

    if (last !== undefined && last.mark === cell) last.text += cell
    else out.push({ mark: cell, text: cell })
  }

  return out
}

// ---------------------------------------------------------------- script

const tick = (text: string): string => text.replace(/`/g, "'")

/** The session as a Markdown script: a heading per scene, numbered steps with ✓ or ✗. */
export const script = (rec: Recording, title: string): string => {
  const sum = totals(rec)
  const lines = [`# ${title}`, '', `${plural(sum.scenes, 'scene')} · ${plural(sum.steps, 'step')} · ${sum.failed} failed`]

  rec.scenes.forEach((scene, s) => {
    lines.push('', `## Scene ${s + 1}: ${clip(scene.prompt, 60) || '(no prompt)'}`, '')
    lines.push(`> You: ${scene.prompt || '(no prompt)'}`, '')

    if (scene.steps.length === 0) lines.push('_No tool calls._')

    scene.steps.forEach((step, i) => {
      const mark = step.isRunning ? '…' : step.ok ? '✓' : '✗'
      const target = step.target === '' ? '' : ` \`${tick(step.target)}\``
      const agents = step.agentCalls > 0 ? `, ${plural(step.agentCalls, 'agent call')}` : ''
      const result = step.result === '' ? '' : `: ${step.result}`

      lines.push(`${i + 1}. ${mark} ${GLYPH[step.kind]} ${step.label}${target} (${took(step.durationMs)}${agents})${result}`)
    })

    if (scene.endedAt !== null) {
      lines.push('', `**Claude:** ${scene.aborted ? '(stopped) ' : ''}${scene.answer || '(no answer)'}`)
    }
  })

  return `${lines.join('\n')}\n`
}
