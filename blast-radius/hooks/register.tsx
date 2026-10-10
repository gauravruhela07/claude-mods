import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Blast, View } from '../types'
import {
  EDIT_TOOLS,
  HUGE,
  LISTED,
  MAX_KEPT,
  MAX_RISKY,
  WIDE,
  absolute,
  baseName,
  classify,
  clip,
  clipPath,
  clock,
  dependentPattern,
  grepArgv,
  headline,
  inside,
  moduleRefs,
  parseHits,
  plural,
  rgArgv,
  statusLine,
} from './blast'

const PANE = 'blast-radius'
const TITLE = 'Blast radius'
const USAGE = 'Usage: /blast-radius [session|turn|clear] (no words: this turn). Nothing changed.'
const SEARCH_MS = 3000
const TICK_MS = 500

const root = atom({ plugin: 'blast-radius', key: 'root' } as const, '')
const turn = atom({ plugin: 'blast-radius', key: 'turn' } as const, 0)
const files = atom({ plugin: 'blast-radius', key: 'files' } as const, [])
const turnPaths = atom({ plugin: 'blast-radius', key: 'turnPaths' } as const, [])
const risky = atom({ plugin: 'blast-radius', key: 'risky' } as const, [])
const queue = atom({ plugin: 'blast-radius', key: 'queue' } as const, [])
const toasted = atom({ plugin: 'blast-radius', key: 'toasted' } as const, [])
const view = atom({ plugin: 'blast-radius', key: 'view' } as const, 'turn')
const shown = atom({ plugin: 'blast-radius', key: 'shown' } as const, [])

type $ = EngineInterface

// One search at a time: a tick that finds one running leaves the queue to it.
// Module variables: a reload drops them with the old timers, and the queue in $.state carries on.
let isBusy = false
// Set when something may wait in the queue, so an idle tick costs no state read (true at load: look once).
let isQueued = true

const str = (input: Record<string, unknown>, key: string): string => {
  const value = input[key]

  return typeof value === 'string' ? value : ''
}

const isBlast = (file: Blast | undefined): file is Blast => file !== undefined

/** This turn's edited files, in the order they were first edited. */
const turnFiles = (all: readonly Blast[], paths: readonly string[]): Blast[] =>
  paths.map(path => all.find(file => file.path === path)).filter(isBlast)

/** Pins (or clears) the status line from this turn's edits. */
const refreshStatus = async ($: $): Promise<void> => {
  const all = await read($, files)
  const paths = await read($, turnPaths)

  $.ui.status(statusLine(turnFiles(all, paths)))
}

/** The project root: the session's cwd from session.start, asked again if that has not run. */
const rootOf = async ($: $): Promise<string> => {
  const known = await read($, root)
  if (known !== '') return known
  const cwd = await $.session.cwd().catch(() => '')
  if (cwd !== '') await update($, root, () => cwd)

  return cwd
}

/** Records a successful edit at once; the dependent search waits on the queue. */
const noteEdit = async ($: $, given: string): Promise<void> => {
  const base = await rootOf($)
  const path = absolute(base, given)
  const rel = inside(base, path)
  const now = await $.clock.now()
  const current = await read($, turn)
  let needsSearch = false

  await update($, files, list => {
    const was = list.find(file => file.path === path)
    const isCached = was !== undefined && was.searchedTurn === current && was.status !== 'failed'
    needsSearch = rel !== undefined && !isCached
    const status = rel === undefined ? 'outside' : isCached ? was.status : 'pending'
    const next: Blast = {
      path,
      rel: rel ?? path,
      status,
      count: was?.count ?? 0,
      dependents: was?.dependents ?? [],
      searchedTurn: current,
      edits: (was?.edits ?? 0) + 1,
      editedAt: now,
    }

    return was === undefined ? [...list, next] : list.map(file => (file.path === path ? next : file))
  })
  await update($, turnPaths, list => (list.includes(path) ? list : [...list, path]))
  if (needsSearch) {
    await update($, queue, list => (list.includes(path) ? list : [...list, path]))
    isQueued = true
  }
  await refreshStatus($)
}

/** Records a wide-reaching shell command and says so once. */
const noteRisky = async ($: $, command: string, reason: string): Promise<void> => {
  const now = await $.clock.now()
  const current = await read($, turn)

  await update($, risky, list => [...list, { command: clip(command, 200), reason, at: now, turn: current }].slice(-MAX_RISKY))
  $.ui.toast(`Risky command ran: ${clip(command, 80)}`)
}

