import {
  AI_TASK_APP_RESTART_GRACE_MS,
  disposeAiTaskManagerTracked,
  getSharedAiTaskManagersPendingDisposal,
  registerAiTaskAppShutdownCleanup,
} from '../../../src/features/ai-task/registerProcessCleanup'
import type { AiTaskManager } from '../../../src/features/ai-task/services/AiTaskManager'
import {
  forgetRetainedAiTaskManager,
  retainAiTaskManager,
} from '../../../src/features/ai-task/services/AiTaskRuntimeLease'

type CleanupHost = Parameters<typeof registerAiTaskAppShutdownCleanup>[0]

function quitRegistrationStub() {
  const eventRef = { unload: jest.fn() }
  return {
    app: { workspace: { on: jest.fn(() => eventRef) } },
    registerEvent: jest.fn(),
  }
}

describe('registerAiTaskAppShutdownCleanup', () => {
  test('shares pending shutdown retries across plugin hot-reload instances', () => {
    const rendererRoot = {}
    const app = {}
    const oldPluginPending = getSharedAiTaskManagersPendingDisposal(
      app,
      rendererRoot,
    )
    const newPluginPending = getSharedAiTaskManagersPendingDisposal(
      app,
      rendererRoot,
    )
    const anotherVaultPending = getSharedAiTaskManagersPendingDisposal(
      {},
      rendererRoot,
    )
    const manager = {
      dispose: jest.fn(),
      disposeAndWait: jest.fn().mockResolvedValue(undefined),
    }

    oldPluginPending.add(manager as never)

    expect(newPluginPending).toBe(oldPluginPending)
    expect(newPluginPending.has(manager as never)).toBe(true)
    expect(anotherVaultPending).not.toBe(oldPluginPending)
    expect(anotherVaultPending.size).toBe(0)
  })

  test('registers a workspace quit task that waits for force-kill completion', async () => {
    let onQuit: ((tasks: { addPromise(promise: Promise<unknown>): void }) => void) | null =
      null
    const completion = Promise.resolve()
    const manager = {
      dispose: jest.fn(),
      disposeAndWait: jest.fn(() => completion),
    }
    const eventRef = { unload: jest.fn() }
    const host = {
      aiTaskManager: manager,
      app: {
        workspace: {
          on: jest.fn(
            (
              event: string,
              listener: (tasks: { addPromise(promise: Promise<unknown>): void }) => void,
            ) => {
              if (event === 'quit') onQuit = listener
              return eventRef
            },
          ),
        },
      },
      registerEvent: jest.fn(),
    }

    registerAiTaskAppShutdownCleanup(host as unknown as CleanupHost)
    expect(host.registerEvent).toHaveBeenCalledWith(eventRef)

    const tasks = { addPromise: jest.fn() }
    ;(onQuit as ((value: typeof tasks) => void) | null)?.(tasks)

    expect(manager.disposeAndWait).toHaveBeenCalledTimes(1)
    expect(tasks.addPromise).toHaveBeenCalledWith(completion)
    await completion
  })

  test('workspace quit arms retained broker cleanup without disposing the live run', async () => {
    let onQuit:
      | ((tasks: { addPromise(promise: Promise<unknown>): void }) => void)
      | null = null
    const scheduled = Promise.resolve()
    const manager = {
      dispose: jest.fn(),
      disposeAndWait: jest.fn().mockResolvedValue(undefined),
      isDisposed: jest.fn(() => false),
      persistSessionStateForRendererReload: jest.fn(),
      prepareForRendererReload: jest.fn(),
      scheduleTerminalShutdownAfterGrace: jest.fn(() => scheduled),
      stopNonPersistentRunsForRendererTransitionAndWait: jest.fn(
        () => Promise.resolve(),
      ),
      rebindRuntimeDependencies: jest.fn(),
    }
    const app = {
      workspace: {
        on: jest.fn(
          (
            _event: string,
            listener: (tasks: {
              addPromise(promise: Promise<unknown>): void
            }) => void,
          ) => {
            onQuit = listener
            return { unload: jest.fn() }
          },
        ),
      },
    }
    const host = {
      app,
      aiTaskManager: manager,
      aiTaskManagersPendingDisposal: new Set(),
      registerEvent: jest.fn(),
    }
    retainAiTaskManager(app, manager as unknown as AiTaskManager)

    registerAiTaskAppShutdownCleanup(host as unknown as CleanupHost)
    const tasks = { addPromise: jest.fn() }
    onQuit?.(tasks)

    expect(manager.persistSessionStateForRendererReload).toHaveBeenCalledTimes(1)
    expect(manager.scheduleTerminalShutdownAfterGrace).toHaveBeenCalledWith(
      AI_TASK_APP_RESTART_GRACE_MS,
      expect.any(String),
      expect.any(String),
      expect.any(Number),
    )
    expect(
      manager.stopNonPersistentRunsForRendererTransitionAndWait,
    ).not.toHaveBeenCalled()
    expect(manager.dispose).not.toHaveBeenCalled()
    expect(manager.disposeAndWait).not.toHaveBeenCalled()
    expect(tasks.addPromise).toHaveBeenCalledWith(scheduled)
    expect(tasks.addPromise).toHaveBeenCalledTimes(1)
    await scheduled

    forgetRetainedAiTaskManager(manager)
  })

  test('hot-upgraded retained manager without new shutdown APIs uses legacy preparation', () => {
    let onQuit:
      | ((tasks: { addPromise(promise: Promise<unknown>): void }) => void)
      | null = null
    const manager = {
      dispose: jest.fn(),
      disposeAndWait: jest.fn().mockResolvedValue(undefined),
      isDisposed: jest.fn(() => false),
      prepareForRendererReload: jest.fn(),
      rebindRuntimeDependencies: jest.fn(),
    }
    const app = {
      workspace: {
        on: jest.fn(
          (
            _event: string,
            listener: (tasks: {
              addPromise(promise: Promise<unknown>): void
            }) => void,
          ) => {
            onQuit = listener
            return { unload: jest.fn() }
          },
        ),
      },
    }
    const host = {
      app,
      aiTaskManager: manager,
      aiTaskManagersPendingDisposal: new Set(),
      registerEvent: jest.fn(),
    }
    retainAiTaskManager(app, manager as unknown as AiTaskManager)
    registerAiTaskAppShutdownCleanup(host as unknown as CleanupHost)

    const tasks = { addPromise: jest.fn() }
    expect(() => onQuit?.(tasks)).not.toThrow()

    expect(manager.prepareForRendererReload).toHaveBeenCalledTimes(1)
    expect(manager.dispose).not.toHaveBeenCalled()
    expect(manager.disposeAndWait).not.toHaveBeenCalled()
    expect(tasks.addPromise).not.toHaveBeenCalled()

    forgetRetainedAiTaskManager(manager)
  })

  test('does not register renderer lifecycle on a focus-sensitive window', () => {
    const registerDomEvent = jest.fn()
    const host = {
      ...quitRegistrationStub(),
      registerDomEvent,
    }

    registerAiTaskAppShutdownCleanup(host as unknown as CleanupHost)
    expect(registerDomEvent).not.toHaveBeenCalled()
  })

  test('waits for a manager still disposing after the settings toggle removed it', () => {
    let onQuit: ((tasks: { addPromise(promise: Promise<unknown>): void }) => void) | null =
      null
    const completion = new Promise<void>(() => undefined)
    const pendingManager = {
      dispose: jest.fn(),
      disposeAndWait: jest.fn(() => completion),
    }
    const host = {
      aiTaskManager: undefined,
      aiTaskManagersPendingDisposal: new Set([pendingManager]),
      app: {
        workspace: {
          on: jest.fn(
            (
              _event: string,
              listener: (tasks: { addPromise(promise: Promise<unknown>): void }) => void,
            ) => {
              onQuit = listener
              return { unload: jest.fn() }
            },
          ),
        },
      },
      registerEvent: jest.fn(),
    }

    registerAiTaskAppShutdownCleanup(host as unknown as CleanupHost)
    const tasks = { addPromise: jest.fn() }
    ;(onQuit as ((value: typeof tasks) => void) | null)?.(tasks)

    expect(pendingManager.disposeAndWait).toHaveBeenCalledTimes(1)
    expect(tasks.addPromise).toHaveBeenCalledWith(completion)
  })

  test('looks up the manager at quit-event time and tolerates it being disabled', () => {
    let onQuit:
      | ((tasks: { addPromise(promise: Promise<unknown>): void }) => void)
      | null = null
    const host = {
      app: {
        workspace: {
          on: jest.fn(
            (
              _event: string,
              listener: (tasks: {
                addPromise(promise: Promise<unknown>): void
              }) => void,
            ) => {
              onQuit = listener
              return { unload: jest.fn() }
            },
          ),
        },
      },
      registerEvent: jest.fn(),
      aiTaskManager: undefined as
        | {
            dispose(): void
            disposeAndWait(): Promise<void>
            prepareForRendererReload(): void
          }
        | undefined,
    }

    registerAiTaskAppShutdownCleanup(host as unknown as CleanupHost)
    const emptyTasks = { addPromise: jest.fn() }
    expect(() => onQuit?.(emptyTasks)).not.toThrow()
    expect(emptyTasks.addPromise).not.toHaveBeenCalled()

    const laterManager = {
      dispose: jest.fn(),
      disposeAndWait: jest.fn().mockResolvedValue(undefined),
      prepareForRendererReload: jest.fn(),
    }
    host.aiTaskManager = laterManager
    const tasks = { addPromise: jest.fn() }
    onQuit?.(tasks)
    expect(laterManager.disposeAndWait).toHaveBeenCalledTimes(1)
    expect(tasks.addPromise).toHaveBeenCalledWith(
      laterManager.disposeAndWait.mock.results[0]?.value,
    )
  })
})

