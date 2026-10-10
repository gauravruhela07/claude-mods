import type { Entry, Listing, Mark, Mode } from '../types'

/** Entries kept per folder listing; the rest is a "… N more" row. */
export const CAP = 200

/** Rows drawn at most, so a huge expanded tree stays light. */
export const MAX_ROWS = 1500

/** Names never shown as tree rows. */
export const IGNORED = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.venv',
  'target',
  '.DS_Store',
])

const DRIVE = /^[A-Za-z]:\//

/** Forward slashes, no empty, `.` or `..` segments; keeps a leading `/` or `C:/`. */
export const normalize = (path: string): string => {
  const slashed = path.replace(/\\/g, '/')
  const prefix = DRIVE.test(slashed) ? slashed.slice(0, 3) : slashed.startsWith('/') ? '/' : ''
  const parts: string[] = []

  for (const seg of slashed.slice(prefix.length).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
      else if (prefix === '') parts.push('..')
      continue
    }
    parts.push(seg)
  }

  return prefix + parts.join('/')
}

const isAbsolute = (path: string): boolean => /^([\\/]|[A-Za-z]:[\\/])/.test(path)

/** An absolute, normalized path for what a tool named, relative ones taken under `root`. */
export const resolve = (root: string, path: string): string =>
  normalize(isAbsolute(path) || root === '' ? path : `${root}/${path}`)

/** The path under `root` ('' for the root itself), or undefined when it lies outside. */
export const relative = (root: string, abs: string): string | undefined => {
  if (root === '') return undefined
  if (abs === root) return ''
  const base = root.endsWith('/') ? root : `${root}/`

  return abs.startsWith(base) ? abs.slice(base.length) : undefined
}

/** The absolute path of a folder given by its path under `root`. */
export const join = (root: string, rel: string): string =>
  rel === '' ? root : root.endsWith('/') ? `${root}${rel}` : `${root}/${rel}`

export const baseName = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

/** True when any folder on the path is one the tree never shows. */
export const isIgnored = (rel: string): boolean => rel.split('/').some(seg => IGNORED.has(seg))

/** The folders above a path under the root, outermost first, the root ('') left out. */
export const parents = (rel: string): string[] => {
  const segs = rel.split('/')
  const out: string[] = []

  for (let i = 1; i < segs.length; i++) out.push(segs.slice(0, i).join('/'))

  return out
}

const compare = (a: string, b: string): number => {
  const x = a.toLowerCase()
  const y = b.toLowerCase()

  if (x !== y) return x < y ? -1 : 1

  return a < b ? -1 : a > b ? 1 : 0
}

/** Folders first, then files, each alphabetical (case folded). */
export const sortEntries = (entries: readonly Entry[]): Entry[] =>
  [...entries].sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : compare(a.name, b.name)))

/** What the tree keeps of a raw `$.fs.list` answer. */
export const toListing = (raw: readonly { name: string; kind: string }[]): Listing => {
  const kept = sortEntries(
    raw.filter(one => !IGNORED.has(one.name)).map(one => ({ name: one.name, isDir: one.kind === 'dir' })),
  )

  return { entries: kept.slice(0, CAP), more: Math.max(0, kept.length - CAP), error: null }
}

const RANK: Record<Mark, number> = { R: 1, M: 2, A: 3 }

/** The mark that stays: added over modified over read. */
export const stronger = (was: Mark | undefined, now: Mark): Mark =>
  was !== undefined && RANK[was] >= RANK[now] ? was : now

/** One line, cut to `max` cells with an ellipsis at the end. */
export const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()

  if (max <= 1) return line.slice(0, Math.max(0, max))

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** One line, cut to `max` cells from the start, so a path keeps its file name. */
export const clipStart = (text: string, max: number): string => {
  if (max <= 1) return text.slice(-Math.max(0, max))

  return text.length > max ? `…${text.slice(text.length - max + 1)}` : text
}

export type Row =
  | { kind: 'dir'; key: string; rel: string; name: string; depth: number; isOpen: boolean; count: number }
  | { kind: 'file'; key: string; rel: string; name: string; depth: number; mark: Mark | null }
  | { kind: 'note'; key: string; depth: number; text: string }

export type Loose = { path: string; mark: Mark }

export type View = {
  rows: Row[]
  outside: Loose[]
  ignored: Loose[]
  changed: number
  added: number
  read: number
  isCut: boolean
}

/** The rows the pane draws, from what the state holds. */
export const buildView = (
  root: string,
  mode: Mode,
  expanded: readonly string[],
  listings: Readonly<Record<string, Listing>>,
  touched: Readonly<Record<string, Mark>>,
  maxRows: number,
): View => {
  const open = new Set(expanded)
  const view: View = { rows: [], outside: [], ignored: [], changed: 0, added: 0, read: 0, isCut: false }
  const marks = new Map<string, Mark>()
  const tally = new Map<string, number>()
  const extra = new Map<string, Map<string, boolean>>()

  for (const [path, mark] of Object.entries(touched)) {
    if (mark === 'M') view.changed += 1
    else if (mark === 'A') view.added += 1
    else view.read += 1

    const rel = relative(root, path)

    if (rel === undefined || rel === '') {
      view.outside.push({ path, mark })
      continue
    }
    if (isIgnored(rel)) {
      view.ignored.push({ path: rel, mark })
      continue
    }

    marks.set(rel, mark)
    const segs = rel.split('/')

    for (let i = 0; i < segs.length; i++) {
      const dir = segs.slice(0, i).join('/')
      const kids = extra.get(dir) ?? new Map<string, boolean>()

      tally.set(dir, (tally.get(dir) ?? 0) + 1)
      kids.set(segs[i] ?? '', i < segs.length - 1)
      extra.set(dir, kids)
    }
  }

  const push = (row: Row): boolean => {
    if (view.rows.length >= maxRows) {
      view.isCut = true
      return false
    }
    view.rows.push(row)
    return true
  }

  const walk = (dir: string, depth: number): void => {
    const listing = listings[dir]
    const entries = [...(listing?.entries ?? [])]
    const names = new Set(entries.map(one => one.name))

    for (const [name, isDir] of extra.get(dir) ?? []) {
      if (!names.has(name)) entries.push({ name, isDir })
    }

    if (mode === 'all') {
      if (listing === undefined && entries.length === 0) push({ kind: 'note', key: `note:${dir}`, depth, text: 'Loading…' })
      else if (listing?.error) push({ kind: 'note', key: `note:${dir}`, depth, text: listing.error })
      else if (entries.length === 0) push({ kind: 'note', key: `note:${dir}`, depth, text: '(empty)' })
    }

    for (const entry of sortEntries(entries)) {
      if (view.isCut) return
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`

      if (entry.isDir) {
        const count = tally.get(rel) ?? 0
        if (mode === 'touched' && count === 0) continue
        const isOpen = open.has(rel)
        if (!push({ kind: 'dir', key: `row:${rel}`, rel, name: entry.name, depth, isOpen, count })) return
        if (isOpen) walk(rel, depth + 1)
      } else {
        const mark = marks.get(rel) ?? null
        if (mode === 'touched' && mark === null) continue
        if (!push({ kind: 'file', key: `row:${rel}`, rel, name: entry.name, depth, mark })) return
      }
    }

    if (mode === 'all' && listing !== undefined && listing.more > 0) {
      push({ kind: 'note', key: `more:${dir}`, depth, text: `… ${listing.more} more` })
    }
  }

  walk('', 0)

  return view
}
