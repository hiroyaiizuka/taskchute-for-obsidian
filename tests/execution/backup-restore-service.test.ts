import { TFile, TFolder } from 'obsidian'
import type { TaskChutePluginLike } from '../../src/types'
import { BackupRestoreService } from '../../src/features/log/services/BackupRestoreService'

interface FolderNode extends TFolder {
  children: Array<TFolder | TFile>
  parent?: FolderNode
}

interface FileNode extends TFile {
  parent?: FolderNode
}

function createFolder(path: string): FolderNode {
  const folder = new TFolder() as FolderNode
  Object.setPrototypeOf(folder, TFolder.prototype)
  folder.path = path
  folder.name = path.split('/').pop() ?? path
  folder.children = []
  return folder
}

function createFile(path: string, mtime: number): FileNode {
  const file = new TFile() as FileNode
  Object.setPrototypeOf(file, TFile.prototype)
  file.path = path
  const filename = path.split('/').pop() ?? path
  const dotIndex = filename.lastIndexOf('.')
  file.basename = dotIndex >= 0 ? filename.slice(0, dotIndex) : filename
  file.extension = dotIndex >= 0 ? filename.slice(dotIndex + 1) : ''
  file.stat = { mtime, ctime: mtime, size: 100 }
  return file
}

function attachChild(parent: FolderNode, child: FolderNode | FileNode): void {
  parent.children.push(child)
  ;(child).parent = parent
}

