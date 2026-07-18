import type {
  AiTaskManager,
  AiTaskManagerDeps,
} from '../../../src/features/ai-task/services/AiTaskManager'
import {
  acquireRetainedAiTaskManager,
  forgetRetainedAiTaskManager,
  getAiTaskRuntimeLeaseGeneration,
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
  readonly timerHistory = new Map<number, () => void>()
  readonly pageHideListeners = new Set<() => void>()
  readonly beforeUnloadListeners = new Set<() => void>()

  setTimeout = jest.fn((handler: () => void) => {
    this.sequence += 1
    this.timers.set(this.sequence, handler)
    this.timerHistory.set(this.sequence, handler)
    return this.sequence
  })

  clearTimeout = jest.fn((handle: number) => {
    this.timers.delete(handle)
  })

  addEventListener = jest.fn(
    (type: 'pagehide' | 'beforeunload', listener: () => void) => {
      if (type === 'pagehide') this.pageHideListeners.add(listener)
      else this.beforeUnloadListeners.add(listener)
    },
  )

  removeEventListener = jest.fn(
    (type: 'pagehide' | 'beforeunload', listener: () => void) => {
      if (type === 'pagehide') this.pageHideListeners.delete(listener)
      else this.beforeUnloadListeners.delete(listener)
    },
  )

  runTimers(): void {
    const pending = Array.from(this.timers.entries())
    this.timers.clear()
    for (const [, callback] of pending) callback()
  }

  invokeStaleTimer(handle: number): void {
    this.timerHistory.get(handle)?.()
  }

  firePageHide(): void {
    for (const listener of Array.from(this.pageHideListeners)) listener()
  }

  fireBeforeUnload(): void {
    for (const listener of Array.from(this.beforeUnloadListeners)) listener()
  }
}

function runtimeWindow(value: FakeRuntimeWindow): AiTaskRuntimeWindow {
  return value as unknown as AiTaskRuntimeWindow
}

