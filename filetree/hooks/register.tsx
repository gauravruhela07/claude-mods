import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Listing, Mark, Mode } from '../types'
import {
  MAX_ROWS,
  baseName,
  buildView,
  clip,
  clipStart,
  isIgnored,
  join,
  normalize,
  parents,
  relative,
  resolve,
  stronger,
  toListing,
} from './tree'
import type { Loose, Row } from './tree'

const PANE = 'filetree'
const TITLE = 'Files'
const USAGE = 'Use /filetree (open), /filetree touched, /filetree all, or /filetree close. Nothing changed.'
const TRACKED = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

const root = atom({ plugin: 'filetree', key: 'root' } as const, '')
const mode = atom({ plugin: 'filetree', key: 'mode' } as const, 'all')
const expanded = atom({ plugin: 'filetree', key: 'expanded' } as const, [])
const listings = atom({ plugin: 'filetree', key: 'listings' } as const, {})
const touched = atom({ plugin: 'filetree', key: 'touched' } as const, {})

type Engine = EngineInterface

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Lists one folder; a folder that cannot be listed comes back with its error. */
const fetchListing = async ($: Engine, top: string, rel: string): Promise<Listing> => {
  try {
    return toListing(await $.fs.list(join(top, rel)))
  } catch {
    return { entries: [], more: 0, error: 'Cannot list this folder' }
  }
}

/** Loads the listings of these folders that are not cached yet. */
const ensureLoaded = async ($: Engine, dirs: readonly string[]): Promise<void> => {
  const top = await read($, root)
  if (top === '') return
  const have = await read($, listings)
  const fresh: Record<string, Listing> = {}

  for (const rel of new Set(dirs)) {
    if (have[rel] === undefined && fresh[rel] === undefined) fresh[rel] = await fetchListing($, top, rel)
  }
  if (Object.keys(fresh).length > 0) await update($, listings, all => ({ ...all, ...fresh }))
}

/** Opens a closed folder (loading it the first time) or closes an open one. */
const toggle = async ($: Engine, rel: string): Promise<void> => {
  let isOpening = false

  await update($, expanded, list => {
    isOpening = !list.includes(rel)
    return isOpening ? [...list, rel] : list.filter(one => one !== rel)
  })
  if (isOpening) await ensureLoaded($, [rel])
}

/** Reloads the root and every open folder; other cached listings are dropped and load again when opened. */
const refresh = async ($: Engine): Promise<void> => {
  const top = await read($, root)
  if (top === '') return
  const open = await read($, expanded)
  const fresh: Record<string, Listing> = {}

  for (const rel of new Set(['', ...open])) fresh[rel] = await fetchListing($, top, rel)
  await update($, listings, () => fresh)
}

/** The mark a successful call leaves, or null when it left none (a Write held for review). */
const markOf = (tool: string, result: unknown, existed: boolean): Mark | null => {
  if (tool === 'Read') return 'R'
  if (tool !== 'Write') return 'M'

  const record = (typeof result === 'object' && result !== null ? result : {}) as { type?: unknown; staged?: unknown }

  if (record.staged === true) return null
  if (record.type === 'create') return 'A'
  if (record.type === 'update') return 'M'

  return existed ? 'M' : 'A'
}

// Folders to load after a touch, drained by the timer so tool calls never wait on a listing.
// Module state: a hot reload drops what was queued, and the folders load when next opened.
let queue: string[] = []
let isDraining = false