/** Runs one search command; the files it printed, or undefined when it failed. */
const runSearch = async ($: $, argv: string[], cwd: string): Promise<string | undefined> => {
  try {
    const ran = await $.process.run(argv, { cwd, timeoutMs: SEARCH_MS })
    // 0: matches, 1: none; anything else is an error unless it still printed files.
    if (ran.exitCode === 0 || ran.exitCode === 1 || ran.stdout.trim() !== '') return ran.exitCode === 1 ? '' : ran.stdout

    return undefined
  } catch {
    return undefined
  }
}

/** Finds the files that reference one edited file's module, rg first, grep when rg fails. */
const searchOne = async ($: $, path: string): Promise<void> => {
  const base = await read($, root)
  const pattern = dependentPattern(moduleRefs(path))
  let hits: string[] | undefined = []

  if (pattern !== undefined && base !== '') {
    const out = (await runSearch($, rgArgv(pattern, base), base)) ?? (await runSearch($, grepArgv(pattern, base), base))
    hits = out === undefined ? undefined : parseHits(out, base, path)
  }

  let found: Blast | undefined
  await update($, files, list =>
    list.map(file => {
      if (file.path !== path) return file
      found =
        hits === undefined
          ? { ...file, status: 'failed' }
          : { ...file, status: 'done', count: hits.length, dependents: hits.slice(0, MAX_KEPT) }

      return found
    }),
  )
  await update($, queue, list => list.filter(one => one !== path))

  if (found !== undefined && found.status === 'done' && found.count >= WIDE) {
    let isNew = false
    await update($, toasted, list => {
      isNew = !list.includes(path)

      return isNew ? [...list, path] : list
    })
    if (isNew) $.ui.toast(`Wide blast: ${baseName(path)} is used by ${plural(found.count, 'file')}`)
  }
  await refreshStatus($)
}

