import { TFile, TFolder } from 'obsidian'
import DayStatePersistenceService from '@/services/DayStatePersistenceService'
import { BackupRestoreService } from '@/features/log/services/BackupRestoreService'
import { LogSnapshotWriter } from '@/features/log/services/LogSnapshotWriter'
import { parseBackupTimestamp, stateBackupPathFor } from '@/features/log/services/MonthBackupSet'
import type { TaskChutePluginLike } from '@/types'

/**
 * A vault kept as a flat map of paths to contents. Folders are derived from
 * the paths, so a backup folder lists whatever files sit under it.
 */
function createVault() {
  const files = new Map<string, string>()
  const fileNode = (path: string) => {
    const file = new TFile()
    Object.setPrototypeOf(file, TFile.prototype)
    file.path = path
    file.name = path.split('/').pop() ?? path
    const dot = file.name.lastIndexOf('.')
    file.basename = dot >= 0 ? file.name.slice(0, dot) : file.name
    file.extension = dot >= 0 ? file.name.slice(dot + 1) : ''
    return file
  }
  const folderNode = (path: string): TFolder | null => {
    const prefix = `${path}/`
    const childNames = new Set<string>()
    for (const key of files.keys()) {
      if (!key.startsWith(prefix)) continue
      childNames.add(key.slice(prefix.length).split('/')[0])
    }
    if (childNames.size === 0) return null
    const folder = new TFolder()
    Object.setPrototypeOf(folder, TFolder.prototype)
    folder.path = path
    folder.name = path.split('/').pop() ?? path
    folder.children = Array.from(childNames).map((name) => {
      const childPath = `${prefix}${name}`
      return files.has(childPath) ? fileNode(childPath) : folderNode(childPath)!
    })
    return folder
  }
  const vault = {
    getAbstractFileByPath: jest.fn((path: string) => (files.has(path) ? fileNode(path) : folderNode(path))),
    read: jest.fn(async (file: TFile) => files.get(file.path) ?? ''),
    modify: jest.fn(async (file: TFile, content: string) => {
      files.set(file.path, content)
    }),
    create: jest.fn(async (path: string, content: string) => {
      files.set(path, content)
      return fileNode(path)
    }),
    adapter: {
      read: jest.fn(async (path: string) => {
        if (!files.has(path)) throw new Error(`missing ${path}`)
        return files.get(path)!
      }),
      write: jest.fn(async (path: string, content: string) => {
        files.set(path, content)
      }),
      exists: jest.fn(async (path: string) => files.has(path)),
    },
  }
  return { files, vault }
}

function createPlugin(settings: Record<string, unknown> = {}) {
  const { files, vault } = createVault()
  const leaves: Array<{ view: { reloadTasksAndRestore: jest.Mock } }> = []
  const plugin = {
    app: {
      vault,
      workspace: { getLeavesOfType: jest.fn(() => leaves) },
      fileManager: { trashFile: jest.fn() },
    },
    settings: { useOrderBasedSort: true, slotKeys: {}, backupIntervalHours: 2, ...settings },
    pathManager: {
      getLogDataPath: () => 'LOGS',
      getTaskFolderPath: () => 'TASKS',
      getProjectFolderPath: () => 'PROJECTS',
      getReviewDataPath: () => 'REVIEWS',
      ensureFolderExists: jest.fn().mockResolvedValue(undefined),
      getLogYearPath: jest.fn((year: string) => `LOGS/${year}`),
      ensureYearFolder: jest.fn(async () => undefined),
      validatePath: jest.fn(() => ({ valid: true })),
    },
    routineAliasService: { loadAliases: jest.fn().mockResolvedValue({}) },
    saveSettings: jest.fn(),
    manifest: { id: 'taskchute-plus' },
  } as unknown as TaskChutePluginLike
  const dayStateService = new DayStatePersistenceService(plugin)
  ;(plugin as { dayStateService: unknown }).dayStateService = dayStateService
  return { plugin, files, vault, dayStateService, leaves }
}

const STATE = 'LOGS/2026-10-state.json'
const TASKS = 'LOGS/2026-10-tasks.json'
const FOLDER = 'LOGS/backups/2026-10'

