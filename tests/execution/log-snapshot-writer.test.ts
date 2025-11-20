import { TFile } from 'obsidian'
import { LogSnapshotWriter } from '../../src/features/log/services/LogSnapshotWriter'
import type { TaskChutePluginLike } from '../../src/types'
import { createEmptyTaskLogSnapshot } from '../../src/utils/executionLogUtils'

interface WriterTestContext {
  plugin: TaskChutePluginLike
  file: TFile
  store: Map<string, string>
  backupStore: Map<string, string>
}

function createMockTFile(path: string): TFile {
  const file = new TFile()
  Object.setPrototypeOf(file, TFile.prototype)
  file.path = path
  const filename = path.split('/').pop() ?? path
  const dotIndex = filename.lastIndexOf('.')
  if (dotIndex >= 0) {
    file.basename = filename.slice(0, dotIndex)
    file.extension = filename.slice(dotIndex + 1)
  } else {
    file.basename = filename
    file.extension = ''
  }
  return file
}

function createWriterTestContext(): WriterTestContext {
  const store = new Map<string, string>()
  const backupStore = new Map<string, string>()
  const file = createMockTFile('LOGS/2025-10-tasks.json')

  const abstractStore = new Map<string, TFile>([[file.path, file]])

  const vault = {
    adapter: {
      write: jest.fn(async (path: string, data: string) => {
        backupStore.set(path, data)
      }),
    },
    getAbstractFileByPath: jest.fn((path: string) => abstractStore.get(path) ?? null),
    read: jest.fn(async (target: TFile) => store.get(target.path) ?? ''),
    modify: jest.fn(async (target: TFile, content: string) => {
      store.set(target.path, content)
    }),
    create: jest.fn(),
  }

  const plugin: TaskChutePluginLike = {
    app: { vault } as TaskChutePluginLike['app'],
    pathManager: {
      getLogDataPath: () => 'LOGS',
      ensureFolderExists: jest.fn().mockResolvedValue(undefined),
    },
    settings: {
      useOrderBasedSort: true,
      slotKeys: {},
      backupIntervalHours: 24,
      backupRetentionDays: 30,
    },
    routineAliasService: {} as TaskChutePluginLike['routineAliasService'],
    dayStateService: {} as TaskChutePluginLike['dayStateService'],
    saveSettings: jest.fn(),
    manifest: {
      id: 'taskchute-plus',
      version: '1.0.0',
      name: 'TaskChute Plus',
      minAppVersion: '1.0.0',
      author: 'TaskChute',
      description: '',
    },
  }

  const initialSnapshot = createEmptyTaskLogSnapshot()
  store.set(file.path, JSON.stringify(initialSnapshot))

  return { plugin, file, store, backupStore }
}

describe('LogSnapshotWriter', () => {
  test('writes backup and stamps lastBackupAt when interval elapsed', async () => {
    const { plugin, file, store, backupStore } = createWriterTestContext()
    const writer = new LogSnapshotWriter(plugin)
    const snapshot = createEmptyTaskLogSnapshot()

    await writer.write('2025-10', snapshot)

    expect(plugin.app.vault.adapter.write).toHaveBeenCalled()
    expect(backupStore.size).toBe(1)
    expect(snapshot.meta?.lastBackupAt).toBeDefined()
    const saved = JSON.parse(store.get(file.path) ?? '{}')
    expect(saved.meta.lastBackupAt).toBe(snapshot.meta?.lastBackupAt)
  })

  test('skips backup when previous backup is still fresh', async () => {
    const { plugin, file, store } = createWriterTestContext()
    const writer = new LogSnapshotWriter(plugin)
    const snapshot = createEmptyTaskLogSnapshot()
    const lastBackupAt = new Date().toISOString()
    snapshot.meta!.lastBackupAt = lastBackupAt

    await writer.write('2025-10', snapshot)

    expect(plugin.app.vault.adapter.write).not.toHaveBeenCalled()
    const saved = JSON.parse(store.get(file.path) ?? '{}')
    expect(saved.meta.lastBackupAt).toBe(lastBackupAt)
    expect(snapshot.meta?.lastBackupAt).toBe(lastBackupAt)
  })

  test('forceBackup option overrides interval guard', async () => {
    const { plugin, file, store, backupStore } = createWriterTestContext()
    const writer = new LogSnapshotWriter(plugin)
    const snapshot = createEmptyTaskLogSnapshot()
    snapshot.meta!.lastBackupAt = new Date().toISOString()

    await writer.write('2025-10', snapshot, { forceBackup: true })

    expect(plugin.app.vault.adapter.write).toHaveBeenCalled()
    expect(backupStore.size).toBe(1)
    const saved = JSON.parse(store.get(file.path) ?? '{}')
    expect(saved.meta.lastBackupAt).toBe(snapshot.meta?.lastBackupAt)
  })
})
