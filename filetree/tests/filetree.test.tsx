import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { FsEntry, On } from 'claude-code'

const ROOT = '/work/proj'
const SURFACES = ['terminal', 'desktop'] as const

const file = (name: string): FsEntry => ({ name, kind: 'file', size: 10, mtimeMs: 1, isLink: false })
const dir = (name: string): FsEntry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })

/** A small fake project; ignored folders sit among the real ones. */
const TREE: Record<string, FsEntry[]> = {
  '/work/proj': [
    file('README.md'),
    dir('src'),
    dir('node_modules'),
    dir('.git'),
    file('.DS_Store'),
    dir('docs'),
    file('package.json'),
    dir('dist'),
    dir('__pycache__'),
  ],
  '/work/proj/src': [file('index.ts'), dir('lib'), file('app.ts'), dir('build')],
  '/work/proj/src/lib': [file('util.ts'), file('math.ts')],
  '/work/proj/src/build': [file('out.js')],
  '/work/proj/docs': [file('a-very-long-file-name-that-keeps-going-and-going.md')],
  '/work/proj/node_modules': [dir('react')],
}

const exists = (path: string): FsEntry['kind'] | undefined => {
  if (TREE[path] !== undefined) return 'dir'
  const cut = path.lastIndexOf('/')
  const parent = TREE[path.slice(0, cut)]

  return parent?.find(one => one.name === path.slice(cut + 1))?.kind
}

/** The engine beneath the plugin: fake fs, panes, command registry, a mocked clock. */
const engine = (on: On) => {
  const clock = mock.clock(on, { now: 1_000 })
  const opened: string[] = []
  const closed: string[] = []

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    opened.push(`${e.id}:${e.title ?? ''}`)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const entries = TREE[e.path]
    return entries === undefined ? { deny: `ENOENT: ${e.path}` } : { value: entries }
  })
  on('fs.stat', ($, e) => {
    const kind = exists(e.path)
    return kind === undefined ? { deny: `ENOENT: ${e.path}` } : { value: { kind, size: 10, mtimeMs: 1, isLink: false } }
  })
  on('tool.call', ($, e) => {
    const input = e as unknown as Record<string, unknown>
    if (String(input.file_path).endsWith('/broken.ts')) return { isError: true, result: 'no such file', text: 'no such file' } as never
    return { result: {} } as never
  })

  return { clock, opened, closed }
}

const run = (args: string) =>
  ({
    command: 'filetree',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  }) as const

