import {
  disposeAiTaskManagerTracked,
  registerAiTaskAppShutdownCleanup,
} from '../../../src/features/ai-task/registerProcessCleanup'

type CleanupHost = Parameters<typeof registerAiTaskAppShutdownCleanup>[0]

function quitRegistrationStub() {
  const eventRef = { unload: jest.fn() }
  return {
    app: { workspace: { on: jest.fn(() => eventRef) } },
    registerEvent: jest.fn(),
  }
}

describe('registerAiTaskAppShutdownCleanup', () => {
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
      registerDomEvent: jest.fn(),
    }

    registerAiTaskAppShutdownCleanup(host as unknown as CleanupHost, window)
    expect(host.registerEvent).toHaveBeenCalledWith(eventRef)

    const tasks = { addPromise: jest.fn() }
    ;(onQuit as ((value: typeof tasks) => void) | null)?.(tasks)

    expect(manager.disposeAndWait).toHaveBeenCalledTimes(1)
    expect(tasks.addPromise).toHaveBeenCalledWith(completion)
    await completion
  })

  test('detaches the current manager synchronously on beforeunload', () => {
    let beforeUnload: (() => void) | null = null
    const manager = {
      dispose: jest.fn(),
      prepareForRendererReload: jest.fn(),
    }
    const host = {
      ...quitRegistrationStub(),
      aiTaskManager: manager,
      registerDomEvent: jest.fn(
        (_target: Window, event: string, listener: () => void) => {
          if (event === 'beforeunload') beforeUnload = listener
        },
      ),
    }

    registerAiTaskAppShutdownCleanup(host as unknown as CleanupHost, window)
    expect(host.registerDomEvent).toHaveBeenCalledWith(
      window,
      'beforeunload',
      expect.any(Function),
    )

    ;(beforeUnload as (() => void) | null)?.()
    expect(manager.prepareForRendererReload).toHaveBeenCalledTimes(1)
    expect(manager.dispose).not.toHaveBeenCalled()
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
      registerDomEvent: jest.fn(),
    }

    registerAiTaskAppShutdownCleanup(host as unknown as CleanupHost, window)
    const tasks = { addPromise: jest.fn() }
    ;(onQuit as ((value: typeof tasks) => void) | null)?.(tasks)

    expect(pendingManager.disposeAndWait).toHaveBeenCalledTimes(1)
    expect(tasks.addPromise).toHaveBeenCalledWith(completion)
  })

  test('looks up the manager at event time and tolerates it being disabled', () => {
    let beforeUnload: (() => void) | null = null
    const host = {
      ...quitRegistrationStub(),
      aiTaskManager: undefined as
        | {
            dispose(): void
            disposeAndWait(): Promise<void>
            prepareForRendererReload(): void
          }
        | undefined,
      registerDomEvent: (_target: Window, _event: string, listener: () => void) => {
        beforeUnload = listener
      },
    }

    registerAiTaskAppShutdownCleanup(host as unknown as CleanupHost, window)
    expect(() => (beforeUnload as (() => void) | null)?.()).not.toThrow()

    const laterManager = {
      dispose: jest.fn(),
      disposeAndWait: jest.fn().mockResolvedValue(undefined),
      prepareForRendererReload: jest.fn(),
    }
    host.aiTaskManager = laterManager
    ;(beforeUnload as (() => void) | null)?.()
    expect(laterManager.prepareForRendererReload).toHaveBeenCalledTimes(1)
    expect(laterManager.dispose).not.toHaveBeenCalled()
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
})
