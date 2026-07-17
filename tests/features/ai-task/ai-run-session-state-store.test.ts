import {
  AI_RUN_SESSION_EVENT_LIMIT,
  AI_RUN_SESSION_REPLAY_LIMIT,
  AI_RUN_SESSION_SERIALIZED_LIMIT,
  AI_RUN_SESSION_STATE_STORAGE_KEY,
  AiRunSessionStateStore,
  type AiRunSessionSnapshot,
  type AiRunSessionTimer,
} from '../../../src/features/ai-task/services/AiRunSessionStateStore'

function createSnapshot(overrides: Partial<AiRunSessionSnapshot> = {}): AiRunSessionSnapshot {
  return {
    record: {
      id: 'run-1',
      taskPath: 'TaskChute/Task/AI.md',
      taskName: 'AI',
      cwd: '/workspace',
      host: 'claude',
      status: 'running',
      mode: 'terminal',
      startedAt: 1_000,
      events: [],
    },
    terminalReplay: 'hello\r\n',
    extraArgs: ['--model', 'claude-test'],
    ...overrides,
  }
}

function createTimer(): AiRunSessionTimer & { fire(): void; clear: jest.Mock } {
  let callback: (() => void) | null = null
  const clear = jest.fn(() => {
    callback = null
  })
  return {
    setTimeout: (handler) => {
      callback = handler
      return 1
    },
    clearTimeout: clear,
    clear,
    fire: () => {
      const pending = callback
      callback = null
      pending?.()
    },
  }
}

