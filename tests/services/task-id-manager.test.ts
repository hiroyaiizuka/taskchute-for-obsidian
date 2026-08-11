import { TFile } from 'obsidian'
import { TaskIdManager, TASK_ID_FRONTMATTER_KEY } from '../../src/services/TaskIdManager'
import type { TaskChutePluginLike } from '../../src/types'

describe('TaskIdManager', () => {
  const createFile = (path: string): TFile => {
    const file = new TFile()
    file.path = path
    file.basename = path.split('/').pop() ?? 'task'
    file.extension = 'md'
    return file
  }

  const createPlugin = () => {
    const fileManager = {
      processFrontMatter: jest.fn(async (_file: TFile, updater: (fm: Record<string, unknown>) => void) => {
        updater({})
      }),
      trashFile: jest.fn(),
    }

    const metadataCache = {
      getFileCache: jest.fn().mockReturnValue({ frontmatter: {} }),
    }

    const vault = {
      getMarkdownFiles: jest.fn().mockReturnValue([]),
      getAbstractFileByPath: jest.fn(),
      read: jest.fn(),
      modify: jest.fn(),
      create: jest.fn(),
    }

    const plugin = {
      app: {
        vault,
        fileManager,
        metadataCache,
      },
      pathManager: {
        getTaskFolderPath: () => 'TaskChute/Task',
      },
      _log: jest.fn(),
    } as unknown as TaskChutePluginLike

    return { plugin, fileManager, metadataCache, vault }
  }

  test('ensureTaskIdForFile writes a new id when missing', async () => {
    const { plugin, fileManager, metadataCache } = createPlugin()
    const file = createFile('TaskChute/Task/sample.md')
    metadataCache.getFileCache = jest.fn().mockReturnValue({ frontmatter: {} })
    const assigned: Record<string, unknown>[] = []
    fileManager.processFrontMatter = jest.fn(async (_: TFile, updater: (fm: Record<string, unknown>) => void) => {
      const fm: Record<string, unknown> = {}
      updater(fm)
      assigned.push(fm)
    })

    const manager = new TaskIdManager(plugin)
    const id = await manager.ensureTaskIdForFile(file)

    expect(id).toBeTruthy()
    expect(id).toMatch(/^tc-task-/)
    expect(assigned[0]?.[TASK_ID_FRONTMATTER_KEY]).toBe(id)
  })

  test('ensureTaskIdForFile migrates legacy taskchuteId to taskId', async () => {
    const { plugin, metadataCache, fileManager } = createPlugin()
    const file = createFile('TaskChute/Task/sample.md')
    metadataCache.getFileCache = jest
      .fn()
      .mockReturnValue({ frontmatter: { taskchuteId: 'tc-task-legacy' } })

    const updated: Record<string, unknown>[] = []
    fileManager.processFrontMatter = jest.fn(async (_: TFile, updater: (fm: Record<string, unknown>) => void) => {
      const fm: Record<string, unknown> = { taskchuteId: 'tc-task-legacy' }
      updater(fm)
      updated.push(fm)
    })

    const manager = new TaskIdManager(plugin)
    const id = await manager.ensureTaskIdForFile(file)

    expect(id).toBe('tc-task-legacy')
    expect(updated).toHaveLength(1)
    expect(updated[0]?.[TASK_ID_FRONTMATTER_KEY]).toBe('tc-task-legacy')
    expect(updated[0]?.taskchuteId).toBeUndefined()
  })

  test('ensureAllTaskIds skips files outside task folder', async () => {
    const { plugin, fileManager, metadataCache, vault } = createPlugin()
    const included = createFile('TaskChute/Task/included.md')
    const excluded = createFile('Other/folder.md')
    vault.getMarkdownFiles = jest.fn().mockReturnValue([included, excluded])
    metadataCache.getFileCache = jest.fn().mockReturnValue({ frontmatter: {} })
    const updates: string[] = []
    fileManager.processFrontMatter = jest.fn(async (file: TFile, updater: (fm: Record<string, unknown>) => void) => {
      updates.push(file.path)
      updater({})
    })

    const manager = new TaskIdManager(plugin)
    await manager.ensureAllTaskIds()

    expect(updates).toEqual(['TaskChute/Task/included.md'])
  })
})
