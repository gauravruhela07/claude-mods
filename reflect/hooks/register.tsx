import { atom, read, update } from 'claude-code'
import type { ModelForkResult, Register, UiPressArgument } from 'claude-code'

import type { Reflection } from '../types'
import { clockTime, cost, failure, followUps, reflectPrompt, toUsage } from './text'

const PANE = 'reflect'
const TITLE = 'Reflect'
const KEEP = 5
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const USAGE = 'Use /reflect [focus words], /reflect show, or /reflect auto [on|off]. Nothing changed.'

const reflections = atom({ plugin: 'reflect', key: 'reflections' } as const, [])
const shown = atom({ plugin: 'reflect', key: 'shown' } as const, null)
const isAuto = atom({ plugin: 'reflect', key: 'isAuto' } as const, false)
const hasEdited = atom({ plugin: 'reflect', key: 'hasEdited' } as const, false)

/** The next reflection, running, after the ones in `list`. */
const nextReflection = (list: readonly Reflection[], at: number, focus: string, origin: Reflection['origin']): Reflection => ({
  id: (list[list.length - 1]?.id ?? 0) + 1,
  at,
  focus,
  origin,
  status: 'running',
  markdown: '',
  error: '',
  usage: null,
})

const isRunning = (list: readonly Reflection[]) => list.some(one => one.status === 'running')

