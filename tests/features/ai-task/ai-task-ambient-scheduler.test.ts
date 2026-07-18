import type { AiTaskAmbientCandidate } from '../../../src/features/ai-task/services/AiTaskAmbientCandidateFinder'
import {
  AI_TASK_AMBIENT_CHECK_INTERVAL_MS,
  AI_TASK_AMBIENT_FAILURE_BACKOFF_STEPS_MS,
  AiTaskAmbientScheduler,
  type AiTaskAmbientEventTarget,
  type AiTaskAmbientTimerHost,
} from '../../../src/features/ai-task/services/AiTaskAmbientScheduler'
import { AiTaskAmbientScheduleStateStore } from '../../../src/features/ai-task/services/AiTaskAmbientScheduleStateStore'

const NOW = new Date(2026, 6, 15, 8, 0)

function candidate(
  identity: string,
  overrides: Partial<AiTaskAmbientCandidate> = {},
): AiTaskAmbientCandidate {
  return {
    identity,
    path: `TaskChute/Task/${identity}.md`,
    dateKey: '2026-07-15',
    scheduledTime: '08:00',
    ...overrides,
  }
}

function createStore(initial: unknown = null): AiTaskAmbientScheduleStateStore {
  let state = initial
  return new AiTaskAmbientScheduleStateStore({
    loadLocalStorage: () => state,
    saveLocalStorage: (_key, value) => {
      state = value
    },
  })
}

class FakeEventTarget implements AiTaskAmbientEventTarget {
  readonly listeners = new Map<string, Set<EventListener>>()

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new Event(type))
    }
  }
}

function createTimerHost(): AiTaskAmbientTimerHost & {
  callback: (() => void) | null
  intervalMs: number | null
  clearInterval: jest.Mock
} {
  const host = {
    callback: null as (() => void) | null,
    intervalMs: null as number | null,
    setInterval: jest.fn((callback: () => void, intervalMs: number) => {
      host.callback = callback
      host.intervalMs = intervalMs
      return 77
    }),
    clearInterval: jest.fn(),
  }
  return host
}

