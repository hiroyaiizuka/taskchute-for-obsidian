import type { AiTaskAmbientCandidate } from '../../../src/features/ai-task/services/AiTaskAmbientCandidateFinder'
import {
  AI_TASK_AMBIENT_CHECK_INTERVAL_MS,
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
    const scheduler = new AiTaskAmbientScheduler({
      findCandidates,
      executeCandidates,
      stateStore: store,
      now: () => new Date(NOW),
      timerHost,
    })

    await scheduler.start()

    expect(findCandidates).toHaveBeenCalledWith(NOW)
    expect(executeCandidates).toHaveBeenCalledWith([one, two], NOW)
    expect(store.isExecuted(one.identity, one.dateKey)).toBe(true)
    expect(store.isExecuted(two.identity, two.dateKey)).toBe(false)
    expect(timerHost.intervalMs).toBe(AI_TASK_AMBIENT_CHECK_INTERVAL_MS)

    timerHost.callback?.()
    await scheduler.checkNow()
    expect(executeCandidates).toHaveBeenLastCalledWith([two], NOW)
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

  test('does not mark failed execution and retries on the next check', async () => {
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
    expect(await scheduler.checkNow(NOW)).toEqual([item])
    expect(store.isExecuted(item.identity, item.dateKey)).toBe(true)
    expect(executeCandidates).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith(
      'warn',
      '[AiTaskAmbientScheduler] Ambient check failed',
      expect.any(Error),
    )
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