export const register: Register = on => {
  // Set in session.start: runs a reflection's fork from a timer of the session's own `$`,
  // so no hook's dispatch waits on the model.
  let runFork: ((job: Reflection) => void) | undefined

  on('session.start', async ($, e, next) => {
    runFork = job => {
      $.clock.after(0, async () => {
        let r: ModelForkResult | undefined
        let thrown = ''
        try {
          r = await $.model.fork({ prompt: reflectPrompt(job.focus) })
        } catch (err) {
          thrown = `Could not run the reflection: ${err instanceof Error ? err.message : String(err)}`
        }
        const text = r?.isAnswered === true ? r.text.trim() : ''
        const isDone = text !== ''
        const error =
          r === undefined
            ? thrown
            : r.isAnswered
              ? isDone
                ? ''
                : 'The model replied without any text. Run /reflect to try again.'
              : failure(r)
        const usage = r === undefined ? null : toUsage(r)

        await update($, reflections, list =>
          list.map(
            (one): Reflection =>
              one.id === job.id ? { ...one, status: isDone ? 'done' : 'failed', markdown: text, error, usage } : one,
          ),
        )
        if (job.origin === 'auto') {
          $.ui.toast(isDone ? 'Reflection ready — /reflect show' : 'Reflection failed — /reflect show')
        }
      })
    }

    await $.command.register({
      name: 'reflect',
      description: 'Claude critiques its own recent work: what may be wrong or missed, and what to check next',
      argumentHint: '[focus words | show | auto [on|off]]',
      immediate: true,
    })
    const stored = await $.store.get('auto')
    await update($, isAuto, () => stored === true)
    // A reload drops a fork in flight with the old environment: say so rather than spin forever.
    await update($, reflections, list =>
      list.map(
        (one): Reflection =>
          one.status === 'running'
            ? { ...one, status: 'failed', error: 'Stopped by a reload of the mod. Run /reflect to try again.' }
            : one,
      ),
    )

    return next(e)
  })

  on('command.run', { command: 'reflect' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(word => word !== '')
    const first = (words[0] ?? '').toLowerCase()

    if (first === 'auto') {
      const arg = words.slice(1).join(' ').toLowerCase()
      if (arg !== '' && arg !== 'on' && arg !== 'off') return { text: USAGE }

      let isOn = false
      await update($, isAuto, was => (isOn = arg === '' ? !was : arg === 'on'))
      await $.store.set('auto', isOn)

      return {
        text: isOn
          ? 'Auto-reflect is on: after a turn that edits files, Claude reflects in the background (this uses tokens). /reflect show opens it.'
          : 'Auto-reflect is off.',
      }
    }

    if (words.length === 1 && first === 'show') {
      await update($, shown, () => null)
      await $.ui.open({ id: PANE, title: TITLE })
      const list = await read($, reflections)

      return { text: list.length === 0 ? 'No reflection yet. Run /reflect to make one.' : 'Opened the newest reflection.' }
    }

    const focus = words.join(' ')
    const list = await read($, reflections)
    const isBusy = isRunning(list)

    if (!isBusy) {
      const job = nextReflection(list, await $.clock.now(), focus, 'command')
      await update($, reflections, was => [...was, job].slice(-KEEP))
      if (runFork === undefined) {
        await update($, reflections, was =>
          was.map(
            (one): Reflection =>
              one.id === job.id ? { ...one, status: 'failed', error: 'Reflect is still starting. Run /reflect again in a moment.' } : one,
          ),
        )
      } else {
        runFork(job)
      }
    }
    await update($, shown, () => null)
    await $.ui.open({ id: PANE, title: TITLE })

    if (isBusy) return { text: 'A reflection is already running; it shows in the Reflect pane.' }

    return { text: focus === '' ? 'Reflecting on the recent work…' : `Reflecting on the recent work (focus: ${focus})…` }
  })

  on('turn.start', async ($, e, next) => {
    await update($, hasEdited, () => false)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const isEdit = e.agentId === undefined && EDIT_TOOLS.has(String(e.tool))

    if (isEdit && ran.deny === undefined && ran.isError !== true && !(await read($, hasEdited))) {
      await update($, hasEdited, () => true)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    const isEdited = await read($, hasEdited)
    if (isEdited) await update($, hasEdited, () => false)
    if (isEdited && !e.isAborted && runFork !== undefined && (await read($, isAuto))) {
      const list = await read($, reflections)
      const newest = list[list.length - 1]

      if (!isRunning(list)) {
        const job = nextReflection(list, await $.clock.now(), '', 'auto')
        // Keep the pane on what the person reads; /reflect show jumps to the new one.
        if (newest !== undefined && (await read($, shown)) === null) await update($, shown, () => newest.id)
        await update($, reflections, was => [...was, job].slice(-KEEP))
        runFork(job)
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const list = await read($, reflections)
    const pick = await read($, shown)
    const auto = await read($, isAuto)
    const width = Math.max(20, e.props.bodyColumns)

    const found = pick === null ? -1 : list.findIndex(one => one.id === pick)
    const at = found < 0 ? list.length - 1 : found
    const r = list[at]

    const close = () => $.ui.close({ id: PANE })
    const footer = (
      <Box key="footer">
        <Text dimColor wrap="wrap">
          Auto-reflect after edits: {auto ? 'on' : 'off'} · /reflect auto
        </Text>
      </Box>
    )

    if (r === undefined) {
      return (
        <Box flexDirection="column" width={width} gap={1}>
          <Box key="body">
            <Text wrap="wrap">No reflection yet. Run /reflect (optionally with focus words) to make one.</Text>
          </Box>
          <Box key="actions" flexDirection="row">
            <Button key="close" label="Close" hotkey="x" role="dismiss" onPress={close} />
          </Box>
          {footer}
        </Box>
      )
    }

    const parts = [`Reflection ${at + 1} of ${list.length}`, clockTime(r.at)]
    if (r.status === 'running') parts.push('running')
    if (r.usage !== null) parts.push(cost(r.usage))
    if (r.origin === 'auto') parts.push('auto')
    const head = parts.join(' · ')

    const fix = async (press: UiPressArgument) => {
      const text = followUps(r.markdown)
      const box = await $.prompt.read()
      const isEmpty = box.text.trim() === ''
      const filled = await $.prompt.fill(isEmpty ? { text, mode: 'replace' } : { text: `\n\n${text}`, mode: 'append' })
      if (filled.isFilled) {
        $.ui.toast('The follow-ups are in the prompt box: edit them, then press Enter.')
        return
      }
      const copied = await $.ui.copy({ text, surface: press.surface })
      $.ui.toast(
        copied.isCopied
          ? 'The prompt box could not take the follow-ups, so they were copied: paste them in.'
          : 'The prompt box could not take the follow-ups.',
      )
    }

    const copy = async (press: UiPressArgument) => {
      const copied = await $.ui.copy({ text: r.markdown, surface: press.surface })
      $.ui.toast(copied.isCopied ? 'Reflection copied.' : 'Could not copy the reflection.')
    }

    const older = list[at - 1]
    const newer = list[at + 1]
    const isLast = at + 1 === list.length - 1

    return (
      <Box flexDirection="column" width={width} gap={1}>
        <Box key="header" flexDirection="column">
          <Text bold wrap="truncate-end">
            {head}
          </Text>
          {r.focus !== '' && (
            <Text dimColor wrap="truncate-end">
              Focus: {r.focus}
            </Text>
          )}
        </Box>
        {r.status === 'running' && (
          <Box key="body">
            <Text color="claude">Reflecting…</Text>
          </Box>
        )}
        {r.status === 'done' && <Markdown key="body" text={r.markdown} />}
        {r.status === 'failed' && (
          <Box key="body">
            <Text color="warning" wrap="wrap">
              {r.error}
            </Text>
          </Box>
        )}
        <Box key="actions" flexDirection="row" flexWrap="wrap" columnGap={1}>
          {r.status === 'done' && (
            <Button key="fix" label="Ask Claude to fix these" hotkey="f" variant="primary" onPress={fix} />
          )}
          {r.status === 'done' && <Button key="copy" label="Copy" hotkey="c" onPress={copy} />}
          {older !== undefined && (
            <Button key="older" label="← Older" hotkey="o" onPress={() => update($, shown, () => older.id)} />
          )}
          {newer !== undefined && (
            <Button
              key="newer"
              label="Newer →"
              hotkey="n"
              onPress={() => update($, shown, () => (isLast ? null : newer.id))}
            />
          )}
          <Button key="close" label="Close" hotkey="x" role="dismiss" onPress={close} />
        </Box>
        {footer}
      </Box>
    )
  })
}
