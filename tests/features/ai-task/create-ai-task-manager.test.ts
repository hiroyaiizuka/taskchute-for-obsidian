import { createAiTaskManager, type AiTaskPluginLike } from '@/features/ai-task'
import type { TaskChuteSettings } from '@/types'
import { createFakeLicenseManager } from '../license/fakeLicenseManager'

type FactoryModule = typeof import('@/features/ai-task')

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

  test('returns undefined when Platform is unavailable', () => {
    // The shared mock now supplies a desktop Platform, so the defensive path —
    // createAiTaskManager reads Platform?.isDesktop rather than assuming the
    // export exists — needs the absence staged explicitly.
    jest.isolateModules(() => {
      jest.doMock('obsidian', () => ({
        ...jest.requireActual<Record<string, unknown>>('obsidian'),
        Platform: undefined,
      }))
      const mod = require('@/features/ai-task') as FactoryModule
      expect(mod.createAiTaskManager(makePlugin({ aiTaskEnabled: true }))).toBeUndefined()
    })
  })

  test('returns undefined on mobile platforms', () => {
    jest.isolateModules(() => {
      jest.doMock('obsidian', () => ({
        ...jest.requireActual<Record<string, unknown>>('obsidian'),
        Platform: { isDesktop: false, isMobile: true },
      }))
      const mod = require('@/features/ai-task') as FactoryModule
      expect(mod.createAiTaskManager(makePlugin())).toBeUndefined()
    })
  })

  test('returns undefined without an active license, even when enabled on desktop', () => {
    jest.isolateModules(() => {
      jest.doMock('obsidian', () => ({
        ...jest.requireActual<Record<string, unknown>>('obsidian'),
        Platform: { isDesktop: true, isMobile: false },
      }))
      const mod = require('@/features/ai-task') as FactoryModule
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
      const mod = require('@/features/ai-task') as FactoryModule
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
      const mod = require('@/features/ai-task') as FactoryModule
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
        '@/features/ai-task/services/TerminalSessionBroker',
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
      const mod = require('@/features/ai-task') as FactoryModule
      const runtimeLease = require(
        '@/features/ai-task/services/AiTaskRuntimeLease'
      ) as typeof import('@/features/ai-task/services/AiTaskRuntimeLease')
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

  // LEV-404: Windows terminals live in the broker when Node.js is there to run it.
  test.each([
    ['a Node.js is found', ['C:\\Program Files\\nodejs\\node.exe'], 'BrokerTerminalDispatcher'],
    ['no Node.js is found', [], 'TerminalDispatcher'],
  ])('on Windows, when %s, terminals use the %s', (_label, nodes, expected) => {
    jest.isolateModules(() => {
      jest.doMock('obsidian', () => ({
        ...jest.requireActual<Record<string, unknown>>('obsidian'),
        Platform: { isDesktop: true, isMobile: false },
      }))
      jest.doMock('@/features/ai-task/services/NodeProcessGateway', () => {
        const actual = jest.requireActual<
          typeof import('@/features/ai-task/services/NodeProcessGateway')
        >('@/features/ai-task/services/NodeProcessGateway')
        class WindowsGateway extends actual.NodeProcessGateway {
          getPtyTransport() {
            return 'conpty' as const
          }
          isPtySupported() {
            // The ConPTY probe has not run yet when the manager is built.
            return false
          }
        }
        return { ...actual, NodeProcessGateway: WindowsGateway }
      })
      const locateNodeOnDisk = jest.fn(() => nodes)
      jest.doMock('@/features/ai-task/services/TerminalSessionBroker', () => ({
        locateNodeOnDisk,
        TerminalSessionBrokerClient: class {
          setRendererLeaseToken(): Promise<void> {
            return Promise.resolve()
          }
          detach(): void {}
          shutdown(): Promise<void> {
            return Promise.resolve()
          }
        },
      }))
      const mod = require('@/features/ai-task') as FactoryModule
      const runtimeLease = require(
        '@/features/ai-task/services/AiTaskRuntimeLease'
      ) as typeof import('@/features/ai-task/services/AiTaskRuntimeLease')
      const plugin = makePlugin()
      ;(plugin.app.vault as unknown as Record<string, unknown>)['adapter'] = {
        getBasePath: () => 'C:\\vault',
      }

      const created = mod.createAiTaskManager(plugin)
      const dispatcher = (
        created as unknown as { deps: { terminal: { dispatcher: object } } }
      ).deps.terminal.dispatcher

      expect(locateNodeOnDisk).toHaveBeenCalled()
      expect(dispatcher.constructor.name).toBe(expected)
      runtimeLease.forgetRetainedAiTaskManager(created as NonNullable<typeof created>)
      created?.dispose()
    })
  })

  // LEV-390: the manager asks this device's approvals before every spawn.
  test("wires the working-folder check to this device's approvals", () => {
    jest.isolateModules(() => {
      jest.doMock('obsidian', () => ({
        ...jest.requireActual<Record<string, unknown>>('obsidian'),
        Platform: { isDesktop: true, isMobile: false },
      }))
      const mod = require('@/features/ai-task') as FactoryModule
      const runtimeLease = require(
        '@/features/ai-task/services/AiTaskRuntimeLease'
      ) as typeof import('@/features/ai-task/services/AiTaskRuntimeLease')
      const plugin = makePlugin()
      const storage = new Map<string, unknown>()
      ;(plugin.app.vault as unknown as Record<string, unknown>)['adapter'] = {
        getBasePath: () => '/vault',
      }
      ;(plugin.app as unknown as Record<string, unknown>)['loadLocalStorage'] = (key: string) =>
        storage.get(key)
      ;(plugin.app as unknown as Record<string, unknown>)['saveLocalStorage'] = (
        key: string,
        value: unknown,
      ) => {
        storage.set(key, value)
      }

      const created = mod.createAiTaskManager(plugin)
      const check = (created as unknown as {
        deps: { isWorkingFolderAllowed?: (run: { cwd?: string; cwdIsVault: boolean; trust: boolean }) => boolean }
      }).deps.isWorkingFolderAllowed
      expect(check).toBeDefined()
      const elsewhere = { cwd: '/Users/me/x', cwdIsVault: false, trust: false }
      expect(check?.(elsewhere)).toBe(false)
      expect(check?.({ cwd: '/vault', cwdIsVault: true, trust: false })).toBe(true)
      storage.set('taskchute-plus-ai-approved-folders', ['/Users/me/x'])
      expect(check?.(elsewhere)).toBe(true)

      runtimeLease.forgetRetainedAiTaskManager(created as NonNullable<typeof created>)
      created?.dispose()
    })
  })

  test('returns undefined when the path manager lacks AI log paths', () => {
    jest.isolateModules(() => {
      jest.doMock('obsidian', () => ({
        ...jest.requireActual<Record<string, unknown>>('obsidian'),
        Platform: { isDesktop: true, isMobile: false },
      }))
      const mod = require('@/features/ai-task') as FactoryModule
      const plugin = makePlugin()
      delete (plugin.pathManager as Record<string, unknown>)['getAiLogsPath']
      expect(mod.createAiTaskManager(plugin)).toBeUndefined()
    })
  })
})
