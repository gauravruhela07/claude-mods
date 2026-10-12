import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Task } from '../types'
import { bar, clip, describe, duration, guess, isPlanTool, plural, remember, replan, savedDurations, started } from './format'

const live = atom({ plugin: 'savvy-progress', key: 'live' } as const, null)
const tasks = atom({ plugin: 'savvy-progress', key: 'tasks' } as const, [])
const now = atom({ plugin: 'savvy-progress', key: 'now' } as const, 0)
const last = atom({ plugin: 'savvy-progress', key: 'last' } as const, null)
const isHidden = atom({ plugin: 'savvy-progress', key: 'isHidden' } as const, false)
const durations = atom({ plugin: 'savvy-progress', key: 'durations' } as const, [])

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SLOW_MS = 30_000
const LONG_TURN_MS = 60_000

const isDone = (task: Task) => task.status === 'completed'
const barWidth = (width: number) => Math.min(20, Math.max(8, Math.floor(width / 5)))

export const register: Register = on => {
  // The 1s tick only writes while a turn runs; a reload resets it, and the next tool call sets it again.
  let isTicking = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'savvy-progress',
      description: 'Show or hide the savvy progress band',
      argumentHint: '[on|off]',
      immediate: true,
    })
    const saved = savedDurations(await $.store.get('durations').catch(() => undefined))
    await update($, durations, () => saved)
    $.clock.every(1000, async () => {
      if (!isTicking) return
      const t = await $.clock.now()
      await update($, now, () => t)
    })

    return next(e)
  })

  on('command.run', { command: 'savvy-progress' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const wants = ['on', 'show'].includes(arg) ? false : ['off', 'hide'].includes(arg) ? true : undefined

    if (arg !== '' && wants === undefined) {
      return { text: 'Use /savvy-progress (toggle), /savvy-progress on, or /savvy-progress off. Nothing changed.' }
    }

    let hidden = false
    await update($, isHidden, was => (hidden = wants ?? !was))

    return { text: hidden ? 'Savvy progress band hidden.' : 'Savvy progress band shown.' }
  })

  on('turn.start', async ($, e, next) => {
    const t = await $.clock.now()
    const list = await read($, tasks)
    const isPlanDone = list.length > 0 && list.every(isDone)

    if (isPlanDone) await update($, tasks, () => [])
    await update($, now, () => t)
    await update($, live, () => ({
      startedAt: t,
      steps: 0,
      reads: 0,
      edits: 0,
      commands: 0,
      agentSteps: 0,
      errors: 0,
      files: [],
      running: [],
      tasksDoneAtStart: isPlanDone ? 0 : list.filter(isDone).length,
    }))
    isTicking = true

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const isMain = e.agentId === undefined
    const id = e.tool_use_id
    const t = await $.clock.now()
    const act = { id, label: describe(tool, input), since: t }

    await update($, live, was => (was === null ? null : started(was, tool, input, act, isMain)))
    isTicking = true

    const ran = await next(e)
    const isOk = ran.deny === undefined && ran.isError !== true

    await update($, live, was =>
      was === null
        ? null
        : {
            ...was,
            errors: was.errors + (isMain && ran.isError === true ? 1 : 0),
            running: was.running.filter(one => one.id !== id),
          },
    )
    if (isOk && isPlanTool(tool)) {
      await update($, tasks, list => replan(list, tool, input, ran.result))
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    isTicking = false
    const turn = await read($, live)

    if (turn !== null) {
      await update($, last, () => ({
        durationMs: e.durationMs,
        steps: turn.steps,
        files: turn.files.length,
        errors: turn.errors,
        isAborted: e.isAborted,
      }))
      if (e.reason === 'answer' && !e.isAborted) {
        const list = remember(await read($, durations), e.durationMs)
        await update($, durations, () => list)
        await $.store.set('durations', list).catch(() => undefined)
      }
      if (e.durationMs >= LONG_TURN_MS && !e.isAborted) {
        $.ui.toast(`Done in ${duration(e.durationMs)} · ${plural(turn.steps, 'step')}`)
      }
    }
    await update($, live, () => null)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) return next(e)
    if (await read($, isHidden)) return next(e)

    const turn = await read($, live)
    const plan = await read($, tasks)
    const done = await read($, last)
    const t = await read($, now)
    const history = await read($, durations)
    const isPlanOpen = plan.length > 0 && !plan.every(isDone)

    if (turn === null && !isPlanOpen && done === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns)
    const rows = []

    if (turn !== null) {
      const elapsed = Math.max(0, t - turn.startedAt)
      const current = turn.running[turn.running.length - 1]
      const age = current === undefined ? 0 : Math.max(0, t - current.since)
      const isSlow = age >= SLOW_MS
      const more = turn.running.length > 1 ? ` +${turn.running.length - 1} more` : ''
      const after = current === undefined ? '' : ` · ${isSlow ? 'still going, ' : ''}${duration(age)}${more}`
      const label = current === undefined ? 'Thinking…' : current.label
      const spin = SPINNER[Math.floor(t / 1000) % SPINNER.length] ?? '•'

      rows.push(
        <Box key="now" flexDirection="row">
          <Text color="claude">{spin} </Text>
          <Text bold>{clip(label, width - 3 - after.length)}</Text>
          <Text color={isSlow ? 'warning' : 'subtle'}>{after}</Text>
        </Box>,
      )

      const parts = [duration(elapsed), plural(turn.steps, 'step')]
      if (turn.reads > 0) parts.push(`${turn.reads} read`)
      if (turn.files.length > 0) parts.push(`${plural(turn.files.length, 'file')} changed`)
      if (turn.commands > 0) parts.push(plural(turn.commands, 'command'))
      if (turn.agentSteps > 0) parts.push(`${turn.agentSteps} by agents`)

      // The bar shares line 2 with the counts: some surfaces show the band only two lines tall.
      // A task list gives a real bar; without one, a bar from how long past turns took, said to be a guess.
      let head: string
      let note: string
      let color: 'success' | 'claude' | 'warning'

      if (isPlanOpen) {
        const total = plan.length
        const finished = plan.filter(isDone).length
        const doneNow = finished - turn.tasksDoneAtStart
        const left = total - finished
        head = `${bar(finished, total, barWidth(width))} ${finished}/${total}`
        note = doneNow > 0 && left > 0 ? `~${duration((elapsed / doneNow) * left)} left` : 'tasks'
        color = 'success'
      } else {
        const est = guess(history, elapsed)
        const percent = Math.min(97, Math.floor((elapsed / Math.max(1, est.totalMs)) * 100))
        head = `${bar(percent, 100, barWidth(width))} ${percent}%`
        note = est.isLonger
          ? 'longer than usual'
          : `~${duration(est.totalMs - elapsed)} left (${est.isLearning ? 'rough guess' : 'guess'})`
        color = est.isLonger ? 'warning' : 'claude'
      }

      const errors = turn.errors > 0 ? ` · ${plural(turn.errors, 'error')}` : ''
      const stats = clip(` · ${parts.join(' · ')}`, Math.max(0, width - head.length - note.length - 1 - errors.length))

      rows.push(
        <Box key="progress" flexDirection="row">
          <Text color={color}>{head}</Text>
          <Text> {note}</Text>
          {stats !== '' && <Text dimColor>{stats}</Text>}
          {errors !== '' && <Text color="error">{errors}</Text>}
        </Box>,
      )
    } else if (isPlanOpen) {
      const total = plan.length
      const finished = plan.filter(isDone).length
      const doing = plan.find(task => task.status === 'in_progress') ?? plan.find(task => !isDone(task))
      const head = `${bar(finished, total, barWidth(width))} ${finished}/${total}`
      const what = doing === undefined ? '' : doing.activeForm || doing.subject

      rows.push(
        <Box key="tasks" flexDirection="row">
          <Text color="success">{head}</Text>
          <Text> {clip(what, width - head.length - 1)}</Text>
        </Box>,
      )
    }

    if (turn === null && done !== null) {
      const mark = done.isAborted ? '■ Stopped after' : '✓ Done in'
      const parts = [`${mark} ${duration(done.durationMs)}`, plural(done.steps, 'step')]
      if (done.files > 0) parts.push(`${plural(done.files, 'file')} changed`)
      if (done.errors > 0) parts.push(plural(done.errors, 'error'))

      rows.push(
        <Box key="last" flexDirection="row">
          <Text dimColor>{clip(parts.join(' · '), width)}</Text>
        </Box>,
      )
    }

    return <Box flexDirection="column">{rows}</Box>
  })
}
