import { createAiTaskManager, type AiTaskPluginLike } from '../../../src/features/ai-task'
import type { TaskChuteSettings } from '../../../src/types'

type FactoryModule = typeof import('../../../src/features/ai-task')

function makePlugin(settings: Partial<TaskChuteSettings> = {}): AiTaskPluginLike {
  return {
    app: {
      vault: {},
      metadataCache: {},
      fileManager: {},
    },
    settings: {
      aiTaskEnabled: true,
      aiTaskLogRetentionDays: 30,
      ...settings,
    } as TaskChuteSettings,
    pathManager: {
      getTaskFolderPath: () => 'TaskChute/Task',
      getProjectFolderPath: () => null,
      getLogDataPath: () => 'TaskChute/Log',
      getReviewDataPath: () => 'TaskChute/Review',
      ensureFolderExists: async () => undefined,
      getLogYearPath: (year: string | number) => `TaskChute/Log/${year}`,
      ensureYearFolder: async (year: string | number) => `TaskChute/Log/${year}`,
      validatePath: () => ({ valid: true }),
      getAiLogsPath: () => 'TaskChute/AI/Logs',
      getAiLogsMonthPath: (yearMonth: string) => `TaskChute/AI/Logs/${yearMonth}`,
    },
    _log: jest.fn(),
  } as unknown as AiTaskPluginLike
}

describe('createAiTaskManager gating', () => {
  test('returns undefined when the AI task feature is disabled', () => {
    const manager = createAiTaskManager(makePlugin({ aiTaskEnabled: false }))
    expect(manager).toBeUndefined()
  })

  test('returns undefined when Platform is unavailable (mock has no Platform)', () => {
    // The shared obsidian mock intentionally does not export Platform, which
    // mirrors non-desktop runtimes where Platform?.isDesktop is falsy.
    const manager = createAiTaskManager(makePlugin({ aiTaskEnabled: true }))
    expect(manager).toBeUndefined()
  })

  test('returns undefined on mobile platforms', () => {
    jest.isolateModules(() => {
      jest.doMock('obsidian', () => ({
        ...jest.requireActual<Record<string, unknown>>('obsidian'),
        Platform: { isDesktop: false, isMobile: true },
      }))
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('../../../src/features/ai-task') as FactoryModule
      expect(mod.createAiTaskManager(makePlugin())).toBeUndefined()
    })
  })

  test('creates a manager when enabled on desktop', () => {
    jest.isolateModules(() => {
      jest.doMock('obsidian', () => ({
        ...jest.requireActual<Record<string, unknown>>('obsidian'),
        Platform: { isDesktop: true, isMobile: false },
      }))
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('../../../src/features/ai-task') as FactoryModule
      const manager = mod.createAiTaskManager(makePlugin())
      expect(manager).toBeDefined()
      expect(typeof manager?.startRun).toBe('function')
      expect(typeof manager?.dispose).toBe('function')
      manager?.dispose()
    })
  })

  test('returns undefined when the path manager lacks AI log paths', () => {
    jest.isolateModules(() => {
      jest.doMock('obsidian', () => ({
        ...jest.requireActual<Record<string, unknown>>('obsidian'),
        Platform: { isDesktop: true, isMobile: false },
      }))
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('../../../src/features/ai-task') as FactoryModule
      const plugin = makePlugin()
      delete (plugin.pathManager as Record<string, unknown>)['getAiLogsPath']
      expect(mod.createAiTaskManager(plugin)).toBeUndefined()
    })
  })
})
