import type { StepKind } from '../types'

type Input = Record<string, unknown>

const str = (input: Input, key: string): string => {
  const value = input[key]

  return typeof value === 'string' ? value : ''
}

/** One line, at most `max` characters, an ellipsis where it was cut. */
export const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()

  if (max <= 1) return line.slice(0, Math.max(0, max))

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export const base = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

export const host = (url: string): string => {
  const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(url)

  return match?.[1] ?? url
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** A real duration as a person reads it: "0.4s", "12s", "3m 5s". */
export const took = (ms: number): string => {
  const safe = Math.max(0, ms)

  if (safe < 10_000) return `${(safe / 1000).toFixed(1)}s`

  const seconds = Math.round(safe / 1000)

  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)

  if (minutes < 60) return `${minutes}m ${seconds % 60}s`

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const file = (input: Input): string =>
  base(str(input, 'file_path') || str(input, 'notebook_path') || str(input, 'path'))

/** Turns a tool call into a short line a person reads: "Reading register.tsx". */
export const describe = (tool: string, input: Input): string => {
  switch (tool) {
    case 'Read':
      return `Reading ${file(input)}`
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Editing ${file(input)}`
    case 'Write':
      return `Writing ${file(input)}`
    case 'Bash':
    case 'PowerShell':
      return str(input, 'description') || `Running ${clip(str(input, 'command'), 60)}`
    case 'Grep':
      return `Searching for "${str(input, 'pattern')}"`
    case 'Glob':
      return `Finding ${str(input, 'pattern')}`
    case 'WebFetch':
      return `Fetching ${host(str(input, 'url'))}`
    case 'WebSearch':
      return `Searching the web: ${str(input, 'query')}`
    case 'Agent':
    case 'Task':
      return `Agent: ${str(input, 'description') || 'working'}`
    case 'Skill':
      return `Using skill ${str(input, 'skill')}`
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return 'Updating the plan'
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return 'Planning'
    case 'ToolSearch':
      return 'Loading tools'
  }

  if (tool.startsWith('mcp__')) {
    const [, server = '', ...rest] = tool.split('__')
    const name = rest.join('__').replace(/_/g, ' ')
    const isOpaque = /^[0-9a-f-]{20,}$/i.test(server)

    return isOpaque ? name : `${server}: ${name}`
  }

  return tool
}

/** What the call worked on: a file's basename, the command, the url's host. */
export const targetOf = (tool: string, input: Input): string => {
  const path = file(input)

  if (path !== '') return path

  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return clip(str(input, 'command'), 120)
    case 'WebFetch':
      return host(str(input, 'url'))
    case 'WebSearch':
      return clip(str(input, 'query'), 120)
    case 'Grep':
    case 'Glob':
      return clip(str(input, 'pattern'), 120)
    case 'Agent':
    case 'Task':
      return str(input, 'subagent_type') || clip(str(input, 'description'), 120)
    case 'Skill':
      return str(input, 'skill')
    case 'ToolSearch':
      return clip(str(input, 'query'), 120)
  }

  if (tool.startsWith('mcp__')) {
    const server = tool.split('__')[1] ?? ''

    return /^[0-9a-f-]{20,}$/i.test(server) ? '' : server
  }

  return ''
}

const KINDS: Record<string, StepKind> = {
  Read: 'read',
  NotebookRead: 'read',
  LS: 'read',
  ReadMcpResourceTool: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'run',
  PowerShell: 'run',
  BashOutput: 'run',
  KillShell: 'run',
  Monitor: 'run',
  Grep: 'search',
  Glob: 'search',
  ToolSearch: 'search',
  LSP: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
  Agent: 'agent',
  Task: 'agent',
  SendMessage: 'agent',
  TodoWrite: 'plan',
  TaskCreate: 'plan',
  TaskUpdate: 'plan',
  TaskList: 'plan',
  TaskGet: 'plan',
  EnterPlanMode: 'plan',
  ExitPlanMode: 'plan',
}

export const kindOf = (tool: string): StepKind => KINDS[tool] ?? 'other'

export const GLYPH: Record<StepKind, string> = {
  read: '▸',
  edit: '✎',
  run: '$',
  search: '?',
  web: '@',
  agent: '◆',
  plan: '≡',
  other: '•',
}
