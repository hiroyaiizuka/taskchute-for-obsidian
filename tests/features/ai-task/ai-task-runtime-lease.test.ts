import type {
  AiTaskManager,
  AiTaskManagerDeps,
} from '../../../src/features/ai-task/services/AiTaskManager'
import {
  acquireRetainedAiTaskManager,
  AI_TASK_TERMINAL_RENDERER_LEASE_OWNER_ID,
  createAiTaskTerminalRendererLeaseIdentity,
  forgetRetainedAiTaskManager,
  getAiTaskRuntimeLeaseGeneration,
  prepareRetainedAiTaskManagerForRendererTransition,
  retainAiTaskManager,
  scheduleAiTaskManagerHotReloadHandoff,
  type AiTaskRuntimeWindow,
} from '../../../src/features/ai-task/services/AiTaskRuntimeLease'

type FakeManager = Pick<
  AiTaskManager,
  | 'dispose'
  | 'isDisposed'
  | 'persistSessionStateForRendererReload'
  | 'prepareForRendererReload'
> & {
  rebindRuntimeDependencies: jest.Mock<void, [AiTaskManagerDeps]>
  cancelTerminalShutdownAfterGrace?: jest.Mock
  scheduleTerminalShutdownAfterGrace?: jest.Mock
  stopNonPersistentRunsForRendererTransitionAndWait?: jest.Mock
  setTerminalRendererLeaseToken?: jest.Mock
}

function makeManager(): FakeManager {
  return {
    dispose: jest.fn(),
    isDisposed: jest.fn(() => false),
    persistSessionStateForRendererReload: jest.fn(),
    prepareForRendererReload: jest.fn(),
    rebindRuntimeDependencies: jest.fn(),
    cancelTerminalShutdownAfterGrace: jest.fn(),
    scheduleTerminalShutdownAfterGrace: jest.fn(),
    stopNonPersistentRunsForRendererTransitionAndWait: jest.fn(
      () => Promise.resolve(),
    ),
    setTerminalRendererLeaseToken: jest.fn(),
  }
}

function manager(value: FakeManager): AiTaskManager {
  return value as unknown as AiTaskManager
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
  return value
}

