import type { Activity, Live, Task } from '../types'

type Input = Record<string, unknown>

const READS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])
const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const COMMANDS = new Set(['Bash', 'PowerShell'])

const str = (input: Input, key: string): string => {
  const value = input[key]

  return typeof value === 'string' ? value : ''
}

export const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()

  if (max <= 1) return line.slice(0, Math.max(0, max))

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export const base = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

const host = (url: string): string => {
  const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(url)

  return match?.[1] ?? url
}

export const duration = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))

  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)

  if (minutes < 60) return `${minutes}m ${seconds % 60}s`

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export const bar = (done: number, total: number, width: number): string => {
  const filled = total === 0 ? 0 : Math.min(width, Math.round((done / total) * width))

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** Turns a tool call into a short line a person reads: "Reading register.tsx". */
export const describe = (tool: string, input: Input): string => {
  const file = base(str(input, 'file_path') || str(input, 'notebook_path') || str(input, 'path'))

  switch (tool) {
    case 'Read':
      return `Reading ${file}`
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Editing ${file}`
    case 'Write':
      return `Writing ${file}`
    case 'Bash':
    case 'PowerShell':
      return str(input, 'description') || `Running ${str(input, 'command')}`
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

/** The turn after one more tool call started. */
export const started = (live: Live, tool: string, input: Input, act: Activity, isMain: boolean): Live => {
  if (!isMain) return { ...live, agentSteps: live.agentSteps + 1 }

  const path = str(input, 'file_path') || str(input, 'notebook_path')
  const isEdit = EDITS.has(tool)

  return {
    ...live,
    steps: live.steps + 1,
    reads: live.reads + (READS.has(tool) ? 1 : 0),
    edits: live.edits + (isEdit ? 1 : 0),
    commands: live.commands + (COMMANDS.has(tool) ? 1 : 0),
    files: isEdit && path !== '' && !live.files.includes(path) ? [...live.files, path] : live.files,
    running: [...live.running, act],
  }
}

/** The task list after a TaskCreate, TaskUpdate or TodoWrite call went through. */
export const replan = (list: Task[], tool: string, input: Input, result: unknown): Task[] => {
  if (tool === 'TodoWrite') {
    const todos = Array.isArray(input.todos) ? (input.todos as Input[]) : []

    return todos.map((todo, i) => ({
      id: `todo-${i}`,
      subject: str(todo, 'content'),
      activeForm: str(todo, 'activeForm') || undefined,
      status: (str(todo, 'status') || 'pending') as Task['status'],
    }))
  }

  if (tool === 'TaskCreate') {
    const made = (result as { task?: { id?: unknown } } | undefined)?.task
    const id = typeof made?.id === 'string' ? made.id : `task-${list.length + 1}`

    return [
      ...list.filter(task => task.id !== id),
      { id, subject: str(input, 'subject'), activeForm: str(input, 'activeForm') || undefined, status: 'pending' },
    ]
  }

  if (tool === 'TaskUpdate') {
    const id = str(input, 'taskId')
    const status = str(input, 'status')

    if (status === 'deleted') return list.filter(task => task.id !== id)

    return list.map(task =>
      task.id !== id
        ? task
        : {
            ...task,
            subject: str(input, 'subject') || task.subject,
            activeForm: str(input, 'activeForm') || task.activeForm,
            status: status === '' ? task.status : (status as Task['status']),
          },
    )
  }

  return list
}

export const isPlanTool = (tool: string): boolean =>
  tool === 'TodoWrite' || tool === 'TaskCreate' || tool === 'TaskUpdate'