const stateFile = (comments: Array<{ id: string; text: string }>) =>
  JSON.stringify({
    days: {
      '2026-10-08': {
        hiddenRoutines: [],
        deletedInstances: [],
        duplicatedInstances: [],
        slotOverrides: {},
        orders: {},
        comments: comments.map((c) => ({ ...c, at: 1000, updatedAt: 1000 })),
      },
    },
    metadata: { version: '1.0', lastUpdated: '2026-10-08T00:00:00.000Z' },
  })

const tasksFile = (title: string) =>
  JSON.stringify({
    taskExecutions: { '2026-10-08': [{ instanceId: 'i-1', taskTitle: title, startTime: '09:00', stopTime: '10:00' }] },
    dailySummary: {},
    meta: { revision: 3, processedCursor: {} },
  })

const backupsIn = (files: Map<string, string>) =>
  Array.from(files.keys()).filter((p) => p.startsWith(`${FOLDER}/`)).sort()

describe('backup file names', () => {
  test('both halves of a set carry the same timestamp', () => {
    expect(parseBackupTimestamp('2026-10-08T03-00-00-000Z.json')).toBe(Date.parse('2026-10-08T03:00:00.000Z'))
    expect(parseBackupTimestamp('2026-10-08T03-00-00-000Z.state.json')).toBe(Date.parse('2026-10-08T03:00:00.000Z'))
    expect(parseBackupTimestamp('notes.json')).toBeNull()
    expect(stateBackupPathFor(`${FOLDER}/2026-10-08T03-00-00-000Z.json`)).toBe(`${FOLDER}/2026-10-08T03-00-00-000Z.state.json`)
  })
})