describe('AiTaskRuntimeLease', () => {
  test('reserves one stable broker owner with a persisted monotonic generation', () => {
    let persisted: unknown = 41
    const store = {
      load: jest.fn(() => persisted),
      save: jest.fn((generation: number) => {
        persisted = generation
      }),
    }

    const first = createAiTaskTerminalRendererLeaseIdentity(store)
    const second = createAiTaskTerminalRendererLeaseIdentity(store)

    expect(first.ownerId).toBe(
      AI_TASK_TERMINAL_RENDERER_LEASE_OWNER_ID,
    )
    expect(second.ownerId).toBe(first.ownerId)
    expect(second.generation).toBeGreaterThan(first.generation)
    expect(store.save).toHaveBeenLastCalledWith(second.generation)
  })

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
    expect(win.beforeUnloadListeners.size).toBe(1)
    expect(win.pageHideListeners.size).toBe(1)
    win.fireBeforeUnload()
    expect(current.prepareForRendererReload).not.toHaveBeenCalled()
    expect(current.persistSessionStateForRendererReload).toHaveBeenCalledTimes(1)
    win.firePageHide()
    expect(current.prepareForRendererReload).toHaveBeenCalledTimes(1)
  })

  test('hot-upgrades the pagehide-only V1 slot and installs save-only beforeunload', () => {
    const win = new FakeRuntimeWindow()
    const app = {}
    const current = makeManager()
    const oldPageHide = jest.fn(() => current.prepareForRendererReload())
    win.pageHideListeners.add(oldPageHide)
    ;(win as unknown as Record<string, unknown>)[
      '__taskchutePlusAiTaskRuntimeLeaseV1__'
    ] = {
      app,
      manager: current,
      generation: 7,
      releaseTimer: null,
      rendererUnloading: false,
      pageHide: oldPageHide,
    }

    expect(
      acquireRetainedAiTaskManager(
        app,
        deps(),
        runtimeWindow(win),
        runtimeWindow(win),
      ),
    ).toBe(current)
    expect(win.pageHideListeners.has(oldPageHide)).toBe(false)
    expect(win.pageHideListeners.size).toBe(1)
    expect(win.beforeUnloadListeners.size).toBe(1)

    win.fireBeforeUnload()
    expect(current.persistSessionStateForRendererReload).toHaveBeenCalledTimes(1)
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

  test('beforeunload persists without detaching and canceled navigation restores handoff', () => {
    const win = new FakeRuntimeWindow()
    const current = makeManager()

    retainAiTaskManager({}, manager(current), runtimeWindow(win))
    win.fireBeforeUnload()

    expect(current.persistSessionStateForRendererReload).toHaveBeenCalledTimes(1)
    expect(current.prepareForRendererReload).not.toHaveBeenCalled()
    expect(current.dispose).not.toHaveBeenCalled()

    win.runTimers()
    scheduleAiTaskManagerHotReloadHandoff(
      manager(current),
      runtimeWindow(win),
      50,
    )
    win.runTimers()
    expect(current.dispose).toHaveBeenCalledTimes(1)
  })

  test('consecutive canceled beforeunload events restore handoff after the latest reset', () => {
    const win = new FakeRuntimeWindow()
    const current = makeManager()

    retainAiTaskManager({}, manager(current), runtimeWindow(win))
    win.fireBeforeUnload()
    win.fireBeforeUnload()

    expect(current.persistSessionStateForRendererReload).toHaveBeenCalledTimes(2)
    expect(win.timers.size).toBe(1)

    win.runTimers()
    scheduleAiTaskManagerHotReloadHandoff(
      manager(current),
      runtimeWindow(win),
      50,
    )
    win.runTimers()

    expect(current.dispose).toHaveBeenCalledTimes(1)
  })

  test('workspace quit transition fences unload before beforeunload and pagehide', () => {
    const win = new FakeRuntimeWindow()
    const current = makeManager()

    retainAiTaskManager({}, manager(current), runtimeWindow(win))
    expect(
      prepareRetainedAiTaskManagerForRendererTransition(
        manager(current),
        runtimeWindow(win),
      ),
    ).toBe(true)
    scheduleAiTaskManagerHotReloadHandoff(
      manager(current),
      runtimeWindow(win),
      50,
    )
    win.fireBeforeUnload()
    win.firePageHide()
    win.runTimers()

    expect(current.persistSessionStateForRendererReload).toHaveBeenCalledTimes(2)
    expect(current.prepareForRendererReload).toHaveBeenCalledTimes(1)
    expect(current.dispose).not.toHaveBeenCalled()
  })

  test('canceled workspace quit eventually restores ordinary hot-reload disposal', () => {
    const win = new FakeRuntimeWindow()
    const current = makeManager()

    retainAiTaskManager({}, manager(current), runtimeWindow(win))
    expect(
      prepareRetainedAiTaskManagerForRendererTransition(
        manager(current),
        runtimeWindow(win),
      ),
    ).toBe(true)

    // No beforeunload/pagehide followed: the app-close attempt was canceled.
    win.runTimers()
    expect(current.cancelTerminalShutdownAfterGrace).toHaveBeenCalledTimes(1)
    expect(
      current.stopNonPersistentRunsForRendererTransitionAndWait,
    ).not.toHaveBeenCalled()
    scheduleAiTaskManagerHotReloadHandoff(
      manager(current),
      runtimeWindow(win),
      50,
    )
    win.runTimers()

    expect(current.dispose).toHaveBeenCalledTimes(1)
  })

  test('slow committed pagehide re-arms broker cleanup after canceled-quit reset', () => {
    const win = new FakeRuntimeWindow()
    const current = makeManager()

    retainAiTaskManager({}, manager(current), runtimeWindow(win))
    expect(
      prepareRetainedAiTaskManagerForRendererTransition(
        manager(current),
        runtimeWindow(win),
      ),
    ).toBe(true)

    // More than the cancelable transition window passes without pagehide.
    win.runTimers()
    expect(current.cancelTerminalShutdownAfterGrace).toHaveBeenCalledTimes(1)

    // A slow but genuine quit finally commits. It must restore the external
    // broker deadline and only now begin stopping renderer-owned/headless
    // runs.
    win.firePageHide()
    expect(current.scheduleTerminalShutdownAfterGrace).toHaveBeenCalledWith(
      60_000,
      expect.any(String),
      expect.any(String),
      expect.any(Number),
    )
    expect(
      current.stopNonPersistentRunsForRendererTransitionAndWait,
    ).toHaveBeenCalledTimes(1)
    expect(current.prepareForRendererReload).toHaveBeenCalledTimes(1)
  })

  test('canceled quit remains compatible with a retained manager lacking cancel API', () => {
    const win = new FakeRuntimeWindow()
    const current = makeManager()
    delete current.cancelTerminalShutdownAfterGrace
    delete current.scheduleTerminalShutdownAfterGrace
    delete current.stopNonPersistentRunsForRendererTransitionAndWait
    delete current.setTerminalRendererLeaseToken

    retainAiTaskManager({}, manager(current), runtimeWindow(win))
    expect(
      prepareRetainedAiTaskManagerForRendererTransition(
        manager(current),
        runtimeWindow(win),
      ),
    ).toBe(true)

    expect(() => win.runTimers()).not.toThrow()
    expect(() => win.firePageHide()).not.toThrow()
    expect(current.prepareForRendererReload).toHaveBeenCalledTimes(1)
  })

  test('adoption rotates the terminal lease while an old pagehide request keeps its captured token', () => {
    const win = new FakeRuntimeWindow()
    const app = {}
    const current = makeManager()

    retainAiTaskManager(app, manager(current), runtimeWindow(win))
    const oldLeaseCall =
      current.setTerminalRendererLeaseToken?.mock.calls[0] ?? []
    const [oldLease, oldOwner, oldLeaseGeneration] = oldLeaseCall as [
      string,
      string,
      number,
    ]
    win.firePageHide()
    expect(current.scheduleTerminalShutdownAfterGrace).toHaveBeenCalledWith(
      60_000,
      oldLease,
      oldOwner,
      oldLeaseGeneration,
    )

    expect(
      acquireRetainedAiTaskManager(app, deps(), runtimeWindow(win)),
    ).toBe(current)
    const leaseCalls =
      current.setTerminalRendererLeaseToken?.mock.calls ?? []
    const [newLease, newOwner, newLeaseGeneration] = leaseCalls.at(-1) as [
      string,
      string,
      number,
    ]

    expect(newLease).not.toBe(oldLease)
    expect(newOwner).toBe(oldOwner)
    // Generations come from Date.now() * 1024 + sequence, so consecutive
    // reservations differ by 1 only while both land in the same millisecond.
    // Rotation is what matters here, not the size of the step.
    expect(newLeaseGeneration).toBeGreaterThan(oldLeaseGeneration)
    expect(oldLease).toEqual(expect.any(String))
  })

  test('adoption rotates the retained BrokerClient before rebinding manager dependencies', () => {
    const win = new FakeRuntimeWindow()
    const app = {}
    const current = makeManager()

    retainAiTaskManager(app, manager(current), runtimeWindow(win))
    current.setTerminalRendererLeaseToken?.mockClear()

    expect(
      acquireRetainedAiTaskManager(app, deps(), runtimeWindow(win)),
    ).toBe(current)

    const leaseOrders =
      current.setTerminalRendererLeaseToken?.mock.invocationCallOrder ?? []
    const rebindOrder =
      current.rebindRuntimeDependencies.mock.invocationCallOrder[0]
    expect(leaseOrders).toHaveLength(2)
    expect(leaseOrders[0]).toBeLessThan(rebindOrder)
    expect(leaseOrders[1]).toBeGreaterThan(rebindOrder)
    expect(
      current.setTerminalRendererLeaseToken?.mock.calls[0],
    ).toEqual(current.setTerminalRendererLeaseToken?.mock.calls[1])
  })

  test('same-renderer adoption persists the next generation for a future renderer', () => {
    const win = new FakeRuntimeWindow()
    const app = {}
    const current = makeManager()
    let persisted: unknown = 0
    const store = {
      load: () => persisted,
      save: (generation: number) => {
        persisted = generation
      },
    }
    const initial =
      createAiTaskTerminalRendererLeaseIdentity(store)

    retainAiTaskManager(
      app,
      manager(current),
      runtimeWindow(win),
      initial,
      store,
    )
    expect(
      acquireRetainedAiTaskManager(
        app,
        deps(),
        runtimeWindow(win),
        undefined,
        store,
      ),
    ).toBe(current)

    const adoptedGeneration =
      current.setTerminalRendererLeaseToken?.mock.calls.at(-1)?.[2] as number
    expect(adoptedGeneration).toBeGreaterThan(initial.generation)
    expect(persisted).toBe(adoptedGeneration)
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
