import type { Blast, Risky } from '../types'

/** Tools whose successful call changes a file. */
export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** A file with at least this many dependents is a wide blast (toast, warning color). */
export const WIDE = 15
/** At least this many is drawn in the error color. */
export const HUGE = 50
/** Dependents kept per file (the count stays exact). */
export const MAX_KEPT = 1000
/** Dependents listed under an expanded row. */
export const LISTED = 30
/** Risky commands kept for the session. */
export const MAX_RISKY = 100

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()

  if (max <= 1) return line.slice(0, Math.max(0, max))

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Clips a path from the left, so its file name stays: "…/src/lib/utils.ts". */
export const clipPath = (path: string, max: number): string => {
  if (path.length <= max) return path
  if (max <= 1) return path.slice(-Math.max(0, max))

  return `…${path.slice(path.length - max + 1)}`
}

export const baseName = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

const trimSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path)

/** The path made absolute against the root. */
export const absolute = (root: string, path: string): string =>
  path.startsWith('/') || root === '' ? path : `${trimSlash(root)}/${path.replace(/^\.\//, '')}`

/** The path relative to the root, or undefined when it lies outside it. */
export const inside = (root: string, path: string): string | undefined => {
  if (root === '') return undefined
  const base = trimSlash(root)
  const prefix = base === '/' ? '/' : `${base}/`

  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined
}

