import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Task } from '../types'
import { bar, clip, describe, duration, isPlanTool, plural, replan, started } from './format'

const live = atom({ plugin: 'savvy-progress', key: 'live' } as const, null)
const tasks = atom({ plugin: 'savvy-progress', key: 'tasks' } as const, [])
const now = atom({ plugin: 'savvy-progress', key: 'now' } as const, 0)
const last = atom({ plugin: 'savvy-progress', key: 'last' } as const, null)
const isHidden = atom({ plugin: 'savvy-progress', key: 'isHidden' } as const, false)

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SLOW_MS = 30_000
const LONG_TURN_MS = 60_000

const isDone = (task: Task) => task.status === 'completed'

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
      const stats = clip(parts.join(' · '), width)

      rows.push(
        <Box key="stats" flexDirection="row">
          <Text dimColor>{stats}</Text>
          {turn.errors > 0 && <Text color="error"> · {plural(turn.errors, 'error')}</Text>}
        </Box>,
      )
    }

    if (isPlanOpen) {
      const total = plan.length
      const finished = plan.filter(isDone).length
      const doing = plan.find(task => task.status === 'in_progress') ?? plan.find(task => !isDone(task))
      const doneNow = turn === null ? 0 : finished - turn.tasksDoneAtStart
      const left = total - finished
      const eta =
        turn !== null && doneNow > 0 && left > 0
          ? ` · ~${duration(((t - turn.startedAt) / doneNow) * left)} left`
          : ''
      const width2 = Math.min(20, Math.max(8, Math.floor(width / 5)))
      const head = `${bar(finished, total, width2)} ${finished}/${total}`
      const what = doing === undefined ? '' : doing.activeForm || doing.subject

      rows.push(
        <Box key="tasks" flexDirection="row">
          <Text color="success">{head}</Text>
          <Text> {clip(what, width - head.length - eta.length - 2)}</Text>
          <Text dimColor>{eta}</Text>
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
