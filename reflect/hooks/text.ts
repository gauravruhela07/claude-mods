import type { ModelForkResult } from 'claude-code'

import type { Usage } from '../types'

/** The question the fork answers, over the session's own transcript. */
export const reflectPrompt = (focus: string): string => {
  const lines = [
    'Stop here and review the work you have done in this session so far, as a skeptical senior reviewer would.',
    'Do not use any tools and do not continue the task. Answer only with the review below.',
    '',
    'Reply in short Markdown with exactly these five headings, in this order, and nothing before or after them:',
    '',
    '## Asked',
    'One or two sentences: what the person actually asked for, in their own terms.',
    '',
    '## Done',
    'At most 5 bullets: what you actually changed, ran or produced. Name files, functions and commands. Facts only.',
    '',
    '## Might be wrong or missed',
    'At most 6 bullets. Concrete problems: bugs, unhandled edge cases, parts of the request skipped or half done,',
    'tests or checks not run, errors you glossed over, claims you made without verifying them.',
    'Name the file and the function (or line) for each one.',
    '',
    '## Risky assumptions',
    'At most 4 bullets: what you assumed without checking (an API, a version, a path, how something behaves,',
    'what the person meant) that would break the work if it were false.',
    '',
    '## Check next',
    'At most 5 numbered steps that would confirm or refute the points above. Each one is a command to run',
    'or a concrete look (which file, what to look for in it). No vague advice such as "test thoroughly".',
    '',
    'Rules:',
    '- Be honest and skeptical. Assume there is at least one mistake and look for it. Do not praise the work or reassure.',
    '- Do not repeat or summarise the transcript beyond the two short opening sections.',
    '- When a section truly has nothing, write "Nothing found" under its heading. Do not invent problems to fill it.',
    '- No preamble and no closing remarks.',
  ]
  const words = focus.trim()
  if (words !== '') lines.push('', `Focus on: ${words}.`)

  return lines.join('\n')
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/

/** The body of the section whose heading matches `name`, without its heading; undefined when absent. */
export const section = (markdown: string, name: RegExp): string | undefined => {
  const lines = markdown.split('\n')
  const start = lines.findIndex(line => {
    const m = HEADING.exec(line)
    return m !== null && name.test(m[2] ?? '')
  })
  if (start < 0) return undefined
  const level = (HEADING.exec(lines[start] ?? '')?.[1] ?? '##').length
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    const m = HEADING.exec(line)
    if (m !== null && (m[1] ?? '').length <= level) break
    body.push(line)
  }

  return body.join('\n').trim()
}

export const MISSED = /^might be wrong or missed\b/i
export const CHECK = /^check next\b/i

/** What the fix button puts in the prompt box. */
export const followUps = (markdown: string): string => {
  const missed = section(markdown, MISSED)
  const check = section(markdown, CHECK)
  const intro = 'Please address these points from your reflection:\n\n'
  if (missed === undefined && check === undefined) return intro + markdown.trim()
  const parts: string[] = []
  if (missed !== undefined) parts.push(`## Might be wrong or missed\n${missed || 'Nothing found'}`)
  if (check !== undefined) parts.push(`## Check next\n${check || 'Nothing found'}`)

  return intro + parts.join('\n\n')
}

/** Why a reflection has no text, in plain words. */
export const failure = (r: ModelForkResult): string => {
  if (r.isAnswered) return ''
  switch (r.reason) {
    case 'nothing-to-fork':
      return 'Nothing to reflect on yet — do some work first.'
    case 'aborted':
      return 'The reflection was stopped before it finished. Run /reflect to try again.'
    case 'empty-reply':
      return 'The model replied without any text. Run /reflect to try again.'
    case 'api-error': {
      const status = r.status === null ? 'no response arrived' : `status ${r.status}`
      return `The API returned an error (${status}, ${r.error}). Try /reflect again in a moment.`
    }
  }
}

/** What the fork cost; null when it cost nothing (nothing to fork, a refused request). */
export const toUsage = (r: ModelForkResult): Usage | null => {
  if (!r.isAnswered && r.reason === 'nothing-to-fork') return null
  const u = r.usage
  const usage = {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens,
    cacheWrite: u.cache_creation_input_tokens,
  }

  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0 ? usage : null
}

const short = (n: number): string =>
  n >= 999_500 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

/** `1.2k tokens (89% from cache)`. */
export const cost = (u: Usage): string => {
  const total = u.input + u.output + u.cacheRead + u.cacheWrite
  const prompt = u.input + u.cacheRead + u.cacheWrite
  const cached = prompt > 0 ? Math.round((u.cacheRead / prompt) * 100) : 0

  return `${short(total)} tokens (${cached}% from cache)`
}

/** `14:02`, local time where the environment knows it. */
export const clockTime = (ms: number): string => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
