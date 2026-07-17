import type {
  AiTaskManager,
  AiTaskManagerDeps,
} from '../../../src/features/ai-task/services/AiTaskManager'
import {
  acquireRetainedAiTaskManager,
  forgetRetainedAiTaskManager,
  retainAiTaskManager,
  scheduleAiTaskManagerHotReloadHandoff,
  type AiTaskRuntimeWindow,
} from '../../../src/features/ai-task/services/AiTaskRuntimeLease'

type FakeManager = Pick<
  AiTaskManager,
  | 'dispose'
  | 'isDisposed'
  | 'prepareForRendererReload'
  | 'rebindRuntimeDependencies'
>

function makeManager(): FakeManager {
  return {
    dispose: jest.fn(),
    isDisposed: jest.fn(() => false),
    prepareForRendererReload: jest.fn(),
    rebindRuntimeDependencies: jest.fn(),
  }
}

function manager(value: FakeManager): AiTaskManager {
  return value as AiTaskManager
}

function deps(): AiTaskManagerDeps {
  return {} as AiTaskManagerDeps
}

class FakeRuntimeWindow {
  private sequence = 0
  readonly timers = new Map<number, () => void>()
  readonly beforeUnloadListeners = new Set<() => void>()

  setTimeout = jest.fn((handler: () => void) => {
    this.sequence += 1
    this.timers.set(this.sequence, handler)
    return this.sequence
  })

  clearTimeout = jest.fn((handle: number) => {
    this.timers.delete(handle)
  })

  addEventListener = jest.fn(
    (_type: 'beforeunload', listener: () => void) => {
      this.beforeUnloadListeners.add(listener)
    },
  )

  removeEventListener = jest.fn(
    (_type: 'beforeunload', listener: () => void) => {
      this.beforeUnloadListeners.delete(listener)
    },
  )

  runTimers(): void {
    const pending = Array.from(this.timers.entries())
    this.timers.clear()
    for (const [, callback] of pending) callback()
  }

  fireBeforeUnload(): void {
    for (const listener of Array.from(this.beforeUnloadListeners)) listener()
  }
}

function runtimeWindow(value: FakeRuntimeWindow): AiTaskRuntimeWindow {
  return value as unknown as AiTaskRuntimeWindow
}

describe('AiTaskRuntimeLease', () => {
  test('a new plugin instance adopts the live manager and cancels disposal', () => {
    const win = new FakeRuntimeWindow()
    const app = {}
    const current = makeManager()
    const nextDeps = deps()

    retainAiTaskManager(app, manager(current), runtimeWindow(win))
    scheduleAiTaskManagerHotReloadHandoff(
      manager(current),
      runtimeWindow(win),
      50,
    )

    const adopted = acquireRetainedAiTaskManager(
      app,
      nextDeps,
      runtimeWindow(win),
    )
    win.runTimers()

    expect(adopted).toBe(current)
    expect(current.rebindRuntimeDependencies).toHaveBeenCalledWith(nextDeps)
    expect(current.dispose).not.toHaveBeenCalled()
    expect(win.beforeUnloadListeners.size).toBe(1)
  })

  test('an unclaimed handoff disposes after its bounded grace period', () => {
    const win = new FakeRuntimeWindow()
    const current = makeManager()

    retainAiTaskManager({}, manager(current), runtimeWindow(win))
    scheduleAiTaskManagerHotReloadHandoff(
      manager(current),
      runtimeWindow(win),
      50,
    )
    win.runTimers()

    expect(current.dispose).toHaveBeenCalledTimes(1)
    expect(win.beforeUnloadListeners.size).toBe(0)
  })

  test('a real renderer beforeunload detaches without disposing', () => {
    const win = new FakeRuntimeWindow()
    const current = makeManager()

    retainAiTaskManager({}, manager(current), runtimeWindow(win))
    win.fireBeforeUnload()

    expect(current.prepareForRendererReload).toHaveBeenCalledTimes(1)
    expect(current.dispose).not.toHaveBeenCalled()
    expect(win.beforeUnloadListeners.size).toBe(0)
  })

  test('a different app cannot adopt another vault runtime', () => {
    const win = new FakeRuntimeWindow()
    const current = makeManager()

    retainAiTaskManager({}, manager(current), runtimeWindow(win))
    const adopted = acquireRetainedAiTaskManager(
      {},
      deps(),
      runtimeWindow(win),
    )

    expect(adopted).toBeUndefined()
    expect(current.dispose).toHaveBeenCalledTimes(1)
  })

  test('explicit feature disable forgets the lease before tracked disposal', () => {
    const win = new FakeRuntimeWindow()
    const current = makeManager()
    const app = {}

    retainAiTaskManager(app, manager(current), runtimeWindow(win))
    forgetRetainedAiTaskManager(current, runtimeWindow(win))

    expect(
      acquireRetainedAiTaskManager(app, deps(), runtimeWindow(win)),
    ).toBeUndefined()
    expect(current.dispose).not.toHaveBeenCalled()
    expect(win.beforeUnloadListeners.size).toBe(0)
  })
})