describe('making a backup set', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-08T03:00:00.000Z') })
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  test('an execution-log backup also copies the day state, as one set', async () => {
    const { plugin, files } = createPlugin()
    files.set(TASKS, tasksFile('before'))
    files.set(STATE, stateFile([{ id: 'c1', text: 'comment' }]))
    await new LogSnapshotWriter(plugin).write('2026-10', JSON.parse(tasksFile('after')), { forceBackup: true })
    expect(backupsIn(files)).toEqual([
      `${FOLDER}/2026-10-08T03-00-00-000Z.json`,
      `${FOLDER}/2026-10-08T03-00-00-000Z.state.json`,
    ])
    expect(files.get(`${FOLDER}/2026-10-08T03-00-00-000Z.state.json`)).toBe(stateFile([{ id: 'c1', text: 'comment' }]))
  })

  test('a month with no day state yet backs up the execution log alone, as before', async () => {
    const { plugin, files } = createPlugin()
    files.set(TASKS, tasksFile('before'))
    await new LogSnapshotWriter(plugin).write('2026-10', JSON.parse(tasksFile('after')), { forceBackup: true })
    expect(backupsIn(files)).toEqual([`${FOLDER}/2026-10-08T03-00-00-000Z.json`])
  })

  test('writing the day state backs up the month once per interval, before the write', async () => {
    const { files, dayStateService } = createPlugin()
    files.set(TASKS, tasksFile('log'))
    files.set(STATE, stateFile([{ id: 'c1', text: 'old' }]))
    const date = new Date(2026, 9, 8)
    const day = await dayStateService.loadDay(date)
    await dayStateService.saveDay(date, { ...day, comments: [{ id: 'c2', text: 'new', at: 2000, updatedAt: 2000 }] })
    expect(backupsIn(files)).toEqual([
      `${FOLDER}/2026-10-08T03-00-00-000Z.json`,
      `${FOLDER}/2026-10-08T03-00-00-000Z.state.json`,
    ])
    // The state half is the file as it was before this write.
    expect(files.get(`${FOLDER}/2026-10-08T03-00-00-000Z.state.json`)).toBe(stateFile([{ id: 'c1', text: 'old' }]))

    // Within the interval: no new set.
    jest.advanceTimersByTime(60 * 60 * 1000)
    await dayStateService.saveDay(date, { ...day, comments: [{ id: 'c3', text: 'later', at: 3000, updatedAt: 3000 }] })
    expect(backupsIn(files)).toHaveLength(2)

    // Past the interval: a new set.
    jest.advanceTimersByTime(61 * 60 * 1000)
    await dayStateService.saveDay(date, { ...day, comments: [{ id: 'c4', text: 'much later', at: 4000, updatedAt: 4000 }] })
    expect(backupsIn(files)).toHaveLength(4)
  })

  test('counts backups made earlier (by another session) toward the interval', async () => {
    const { files, dayStateService } = createPlugin()
    files.set(STATE, stateFile([]))
    files.set(`${FOLDER}/2026-10-08T02-30-00-000Z.json`, tasksFile('earlier'))
    const date = new Date(2026, 9, 8)
    const day = await dayStateService.loadDay(date)
    await dayStateService.saveDay(date, { ...day, comments: [{ id: 'c1', text: 'x', at: 1, updatedAt: 1 }] })
    expect(backupsIn(files)).toEqual([`${FOLDER}/2026-10-08T02-30-00-000Z.json`])
  })

  test('a new month file (nothing to back up yet) is created without a backup', async () => {
    const { files, dayStateService } = createPlugin()
    const date = new Date(2026, 9, 8)
    const day = await dayStateService.loadDay(date)
    await dayStateService.saveDay(date, { ...day, comments: [{ id: 'c1', text: 'x', at: 1, updatedAt: 1 }] })
    expect(files.has(STATE)).toBe(true)
    expect(backupsIn(files)).toEqual([])
  })

  test('the day state and the execution log share one interval: a change that writes both makes one set', async () => {
    const { plugin, files, dayStateService } = createPlugin()
    files.set(TASKS, tasksFile('before'))
    files.set(STATE, stateFile([{ id: 'c1', text: 'old' }]))
    const date = new Date(2026, 9, 8)
    const day = await dayStateService.loadDay(date)
    await dayStateService.saveDay(date, { ...day, comments: [{ id: 'c2', text: 'new', at: 2, updatedAt: 2 }] })
    jest.advanceTimersByTime(20)
    // The log has never recorded a backup of its own, which used to mean "back up now".
    await new LogSnapshotWriter(plugin).write('2026-10', JSON.parse(tasksFile('after')))
    expect(backupsIn(files)).toEqual([
      `${FOLDER}/2026-10-08T03-00-00-000Z.json`,
      `${FOLDER}/2026-10-08T03-00-00-000Z.state.json`,
    ])

    // Either way round.
    jest.advanceTimersByTime(3 * 60 * 60 * 1000)
    await new LogSnapshotWriter(plugin).write('2026-10', JSON.parse(tasksFile('later')))
    jest.advanceTimersByTime(20)
    await dayStateService.saveDay(date, { ...day, comments: [{ id: 'c3', text: 'later', at: 3, updatedAt: 3 }] })
    expect(backupsIn(files)).toHaveLength(4)
  })

  test('forcing a backup of the execution log still makes a set within the interval', async () => {
    const { plugin, files, dayStateService } = createPlugin()
    files.set(TASKS, tasksFile('before'))
    files.set(STATE, stateFile([]))
    const date = new Date(2026, 9, 8)
    const day = await dayStateService.loadDay(date)
    await dayStateService.saveDay(date, { ...day, comments: [{ id: 'c1', text: 'x', at: 1, updatedAt: 1 }] })
    jest.advanceTimersByTime(1000)
    await new LogSnapshotWriter(plugin).write('2026-10', JSON.parse(tasksFile('after')), { forceBackup: true })
    expect(backupsIn(files)).toHaveLength(4)
  })

  test('after a failed backup, the next write tries again', async () => {
    const { files, vault, dayStateService } = createPlugin()
    files.set(STATE, stateFile([]))
    vault.adapter.write.mockRejectedValueOnce(new Error('disk full'))
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const date = new Date(2026, 9, 8)
    const day = await dayStateService.loadDay(date)
    await dayStateService.saveDay(date, { ...day, comments: [{ id: 'c1', text: 'x', at: 1, updatedAt: 1 }] })
    expect(backupsIn(files)).toEqual([])
    jest.advanceTimersByTime(1000)
    await dayStateService.saveDay(date, { ...day, comments: [{ id: 'c2', text: 'y', at: 2, updatedAt: 2 }] })
    expect(backupsIn(files)).toEqual([`${FOLDER}/2026-10-08T03-00-01-000Z.state.json`])
    warn.mockRestore()
  })

  test('a failed backup does not stop the write', async () => {
    const { files, vault, dayStateService } = createPlugin()
    files.set(STATE, stateFile([]))
    vault.adapter.write.mockRejectedValueOnce(new Error('disk full'))
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const date = new Date(2026, 9, 8)
    const day = await dayStateService.loadDay(date)
    await dayStateService.saveDay(date, { ...day, comments: [{ id: 'c1', text: 'kept', at: 1, updatedAt: 1 }] })
    expect(files.get(STATE)).toContain('kept')
    warn.mockRestore()
  })
})