const pane = ($: Engine, surface: (typeof SURFACES)[number], bodyColumns = 60) =>
  $.ui.mount({
    plugin: 'filetree',
    surface,
    component: 'Pane',
    requestId: 'filetree',
    props: {
      title: 'Files',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  })

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

const rowKeys = async (ui: { findAll: (q: { type: string }) => Promise<{ key: string | undefined }[]> }) =>
  (await ui.findAll({ type: 'Box' })).map(one => one.key ?? '').filter(key => key.startsWith('row:'))

test('/filetree opens the pane with the top level, folders first, ignored names left out', async ($, on) => {
  const { opened } = engine(on)
  await start($)

  const reply = await $.command.run(run(''))
  expect(reply.text).toContain('File tree opened')
  expect(opened).toEqual(['filetree:Files'])

  for (const surface of SURFACES) {
    const ui = await pane($, surface)
    const header = (await ui.find({ key: 'header' }))?.text ?? ''
    expect(header).toContain('proj')
    expect(header).toContain('0 changed · 0 new · 0 read')
    expect(await rowKeys(ui)).toEqual(['row:docs', 'row:src', 'row:package.json', 'row:README.md'])
    expect((await ui.find({ key: 'dir:src' }))?.text).toContain('▸ src/')
    for (const name of ['node_modules', '.git', '.DS_Store', 'dist', '__pycache__']) {
      expect(await ui.find({ text: name })).toBeUndefined()
    }
    expect((await ui.find({ key: 'mode' }))?.text).toBe('Only touched')
    expect(await ui.find({ key: 'collapse' })).toBeDefined()
    expect(await ui.find({ key: 'refresh' })).toBeDefined()
    await ui.unmount()
  }
})

test('pressing a folder Button expands it, again collapses it, and long names are cut to the width', async ($, on) => {
  engine(on)
  await start($)
  await $.command.run(run(''))

  for (const surface of SURFACES) {
    const ui = await pane($, surface, 30)
    await ui.press({ key: 'dir:src' })
    expect((await ui.find({ key: 'dir:src' }))?.text).toContain('▾ src/')
    expect(await rowKeys(ui)).toEqual([
      'row:docs',
      'row:src',
      'row:src/lib',
      'row:src/app.ts',
      'row:src/index.ts',
      'row:package.json',
      'row:README.md',
    ])
    expect(await ui.find({ text: 'build' })).toBeUndefined()

    await ui.press({ key: 'dir:docs' })
    const long = (await ui.find({ key: 'row:docs/a-very-long-file-name-that-keeps-going-and-going.md' }))?.text ?? ''
    expect(long).toContain('…')
    expect(long.length).toBeLessThanOrEqual(30)

    await ui.press({ key: 'dir:src' })
    await ui.press({ key: 'dir:docs' })
    expect(await ui.find({ key: 'row:src/index.ts' })).toBeUndefined()
    expect((await ui.find({ key: 'dir:src' }))?.text).toContain('▸ src/')
    await ui.unmount()
  }
})

test('an Edit of a nested file marks it M and opens the folders on its path', async ($, on) => {
  const { clock } = engine(on)
  await start($)
  await $.command.run(run(''))

  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/lib/util.ts`, old_string: 'a', new_string: 'b' })
  await clock.advance(300)

  for (const surface of SURFACES) {
    const ui = await pane($, surface)
    expect((await ui.find({ key: 'row:src/lib/util.ts' }))?.text).toBe('M util.ts')
    expect(await ui.find({ key: 'row:src/lib/math.ts' })).toBeDefined()
    expect((await ui.find({ key: 'dir:src' }))?.text).toContain('▾')
    expect((await ui.find({ key: 'dir:src/lib' }))?.text).toContain('▾')
    expect((await ui.find({ key: 'row:src' }))?.text).toContain('1')
    expect((await ui.find({ key: 'header' }))?.text).toContain('1 changed · 0 new · 0 read')
    await ui.unmount()
  }
})

test('Write of a new file is A, Read is R, failures do not count, outside paths get their own group', async ($, on) => {
  const { clock } = engine(on)
  await start($)

  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/fresh.ts`, content: 'x' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/package.json`, content: '{}' })
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/README.md` })
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/broken.ts` })
  await $.tool.call({ tool: 'Read', file_path: '/etc/hosts' })
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/node_modules/react/index.js` })
  await clock.advance(300)
  await $.command.run(run(''))

  for (const surface of SURFACES) {
    const ui = await pane($, surface)
    expect((await ui.find({ key: 'row:src/fresh.ts' }))?.text).toBe('A fresh.ts')
    expect((await ui.find({ key: 'row:package.json' }))?.text).toBe('M package.json')
    expect((await ui.find({ key: 'row:README.md' }))?.text).toBe('R README.md')
    expect(await ui.find({ key: 'row:src/broken.ts' })).toBeUndefined()
    expect((await ui.find({ key: 'header' }))?.text).toContain('1 changed · 1 new · 3 read')
    const outside = (await ui.find({ key: 'outside' }))?.text ?? ''
    expect(outside).toContain('Outside project (1)')
    expect(outside).toContain('/etc/hosts')
    expect(await ui.find({ key: 'row:node_modules' })).toBeUndefined()
    expect((await ui.find({ key: 'ignored' }))?.text).toContain('node_modules/react/index.js')
    await ui.unmount()
  }
})

test('touched mode hides untouched files; the mode Button and Collapse all work', async ($, on) => {
  const { clock } = engine(on)
  await start($)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/lib/util.ts`, old_string: 'a', new_string: 'b' })
  await clock.advance(300)

  const reply = await $.command.run(run('touched'))
  expect(reply.text).toContain('only touched')

  for (const surface of SURFACES) {
    const ui = await pane($, surface)
    expect(await rowKeys(ui)).toEqual(['row:src', 'row:src/lib', 'row:src/lib/util.ts'])
    expect((await ui.find({ key: 'mode' }))?.text).toBe('Show all')

    await ui.press({ key: 'mode' })
    expect(await ui.find({ key: 'row:README.md' })).toBeDefined()
    expect(await ui.find({ key: 'row:src/lib/math.ts' })).toBeDefined()

    await ui.press({ key: 'collapse' })
    expect(await ui.find({ key: 'row:src/lib' })).toBeUndefined()
    await ui.press({ key: 'refresh' })
    expect(await rowKeys(ui)).toEqual(['row:docs', 'row:src', 'row:package.json', 'row:README.md'])

    await ui.press({ key: 'dir:src' })
    await ui.press({ key: 'dir:src/lib' })
    await ui.press({ key: 'mode' })
    await ui.unmount()
  }
})

test('unknown words answer with the usage line and change nothing; close closes', async ($, on) => {
  const { opened, closed } = engine(on)
  await start($)

  for (const args of ['touched please', 'open', 'help me']) {
    expect((await $.command.run(run(args))).text).toContain('Nothing changed')
  }
  expect(opened).toEqual([])
  expect(closed).toEqual([])

  await $.command.run(run(''))
  const ui = await pane($, 'terminal')
  expect((await ui.find({ key: 'mode' }))?.text).toBe('Only touched')
  expect(await ui.find({ key: 'row:README.md' })).toBeDefined()
  await ui.unmount()

  expect((await $.command.run(run('close'))).text).toContain('closed')
  expect(closed).toEqual(['filetree'])
})
