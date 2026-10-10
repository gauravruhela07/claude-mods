/** What kind of work a step was, which picks its glyph in the theatre. */
export type StepKind = 'read' | 'edit' | 'run' | 'search' | 'web' | 'agent' | 'plan' | 'other'

/** One main-loop tool call, as the theatre plays it back. */
export type Step = {
  /** The tool_use_id of the call. */
  id: string
  tool: string
  /** The call in plain words: "Reading register.tsx". */
  label: string
  /** File basename, command, url host, pattern; "" when the tool has none. */
  target: string
  kind: StepKind
  startedAt: number
  /** Real time the call took; 0 while it runs. */
  durationMs: number
  isRunning: boolean
  ok: boolean
  /** The first 120 characters of what the model read back, on one line. */
  result: string
  /** For an Agent step: the subagent matched to it, and the tool calls it made. */
  agentId: string | null
  agentCalls: number
}

/** One main-loop turn: the prompt, the steps, the answer. */
export type Scene = {
  id: string
  /** The prompt, clipped to 200 characters. */
  prompt: string
  startedAt: number
  /** null while the turn still runs. */
  endedAt: number | null
  /** The final answer, clipped to 300 characters. */
  answer: string
  aborted: boolean
  steps: Step[]
}

/** A whole session's film. */
export type Recording = { scenes: Scene[] }

/** What `$.store` keeps under `last-session`. */
export type SavedSession = { sessionId: string; savedAt: number; scenes: Scene[] }

export type Speed = 1 | 2 | 4

/** Which film the theatre shows: this session's, or the one before it. */
export type Source = 'live' | 'last'

/** Where the playhead stands: a scene, and a step in it (-1 is the scene's title card). */
export type Position = { scene: number; step: number }

export type Playback = Position & {
  source: Source
  isPlaying: boolean
  speed: Speed
  /** When the current frame began to hold, in `$.clock.now()` milliseconds. */
  since: number
  /** True once playback ran off the last frame. */
  isEnded: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'replay-theatre': {
      recording: Recording
      previous: Recording | null
      playback: Playback
    }
  }
}
