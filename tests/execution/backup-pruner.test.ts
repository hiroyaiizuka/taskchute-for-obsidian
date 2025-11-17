import { TFile, TFolder } from 'obsidian'
import type { TaskChutePluginLike } from '../../src/types'
import { BackupPruner } from '../../src/features/log/services/BackupPruner'

const DAY = 24 * 60 * 60 * 1000

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
  file.stat = { mtime, ctime: mtime, size: 0 }
  return file
}

function attachChild(parent: FolderNode, child: FolderNode | FileNode): void {
  parent.children.push(child)
  ;(child as FolderNode | FileNode).parent = parent
}

function detachChild(target: FolderNode | FileNode): void {
  const parent = (target as FolderNode | FileNode).parent
  if (!parent) return
  parent.children = parent.children.filter((entry) => entry !== target)
}

function createPrunerContext(retentionDays = 30) {
  const backupRoot = createFolder('LOGS/.backups')
  const vault = {
    adapter: {
      stat: jest.fn(),
    },
    getAbstractFileByPath: jest.fn((path: string) => (path === 'LOGS/.backups' ? backupRoot : null)),
    delete: jest.fn(async (target: FolderNode | FileNode) => {
      detachChild(target)
    }),
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
      backupRetentionDays: retentionDays,
      backupIntervalHours: 24,
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

  return { plugin, backupRoot }
}

describe('BackupPruner', () => {
  test('removes backup files older than retention window', async () => {
    const { plugin, backupRoot } = createPrunerContext(30)
    const monthFolder = createFolder('LOGS/.backups/2025-10')
    attachChild(backupRoot, monthFolder)
    const oldFile = createFile('LOGS/.backups/2025-10/old.json', Date.now() - 40 * DAY)
    const recentFile = createFile('LOGS/.backups/2025-10/recent.json', Date.now() - 5 * DAY)
    attachChild(monthFolder, oldFile)
    attachChild(monthFolder, recentFile)

    const pruner = new BackupPruner(plugin)
    await pruner.prune()

    expect(plugin.app.vault.delete).toHaveBeenCalledWith(oldFile)
    expect(plugin.app.vault.delete).not.toHaveBeenCalledWith(recentFile)
    expect(monthFolder.children).toContain(recentFile)
  })

  test('deletes empty month folder after pruning files', async () => {
    const { plugin, backupRoot } = createPrunerContext(7)
    const monthFolder = createFolder('LOGS/.backups/2025-09')
    attachChild(backupRoot, monthFolder)
    const expired = createFile('LOGS/.backups/2025-09/old.json', Date.now() - 60 * DAY)
    attachChild(monthFolder, expired)

    const pruner = new BackupPruner(plugin)
    await pruner.prune()

    expect(plugin.app.vault.delete).toHaveBeenCalledWith(expired)
    expect(plugin.app.vault.delete).toHaveBeenCalledWith(monthFolder)
    expect(backupRoot.children).toHaveLength(0)
  })
})
