import { createAiTaskManager, type AiTaskPluginLike } from '../../../src/features/ai-task'
import type { TaskChuteSettings } from '../../../src/types'
import { createFakeLicenseManager } from '../license/fakeLicenseManager'

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
    licenseManager: createFakeLicenseManager(),
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
      const mod = require('../../../src/features/ai-task') as FactoryModule
      expect(mod.createAiTaskManager(makePlugin())).toBeUndefined()
    })
  })

  test('returns undefined without an active license, even when enabled on desktop', () => {
    jest.isolateModules(() => {
      jest.doMock('obsidian', () => ({
        ...jest.requireActual<Record<string, unknown>>('obsidian'),
        Platform: { isDesktop: true, isMobile: false },
      }))
      const mod = require('../../../src/features/ai-task') as FactoryModule
      const plugin = makePlugin()
      ;(plugin as { licenseManager?: unknown }).licenseManager = createFakeLicenseManager(false)
      expect(mod.createAiTaskManager(plugin)).toBeUndefined()
    })
  })

  test('returns undefined when no license manager exists at all', () => {
    jest.isolateModules(() => {
      jest.doMock('obsidian', () => ({
        ...jest.requireActual<Record<string, unknown>>('obsidian'),
        Platform: { isDesktop: true, isMobile: false },
      }))
      const mod = require('../../../src/features/ai-task') as FactoryModule
      const plugin = makePlugin()
      delete (plugin as { licenseManager?: unknown }).licenseManager
      // Fails closed: a bootstrap failure must not hand out the paid feature.
      expect(mod.createAiTaskManager(plugin)).toBeUndefined()
    })
  })

  test('creates a manager when enabled on desktop', () => {
    jest.isolateModules(() => {
      jest.doMock('obsidian', () => ({
        ...jest.requireActual<Record<string, unknown>>('obsidian'),
        Platform: { isDesktop: true, isMobile: false },
      }))
      const mod = require('../../../src/features/ai-task') as FactoryModule
      const manager = mod.createAiTaskManager(makePlugin())
      expect(manager).toBeDefined()
      expect(typeof manager?.startRun).toBe('function')
      expect(typeof manager?.dispose).toBe('function')
      manager?.dispose()
    })
  })

  test('constructs the broker client with the same persisted lease retained by the manager', () => {
    jest.isolateModules(() => {
      let constructedOptions: Record<string, unknown> | undefined
      const setLease = jest.fn()
      jest.doMock('obsidian', () => ({
        ...jest.requireActual<Record<string, unknown>>('obsidian'),
        Platform: { isDesktop: true, isMobile: false },
      }))
      jest.doMock(
        '../../../src/features/ai-task/services/TerminalSessionBroker',
        () => ({
          TerminalSessionBrokerClient: class {
            constructor(options: Record<string, unknown>) {
              constructedOptions = options
            }

            setRendererLeaseToken(
              token: string,
              ownerId?: string,
              generation?: number,
            ): Promise<void> {
              setLease(token, ownerId, generation)
              return Promise.resolve()
            }

            detach(): void {}

            shutdown(): Promise<void> {
              return Promise.resolve()
            }
          },
        }),
      )
      const mod = require('../../../src/features/ai-task') as FactoryModule
      const runtimeLease = require(
        '../../../src/features/ai-task/services/AiTaskRuntimeLease'
      ) as typeof import('../../../src/features/ai-task/services/AiTaskRuntimeLease')
      const plugin = makePlugin()
      let persistedGeneration: unknown = 41
      ;(plugin.app.vault as unknown as Record<string, unknown>)['adapter'] = {
        getBasePath: () => '/vault',
      }
      ;(plugin.app as unknown as Record<string, unknown>)['loadLocalStorage'] =
        (key: string) =>
          key ===
          runtimeLease.AI_TASK_TERMINAL_RENDERER_LEASE_GENERATION_STORAGE_KEY
            ? persistedGeneration
            : undefined
      ;(plugin.app as unknown as Record<string, unknown>)['saveLocalStorage'] =
        (key: string, value: unknown) => {
          if (
            key ===
            runtimeLease.AI_TASK_TERMINAL_RENDERER_LEASE_GENERATION_STORAGE_KEY
          ) {
            persistedGeneration = value
          }
        }

      const created = mod.createAiTaskManager(plugin)
      expect(created).toBeDefined()
      const retainedIdentity =
        runtimeLease.getAiTaskRuntimeTerminalLeaseIdentity(
          created as NonNullable<typeof created>,
        )
      expect(retainedIdentity).toBeDefined()
      expect(constructedOptions).toMatchObject({
        rendererLeaseToken: retainedIdentity?.token,
        rendererLeaseOwnerId: retainedIdentity?.ownerId,
        rendererLeaseGeneration: retainedIdentity?.generation,
      })
      expect(setLease).toHaveBeenCalledWith(
        retainedIdentity?.token,
        retainedIdentity?.ownerId,
        retainedIdentity?.generation,
      )
      expect(persistedGeneration).toBe(retainedIdentity?.generation)

      runtimeLease.forgetRetainedAiTaskManager(
        created as NonNullable<typeof created>,
      )
      created?.dispose()
    })
  })

  test('returns undefined when the path manager lacks AI log paths', () => {
    jest.isolateModules(() => {
      jest.doMock('obsidian', () => ({
        ...jest.requireActual<Record<string, unknown>>('obsidian'),
        Platform: { isDesktop: true, isMobile: false },
      }))
      const mod = require('../../../src/features/ai-task') as FactoryModule
      const plugin = makePlugin()
      delete (plugin.pathManager as Record<string, unknown>)['getAiLogsPath']
      expect(mod.createAiTaskManager(plugin)).toBeUndefined()
    })
  })
})
