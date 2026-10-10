import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

import { classify, dependentPattern, moduleNames, moduleRefs } from '../hooks/blast'

const ROOT = '/repo'
const UTILS = '/repo/src/lib/utils.ts'
const REL = 'src/lib/utils.ts'
const SURFACES = ['terminal', 'desktop'] as const

const pane = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'blast-radius',
    surface,
    component: 'Pane',
    requestId: 'blast-radius',
    props: {
      title: 'Blast radius',
      isFocused: false,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

const run = (args: string) =>
  ({
    command: 'blast-radius',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  }) as const

const ok = (stdout: string, exitCode = 0): ProcessRunResult => ({
  exitCode,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

/** What a fake rg prints: `n` dependents, and the edited file itself, which must be left out. */
const hits = (n: number): string =>
  [UTILS, ...Array.from({ length: n }, (_, i) => `${ROOT}/src/dep${String(i).padStart(2, '0')}.ts`)].join('\n') + '\n'

type Answer = (argv: readonly string[]) => ProcessRunResult | Promise<ProcessRunResult> | 'fail'

/** The engine beneath the plugin: clock, session, turn, toasts, status, pane and process answers. */
const world = (on: On, answer: Answer) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const runs: { argv: string[]; cwd?: string; timeoutMs?: number }[] = []

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', async ($, e) => {
    runs.push({ argv: [...e.argv], cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
    const out = await answer(e.argv)

    return out === 'fail' ? { deny: `${e.argv[0]}: not found` } : { value: out }
  })

  return { clock, toasts, statuses, runs, lastStatus: () => statuses[statuses.length - 1] }
}

const start = async ($: Engine) =>
  $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

test('an edit is recorded at once, searched off the tool call, and its dependents show in the pane', async ($, on) => {
  let release = () => {}
  const held = new Promise<void>(resolve => (release = resolve))
  const w = world(on, async () => {
    await held

    return ok(hits(3))
  })
  on('tool.call', () => ({ result: { marker: 'engine result' } }) as never)

  await start($)
  await $.turn.start({ text: 'edit utils', turnId: 't1' })
  const ran = await $.tool.call({ tool: 'Edit', file_path: UTILS, old_string: 'a', new_string: 'b' })

  // Unchanged, and back before any search started.
  expect(ran.result).toEqual({ marker: 'engine result' })
  expect(w.runs).toHaveLength(0)
  expect(w.lastStatus()).toBe('blast: 1 file → 0 dependents · searching…')

  expect((await $.command.run(run(''))).text).toContain('1 file edited')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect((await ui.find({ key: `row:${REL}` }))?.text).toContain('searching…')
    await ui.unmount()
  }

  // The timer starts the search; it hangs, and another edit still comes straight back.
  await w.clock.advance(500)
  expect(w.runs).toHaveLength(1)
  const second = await $.tool.call({ tool: 'Write', file_path: '/repo/src/other.ts', content: 'x' })
  expect(second.result).toEqual({ marker: 'engine result' })

  release()
  await w.clock.advance(500)

  const [rg] = w.runs
  expect(rg?.argv.slice(0, 11)).toEqual(['rg', '-l', '--hidden', '-g', '!.git', '-g', '!node_modules', '-g', '!dist', '-g', '!build'])
  expect(rg?.argv[rg.argv.length - 1]).toBe(ROOT)
  expect(rg?.timeoutMs).toBe(3000)
  expect(w.runs).toHaveLength(2)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect((await ui.find({ key: `row:${REL}` }))?.text).toContain('3 dependents')
    // other.ts's search printed utils.ts too: 3 shared dependents plus utils.ts, counted once.
    expect((await ui.find({ key: 'header' }))?.text).toContain('This turn: 2 files edited → 4 dependents · 0 risky commands')
    expect((await ui.find({ key: 'row:src/other.ts' }))?.text).toContain('4 dependents')
    await ui.unmount()
  }
  expect(w.lastStatus()).toBe('blast: 2 files → 4 dependents')
})

test('a risky shell command is listed and toasted, a plain one is not', async ($, on) => {
  const w = world(on, () => ok(''))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)

  await start($)
  await $.turn.start({ text: 'reset', turnId: 't1' })
  const ran = await $.tool.call({ tool: 'Bash', command: 'git reset --hard HEAD~1', description: 'Reset' })
  await $.tool.call({ tool: 'Bash', command: 'ls -la', description: 'List' })

  expect(ran.result).toEqual({ stdout: '', stderr: '', interrupted: false })
  expect(w.toasts).toEqual(['Risky command ran: git reset --hard HEAD~1'])
  expect(w.lastStatus()).toBeUndefined()

  await $.command.run(run(''))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    const row = (await ui.find({ key: 'risky:0' }))?.text ?? ''
    expect(row).toContain('git reset --hard')
    expect(row).toContain('HEAD~1')
    expect(await ui.find({ key: 'risky:1' })).toBeUndefined()
    expect((await ui.find({ key: 'header' }))?.text).toContain('0 files edited → 0 dependents · 1 risky command')
    await ui.unmount()
  }
})