/** Works through the search queue, one search after another, off any hook's answer. */
const drain = async ($: $): Promise<void> => {
  if (isBusy || !isQueued) return
  isBusy = true
  try {
    for (let guard = 0; guard < 500; guard += 1) {
      isQueued = false
      const [head] = await read($, queue)
      if (head === undefined) return
      await searchOne($, head)
    }
    isQueued = true
  } catch {
    // Show only: a failed search leaves the row as it was; the next tick tries the queue again.
    isQueued = true
  } finally {
    isBusy = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await update($, root, () => e.cwd)
    // The queue's timer: searches run here, never inside a tool call's answer.
    $.clock.every(TICK_MS, () => {
      void drain($)
    })
    await refreshStatus($)
    await $.command.register({
      name: 'blast-radius',
      description: 'Show the files that depend on what Claude edited, and risky shell commands',
      argumentHint: '[session|turn|clear]',
      immediate: true,
    })

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, turn, n => n + 1)
    await update($, turnPaths, () => [])
    await update($, toasted, () => [])
    $.ui.status(undefined)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)

    try {
      if (e.agentId !== undefined || ran.deny !== undefined) return ran
      const tool = String(e.tool)
      const input = e as unknown as Record<string, unknown>

      if (EDIT_TOOLS.has(tool)) {
        const path = str(input, 'file_path') || str(input, 'notebook_path')
        if (ran.isError !== true && path !== '') await noteEdit($, path)
      } else if (tool === 'Bash') {
        const command = str(input, 'command')
        const reason = classify(command)
        if (reason !== undefined) await noteRisky($, command, reason)
      }
    } catch {
      // Show only: bookkeeping never touches the tool's result.
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'blast-radius' }, async ($, e) => {
    const words = e.args.trim().toLowerCase().split(/\s+/).filter(word => word !== '')
    const word = words.length === 0 ? 'turn' : words.length === 1 ? words[0] : undefined

    if (word === 'clear') {
      await update($, files, () => [])
      await update($, turnPaths, () => [])
      await update($, risky, () => [])
      await update($, queue, () => [])
      await update($, toasted, () => [])
      await update($, shown, () => [])
      $.ui.status(undefined)

      return { text: 'Blast radius cleared: no edited files or risky commands recorded.' }
    }
    if (word !== 'turn' && word !== 'session') return { text: USAGE }

    const mode: View = word
    await update($, view, () => mode)
    const opened = await $.ui.open({ id: PANE, title: TITLE }).catch((error: unknown) => ({ isPlaced: false as const, reason: String(error) }))
    const all = await read($, files)
    const current = await read($, turn)
    const commands = await read($, risky)
    const list = mode === 'turn' ? turnFiles(all, await read($, turnPaths)) : all
    const ran = mode === 'turn' ? commands.filter(one => one.turn === current) : commands
    const where = opened.isPlaced ? '' : ` (the pane waits: ${opened.reason})`

    return { text: `Blast radius, ${mode === 'turn' ? 'this turn' : 'this session'}: ${headline(list, ran)}${where}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(24, e.props.bodyColumns)
    const mode = await read($, view)
    const all = await read($, files)
    const paths = await read($, turnPaths)
    const current = await read($, turn)
    const commands = await read($, risky)
    const open = await read($, shown)
    const list = mode === 'turn' ? turnFiles(all, paths) : all
    const ran = mode === 'turn' ? commands.filter(one => one.turn === current) : commands
    const label = mode === 'turn' ? 'This turn' : 'This session'
    const rows = []

    rows.push(
      <Box key="header" flexDirection="column">
        <Text bold wrap="wrap">{`${label}: ${headline(list, ran)}`}</Text>
        <Text dimColor>{clip(mode === 'turn' ? '/blast-radius session shows every edit this session' : '/blast-radius shows this turn only', width)}</Text>
      </Box>,
    )

    if (list.length === 0) {
      rows.push(
        <Box key="none" flexDirection="column">
          <Text dimColor>{mode === 'turn' ? 'No files edited this turn.' : 'No files edited this session.'}</Text>
        </Box>,
      )
    }

    for (const file of list) {
      const isOpen = open.includes(file.path)
      const canShow = file.status === 'done' && file.count > 0
      const what =
        file.status === 'pending'
          ? 'searching…'
          : file.status === 'failed'
            ? 'search failed'
            : file.status === 'outside'
              ? 'outside project'
              : plural(file.count, 'dependent')
      const color =
        file.status !== 'done' ? undefined : file.count >= HUGE ? 'error' : file.count >= WIDE ? 'warning' : undefined
      // The terminal draws the Button as "[ Show ]": 8 cells, after one cell of space.
      const room = Math.max(4, width - what.length - 1 - (canShow ? 9 : 0))

      rows.push(
        <Box key={`row:${file.rel}`} flexDirection="row">
          <Text>{clipPath(file.rel, room).padEnd(room)} </Text>
          {color === undefined ? (
            <Text dimColor={file.status !== 'done'}>{what}</Text>
          ) : (
            <Text color={color} bold={color === 'error'}>
              {what}
            </Text>
          )}
          {canShow && <Text> </Text>}
          {canShow && (
            <Button
              key={`show:${file.rel}`}
              label={isOpen ? 'Hide' : 'Show'}
              onPress={() => {
                void update($, shown, was => (was.includes(file.path) ? was.filter(one => one !== file.path) : [...was, file.path]))
              }}
            />
          )}
        </Box>,
      )

      if (isOpen && canShow) {
        const listed = file.dependents.slice(0, LISTED)
        const more = file.count - listed.length

        rows.push(
          <Box key={`deps:${file.rel}`} flexDirection="column" paddingLeft={2}>
            {listed.map(one => (
              <Text dimColor>{clipPath(one, width - 2)}</Text>
            ))}
            {more > 0 && <Text dimColor>{`… ${more} more`}</Text>}
          </Box>,
        )
      }
    }

    rows.push(
      <Box key="risky" flexDirection="column" marginTop={1}>
        <Text bold>Risky commands</Text>
        {ran.length === 0 && <Text dimColor>{mode === 'turn' ? 'None this turn.' : 'None this session.'}</Text>}
      </Box>,
    )

    ran.forEach((one, i) => {
      const time = clock(one.at)
      const room = Math.max(4, width - one.reason.length - time.length - 5)

      rows.push(
        <Box key={`risky:${i}`} flexDirection="row">
          <Text color="warning">{one.reason}</Text>
          <Text dimColor> · </Text>
          <Text>{clip(one.command, room)}</Text>
          <Text dimColor> {time}</Text>
        </Box>,
      )
    })

    return <Box flexDirection="column">{rows}</Box>
  })
}