describe('AiTaskAmbientScheduler', () => {
  test('starts with an immediate check, schedules every 60 seconds, and marks only successes', async () => {
    const one = candidate('taskId:one')
    const two = candidate('taskId:two')
    const store = createStore()
    const findCandidates = jest.fn(() => [one, two])
    const executeCandidates = jest.fn(async () => new Set([one.identity]))
    const timerHost = createTimerHost()
    let current = NOW
    const scheduler = new AiTaskAmbientScheduler({
      findCandidates,
      executeCandidates,
      stateStore: store,
      now: () => new Date(current),
      timerHost,
    })

    await scheduler.start()

    expect(findCandidates).toHaveBeenCalledWith(NOW)
    expect(executeCandidates).toHaveBeenCalledWith([one, two], NOW)
    expect(store.isExecuted(one.identity, one.dateKey)).toBe(true)
    expect(store.isExecuted(two.identity, two.dateKey)).toBe(false)
    expect(timerHost.intervalMs).toBe(AI_TASK_AMBIENT_CHECK_INTERVAL_MS)

    current = new Date(NOW.getTime() + AI_TASK_AMBIENT_CHECK_INTERVAL_MS)
    timerHost.callback?.()
    await scheduler.checkNow()
    expect(executeCandidates).toHaveBeenLastCalledWith([two], current)
  })

  test('filters already-executed identities before calling the executor', async () => {
    const done = candidate('taskId:done')
    const pending = candidate('taskId:pending')
    const store = createStore()
    store.markExecuted(done.identity, done.dateKey, NOW)
    const executeCandidates = jest.fn(async () => [pending.identity])
    const scheduler = new AiTaskAmbientScheduler({
      findCandidates: () => [done, pending],
      executeCandidates,
      stateStore: store,
    })

    expect(await scheduler.checkNow(NOW)).toEqual([pending])
    expect(executeCandidates).toHaveBeenCalledWith([pending], NOW)
  })

  test('coalesces overlapping checks into one discovery/execution', async () => {
    const item = candidate('taskId:slow')
    let resolveExecution!: (value: readonly string[]) => void
    const execution = new Promise<readonly string[]>((resolve) => {
      resolveExecution = resolve
    })
    const executeCandidates = jest.fn(() => execution)
    const findCandidates = jest.fn(() => [item])
    const scheduler = new AiTaskAmbientScheduler({
      findCandidates,
      executeCandidates,
      stateStore: createStore(),
    })

    const first = scheduler.checkNow(NOW)
    const second = scheduler.checkNow(new Date(2026, 6, 15, 8, 1))
    await Promise.resolve()
    expect(findCandidates).toHaveBeenCalledTimes(1)
    expect(executeCandidates).toHaveBeenCalledTimes(1)

    resolveExecution([item.identity])
    await Promise.all([first, second])
    expect(executeCandidates).toHaveBeenCalledTimes(1)
  })

  test('does not mark failed execution and retries after the backoff window', async () => {
    const item = candidate('taskId:retry')
    const store = createStore()
    const executeCandidates = jest
      .fn<Promise<readonly string[]>, [readonly AiTaskAmbientCandidate[], Date]>()
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockResolvedValueOnce([item.identity])
    const log = jest.fn()
    const scheduler = new AiTaskAmbientScheduler({
      findCandidates: () => [item],
      executeCandidates,
      stateStore: store,
      log,
    })

    expect(await scheduler.checkNow(NOW)).toEqual([])
    expect(store.isExecuted(item.identity, item.dateKey)).toBe(false)

    // Within the first backoff window the candidate is skipped entirely.
    expect(await scheduler.checkNow(NOW)).toEqual([])
    expect(
      await scheduler.checkNow(new Date(NOW.getTime() + 59_000)),
    ).toEqual([])
    expect(executeCandidates).toHaveBeenCalledTimes(1)

    const retryAt = new Date(
      NOW.getTime() + AI_TASK_AMBIENT_FAILURE_BACKOFF_STEPS_MS[0],
    )
    expect(await scheduler.checkNow(retryAt)).toEqual([item])
    expect(store.isExecuted(item.identity, item.dateKey)).toBe(true)
    expect(executeCandidates).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith(
      'warn',
      '[AiTaskAmbientScheduler] Ambient check failed',
      expect.any(Error),
    )
  })

  test('escalates backoff for consecutive failures up to the cap and skips the executor while backed off', async () => {
    const item = candidate('taskId:always-fails')
    const executeCandidates = jest.fn(async () => [] as string[])
    const scheduler = new AiTaskAmbientScheduler({
      findCandidates: () => [item],
      executeCandidates,
      stateStore: createStore(),
    })

    const [oneMin, fiveMin, fifteenMin, oneHour] =
      AI_TASK_AMBIENT_FAILURE_BACKOFF_STEPS_MS
    let at = NOW.getTime()
    const check = (offsetMs: number) =>
      scheduler.checkNow(new Date(at + offsetMs))

    await check(0)
    expect(executeCandidates).toHaveBeenCalledTimes(1)

    await check(oneMin - 1)
    expect(executeCandidates).toHaveBeenCalledTimes(1)
    at += oneMin
    await check(0)
    expect(executeCandidates).toHaveBeenCalledTimes(2)

    await check(fiveMin - 1)
    expect(executeCandidates).toHaveBeenCalledTimes(2)
    at += fiveMin
    await check(0)
    expect(executeCandidates).toHaveBeenCalledTimes(3)

    await check(fifteenMin - 1)
    expect(executeCandidates).toHaveBeenCalledTimes(3)
    at += fifteenMin
    await check(0)
    expect(executeCandidates).toHaveBeenCalledTimes(4)

    // Fourth failure reaches the cap; further failures stay at one hour.
    await check(oneHour - 1)
    expect(executeCandidates).toHaveBeenCalledTimes(4)
    at += oneHour
    await check(0)
    expect(executeCandidates).toHaveBeenCalledTimes(5)
    await check(oneHour - 1)
    expect(executeCandidates).toHaveBeenCalledTimes(5)
    at += oneHour
    await check(0)
    expect(executeCandidates).toHaveBeenCalledTimes(6)
  })

  test('resets the failure counter after a success', async () => {
    const item = candidate('taskId:flaky')
    const executeCandidates = jest
      .fn<Promise<readonly string[]>, [readonly AiTaskAmbientCandidate[], Date]>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([item.identity])
      .mockResolvedValue([])
    const scheduler = new AiTaskAmbientScheduler({
      findCandidates: () => [item],
      executeCandidates,
      stateStore: {
        isExecuted: () => false,
        markExecuted: () => true,
        prune: () => {},
      },
    })

    const [oneMin] = AI_TASK_AMBIENT_FAILURE_BACKOFF_STEPS_MS

    await scheduler.checkNow(NOW)
    const successAt = NOW.getTime() + oneMin
    expect(await scheduler.checkNow(new Date(successAt))).toEqual([item])
    expect(executeCandidates).toHaveBeenCalledTimes(2)

    // A later failure restarts at the first delay, not the escalated one.
    await scheduler.checkNow(new Date(successAt + 1_000))
    expect(executeCandidates).toHaveBeenCalledTimes(3)
    await scheduler.checkNow(new Date(successAt + 1_000 + oneMin - 1))
    expect(executeCandidates).toHaveBeenCalledTimes(3)
    await scheduler.checkNow(new Date(successAt + 1_000 + oneMin))
    expect(executeCandidates).toHaveBeenCalledTimes(4)
  })

  test('resets backoff when the date key changes', async () => {
    const dayOne = candidate('taskId:cross-day', { dateKey: '2026-07-15' })
    const dayTwo = candidate('taskId:cross-day', { dateKey: '2026-07-16' })
    let active = dayOne
    const executeCandidates = jest.fn(async () => [] as string[])
    const scheduler = new AiTaskAmbientScheduler({
      findCandidates: () => [active],
      executeCandidates,
      stateStore: createStore(),
    })

    const [oneMin] = AI_TASK_AMBIENT_FAILURE_BACKOFF_STEPS_MS
    const lateNight = new Date(2026, 6, 15, 23, 58)
    await scheduler.checkNow(lateNight)
    await scheduler.checkNow(new Date(lateNight.getTime() + oneMin))
    expect(executeCandidates).toHaveBeenCalledTimes(2)
    // Two consecutive failures: the five-minute window now spans midnight.
    await scheduler.checkNow(new Date(lateNight.getTime() + 2 * oneMin))
    expect(executeCandidates).toHaveBeenCalledTimes(2)

    // The new date key clears the record even inside the old window, and the
    // counter restarts at the first delay.
    active = dayTwo
    const nextDay = new Date(2026, 6, 16, 0, 1)
    await scheduler.checkNow(nextDay)
    expect(executeCandidates).toHaveBeenCalledTimes(3)
    await scheduler.checkNow(new Date(nextDay.getTime() + oneMin - 1))
    expect(executeCandidates).toHaveBeenCalledTimes(3)
    await scheduler.checkNow(new Date(nextDay.getTime() + oneMin))
    expect(executeCandidates).toHaveBeenCalledTimes(4)
  })

  test('focus-triggered checks also respect the backoff window', async () => {
    const item = candidate('taskId:focus-fail')
    const focusTarget = new FakeEventTarget()
    const timerHost = createTimerHost()
    let current = NOW
    const executeCandidates = jest.fn(async () => [] as string[])
    const scheduler = new AiTaskAmbientScheduler({
      findCandidates: () => [item],
      executeCandidates,
      stateStore: createStore(),
      now: () => new Date(current),
      timerHost,
      focusTarget,
    })
    await scheduler.start()
    expect(executeCandidates).toHaveBeenCalledTimes(1)

    current = new Date(NOW.getTime() + 30_000)
    focusTarget.emit('focus')
    await scheduler.checkNow()
    expect(executeCandidates).toHaveBeenCalledTimes(1)

    current = new Date(
      NOW.getTime() + AI_TASK_AMBIENT_FAILURE_BACKOFF_STEPS_MS[0],
    )
    focusTarget.emit('focus')
    await scheduler.checkNow()
    expect(executeCandidates).toHaveBeenCalledTimes(2)
  })

  test('focus and visible visibilitychange trigger catch-up checks', async () => {
    const item = candidate('taskId:resume')
    const store = createStore()
    const focusTarget = new FakeEventTarget()
    const visibilityTarget = new FakeEventTarget()
    const timerHost = createTimerHost()
    let visible = false
    const findCandidates = jest.fn(() => [item])
    const executeCandidates = jest.fn(async () => [] as string[])
    const scheduler = new AiTaskAmbientScheduler({
      findCandidates,
      executeCandidates,
      stateStore: store,
      now: () => new Date(NOW),
      timerHost,
      focusTarget,
      visibilityTarget,
      isDocumentVisible: () => visible,
    })
    await scheduler.start()
    findCandidates.mockClear()

    visibilityTarget.emit('visibilitychange')
    await Promise.resolve()
    expect(findCandidates).not.toHaveBeenCalled()

    visible = true
    visibilityTarget.emit('visibilitychange')
    await scheduler.checkNow()
    expect(findCandidates).toHaveBeenCalledTimes(1)

    focusTarget.emit('focus')
    await scheduler.checkNow()
    expect(findCandidates).toHaveBeenCalledTimes(2)
  })

  test('start is idempotent and dispose clears exactly one timer and both listeners', async () => {
    const timerHost = createTimerHost()
    const focusTarget = new FakeEventTarget()
    const visibilityTarget = new FakeEventTarget()
    const findCandidates = jest.fn(() => [])
    const scheduler = new AiTaskAmbientScheduler({
      findCandidates,
      executeCandidates: jest.fn(async () => []),
      stateStore: createStore(),
      timerHost,
      focusTarget,
      visibilityTarget,
      now: () => NOW,
    })

    await scheduler.start()
    await scheduler.start()
    expect(timerHost.setInterval).toHaveBeenCalledTimes(1)
    expect(findCandidates).toHaveBeenCalledTimes(1)
    expect(focusTarget.listeners.get('focus')?.size).toBe(1)
    expect(visibilityTarget.listeners.get('visibilitychange')?.size).toBe(1)

    scheduler.dispose()
    scheduler.dispose()
    expect(timerHost.clearInterval).toHaveBeenCalledTimes(1)
    expect(focusTarget.listeners.get('focus')?.size).toBe(0)
    expect(visibilityTarget.listeners.get('visibilitychange')?.size).toBe(0)
    expect(scheduler.isStarted()).toBe(false)
  })

  test('default timer stays owned by the root renderer across activeWindow changes', async () => {
    const originalActiveWindow = activeWindow
    const rootSetInterval = jest
      .spyOn(window, 'setInterval')
      .mockReturnValue(901)
    const rootClearInterval = jest
      .spyOn(window, 'clearInterval')
      .mockImplementation(() => undefined)
    const popoutSetInterval = jest.fn(() => 902)
    const popoutClearInterval = jest.fn()
    const popout = {
      setInterval: popoutSetInterval,
      clearInterval: popoutClearInterval,
    } as unknown as Window
    const replacementPopout = {
      setInterval: jest.fn(() => 903),
      clearInterval: jest.fn(),
    } as unknown as Window

    try {
      ;(globalThis as typeof globalThis & { activeWindow: Window }).activeWindow =
        popout
      const scheduler = new AiTaskAmbientScheduler({
        findCandidates: () => [],
        executeCandidates: jest.fn(async () => []),
        stateStore: createStore(),
        now: () => NOW,
      })

      await scheduler.start()
      ;(globalThis as typeof globalThis & { activeWindow: Window }).activeWindow =
        replacementPopout
      scheduler.dispose()

      expect(rootSetInterval).toHaveBeenCalledWith(
        expect.any(Function),
        AI_TASK_AMBIENT_CHECK_INTERVAL_MS,
      )
      expect(rootClearInterval).toHaveBeenCalledWith(901)
      expect(popoutSetInterval).not.toHaveBeenCalled()
      expect(popoutClearInterval).not.toHaveBeenCalled()
      expect(replacementPopout.clearInterval).not.toHaveBeenCalled()
    } finally {
      ;(globalThis as typeof globalThis & { activeWindow: Window }).activeWindow =
        originalActiveWindow
      rootSetInterval.mockRestore()
      rootClearInterval.mockRestore()
    }
  })

  test('dispose prevents an in-flight discovery from launching work', async () => {
    const item = candidate('taskId:late-discovery')
    let resolveDiscovery!: (
      value: readonly AiTaskAmbientCandidate[],
    ) => void
    const discovery = new Promise<readonly AiTaskAmbientCandidate[]>((resolve) => {
      resolveDiscovery = resolve
    })
    const executeCandidates = jest.fn(async () => [item.identity])
    const scheduler = new AiTaskAmbientScheduler({
      findCandidates: () => discovery,
      executeCandidates,
      stateStore: createStore(),
    })

    const check = scheduler.checkNow(NOW)
    scheduler.dispose()
    resolveDiscovery([item])

    await expect(check).resolves.toEqual([])
    await expect(scheduler.checkNow(NOW)).resolves.toEqual([])
    expect(executeCandidates).not.toHaveBeenCalled()
  })

  test('dispose after launch prevents an in-flight execution from being marked complete', async () => {
    const item = candidate('taskId:late-execution')
    const store = createStore()
    let resolveExecution!: (value: readonly string[]) => void
    const execution = new Promise<readonly string[]>((resolve) => {
      resolveExecution = resolve
    })
    const executeCandidates = jest.fn(() => execution)
    const scheduler = new AiTaskAmbientScheduler({
      findCandidates: () => [item],
      executeCandidates,
      stateStore: store,
    })

    const check = scheduler.checkNow(NOW)
    await Promise.resolve()
    expect(executeCandidates).toHaveBeenCalledTimes(1)

    scheduler.dispose()
    resolveExecution([item.identity])

    await expect(check).resolves.toEqual([])
    expect(store.isExecuted(item.identity, item.dateKey)).toBe(false)
  })

  test('prunes old schedule records during every check', async () => {
    const store = createStore({
      version: 1,
      executions: {
        old: {
          lastExecutedDate: '2026-06-01',
          lastExecutedAt: '2026-06-01T00:00:00.000Z',
        },
      },
    })
    const scheduler = new AiTaskAmbientScheduler({
      findCandidates: () => [],
      executeCandidates: jest.fn(async () => []),
      stateStore: store,
    })

    await scheduler.checkNow(NOW)
    expect(store.getRecord('old')).toBeNull()
  })

  test('deduplicates identities returned by a defensive candidate source', async () => {
    const item = candidate('taskId:duplicate')
    const executeCandidates = jest.fn(async () => [item.identity])
    const scheduler = new AiTaskAmbientScheduler({
      findCandidates: () => [item, { ...item }],
      executeCandidates,
      stateStore: createStore(),
    })

    await scheduler.checkNow(NOW)
    expect(executeCandidates).toHaveBeenCalledWith([item], NOW)
  })
})