test('15 or more dependents toast once per file per turn, and color the count', async ($, on) => {
  let size = 20
  const w = world(on, () => ok(hits(size)))
  on('tool.call', () => ({ result: {} }) as never)

  await start($)
  await $.turn.start({ text: 'one', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: UTILS, old_string: 'a', new_string: 'b' })
  await w.clock.advance(500)
  await $.tool.call({ tool: 'Edit', file_path: UTILS, old_string: 'b', new_string: 'c' })
  await w.clock.advance(500)

  expect(w.runs).toHaveLength(1)
  expect(w.toasts).toEqual(['Wide blast: utils.ts is used by 20 files'])
  expect(w.lastStatus()).toBe('blast: 1 file → 20 dependents')

  await $.command.run(run(''))
  const ui = await $.ui.mount(pane('terminal'))
  expect((await ui.find({ type: 'Text', text: /^20 dependents$/ }))?.props.color).toBe('warning')
  await ui.unmount()

  size = 60
  await $.turn.start({ text: 'two', turnId: 't2' })
  expect(w.lastStatus()).toBeUndefined()
  await $.tool.call({ tool: 'Edit', file_path: UTILS, old_string: 'c', new_string: 'd' })
  await w.clock.advance(500)

  expect(w.runs).toHaveLength(2)
  expect(w.toasts).toEqual(['Wide blast: utils.ts is used by 20 files', 'Wide blast: utils.ts is used by 60 files'])
  for (const surface of SURFACES) {
    const again = await $.ui.mount(pane(surface))
    expect((await again.find({ type: 'Text', text: /^60 dependents$/ }))?.props.color).toBe('error')
    await again.unmount()
  }
})

test('Show lists the first 30 dependents, then how many more', async ($, on) => {
  const w = world(on, () => ok(hits(42)))
  on('tool.call', () => ({ result: {} }) as never)

  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: UTILS, old_string: 'a', new_string: 'b' })
  await w.clock.advance(500)
  await $.command.run(run(''))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ key: `deps:${REL}` })).toBeUndefined()
    await ui.press({ key: `show:${REL}` })
    const deps = (await ui.find({ key: `deps:${REL}` }))?.text ?? ''
    expect(deps).toContain('src/dep00.ts')
    expect(deps).toContain('src/dep29.ts')
    expect(deps).not.toContain('src/dep30.ts')
    expect(deps).toContain('… 12 more')
    expect((await ui.findAll({ type: 'Text', text: /^src\/dep/ })).length).toBe(30)
    await ui.press({ key: `show:${REL}` })
    expect(await ui.find({ key: `deps:${REL}` })).toBeUndefined()
    await ui.unmount()
  }
})