describe('listing and restoring backup sets', () => {
  const stamp = '2026-10-08T03-00-00-000Z'

  test('old backups (execution log only) are listed as before; a set is listed once', () => {
    const { plugin, files } = createPlugin()
    files.set(`${FOLDER}/2026-10-07T03-00-00-000Z.json`, tasksFile('old'))
    files.set(`${FOLDER}/${stamp}.json`, tasksFile('set'))
    files.set(`${FOLDER}/${stamp}.state.json`, stateFile([]))
    const entries = new BackupRestoreService(plugin).listBackups().get('2026-10') ?? []
    expect(entries.map((e) => e.path)).toEqual([`${FOLDER}/${stamp}.json`, `${FOLDER}/2026-10-07T03-00-00-000Z.json`])
  })

  test('a set with only the day state is listed by its day-state file', () => {
    const { plugin, files } = createPlugin()
    files.set(`${FOLDER}/${stamp}.state.json`, stateFile([]))
    const entries = new BackupRestoreService(plugin).listBackups().get('2026-10') ?? []
    expect(entries.map((e) => e.path)).toEqual([`${FOLDER}/${stamp}.state.json`])
  })

  test('restoring a set puts back the execution log and the day state, and reloads open views', async () => {
    const { plugin, files, dayStateService, leaves } = createPlugin({ backupIntervalHours: 0 })
    const view = { reloadTasksAndRestore: jest.fn().mockResolvedValue(undefined) }
    leaves.push({ view })
    files.set(TASKS, tasksFile('current'))
    files.set(STATE, stateFile([{ id: 'now', text: 'written after the backup' }]))
    await dayStateService.loadDay(new Date(2026, 9, 8))
    files.set(`${FOLDER}/${stamp}.json`, tasksFile('backed up'))
    files.set(`${FOLDER}/${stamp}.state.json`, stateFile([{ id: 'then', text: 'from the backup' }]))

    await new BackupRestoreService(plugin).restoreFromBackup('2026-10', `${FOLDER}/${stamp}.json`)

    expect(files.get(TASKS)).toContain('backed up')
    const restored = await dayStateService.loadDay(new Date(2026, 9, 8))
    expect(restored.comments?.map((c) => c.id)).toEqual(['then'])
    expect(view.reloadTasksAndRestore).toHaveBeenCalledWith({ clearDayStateCache: 'all' })
  })

  test('restoring an old backup without a day-state half leaves the day state alone', async () => {
    const { plugin, files, dayStateService } = createPlugin()
    files.set(TASKS, tasksFile('current'))
    files.set(STATE, stateFile([{ id: 'now', text: 'kept' }]))
    files.set(`${FOLDER}/${stamp}.json`, tasksFile('backed up'))
    const restoreMonth = jest.spyOn(dayStateService, 'restoreMonth')

    await new BackupRestoreService(plugin).restoreFromBackup('2026-10', `${FOLDER}/${stamp}.json`)

    expect(files.get(TASKS)).toContain('backed up')
    expect(restoreMonth).not.toHaveBeenCalled()
    expect(files.get(STATE)).toContain('kept')
  })

  test('restoring a day-state-only set puts back the day state and leaves the execution log alone', async () => {
    const { plugin, files, dayStateService } = createPlugin({ backupIntervalHours: 0 })
    files.set(TASKS, tasksFile('current'))
    files.set(STATE, stateFile([{ id: 'now', text: 'replaced' }]))
    files.set(`${FOLDER}/${stamp}.state.json`, stateFile([{ id: 'then', text: 'restored' }]))

    await new BackupRestoreService(plugin).restoreFromBackup('2026-10', `${FOLDER}/${stamp}.state.json`)

    expect(files.get(TASKS)).toContain('current')
    const restored = await dayStateService.loadDay(new Date(2026, 9, 8))
    expect(restored.comments?.map((c) => c.id)).toEqual(['then'])
  })
})