const drain = async ($: Engine): Promise<void> => {
  if (isDraining || queue.length === 0) return
  isDraining = true
  try {
    while (queue.length > 0) {
      const batch = queue
      queue = []
      await ensureLoaded($, batch)
    }
  } catch {
    // A failed load is retried the next time the folder is opened or refreshed.
  } finally {
    isDraining = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const top = normalize(e.cwd)
    let isMoved = false

    await update($, root, was => {
      isMoved = was !== top
      return top
    })
    if (isMoved) {
      await update($, listings, () => ({}))
      await update($, expanded, () => [])
    }
    await $.command.register({
      name: 'filetree',
      description: 'Show the project file tree, marking files Claude read (R), changed (M) or created (A)',
      argumentHint: '[touched|all|close]',
      immediate: true,
    })
    $.clock.every(250, () => void drain($))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      queue = []
      await update($, touched, () => ({}))
    }

    return next(e)
  })

  on('command.run', { command: 'filetree' }, async ($, e) => {
    const word = e.args.trim().toLowerCase()

    if (word !== '' && word !== 'touched' && word !== 'all' && word !== 'close') return { text: USAGE }

    if (word === 'close') {
      try {
        await $.ui.close({ id: PANE })
      } catch {
        return { text: 'The file tree stays open.' }
      }
      return { text: 'File tree closed.' }
    }

    if (word === 'touched' || word === 'all') {
      const wanted: Mode = word
      await update($, mode, () => wanted)
    }
    await ensureLoaded($, ['', ...(await read($, expanded))])

    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
    const shown = (await read($, mode)) === 'touched' ? 'only touched files' : 'all files'

    return {
      text: opened.isPlaced ? `File tree opened (${shown}).` : `File tree opened (${shown}); ${opened.reason}`,
    }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (!TRACKED.has(tool)) return next(e)

    const input = e as unknown as Record<string, unknown>
    const raw = text(input.file_path) || text(input.notebook_path)
    if (raw === '') return next(e)

    const top = await read($, root)
    const path = resolve(top, raw)
    const existed = tool === 'Write' ? await $.fs.stat(path).then(() => true, () => false) : true
    const ran = await next(e)

    if (ran.deny !== undefined || ran.isError === true) return ran
    const mark = markOf(tool, ran.result, existed)
    if (mark === null) return ran

    await update($, touched, all => ({ ...all, [path]: stronger(all[path], mark) }))

    const rel = relative(top, path)
    if (rel !== undefined && rel !== '' && !isIgnored(rel)) {
      const dirs = parents(rel)
      const open = await read($, expanded)
      const missing = dirs.filter(dir => !open.includes(dir))

      if (missing.length > 0) {
        await update($, expanded, list => [...list, ...missing.filter(dir => !list.includes(dir))])
      }
      queue.push('', ...dirs)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const top = await read($, root)
    const shown = await read($, mode)
    const view = buildView(
      top,
      shown,
      await read($, expanded),
      await read($, listings),
      await read($, touched),
      MAX_ROWS,
    )
    const width = Math.max(20, e.props.bodyColumns)

    const tone = (mark: Mark | null) =>
      mark === 'M' ? { color: 'warning' } : mark === 'A' ? { color: 'success' } : mark === 'R' ? { dimColor: true } : {}

    const line = (row: Row) => {
      const pad = row.depth * 2
      const room = Math.max(4, width - pad - 2)

      if (row.kind === 'dir') {
        const tail = row.count > 0 ? ` ${row.count}` : ''

        return (
          <Box key={row.key} flexDirection="row" paddingLeft={pad}>
            <Button
              key={`dir:${row.rel}`}
              plain
              label={`${row.isOpen ? '▾' : '▸'} ${clip(`${row.name}/`, room - tail.length)}`}
              onPress={() => toggle($, row.rel)}
            />
            {tail !== '' && <Text color="warning">{tail}</Text>}
          </Box>
        )
      }

      if (row.kind === 'file') {
        return (
          <Box key={row.key} flexDirection="row" paddingLeft={pad}>
            <Text {...tone(row.mark)} bold={row.mark === 'M' || row.mark === 'A'}>
              {row.mark ?? ' '}{' '}
            </Text>
            <Text {...tone(row.mark)} wrap="truncate-end">
              {clip(row.name, room)}
            </Text>
          </Box>
        )
      }

      return (
        <Box key={row.key} flexDirection="row" paddingLeft={pad + 2}>
          <Text dimColor wrap="truncate-end">
            {clip(row.text, Math.max(4, width - pad - 2))}
          </Text>
        </Box>
      )
    }

    const group = (key: string, title: string, list: Loose[]) =>
      list.length === 0 ? null : (
        <Box key={key} flexDirection="column" marginTop={1}>
          <Text bold dimColor>
            {clip(`${title} (${list.length})`, width)}
          </Text>
          {list.map(one => (
            <Box key={`${key}:${one.path}`} flexDirection="row">
              <Text {...tone(one.mark)} bold={one.mark !== 'R'}>
                {one.mark}{' '}
              </Text>
              <Text {...tone(one.mark)} wrap="truncate-start">
                {clipStart(one.path, width - 2)}
              </Text>
            </Box>
          ))}
        </Box>
      )

    const counts = ` · ${view.changed} changed · ${view.added} new · ${view.read} read`
    const name = clip(baseName(top) || 'project', Math.max(6, width - counts.length))
    const isEmpty = view.rows.length === 0

    return (
      <Box flexDirection="column">
        <Box key="header" flexDirection="row">
          <Text bold>{name}</Text>
          <Text dimColor wrap="truncate-end">
            {clip(counts, Math.max(0, width - name.length))}
          </Text>
        </Box>
        <Box key="actions" flexDirection="row" flexWrap="wrap" columnGap={1} marginBottom={1}>
          <Button
            key="mode"
            label={shown === 'all' ? 'Only touched' : 'Show all'}
            onPress={() => update($, mode, was => (was === 'all' ? 'touched' : 'all'))}
          />
          <Button key="collapse" label="Collapse all" onPress={() => update($, expanded, () => [])} />
          <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
        </Box>
        {top === '' && <Text dimColor>Waiting for the session to start…</Text>}
        {top !== '' && isEmpty && shown === 'touched' && (
          <Text dimColor>{clip('Nothing in the project touched yet.', width)}</Text>
        )}
        {view.rows.map(line)}
        {view.isCut && <Text dimColor>{clip(`… stopped at ${MAX_ROWS} rows; collapse some folders`, width)}</Text>}
        {group('outside', 'Outside project', view.outside)}
        {group('ignored', 'In ignored folders', view.ignored)}
      </Box>
    )
  })
}
