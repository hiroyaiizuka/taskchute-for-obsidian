import { TFile } from 'obsidian'

import { listFilesInFolder } from '../../src/utils/vaultFiles'

function file(path: string): TFile {
  const result = new TFile()
  result.path = path
  result.basename = path.split('/').pop()?.replace(/\.[^.]+$/u, '') ?? path
  result.extension = path.split('.').pop() ?? ''
  return result
}

function folder(path: string, children: unknown[] = []): { path: string; children: unknown[] } {
  return { path, children }
}

function appWithRoot(root: unknown) {
  return {
    vault: {
      getAbstractFileByPath: jest.fn(() => root),
    },
  }
}

describe('listFilesInFolder', () => {
  test('recursively returns markdown files under the requested folder only', () => {
    const taskA = file('TaskChute/Task/a.md')
    const taskB = file('TaskChute/Task/Nested/b.md')
    const ignoredJson = file('TaskChute/Task/data.json')
    const root = folder('TaskChute/Task', [
      taskA,
      ignoredJson,
      folder('TaskChute/Task/Nested', [taskB]),
    ])
    const app = appWithRoot(root)

    const files = listFilesInFolder(app, 'TaskChute/Task', { markdownOnly: true })

    expect(files.map((candidate) => candidate.path)).toEqual([
      'TaskChute/Task/a.md',
      'TaskChute/Task/Nested/b.md',
    ])
    expect(app.vault.getAbstractFileByPath).toHaveBeenCalledWith('TaskChute/Task')
  })

  test('returns an empty list when the folder is missing', () => {
    const app = appWithRoot(null)

    expect(listFilesInFolder(app, 'TaskChute/Task', { markdownOnly: true })).toEqual([])
  })

  test('infers markdown extension from path when a test stub omits extension', () => {
    const task = new TFile()
    task.path = 'TaskChute/Task/no-extension-property.md'
    task.basename = 'no-extension-property'
    const root = folder('TaskChute/Task', [task])
    const app = appWithRoot(root)

    expect(listFilesInFolder(app, 'TaskChute/Task', { markdownOnly: true })).toEqual([task])
  })

  test('filters by suffix for log snapshots and day state files', () => {
    const snapshot = file('TaskChute/Log/2026-05-tasks.json')
    const state = file('TaskChute/Log/2026-05-state.json')
    const delta = file('TaskChute/Log/inbox/device/2026-05.jsonl')
    const root = folder('TaskChute/Log', [snapshot, state, folder('TaskChute/Log/inbox', [delta])])
    const app = appWithRoot(root)

    expect(listFilesInFolder(app, 'TaskChute/Log', { suffix: '-tasks.json' })).toEqual([snapshot])
    expect(listFilesInFolder(app, 'TaskChute/Log', { suffix: '-state.json' })).toEqual([state])
  })
})