describe('disposeAiTaskManagerTracked', () => {
  test('keeps the manager registered until disposal completes', async () => {
    let resolveCompletion: (() => void) | null = null
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve
    })
    const manager = {
      dispose: jest.fn(),
      disposeAndWait: jest.fn(() => completion),
    }
    const pending = new Set<typeof manager>()

    disposeAiTaskManagerTracked(
      { aiTaskManagersPendingDisposal: pending },
      manager,
    )

    expect(manager.disposeAndWait).toHaveBeenCalledTimes(1)
    expect(pending.has(manager)).toBe(true)

    ;(resolveCompletion as (() => void) | null)?.()
    await completion
    await Promise.resolve()
    expect(pending.has(manager)).toBe(false)
  })

  test('keeps an unconfirmed shutdown registered so app quit can retry it', async () => {
    const shutdownError = new Error('broker shutdown unconfirmed')
    const manager = {
      dispose: jest.fn(),
      disposeAndWait: jest.fn()
        .mockRejectedValueOnce(shutdownError)
        .mockResolvedValueOnce(undefined),
    }
    const pending = new Set<typeof manager>()

    disposeAiTaskManagerTracked(
      { aiTaskManagersPendingDisposal: pending },
      manager,
    )
    await Promise.resolve()
    await Promise.resolve()

    expect(pending.has(manager)).toBe(true)

    let onQuit:
      | ((tasks: { addPromise(promise: Promise<unknown>): void }) => void)
      | null = null
    const host = {
      aiTaskManager: undefined,
      aiTaskManagersPendingDisposal: pending,
      app: {
        workspace: {
          on: jest.fn(
            (
              _event: string,
              listener: (tasks: {
                addPromise(promise: Promise<unknown>): void
              }) => void,
            ) => {
              onQuit = listener
              return { unload: jest.fn() }
            },
          ),
        },
      },
      registerEvent: jest.fn(),
    }
    registerAiTaskAppShutdownCleanup(host as unknown as CleanupHost)
    const tasks = { addPromise: jest.fn() }
    onQuit?.(tasks)
    const retry = tasks.addPromise.mock.calls[0]?.[0] as Promise<void>
    await retry
    await Promise.resolve()

    expect(manager.disposeAndWait).toHaveBeenCalledTimes(2)
    expect(pending.has(manager)).toBe(false)
  })
})
