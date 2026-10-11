/** One tool call that is running now, in words a person reads. */
export type Activity = { id: string; label: string; since: number }

/** The turn that runs now. */
export type Live = {
  startedAt: number
  steps: number
  reads: number
  edits: number
  commands: number
  agentSteps: number
  errors: number
  files: string[]
  running: Activity[]
  tasksDoneAtStart: number
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

/** One item of Claude's task list (TaskCreate / TodoWrite). */
export type Task = { id: string; subject: string; activeForm?: string; status: TaskStatus }

/** What the last finished turn came to. */
export type Summary = {
  durationMs: number
  steps: number
  files: number
  errors: number
  isAborted: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'savvy-progress': {
      live: Live | null
      tasks: Task[]
      now: number
      last: Summary | null
      isHidden: boolean
      /** How long past answered turns took, in ms, oldest first; kept across sessions in `$.store`. */
      durations: number[]
    }
  }
}