describe('AiTaskRuntimeLease', () => {
  test('hot-upgrades a legacy V1 slot and removes its beforeunload listener', () => {
    const win = new FakeRuntimeWindow()
    const app = {}
    const current = makeManager()
    const legacyBeforeUnload = jest.fn(() => {
      current.prepareForRendererReload()
    })
    win.beforeUnloadListeners.add(legacyBeforeUnload)
    ;(win as unknown as Record<string, unknown>)[
      '__taskchutePlusAiTaskRuntimeLeaseV1__'
    ] = {
      app,
      manager: current,
      releaseTimer: null,
      beforeUnload: legacyBeforeUnload,
    }

    const adopted = acquireRetainedAiTaskManager(
      app,
      deps(),
      runtimeWindow(win),
      runtimeWindow(win),
    )

    expect(adopted).toBe(current)
    expect(win.beforeUnloadListeners.size).toBe(0)
    expect(win.pageHideListeners.size).toBe(1)
    win.fireBeforeUnload()
    expect(current.prepareForRendererReload).not.toHaveBeenCalled()
    win.firePageHide()
    expect(current.prepareForRendererReload).toHaveBeenCalledTimes(1)
  })

  test('moves a legacy activeWindow slot from a popout to the root renderer', () => {
    const rootWindow = new FakeRuntimeWindow()
    const popoutWindow = new FakeRuntimeWindow()
    const app = {}
    const current = makeManager()
    const legacyBeforeUnload = jest.fn()
    popoutWindow.beforeUnloadListeners.add(legacyBeforeUnload)
    ;(popoutWindow as unknown as Record<string, unknown>)[
      '__taskchutePlusAiTaskRuntimeLeaseV1__'
    ] = {
      app,
      manager: current,
      releaseTimer: null,
      beforeUnload: legacyBeforeUnload,
    }

    expect(
      acquireRetainedAiTaskManager(
        app,
        deps(),
        runtimeWindow(rootWindow),
        runtimeWindow(popoutWindow),
      ),
    ).toBe(current)
    expect(popoutWindow.beforeUnloadListeners.size).toBe(0)
    expect(rootWindow.pageHideListeners.size).toBe(1)

    scheduleAiTaskManagerHotReloadHandoff(manager(current), undefined, 50)
    rootWindow.runTimers()
    expect(current.dispose).toHaveBeenCalledTimes(1)
  })

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
    expect(win.pageHideListeners.size).toBe(1)
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
    expect(win.pageHideListeners.size).toBe(0)
  })

  test('a committed renderer pagehide detaches without disposing', () => {
    const win = new FakeRuntimeWindow()
    const current = makeManager()

    retainAiTaskManager({}, manager(current), runtimeWindow(win))
    win.firePageHide()

    expect(current.prepareForRendererReload).toHaveBeenCalledTimes(1)
    expect(current.dispose).not.toHaveBeenCalled()
  })

  test('renderer reload: pagehide then the plugin-unload handoff NEVER disposes', () => {
    // pagehide is committed (unlike cancelable beforeunload). Plugin.onunload
    // may run before or after it, and neither order may kill the live CLI.
    const win = new FakeRuntimeWindow()
    const current = makeManager()

    retainAiTaskManager({}, manager(current), runtimeWindow(win))
    win.firePageHide()
    scheduleAiTaskManagerHotReloadHandoff(
      manager(current),
      runtimeWindow(win),
      50,
    )
    win.runTimers()

    expect(current.prepareForRendererReload).toHaveBeenCalledTimes(1)
    expect(current.dispose).not.toHaveBeenCalled()
    expect(win.timers.size).toBe(0)
  })

  test('pagehide clears a handoff timer that was already armed', () => {
    const win = new FakeRuntimeWindow()
    const current = makeManager()

    retainAiTaskManager({}, manager(current), runtimeWindow(win))
    scheduleAiTaskManagerHotReloadHandoff(
      manager(current),
      runtimeWindow(win),
      50,
    )
    expect(win.timers.size).toBe(1)

    win.firePageHide()
    scheduleAiTaskManagerHotReloadHandoff(
      manager(current),
      runtimeWindow(win),
      50,
    )
    win.runTimers()

    expect(current.prepareForRendererReload).toHaveBeenCalledTimes(1)
    expect(current.dispose).not.toHaveBeenCalled()
    expect(win.timers.size).toBe(0)
  })

  test('a callback already queued before pagehide cannot dispose the runtime', () => {
    const win = new FakeRuntimeWindow()
    const current = makeManager()

    retainAiTaskManager({}, manager(current), runtimeWindow(win))
    scheduleAiTaskManagerHotReloadHandoff(
      manager(current),
      runtimeWindow(win),
      50,
    )
    const armedHandle = win.setTimeout.mock.results[0]?.value as number

    win.firePageHide()
    // Simulate the browser having queued the timer callback immediately
    // before clearTimeout won the pagehide race.
    win.invokeStaleTimer(armedHandle)

    expect(current.prepareForRendererReload).toHaveBeenCalledTimes(1)
    expect(current.dispose).not.toHaveBeenCalled()
  })

  test('a callback already queued before adoption cannot dispose the adopted runtime', () => {
    const win = new FakeRuntimeWindow()
    const app = {}
    const current = makeManager()

    retainAiTaskManager(app, manager(current), runtimeWindow(win))
    scheduleAiTaskManagerHotReloadHandoff(
      manager(current),
      runtimeWindow(win),
      50,
    )
    const armedHandle = win.setTimeout.mock.results[0]?.value as number
    expect(
      acquireRetainedAiTaskManager(app, deps(), runtimeWindow(win)),
    ).toBe(current)

    win.invokeStaleTimer(armedHandle)

    expect(current.dispose).not.toHaveBeenCalled()
  })

  test('an old plugin unload cannot schedule disposal after a newer owner adopted', () => {
    const win = new FakeRuntimeWindow()
    const app = {}
    const current = makeManager()

    retainAiTaskManager(app, manager(current), runtimeWindow(win))
    const oldGeneration = getAiTaskRuntimeLeaseGeneration(
      manager(current),
      runtimeWindow(win),
    )
    expect(
      acquireRetainedAiTaskManager(app, deps(), runtimeWindow(win)),
    ).toBe(current)
    const newGeneration = getAiTaskRuntimeLeaseGeneration(
      manager(current),
      runtimeWindow(win),
    )
    expect(newGeneration).not.toBe(oldGeneration)

    scheduleAiTaskManagerHotReloadHandoff(
      manager(current),
      runtimeWindow(win),
      50,
      oldGeneration,
    )
    win.runTimers()

    expect(current.dispose).not.toHaveBeenCalled()
    expect(win.timers.size).toBe(0)
  })

  test('same-renderer adoption restores normal handoff semantics', () => {
    const win = new FakeRuntimeWindow()
    const app = {}
    const current = makeManager()

    retainAiTaskManager(app, manager(current), runtimeWindow(win))
    const adopted = acquireRetainedAiTaskManager(app, deps(), runtimeWindow(win))
    expect(adopted).toBe(current)

    // The renderer survived, so a later plugin disable must dispose again.
    scheduleAiTaskManagerHotReloadHandoff(
      manager(current),
      runtimeWindow(win),
      50,
    )
    win.runTimers()
    expect(current.dispose).toHaveBeenCalledTimes(1)
  })

  test('handoff uses the window captured at retain time when no window is passed', () => {
    const ownerWindow = new FakeRuntimeWindow()
    const current = makeManager()

    retainAiTaskManager({}, manager(current), runtimeWindow(ownerWindow))
    scheduleAiTaskManagerHotReloadHandoff(manager(current), undefined, 50)
    ownerWindow.runTimers()

    expect(current.dispose).toHaveBeenCalledTimes(1)
    expect(ownerWindow.pageHideListeners.size).toBe(0)
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
    expect(win.pageHideListeners.size).toBe(0)
  })
})