function createRestoreContext() {
  const backupRoot = createFolder('LOGS/backups')
  const legacyRoot = createFolder('LOGS/.backups')
  const taskFolder = createFolder('TaskChute/Task')
  const fileContents: Record<string, string> = {}
  const fileNodes = new Map<string, FileNode>()

  // Map to store frontmatter for each file
  const fileFrontmatterMap = new Map<string, Record<string, unknown>>()

  const ensureFileNode = (path: string): FileNode => {
    const existing = fileNodes.get(path)
    if (existing) return existing
    const file = createFile(path, Date.now())
    fileNodes.set(path, file)
    return file
  }

  const vault = {
    adapter: {
      read: jest.fn(async (path: string) => {
        if (Object.prototype.hasOwnProperty.call(fileContents, path)) {
          return fileContents[path]
        }
        throw new Error(`File not found: ${path}`)
      }),
      write: jest.fn(async (path: string, content: string) => {
        fileContents[path] = content
      }),
      stat: jest.fn(),
    },
    getAbstractFileByPath: jest.fn((path: string) => {
      if (path === 'LOGS/backups') return backupRoot
      if (path === 'LOGS/.backups') return legacyRoot
      if (path === 'TaskChute/Task') return taskFolder
      if (fileContents[path] !== undefined) {
        return ensureFileNode(path)
      }
      return null
    }),
    read: jest.fn(async (file: TFile) => fileContents[file.path] ?? ''),
    modify: jest.fn(async (file: TFile, content: string) => {
      fileContents[file.path] = content
    }),
    create: jest.fn(async (path: string, content: string) => {
      fileContents[path] = content
      return ensureFileNode(path)
    }),
  }

  const metadataCache = {
    getFileCache: jest.fn((file: TFile) => {
      const frontmatter = fileFrontmatterMap.get(file.path)
      if (frontmatter) {
        return { frontmatter }
      }
      return null
    }),
  }

  const plugin: TaskChutePluginLike = {
    app: { vault, metadataCache } as TaskChutePluginLike['app'],
    pathManager: {
      getLogDataPath: () => 'LOGS',
      getTaskFolderPath: () => 'TaskChute/Task',
      ensureFolderExists: jest.fn().mockResolvedValue(undefined),
    },
    settings: {
      useOrderBasedSort: true,
      slotKeys: {},
      backupRetentionDays: 1,
      backupIntervalHours: 2,
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

  return { plugin, backupRoot, legacyRoot, taskFolder, fileContents, vault, fileFrontmatterMap }
}

describe('BackupRestoreService', () => {
  describe('listBackups', () => {
    test('returns empty map when no backup folders exist', async () => {
      const { plugin } = createRestoreContext()
      // Override to return null for backup folders
      ;(plugin.app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null)

      const service = new BackupRestoreService(plugin)
      const result = service.listBackups()

      expect(result.size).toBe(0)
    })

    test('lists backups grouped by month key', async () => {
      const { plugin, backupRoot } = createRestoreContext()
      const now = Date.now()

      // Create month folders
      const dec2025 = createFolder('LOGS/backups/2025-12')
      const nov2025 = createFolder('LOGS/backups/2025-11')
      attachChild(backupRoot, dec2025)
      attachChild(backupRoot, nov2025)

      // Create backup files with ISO timestamps
      const decBackup1 = createFile('LOGS/backups/2025-12/2025-12-08T10-00-00-000Z.json', now - 2 * 60 * 60 * 1000)
      const decBackup2 = createFile('LOGS/backups/2025-12/2025-12-08T08-00-00-000Z.json', now - 4 * 60 * 60 * 1000)
      const novBackup1 = createFile('LOGS/backups/2025-11/2025-11-30T10-00-00-000Z.json', now - 8 * 24 * 60 * 60 * 1000)
      attachChild(dec2025, decBackup1)
      attachChild(dec2025, decBackup2)
      attachChild(nov2025, novBackup1)

      const service = new BackupRestoreService(plugin)
      const result = service.listBackups()

      expect(result.size).toBe(2)
      expect(result.has('2025-12')).toBe(true)
      expect(result.has('2025-11')).toBe(true)
      expect(result.get('2025-12')?.length).toBe(2)
      expect(result.get('2025-11')?.length).toBe(1)
    })

    test('sorts backups within each month by timestamp descending (newest first)', async () => {
      const { plugin, backupRoot } = createRestoreContext()
      const now = Date.now()

      const dec2025 = createFolder('LOGS/backups/2025-12')
      attachChild(backupRoot, dec2025)

      // Add files in random order
      const older = createFile('LOGS/backups/2025-12/2025-12-08T06-00-00-000Z.json', now - 6 * 60 * 60 * 1000)
      const newest = createFile('LOGS/backups/2025-12/2025-12-08T10-00-00-000Z.json', now - 2 * 60 * 60 * 1000)
      const middle = createFile('LOGS/backups/2025-12/2025-12-08T08-00-00-000Z.json', now - 4 * 60 * 60 * 1000)
      attachChild(dec2025, older)
      attachChild(dec2025, newest)
      attachChild(dec2025, middle)

      const service = new BackupRestoreService(plugin)
      const result = service.listBackups()

      const decBackups = result.get('2025-12')!
      expect(decBackups[0].path).toContain('10-00-00')
      expect(decBackups[1].path).toContain('08-00-00')
      expect(decBackups[2].path).toContain('06-00-00')
    })

    test('parses timestamp from filename correctly', async () => {
      const { plugin, backupRoot } = createRestoreContext()

      const dec2025 = createFolder('LOGS/backups/2025-12')
      attachChild(backupRoot, dec2025)

      const backup = createFile('LOGS/backups/2025-12/2025-12-08T14-30-00-000Z.json', Date.now())
      attachChild(dec2025, backup)

      const service = new BackupRestoreService(plugin)
      const result = service.listBackups()

      const entry = result.get('2025-12')![0]
      expect(entry.timestamp.getUTCHours()).toBe(14)
      expect(entry.timestamp.getUTCMinutes()).toBe(30)
      expect(entry.monthKey).toBe('2025-12')
    })

    test('generates human-readable relative time label', async () => {
      const { plugin, backupRoot } = createRestoreContext()
      const now = Date.now()

      const dec2025 = createFolder('LOGS/backups/2025-12')
      attachChild(backupRoot, dec2025)

      // 2 hours ago
      const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000)
      const filename = twoHoursAgo.toISOString().replace(/[:.]/g, '-') + '.json'
      const backup = createFile(`LOGS/backups/2025-12/${filename}`, twoHoursAgo.getTime())
      attachChild(dec2025, backup)

      const service = new BackupRestoreService(plugin)
      const result = service.listBackups()

      const entry = result.get('2025-12')![0]
      // Label should indicate relative time (implementation will vary by locale)
      expect(entry.label).toBeDefined()
      expect(typeof entry.label).toBe('string')
    })

    test('also includes backups from legacy .backups folder', async () => {
      const { plugin, backupRoot, legacyRoot } = createRestoreContext()
      const now = Date.now()

      // New backup folder
      const dec2025 = createFolder('LOGS/backups/2025-12')
      attachChild(backupRoot, dec2025)
      const newBackup = createFile('LOGS/backups/2025-12/2025-12-08T10-00-00-000Z.json', now)
      attachChild(dec2025, newBackup)

      // Legacy backup folder
      const legacyDec = createFolder('LOGS/.backups/2025-12')
      attachChild(legacyRoot, legacyDec)
      const legacyBackup = createFile('LOGS/.backups/2025-12/2025-12-08T08-00-00-000Z.json', now - 2 * 60 * 60 * 1000)
      attachChild(legacyDec, legacyBackup)

      const service = new BackupRestoreService(plugin)
      const result = service.listBackups()

      const decBackups = result.get('2025-12')!
      expect(decBackups.length).toBe(2)
    })
  })

  describe('restoreFromBackup', () => {
    test('overwrites current log file with backup content', async () => {
      const { plugin, backupRoot, fileContents } = createRestoreContext()

      // Setup backup file
      const dec2025 = createFolder('LOGS/backups/2025-12')
      attachChild(backupRoot, dec2025)
      const backup = createFile('LOGS/backups/2025-12/2025-12-08T10-00-00-000Z.json', Date.now())
      attachChild(dec2025, backup)

      // Backup contains old data
      const backupData = JSON.stringify({
        taskExecutions: { '2025-12-08': { task1: { completedAt: '2025-12-08T09:00:00Z' } } },
        dailySummary: { '2025-12-08': { completedTasks: 5, totalTasks: 10 } },
        meta: { revision: 1 },
      })
      fileContents['LOGS/backups/2025-12/2025-12-08T10-00-00-000Z.json'] = backupData

      // Current log file has different data
      fileContents['LOGS/2025-12-tasks.json'] = JSON.stringify({
        taskExecutions: { '2025-12-08': { task1: {}, task2: {} } },
        dailySummary: { '2025-12-08': { completedTasks: 10, totalTasks: 15 } },
        meta: { revision: 5 },
      })

      const service = new BackupRestoreService(plugin)
      await service.restoreFromBackup('2025-12', 'LOGS/backups/2025-12/2025-12-08T10-00-00-000Z.json')

      const restored = JSON.parse(fileContents['LOGS/2025-12-tasks.json'])
      const expected = JSON.parse(backupData)
      expect(restored.taskExecutions).toEqual(expected.taskExecutions)
      expect(restored.dailySummary).toEqual(expected.dailySummary)
      expect(restored.meta.revision).toBe(1)
      expect(restored.meta.processedCursor).toEqual({})
      expect(typeof restored.meta.lastBackupAt).toBe('string')
    })

    test('throws error if backup file cannot be read', async () => {
      const { plugin } = createRestoreContext()

      const service = new BackupRestoreService(plugin)

      await expect(
        service.restoreFromBackup('2025-12', 'LOGS/backups/2025-12/nonexistent.json')
      ).rejects.toThrow()
    })
  })

  describe('formatRelativeTime', () => {
    test('formats hours correctly', () => {
      const { plugin } = createRestoreContext()
      const service = new BackupRestoreService(plugin)
      const now = new Date()
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000)

      const label = service.formatRelativeTime(twoHoursAgo, now)

      expect(label).toMatch(/2.*時間前|2 hours? ago/i)
    })

    test('formats days correctly', () => {
      const { plugin } = createRestoreContext()
      const service = new BackupRestoreService(plugin)
      const now = new Date()
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)

      const label = service.formatRelativeTime(threeDaysAgo, now)

      expect(label).toMatch(/3.*日前|3 days? ago/i)
    })
  })

  describe('getBackupPreview', () => {
    test('returns preview with task executions for target date', async () => {
      const { plugin, fileContents } = createRestoreContext()

      const backupData = {
        taskExecutions: {
          '2025-12-08': [
            { taskTitle: 'メール対応', startTime: '09:00', stopTime: '09:30', durationSec: 1800 },
            { taskTitle: 'ミーティング', startTime: '10:00', stopTime: '11:00', durationSec: 3600 },
            { taskTitle: '資料作成', startTime: '14:00', stopTime: '-', durationSec: 0 },
          ],
        },
        dailySummary: {
          '2025-12-08': { totalTasks: 10, completedTasks: 2 },
        },
        meta: { revision: 1 },
      }
      fileContents['LOGS/backups/2025-12/backup.json'] = JSON.stringify(backupData)

      const service = new BackupRestoreService(plugin)
      const preview = await service.getBackupPreview('LOGS/backups/2025-12/backup.json', '2025-12-08')

      expect(preview.targetDate).toBe('2025-12-08')
      expect(preview.executions.length).toBe(3)
      // Sorted by startTime
      expect(preview.executions[0].taskName).toBe('メール対応')
      expect(preview.executions[0].startTime).toBe('09:00')
      expect(preview.executions[0].endTime).toBe('09:30')
      expect(preview.executions[1].taskName).toBe('ミーティング')
      expect(preview.executions[1].startTime).toBe('10:00')
      expect(preview.executions[1].endTime).toBe('11:00')
      expect(preview.executions[2].taskName).toBe('資料作成')
      expect(preview.executions[2].startTime).toBe('14:00')
      expect(preview.executions[2].endTime).toBe('-')
    })

    test('sorts executions by start time', async () => {
      const { plugin, fileContents } = createRestoreContext()

      const backupData = {
        taskExecutions: {
          '2025-12-08': [
            { taskTitle: '午後のタスク', startTime: '14:00', stopTime: '15:00', durationSec: 3600 },
            { taskTitle: '朝のタスク', startTime: '09:00', stopTime: '10:00', durationSec: 3600 },
            { taskTitle: '昼のタスク', startTime: '12:00', stopTime: '13:00', durationSec: 3600 },
          ],
        },
        dailySummary: {},
        meta: { revision: 1 },
      }
      fileContents['LOGS/backups/2025-12/backup.json'] = JSON.stringify(backupData)

      const service = new BackupRestoreService(plugin)
      const preview = await service.getBackupPreview('LOGS/backups/2025-12/backup.json', '2025-12-08')

      // Sorted by start time
      expect(preview.executions[0].taskName).toBe('朝のタスク')
      expect(preview.executions[0].startTime).toBe('09:00')
      expect(preview.executions[1].taskName).toBe('昼のタスク')
      expect(preview.executions[1].startTime).toBe('12:00')
      expect(preview.executions[2].taskName).toBe('午後のタスク')
      expect(preview.executions[2].startTime).toBe('14:00')
    })

    test('handles missing target date gracefully', async () => {
      const { plugin, fileContents } = createRestoreContext()

      const backupData = {
        taskExecutions: {
          '2025-12-07': [
            { taskTitle: '昨日のタスク', startTime: '09:00', stopTime: '10:00', durationSec: 3600 },
          ],
        },
        dailySummary: {},
        meta: { revision: 1 },
      }
      fileContents['LOGS/backups/2025-12/backup.json'] = JSON.stringify(backupData)

      const service = new BackupRestoreService(plugin)
      const preview = await service.getBackupPreview('LOGS/backups/2025-12/backup.json', '2025-12-08')

      expect(preview.targetDate).toBe('2025-12-08')
      expect(preview.executions).toEqual([])
    })

    test('uses taskName fallback when taskTitle is not present', async () => {
      const { plugin, fileContents } = createRestoreContext()

      const backupData = {
        taskExecutions: {
          '2025-12-08': [
            { taskName: 'タスク名のみ', startTime: '09:00', stopTime: '10:00' },
          ],
        },
        dailySummary: {},
        meta: { revision: 1 },
      }
      fileContents['LOGS/backups/2025-12/backup.json'] = JSON.stringify(backupData)

      const service = new BackupRestoreService(plugin)
      const preview = await service.getBackupPreview('LOGS/backups/2025-12/backup.json', '2025-12-08')

      expect(preview.executions[0].taskName).toBe('タスク名のみ')
    })
  })

  describe('getLatestDateInBackup', () => {
    test('returns the most recent date with execution data', async () => {
      const { plugin, fileContents } = createRestoreContext()

      const backupData = {
        taskExecutions: {
          '2025-12-05': [{ taskTitle: '古いタスク', startTime: '09:00', stopTime: '10:00' }],
          '2025-12-08': [{ taskTitle: '最新タスク', startTime: '09:00', stopTime: '10:00' }],
          '2025-12-06': [{ taskTitle: '中間タスク', startTime: '09:00', stopTime: '10:00' }],
        },
        dailySummary: {},
        meta: { revision: 1 },
      }
      fileContents['LOGS/backups/2025-12/backup.json'] = JSON.stringify(backupData)

      const service = new BackupRestoreService(plugin)
      const latestDate = await service.getLatestDateInBackup('LOGS/backups/2025-12/backup.json')

      expect(latestDate).toBe('2025-12-08')
    })

    test('skips dates with empty execution arrays', async () => {
      const { plugin, fileContents } = createRestoreContext()

      const backupData = {
        taskExecutions: {
          '2025-12-08': [], // Empty - should be skipped
          '2025-12-07': [{ taskTitle: 'タスク', startTime: '09:00', stopTime: '10:00' }],
          '2025-12-06': [{ taskTitle: '古いタスク', startTime: '09:00', stopTime: '10:00' }],
        },
        dailySummary: {},
        meta: { revision: 1 },
      }
      fileContents['LOGS/backups/2025-12/backup.json'] = JSON.stringify(backupData)

      const service = new BackupRestoreService(plugin)
      const latestDate = await service.getLatestDateInBackup('LOGS/backups/2025-12/backup.json')

      expect(latestDate).toBe('2025-12-07')
    })

    test('returns undefined when no execution data exists', async () => {
      const { plugin, fileContents } = createRestoreContext()

      const backupData = {
        taskExecutions: {},
        dailySummary: {},
        meta: { revision: 1 },
      }
      fileContents['LOGS/backups/2025-12/backup.json'] = JSON.stringify(backupData)

      const service = new BackupRestoreService(plugin)
      const latestDate = await service.getLatestDateInBackup('LOGS/backups/2025-12/backup.json')

      expect(latestDate).toBeUndefined()
    })

    test('returns undefined when all dates have empty arrays', async () => {
      const { plugin, fileContents } = createRestoreContext()

      const backupData = {
        taskExecutions: {
          '2025-12-08': [],
          '2025-12-07': [],
        },
        dailySummary: {},
        meta: { revision: 1 },
      }
      fileContents['LOGS/backups/2025-12/backup.json'] = JSON.stringify(backupData)

      const service = new BackupRestoreService(plugin)
      const latestDate = await service.getLatestDateInBackup('LOGS/backups/2025-12/backup.json')

      expect(latestDate).toBeUndefined()
    })

    test('returns undefined when backup file cannot be read', async () => {
      const { plugin } = createRestoreContext()

      const service = new BackupRestoreService(plugin)
      const latestDate = await service.getLatestDateInBackup('LOGS/backups/2025-12/nonexistent.json')

      expect(latestDate).toBeUndefined()
    })
  })

  describe('restoreFromBackup with records rebuild', () => {
    test('rebuilds records for all dates after restore', async () => {
      const { plugin, backupRoot, fileContents, vault } = createRestoreContext()

      // Setup backup file
      const dec2025 = createFolder('LOGS/backups/2025-12')
      attachChild(backupRoot, dec2025)
      const backup = createFile('LOGS/backups/2025-12/2025-12-08T10-00-00-000Z.json', Date.now())
      attachChild(dec2025, backup)

      // Backup contains execution data for multiple dates
      const backupData = JSON.stringify({
        taskExecutions: {
          '2025-12-07': [
            { taskTitle: 'Task 1', instanceId: 'inst-1', startTime: '09:00', stopTime: '10:00', durationSec: 3600 },
          ],
          '2025-12-08': [
            { taskTitle: 'Task 2', instanceId: 'inst-2', startTime: '11:00', stopTime: '12:00', durationSec: 3600 },
            { taskTitle: 'Task 3', instanceId: 'inst-3', startTime: '14:00', stopTime: '15:00', durationSec: 3600 },
          ],
        },
        dailySummary: {
          '2025-12-07': { totalTasks: 1, completedTasks: 1 },
          '2025-12-08': { totalTasks: 2, completedTasks: 2 },
        },
        meta: { revision: 1 },
      })
      fileContents['LOGS/backups/2025-12/2025-12-08T10-00-00-000Z.json'] = backupData

      const service = new BackupRestoreService(plugin)
      await service.restoreFromBackup('2025-12', 'LOGS/backups/2025-12/2025-12-08T10-00-00-000Z.json')

      // Verify records were rebuilt (vault.modify or vault.create should be called for record files)
      const modifyCalls = (vault.modify as jest.Mock).mock.calls
      const createCalls = (vault.create as jest.Mock).mock.calls
      const allWrittenPaths = [
        ...modifyCalls.map((call: [TFile, string]) => call[0].path),
        ...createCalls.map((call: [string, string]) => call[0]),
      ]

      // Should have written snapshot and record files
      expect(allWrittenPaths.some((p: string) => p.includes('2025-12-tasks.json'))).toBe(true)
    })

    test('passes correct canonicalRevision and snapshotMeta to writeDay', async () => {
      const { plugin, backupRoot, fileContents, vault } = createRestoreContext()

      // Setup backup file
      const dec2025 = createFolder('LOGS/backups/2025-12')
      attachChild(backupRoot, dec2025)
      const backup = createFile('LOGS/backups/2025-12/2025-12-10T10-00-00-000Z.json', Date.now())
      attachChild(dec2025, backup)

      // Backup with specific meta information
      const backupData = JSON.stringify({
        taskExecutions: {
          '2025-12-10': [
            { taskTitle: 'Task A', instanceId: 'inst-a', startTime: '09:00', stopTime: '10:00', durationSec: 3600 },
          ],
        },
        dailySummary: {
          '2025-12-10': { totalTasks: 1, completedTasks: 1 },
        },
        meta: {
          revision: 42,
          processedCursor: { 'device-1': 100 },
          lastBackupAt: '2025-12-10T09:00:00Z',
        },
      })
      fileContents['LOGS/backups/2025-12/2025-12-10T10-00-00-000Z.json'] = backupData

      const service = new BackupRestoreService(plugin)
      await service.restoreFromBackup('2025-12', 'LOGS/backups/2025-12/2025-12-10T10-00-00-000Z.json')

      // Check that record file was created with correct frontmatter
      const createCalls = (vault.create as jest.Mock).mock.calls
      const recordCreates = createCalls.filter((call: [string, string]) =>
        call[0].includes('record-2025-12-10.md')
      )

      // Record file should be created
      expect(recordCreates.length).toBe(1)

      // Verify the content includes canonicalRevision (from the frontmatter)
      const recordContent = recordCreates[0][1] as string
      expect(recordContent).toContain('canonicalRevision: 42')
    })

    test('rebuilds records for summary-only dates (no taskExecutions)', async () => {
      const { plugin, backupRoot, fileContents, vault } = createRestoreContext()

      // Setup backup file
      const dec2025 = createFolder('LOGS/backups/2025-12')
      attachChild(backupRoot, dec2025)
      const backup = createFile('LOGS/backups/2025-12/2025-12-15T10-00-00-000Z.json', Date.now())
      attachChild(dec2025, backup)

      // Backup with:
      // - 2025-12-14: has taskExecutions
      // - 2025-12-15: summary-only (no taskExecutions, totalTasks recorded via heatmap)
      const backupData = JSON.stringify({
        taskExecutions: {
          '2025-12-14': [
            { taskTitle: 'Task A', instanceId: 'inst-a', startTime: '09:00', stopTime: '10:00', durationSec: 3600 },
          ],
          // Note: 2025-12-15 is NOT in taskExecutions
        },
        dailySummary: {
          '2025-12-14': { totalTasks: 1, completedTasks: 1 },
          '2025-12-15': { totalTasks: 5, completedTasks: 0 },  // Summary-only date
        },
        meta: { revision: 10 },
      })
      fileContents['LOGS/backups/2025-12/2025-12-15T10-00-00-000Z.json'] = backupData

      const service = new BackupRestoreService(plugin)
      await service.restoreFromBackup('2025-12', 'LOGS/backups/2025-12/2025-12-15T10-00-00-000Z.json')

      // Check that record files were created
      const createCalls = (vault.create as jest.Mock).mock.calls
      const recordPaths = createCalls
        .filter((call: [string, string]) => call[0].includes('record-'))
        .map((call: [string, string]) => call[0])

      // Both dates should have records - including summary-only date
      expect(recordPaths.some((p: string) => p.includes('record-2025-12-14.md'))).toBe(true)
      expect(recordPaths.some((p: string) => p.includes('record-2025-12-15.md'))).toBe(true)

      // Verify the summary-only record contains the summary data
      const summaryOnlyRecord = createCalls.find((call: [string, string]) =>
        call[0].includes('record-2025-12-15.md')
      )
      expect(summaryOnlyRecord).toBeDefined()
      const content = summaryOnlyRecord[1] as string
      expect(content).toContain('totalTasks: 5')
    })

    test('overwrites empty-day records to clear stale data', async () => {
      const { plugin, backupRoot, fileContents, vault } = createRestoreContext()

      const dec2025 = createFolder('LOGS/backups/2025-12')
      attachChild(backupRoot, dec2025)
      const backup = createFile('LOGS/backups/2025-12/2025-12-16T10-00-00-000Z.json', Date.now())
      attachChild(dec2025, backup)

      const recordPath = 'LOGS/records/2025/record-2025-12-16.md'
      fileContents[recordPath] = 'stale record content'

      const backupData = JSON.stringify({
        taskExecutions: {
          '2025-12-16': [],
        },
        dailySummary: {},
        meta: { revision: 3 },
      })
      fileContents['LOGS/backups/2025-12/2025-12-16T10-00-00-000Z.json'] = backupData

      const service = new BackupRestoreService(plugin)
      await service.restoreFromBackup('2025-12', 'LOGS/backups/2025-12/2025-12-16T10-00-00-000Z.json')

      const updated = fileContents[recordPath] ?? ''
      expect(updated).toContain('(no entries)')
      expect(updated).not.toContain('stale record content')
      const modifyCalls = (vault.modify as jest.Mock).mock.calls
      expect(modifyCalls.some((call: [TFile, string]) => call[0].path === recordPath)).toBe(true)
    })
  })
})