describe('AiRunSessionStateStore', () => {
  test('round-trips bounded run metadata, events, args, and terminal replay', () => {
    let state: unknown = null
    const storage = {
      loadLocalStorage: jest.fn(() => state),
      saveLocalStorage: jest.fn((_key: string, value: unknown) => {
        state = value
      }),
    }
    const store = new AiRunSessionStateStore(storage)
    const snapshot = createSnapshot({
      needsTaskStateReconciliation: true,
      record: {
        ...createSnapshot().record,
        sessionId: 'session-1',
        events: [
          { kind: 'init', sessionId: 'session-1', model: 'test' },
          { kind: 'assistant-text', text: 'answer' },
        ],
      },
    })

    store.saveNow([snapshot])
    const restored = store.load()

    expect(storage.saveLocalStorage).toHaveBeenCalledWith(
      AI_RUN_SESSION_STATE_STORAGE_KEY,
      expect.objectContaining({ version: 1 }),
    )
    expect(restored).toEqual([snapshot])
  })

  test('keeps only a run-bound broker id and never restores a transcript path', () => {
    let state: unknown = null
    const store = new AiRunSessionStateStore({
      loadLocalStorage: () => state,
      saveLocalStorage: (_key, value) => {
        state = value
      },
    })
    store.saveNow([
      createSnapshot({
        record: {
          ...createSnapshot().record,
          terminalSessionId: 'run-1',
          transcriptPath: '/Users/example/valuable-file.md',
        },
      }),
    ])

    expect(store.load()[0]?.record).toMatchObject({
      id: 'run-1',
      terminalSessionId: 'run-1',
    })
    expect(store.load()[0]?.record.transcriptPath).toBeUndefined()

    state = {
      version: 1,
      runs: [
        createSnapshot({
          record: {
            ...createSnapshot().record,
            terminalSessionId: '../another-session',
          },
        }),
      ],
    }
    expect(store.load()[0]?.record.terminalSessionId).toBeUndefined()
  })

  test('coalesces output-heavy updates and flush writes only the latest snapshot', () => {
    const timer = createTimer()
    const saveLocalStorage = jest.fn()
    const store = new AiRunSessionStateStore(
      { loadLocalStorage: () => null, saveLocalStorage },
      { timer, saveDelayMs: 250 },
    )

    const oldSnapshot = jest.fn(() => [createSnapshot({ terminalReplay: 'old' })])
    const latestSnapshot = jest.fn(() => [
      createSnapshot({ terminalReplay: 'latest' }),
    ])
    store.scheduleSave(oldSnapshot)
    store.scheduleSave(latestSnapshot)
    expect(saveLocalStorage).not.toHaveBeenCalled()
    expect(oldSnapshot).not.toHaveBeenCalled()
    expect(latestSnapshot).not.toHaveBeenCalled()

    timer.fire()

    expect(saveLocalStorage).toHaveBeenCalledTimes(1)
    expect(saveLocalStorage.mock.calls[0]?.[1]).toMatchObject({
      runs: [{ terminalReplay: 'latest' }],
    })
    expect(oldSnapshot).not.toHaveBeenCalled()
    expect(latestSnapshot).toHaveBeenCalledTimes(1)
  })

  test('saveNow cancels a pending throttled write so stale output cannot win', () => {
    const timer = createTimer()
    const saveLocalStorage = jest.fn()
    const store = new AiRunSessionStateStore(
      { loadLocalStorage: () => null, saveLocalStorage },
      { timer },
    )

    store.scheduleSave([createSnapshot({ terminalReplay: 'stale' })])
    store.saveNow([createSnapshot({ terminalReplay: 'shutdown snapshot' })])
    timer.fire()

    expect(timer.clear).toHaveBeenCalledTimes(1)
    expect(saveLocalStorage).toHaveBeenCalledTimes(1)
    expect(saveLocalStorage.mock.calls[0]?.[1]).toMatchObject({
      runs: [{ terminalReplay: 'shutdown snapshot' }],
    })
  })

  test('rejects corrupt entries and clamps untrusted replay/events before UI restore', () => {
    const oversizedReplay = 'x'.repeat(AI_RUN_SESSION_REPLAY_LIMIT + 100)
    const tooManyEvents = Array.from(
      { length: AI_RUN_SESSION_EVENT_LIMIT + 100 },
      (_, index) => ({ kind: 'raw', text: `event-${index}` }),
    )
    const state = {
      version: 1,
      runs: [
        { record: { id: '__proto__' } },
        createSnapshot({
          terminalReplay: oversizedReplay,
          record: { ...createSnapshot().record, events: tooManyEvents },
        }),
      ],
    }
    const store = new AiRunSessionStateStore({
      loadLocalStorage: () => state,
      saveLocalStorage: () => undefined,
    })

    const restored = store.load()

    expect(restored).toHaveLength(1)
    expect(restored[0]?.terminalReplay).toHaveLength(AI_RUN_SESSION_REPLAY_LIMIT)
    expect(restored[0]?.record.events.length).toBeLessThanOrEqual(
      AI_RUN_SESSION_EVENT_LIMIT,
    )
    expect(restored[0]?.record.events).toContainEqual({
      kind: 'elision',
      omittedCount: 101,
    })
  })

  test('never evicts an old active run behind twelve newer finished runs', () => {
    const active = createSnapshot({
      record: { ...createSnapshot().record, id: 'old-active', startedAt: 1 },
    })
    const finished = Array.from({ length: 12 }, (_, index) =>
      createSnapshot({
        record: {
          ...createSnapshot().record,
          id: `finished-${index}`,
          status: 'succeeded',
          startedAt: index + 10,
          endedAt: index + 20,
        },
      }),
    )
    const store = new AiRunSessionStateStore({
      loadLocalStorage: () => ({ version: 1, runs: [active, ...finished] }),
      saveLocalStorage: () => undefined,
    })

    const restored = store.load()

    expect(restored).toHaveLength(12)
    expect(restored.map((snapshot) => snapshot.record.id)).toContain('old-active')
    expect(restored.map((snapshot) => snapshot.record.id)).not.toContain(
      'finished-0',
    )
  })

  test('capacity pressure sheds critical output but preserves every recovery marker', () => {
    const denseEvents = Array.from({ length: AI_RUN_SESSION_EVENT_LIMIT }, () => ({
      kind: 'raw' as const,
      text: 'x'.repeat(4 * 1024),
    }))
    const criticalA = createSnapshot({
      needsTaskStateReconciliation: true,
      terminalReplay: 'a'.repeat(AI_RUN_SESSION_REPLAY_LIMIT),
      record: {
        ...createSnapshot().record,
        id: 'critical-a',
        status: 'interrupted',
        events: denseEvents,
      },
    })
    const criticalB = createSnapshot({
      needsTaskStateReconciliation: true,
      terminalReplay: 'b'.repeat(AI_RUN_SESSION_REPLAY_LIMIT),
      record: {
        ...createSnapshot().record,
        id: 'critical-b',
        events: denseEvents,
      },
    })
    let saved: unknown = null
    const store = new AiRunSessionStateStore({
      loadLocalStorage: () => null,
      saveLocalStorage: (_key, value) => {
        saved = value
      },
    })

    store.saveNow([criticalA, criticalB])

    expect(JSON.stringify(saved).length).toBeLessThanOrEqual(
      AI_RUN_SESSION_SERIALIZED_LIMIT,
    )
    expect(saved).toMatchObject({
      runs: [
        {
          record: { id: 'critical-a', events: [] },
          needsTaskStateReconciliation: true,
          extraArgs: [],
        },
        {
          record: { id: 'critical-b', events: [] },
          needsTaskStateReconciliation: true,
          extraArgs: [],
        },
      ],
    })
  })

  test('contains local-storage read/write exceptions', () => {
    const log = jest.fn()
    const store = new AiRunSessionStateStore(
      {
        loadLocalStorage: () => {
          throw new Error('read denied')
        },
        saveLocalStorage: () => {
          throw new Error('quota')
        },
      },
      { log },
    )

    expect(store.load()).toEqual([])
    expect(() => store.saveNow([createSnapshot()])).not.toThrow()
    expect(log).toHaveBeenCalledTimes(2)
  })
})