const stripExt = (name: string): string => {
  const typed = /^(.+)\.d\.[cm]?ts$/.exec(name)
  if (typed?.[1] !== undefined) return typed[1]
  const dot = name.lastIndexOf('.')

  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * How other files reach this file's module: by its base name with no extension
 * (`names`), or, for a folder's entry file (index.*, __init__.py, mod.rs), by the
 * folder's name (`folders`), and for index.* also by an explicit `/index` path.
 * An `__init__` or `mod` alone is no useful name.
 */
export type ModuleRefs = { names: string[]; folders: string[]; isIndex: boolean }

export const moduleRefs = (path: string): ModuleRefs => {
  const parts = path.split('/').filter(Boolean)
  const file = parts[parts.length - 1] ?? ''
  const folder = parts[parts.length - 2]
  const stem = stripExt(file)
  const isIndex = stem === 'index'

  if (isIndex || file === '__init__.py' || file === 'mod.rs') {
    return { names: [], folders: folder === undefined || folder === '' ? [] : [folder], isIndex }
  }

  return { names: stem === '' ? [] : [stem], folders: [], isIndex: false }
}

/** Every name a search looks for, for display and tests: "utils", or "widgets" and "index". */
export const moduleNames = (path: string): string[] => {
  const refs = moduleRefs(path)

  return [...refs.folders, ...refs.names, ...(refs.isIndex ? ['index'] : [])]
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const BEFORE = "[/.:'\"<`[:space:]]"
const AFTER = "([./'\"`>;:,)[:space:]]|$)"
// A folder named in a path ends the path ("./widgets"), or goes on as a module path
// ("pkg.core.x", "crate::net::x"); "./widgets/button" reaches another file, not the entry.
const AFTER_FOLDER = "(['\"`>;:,).[:space:]]|$)"

/**
 * One pattern, read alike by rg and by grep -E: a line holding an
 * import / require / from / include / use / mod word, then later one of the
 * names standing as a module path piece ("./utils", "lib.utils", "crate::utils",
 * "utils.h"). Undefined when the file has no name to look for.
 */
export const dependentPattern = (refs: ModuleRefs): string | undefined => {
  const parts: string[] = []

  if (refs.names.length > 0) parts.push(`${BEFORE}(${refs.names.map(escape).join('|')})${AFTER}`)
  if (refs.folders.length > 0) parts.push(`${BEFORE}(${refs.folders.map(escape).join('|')})${AFTER_FOLDER}`)
  if (refs.isIndex) parts.push(`/index${AFTER}`)
  if (parts.length === 0) return undefined

  return '(^|[^A-Za-z0-9_$])(import|require|require_relative|from|include|use|mod)([^A-Za-z0-9_$].*)?' + `(${parts.join('|')})`
}

export const rgArgv = (pattern: string, root: string): string[] => [
  'rg',
  '-l',
  '--hidden',
  '-g',
  '!.git',
  '-g',
  '!node_modules',
  '-g',
  '!dist',
  '-g',
  '!build',
  '-e',
  pattern,
  root,
]

export const grepArgv = (pattern: string, root: string): string[] => [
  'grep',
  '-rIlE',
  '--exclude-dir=.git',
  '--exclude-dir=node_modules',
  '--exclude-dir=dist',
  '--exclude-dir=build',
  '-e',
  pattern,
  root,
]

/** The files a search printed, relative to the root, the edited file left out. */
export const parseHits = (stdout: string, root: string, self: string): string[] => {
  const seen = new Set<string>()

  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const full = absolute(root, line.replace(/^\.\//, ''))
    if (full === self) continue
    seen.add(inside(root, full) ?? full)
  }

  return [...seen].sort()
}

type Rule = { reason: string; test: (command: string, segments: readonly string[][]) => boolean }

/** The command split into simple commands (on ; & | newlines, subshell and backtick marks), each into words. */
const segmentsOf = (command: string): string[][] =>
  command
    .split(/[;&|\n()`]+/)
    .map(part => part.trim().split(/\s+/).filter(word => word !== ''))
    .filter(words => words.length > 0)

const isWord = (word: string, name: string): boolean => word === name || word.endsWith(`/${name}`)

/** The flags after the first `name` word of a segment (every word that starts with "-"), or undefined. */
const flagsOf = (words: readonly string[], name: string): string[] | undefined => {
  const at = words.findIndex(word => isWord(word, name))
  if (at < 0) return undefined

  return words.slice(at + 1).filter(word => word.startsWith('-') && word !== '-' && word !== '--')
}

const hasShort = (flags: readonly string[], letter: string): boolean =>
  flags.some(flag => /^-[A-Za-z]+$/.test(flag) && flag.includes(letter))

const hasLong = (flags: readonly string[], long: string): boolean => flags.some(flag => flag === long || flag.startsWith(`${long}=`))

/** Whether some `rm` in the command is recursive, and whether one is recursive and forced. */
const rmFlags = (segments: readonly string[][]): { recursive: boolean; force: boolean } => {
  let recursive = false

  for (const words of segments) {
    const flags = flagsOf(words, 'rm')
    if (flags === undefined) continue
    const r = hasShort(flags, 'r') || hasShort(flags, 'R') || hasLong(flags, '--recursive')
    const f = hasShort(flags, 'f') || hasLong(flags, '--force')
    if (r && f) return { recursive: true, force: true }
    recursive ||= r
  }

  return { recursive, force: false }
}

const recursiveOn = (segments: readonly string[][], name: string): boolean =>
  segments.some(words => {
    const flags = flagsOf(words, name)

    return flags !== undefined && (hasShort(flags, 'R') || hasLong(flags, '--recursive'))
  })

/** A segment that runs `git <sub>` (global options before the subcommand allowed). */
const gitSub = (words: readonly string[], sub: string): string[] | undefined => {
  const at = words.findIndex(word => isWord(word, 'git'))
  if (at < 0) return undefined
  const rest = words.slice(at + 1)
  const subAt = rest.findIndex(word => !word.startsWith('-') && !/^[^=]+=/.test(word) && word !== 'git')
  if (subAt < 0 || rest[subAt] !== sub) return undefined

  return rest.slice(subAt + 1)
}

const git = (segments: readonly string[][], sub: string, test: (args: string[]) => boolean): boolean =>
  segments.some(words => {
    const args = gitSub(words, sub)

    return args !== undefined && test(args)
  })

const runs = (segments: readonly string[][], name: string, test: (args: string[]) => boolean = () => true): boolean =>
  segments.some(words => {
    const at = words.findIndex(word => isWord(word, name))

    return at >= 0 && test(words.slice(at + 1))
  })

const RULES: Rule[] = [
  { reason: 'rm -rf', test: (c, s) => rmFlags(s).force },
  { reason: 'rm -r', test: (c, s) => rmFlags(s).recursive },
  {
    reason: 'git push --force',
    test: (c, s) =>
      git(s, 'push', args => hasShort(args, 'f') || hasLong(args, '--force') || hasLong(args, '--force-with-lease')),
  },
  { reason: 'git reset --hard', test: (c, s) => git(s, 'reset', args => args.includes('--hard')) },
  { reason: 'git clean -f', test: (c, s) => git(s, 'clean', args => hasShort(args, 'f') || hasLong(args, '--force')) },
  {
    reason: 'git checkout -- .',
    test: (c, s) =>
      git(s, 'checkout', args => {
        const dash = args.indexOf('--')

        return dash >= 0 && args.slice(dash + 1).some(arg => arg === '.' || arg === './' || arg === '*')
      }),
  },
  { reason: 'DROP TABLE', test: c => /\bDROP\s+TABLE\b/i.test(c) },
  { reason: 'DROP DATABASE', test: c => /\bDROP\s+(DATABASE|SCHEMA)\b/i.test(c) },
  { reason: 'TRUNCATE', test: c => /\bTRUNCATE\b/i.test(c) },
  { reason: 'kubectl delete', test: (c, s) => runs(s, 'kubectl', args => args.includes('delete')) },
  {
    reason: 'terraform destroy',
    test: (c, s) => runs(s, 'terraform', args => args.includes('destroy') || (args.includes('apply') && args.includes('-destroy'))),
  },
  { reason: 'chmod -R', test: (c, s) => recursiveOn(s, 'chmod') },
  { reason: 'chown -R', test: (c, s) => recursiveOn(s, 'chown') },
  { reason: 'sudo', test: (c, s) => s.some(words => isWord(words[0] ?? '', 'sudo')) },
  { reason: 'mkfs', test: (c, s) => s.some(words => words.some(word => /^(.*\/)?mkfs(\.[A-Za-z0-9]+)?$/.test(word))) },
  { reason: 'dd if=', test: (c, s) => runs(s, 'dd', args => args.some(arg => arg.startsWith('if='))) },
]

/** Why a shell command reaches wide, or undefined when it does not. */
export const classify = (command: string): string | undefined => {
  const segments = segmentsOf(command)

  return RULES.find(rule => rule.test(command, segments))?.reason
}

/** What a set of edited files comes to: how many, how many distinct dependents, how many still searching. */
export type Totals = { files: number; dependents: number; pending: number }

export const totals = (files: readonly Blast[]): Totals => {
  const reached = new Set<string>()
  let extra = 0
  let pending = 0

  for (const file of files) {
    if (file.status === 'pending') pending += 1
    if (file.status !== 'done') continue
    for (const one of file.dependents) reached.add(one)
    extra += Math.max(0, file.count - file.dependents.length)
  }

  return { files: files.length, dependents: reached.size + extra, pending }
}

/** The status line for this turn's edits, or undefined when nothing was edited. */
export const statusLine = (files: readonly Blast[]): string | undefined => {
  if (files.length === 0) return undefined
  const sum = totals(files)
  const tail = sum.pending > 0 ? ' · searching…' : ''

  return `blast: ${plural(sum.files, 'file')} → ${plural(sum.dependents, 'dependent')}${tail}`
}

/** "3 files edited → 27 dependents · 1 risky command". */
export const headline = (files: readonly Blast[], risky: readonly Risky[]): string => {
  const sum = totals(files)
  const tail = sum.pending > 0 ? ' (searching…)' : ''

  return `${plural(sum.files, 'file')} edited → ${plural(sum.dependents, 'dependent')}${tail} · ${plural(risky.length, 'risky command')}`
}

export const clock = (ms: number): string => {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')

  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}