test('the session view keeps every edit; clear resets; unknown words change nothing', async ($, on) => {
  const w = world(on, () => ok(hits(2)))
  on('tool.call', () => ({ result: {} }) as never)

  await start($)
  await $.turn.start({ text: 'one', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: UTILS, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build', description: 'Clean' })
  await w.clock.advance(500)
  await $.turn.start({ text: 'two', turnId: 't2' })

  expect((await $.command.run(run('session'))).text).toContain('this session: 1 file edited → 2 dependents · 1 risky command')

  for (const odd of ['bogus', 'session please', 'clear everything now']) {
    const reply = (await $.command.run(run(odd))).text ?? ''
    expect(reply).toContain('Usage: /blast-radius [session|turn|clear]')
    expect(reply).toContain('Nothing changed')
  }

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect((await ui.find({ key: 'header' }))?.text).toContain('This session: 1 file edited → 2 dependents · 1 risky command')
    expect((await ui.find({ key: `row:${REL}` }))?.text).toContain('2 dependents')
    expect((await ui.find({ key: 'risky:0' }))?.text).toContain('rm -rf')
    await ui.unmount()
  }

  expect((await $.command.run(run('turn'))).text).toContain('this turn: 0 files edited')
  expect((await $.command.run(run('CLEAR'))).text).toContain('cleared')
  expect(w.lastStatus()).toBeUndefined()
  await $.command.run(run('session'))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect((await ui.find({ key: 'header' }))?.text).toContain('This session: 0 files edited → 0 dependents · 0 risky commands')
    expect((await ui.find({ key: 'none' }))?.text).toContain('No files edited this session.')
    expect(await ui.find({ key: 'risky:0' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a failed Edit is ignored', async ($, on) => {
  const w = world(on, () => ok(hits(5)))
  on('tool.call', () => ({ isError: true, result: 'String to replace not found', text: 'String to replace not found' }) as never)

  await start($)
  await $.turn.start({ text: 'try', turnId: 't1' })
  const ran = await $.tool.call({ tool: 'Edit', file_path: UTILS, old_string: 'nope', new_string: 'b' })
  await w.clock.advance(1000)

  expect(ran.isError).toBe(true)
  expect(ran.text).toBe('String to replace not found')
  expect(w.runs).toHaveLength(0)
  expect(w.statuses.every(text => text === undefined)).toBe(true)

  await $.command.run(run(''))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect((await ui.find({ key: 'none' }))?.text).toContain('No files edited this turn.')
    expect(await ui.find({ key: `row:${REL}` })).toBeUndefined()
    await ui.unmount()
  }
})

test('falls back to grep when rg is missing', async ($, on) => {
  const w = world(on, argv => (argv[0] === 'rg' ? 'fail' : ok(`${ROOT}/a.ts\n${ROOT}/b.ts\n`)))
  on('tool.call', () => ({ result: {} }) as never)

  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/repo/nb/model.ipynb', new_source: 'x' })
  await w.clock.advance(500)

  expect(w.runs.map(one => one.argv[0])).toEqual(['rg', 'grep'])
  expect(w.runs[1]?.argv.slice(0, 2)).toEqual(['grep', '-rIlE'])
  expect(w.runs[1]?.timeoutMs).toBe(3000)
  expect(w.lastStatus()).toBe('blast: 1 file → 2 dependents')
})

test('the module names, the search pattern and the risky rules', () => {
  expect(moduleNames('/r/src/utils.ts')).toEqual(['utils'])
  expect(moduleNames('/r/src/types.d.ts')).toEqual(['types'])
  expect(moduleNames('/r/src/widgets/index.tsx')).toEqual(['widgets', 'index'])
  expect(moduleNames('/r/pkg/core/__init__.py')).toEqual(['core'])
  expect(moduleNames('/r/src/net/mod.rs')).toEqual(['net'])

  // The pattern as rg and grep read it, made a JS RegExp ([:space:] is \s there).
  const asRegExp = (path: string) => new RegExp((dependentPattern(moduleRefs(path)) ?? '$^').replace(/\[:space:\]/g, '\\s'))
  const pattern = asRegExp('/r/src/lib/utils.ts')
  for (const line of [
    "import { a } from './lib/utils'",
    'const u = require("../utils.js")',
    '} from "./utils"',
    'from utils import thing',
    'from .pkg.utils import thing',
    '#include "utils.h"',
    'use crate::utils::helper;',
    'mod utils;',
    "@import 'utils';",
  ]) {
    expect(pattern.test(line), line).toBe(true)
  }
  for (const line of ["import { x } from './utilsx'", 'const utils = 1', '// utils here']) {
    expect(pattern.test(line), line).toBe(false)
  }

  const entry = asRegExp('/r/src/widgets/index.ts')
  for (const line of ["import { Button } from './widgets'", "import w from '../widgets/index.js'", 'from app.widgets import x']) {
    expect(entry.test(line), line).toBe(true)
  }
  for (const line of ["import { Button } from './widgets/button'", "import { index } from 'search'"]) {
    expect(entry.test(line), line).toBe(false)
  }

  const cases: [string, string | undefined][] = [
    ['rm -rf node_modules', 'rm -rf'],
    ['rm -r -f dist', 'rm -rf'],
    ['rm -fr /tmp/x', 'rm -rf'],
    ['rm -r old', 'rm -r'],
    ['rm file.txt', undefined],
    ['git push --force origin main', 'git push --force'],
    ['git push -f', 'git push --force'],
    ['git push origin main', undefined],
    ['git reset --hard HEAD~2', 'git reset --hard'],
    ['git reset HEAD file', undefined],
    ['git clean -fdx', 'git clean -f'],
    ['git checkout -- .', 'git checkout -- .'],
    ['git checkout main', undefined],
    ['psql -c "DROP TABLE users"', 'DROP TABLE'],
    ['mysql -e "drop database app"', 'DROP DATABASE'],
    ['psql -c "TRUNCATE orders"', 'TRUNCATE'],
    ['kubectl delete pod web-1', 'kubectl delete'],
    ['kubectl get pods', undefined],
    ['terraform destroy -auto-approve', 'terraform destroy'],
    ['chmod -R 777 .', 'chmod -R'],
    ['chown -R me:staff /srv', 'chown -R'],
    ['chmod +x run.sh', undefined],
    ['sudo apt-get install jq', 'sudo'],
    ['mkfs.ext4 /dev/sdb1', 'mkfs'],
    ['dd if=/dev/zero of=/dev/sda bs=1M', 'dd if='],
    ['npm test && git status', undefined],
    ['cd app && rm -rf .next', 'rm -rf'],
  ]
  for (const [command, reason] of cases) expect(classify(command), command).toBe(reason)
})
