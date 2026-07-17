import { TFile } from 'obsidian'

import {
  AiRunAlreadyActiveError,
  AiTaskManager,
  INTERRUPTED_RUN_ERROR_MESSAGE,
  type AiTaskManagerDeps,
} from '../../../src/features/ai-task/services/AiTaskManager'
import type { AiRunSessionSnapshot } from '../../../src/features/ai-task/services/AiRunSessionStateStore'
import type {
  AiRunCallbacks,
  AiRunRequest,
} from '../../../src/features/ai-task/services/dispatchers/Dispatcher'
import type {
  TerminalRunCallbacks,
  TerminalRunHandle,
} from '../../../src/features/ai-task/services/dispatchers/TerminalDispatcher'

function restoredSnapshot(
  overrides: Partial<AiRunSessionSnapshot> = {},
): AiRunSessionSnapshot {
  return {
    record: {
      id: 'restored-run',
      taskPath: 'TaskChute/Task/AI task.md',
      taskName: 'AI task',
      cwd: '/workspace',
      host: 'claude',
      mode: 'terminal',
      status: 'running',
      startedAt: 1_000,
      pid: 999,
      transcriptPath: '/tmp/old-transcript',
      events: [],
    },
    terminalReplay: '\u001b[32mrestored terminal\u001b[0m\r\n',
    extraArgs: ['--model', 'test'],
    ...overrides,
  }
}

function createDeps(
  snapshots: AiRunSessionSnapshot[],
): AiTaskManagerDeps & {
  sessionState: NonNullable<AiTaskManagerDeps['sessionState']>
} {
  const sessionState = {
    load: jest.fn(() => snapshots),
    scheduleSave: jest.fn(),
    saveNow: jest.fn(),
    flush: jest.fn(),
  }
  return {
    app: {
      vault: { cachedRead: jest.fn(async () => '') },
      metadataCache: { getFileCache: jest.fn(() => null) },
    },
    dispatchers: {
      claude: { start: jest.fn(() => ({ pid: 1, stop: jest.fn() })) },
      codex: { start: jest.fn(() => ({ pid: 2, stop: jest.fn() })) },
    },
    binaryLocator: { resolve: jest.fn(async () => '/bin/claude') },
    logWriter: {
      writeRunLog: jest.fn(async () => undefined),
      pruneOldLogs: jest.fn(async () => undefined),
    },
    sessionState,
  }
}

function makeTaskFile(): TFile {
  const file = new TFile()
  file.path = 'TaskChute/Task/AI task.md'
  file.basename = 'AI task'
  file.extension = 'md'
  return file
}

describe('AiTaskManager persisted session restore', () => {
  test('reattaches a broker session with the same run id and restores input only from broker-confirmed metadata', () => {
    let callbacks: TerminalRunCallbacks | null = null
    const write = jest.fn()
    const detach = jest.fn()
    const attach = jest.fn(
      (sessionId: string, nextCallbacks: TerminalRunCallbacks): TerminalRunHandle => {
        callbacks = nextCallbacks
        return {
          sessionId,
          write,
          resize: jest.fn(),
          stop: jest.fn(),
          forceKill: jest.fn(),
        }
      },
    )
    const snapshot = restoredSnapshot({
      record: {
        ...restoredSnapshot().record,
        terminalSessionId: 'restored-run',
        // Persisted paths are untrusted and must never reach cleanup/resize.
        transcriptPath: '/Users/example/valuable-file.md',
      },
    })
    const deps = createDeps([snapshot])
    const readAndDeleteFile = jest.fn(async () => '')
    deps.terminal = {
      dispatcher: {
        isPersistent: true,
        start: jest.fn(),
        attach,
        detach,
      },
      isSupported: () => true,
      makeTempFilePath: jest.fn(),
      readAndDeleteFile,
    }

    const manager = new AiTaskManager(deps)
    expect(attach).toHaveBeenCalledWith(
      'restored-run',
      expect.any(Object),
    )
    expect(manager.getRun('restored-run')).toMatchObject({
      id: 'restored-run',
      status: 'running',
      terminalSessionId: 'restored-run',
    })
    expect(manager.getRun('restored-run')?.transcriptPath).toBeUndefined()
    expect(
      manager.claimInterruptedTaskStateReconciliation('restored-run'),
    ).toBe(false)

    callbacks?.onAttached?.(4242, '/tmp/broker-confirmed-transcript')
    callbacks?.onData('broker replay\r\n')
    manager.sendTerminalInput('restored-run', 'after reload\r')

    expect(manager.getRun('restored-run')).toMatchObject({
      pid: 4242,
      transcriptPath: '/tmp/broker-confirmed-transcript',
      status: 'running',
    })
    expect(write).toHaveBeenCalledWith('after reload\r')
    const chunks: string[] = []
    manager.onTerminalData('restored-run', (chunk) => chunks.push(chunk))
    expect(chunks.join('')).toBe('broker replay\r\n')
    expect(readAndDeleteFile).not.toHaveBeenCalled()

    manager.prepareForRendererReload()
    expect(detach).toHaveBeenCalledTimes(1)
    expect(deps.sessionState.saveNow).toHaveBeenLastCalledWith([
      expect.objectContaining({
        record: expect.objectContaining({
          id: 'restored-run',
          terminalSessionId: 'restored-run',
          transcriptPath: undefined,
          pid: undefined,
          status: 'running',
        }),
      }),
    ])
  })

  test('falls back to interrupted replay when the persisted broker session is missing', () => {
    let callbacks: TerminalRunCallbacks | null = null
    const snapshot = restoredSnapshot({
      record: {
        ...restoredSnapshot().record,
        terminalSessionId: 'restored-run',
        transcriptPath: '/Users/example/valuable-file.md',
      },
    })
    const deps = createDeps([snapshot])
    const readAndDeleteFile = jest.fn(async () => '')
    deps.terminal = {
      dispatcher: {
        isPersistent: true,
        start: jest.fn(),
        attach: jest.fn((_sessionId, nextCallbacks) => {
          callbacks = nextCallbacks
          return {
            sessionId: 'restored-run',
            write: jest.fn(),
            stop: jest.fn(),
          }
        }),
      },
      isSupported: () => true,
      makeTempFilePath: jest.fn(),
      readAndDeleteFile,
    }
    const manager = new AiTaskManager(deps)

    callbacks?.onUnavailable?.()

    expect(manager.getRun('restored-run')).toMatchObject({
      status: 'interrupted',
      errorMessage: INTERRUPTED_RUN_ERROR_MESSAGE,
    })
    expect(manager.getRun('restored-run')?.terminalSessionId).toBeUndefined()
    expect(manager.getRun('restored-run')?.transcriptPath).toBeUndefined()
    expect(readAndDeleteFile).not.toHaveBeenCalled()
    expect(
      manager.claimInterruptedTaskStateReconciliation('restored-run'),
    ).toBe(true)
    const chunks: string[] = []
    manager.onTerminalData('restored-run', (chunk) => chunks.push(chunk))
    expect(chunks.join('')).toContain('restored terminal')
  })

  test('restores a formerly-active PTY as interrupted with replay, never as running', () => {
    const deps = createDeps([restoredSnapshot()])
    const manager = new AiTaskManager(deps)
    const record = manager.getRun('restored-run')

    expect(record).toMatchObject({
      status: 'interrupted',
      errorMessage: INTERRUPTED_RUN_ERROR_MESSAGE,
      exitCode: null,
    })
    expect(record?.pid).toBeUndefined()
    expect(record?.transcriptPath).toBeUndefined()
    expect(manager.getActiveRunForTask('TaskChute/Task/AI task.md')).toBeUndefined()
    expect(manager.hasTaskRunLifecycle('TaskChute/Task/AI task.md')).toBe(true)

    const chunks: string[] = []
    manager.onTerminalData('restored-run', (chunk) => chunks.push(chunk))
    expect(chunks.join('')).toContain('restored terminal')

    expect(manager.claimInterruptedTaskStateReconciliation('restored-run')).toBe(true)
    expect(manager.claimInterruptedTaskStateReconciliation('restored-run')).toBe(false)
    expect(deps.sessionState.saveNow).toHaveBeenCalledWith([
      expect.objectContaining({
        record: expect.objectContaining({ status: 'interrupted' }),
        needsTaskStateReconciliation: true,
      }),
    ])
  })

  test('shares one interrupted timer repair promise with every mounted view', async () => {
    const deps = createDeps([restoredSnapshot()])
    const manager = new AiTaskManager(deps)
    let finishRepair: () => void = () => undefined
    const repair = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRepair = resolve
        }),
    )

    const first = manager.coordinateInterruptedTaskStateReconciliation(
      'restored-run',
      { instanceId: 'timer-instance', timerStartedAt: 500 },
      repair,
    )
    const second = manager.coordinateInterruptedTaskStateReconciliation(
      'restored-run',
      { instanceId: 'timer-instance', timerStartedAt: 500 },
      repair,
    )
    await Promise.resolve()

    expect(repair).toHaveBeenCalledTimes(1)
    expect(manager.hasTaskRunLifecycle('TaskChute/Task/AI task.md')).toBe(true)
    await expect(manager.startRun(makeTaskFile())).rejects.toBeInstanceOf(
      AiRunAlreadyActiveError,
    )

    finishRepair()
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(manager.hasTaskRunLifecycle('TaskChute/Task/AI task.md')).toBe(false)

    const lateRepair = jest.fn(async () => undefined)
    await expect(
      manager.coordinateInterruptedTaskStateReconciliation(
        'restored-run',
        { instanceId: 'timer-instance', timerStartedAt: 500 },
        lateRepair,
      ),
    ).resolves.toBe(true)
    expect(lateRepair).not.toHaveBeenCalled()
    const newTimerRepair = jest.fn(async () => undefined)
    const restoredEndedAt = manager.getRun('restored-run')?.endedAt
    if (restoredEndedAt === undefined) throw new Error('missing restored cutoff')
    await expect(
      manager.coordinateInterruptedTaskStateReconciliation(
        'restored-run',
        {
          instanceId: 'timer-instance',
          timerStartedAt: restoredEndedAt + 1,
        },
        newTimerRepair,
      ),
    ).resolves.toBe(false)
    expect(newTimerRepair).not.toHaveBeenCalled()
    await expect(manager.startRun(makeTaskFile())).rejects.not.toBeInstanceOf(
      AiRunAlreadyActiveError,
    )
  })

  test('keeps the reconciliation marker across repeated reloads without a mounted view', () => {
    const firstDeps = createDeps([restoredSnapshot()])
    new AiTaskManager(firstDeps)
    const persisted = (firstDeps.sessionState.saveNow as jest.Mock).mock
      .calls[0]?.[0] as AiRunSessionSnapshot[]

    const secondDeps = createDeps(persisted)
    const secondManager = new AiTaskManager(secondDeps)

    expect(secondManager.getRun('restored-run')?.status).toBe('interrupted')
    expect(
      secondManager.claimInterruptedTaskStateReconciliation('restored-run'),
    ).toBe(true)
    secondManager.completeInterruptedTaskStateReconciliation('restored-run')
    expect(
      secondManager.hasTaskRunLifecycle('TaskChute/Task/AI task.md'),
    ).toBe(false)
    expect(secondDeps.sessionState.saveNow).toHaveBeenLastCalledWith([
      expect.not.objectContaining({ needsTaskStateReconciliation: true }),
    ])
  })

  test('keeps a completed run completed and does not request timer reconciliation', () => {
    const finished = restoredSnapshot({
      record: {
        ...restoredSnapshot().record,
        status: 'succeeded',
        endedAt: 2_000,
        exitCode: 0,
      },
    })
    const deps = createDeps([finished])
    const manager = new AiTaskManager(deps)

    expect(manager.getRun('restored-run')?.status).toBe('succeeded')
    expect(manager.hasTaskRunLifecycle('TaskChute/Task/AI task.md')).toBe(false)
    expect(manager.claimInterruptedTaskStateReconciliation('restored-run')).toBe(false)
    // No active status needed normalization, so construction is read-only.
    expect(deps.sessionState.saveNow).not.toHaveBeenCalled()
  })

  test('closing a restored run removes it from the durable workspace', () => {
    const deps = createDeps([restoredSnapshot()])
    const manager = new AiTaskManager(deps)
    const saveNow = deps.sessionState.saveNow as jest.Mock
    saveNow.mockClear()

    manager.releaseRun('restored-run')

    expect(manager.getRuns()).toEqual([])
    expect(saveNow).toHaveBeenCalledWith([])
  })

  test('dispose snapshots the live status before a synchronous stop exit races in', async () => {
    let callbacks: AiRunCallbacks | null = null
    const stop = jest.fn(() => {
      callbacks?.onExit({
        status: 'stopped',
        exitCode: null,
        signal: 'SIGTERM',
      })
    })
    const dispatcher = {
      start: jest.fn((_request: AiRunRequest, nextCallbacks: AiRunCallbacks) => {
        callbacks = nextCallbacks
        return { pid: 4242, stop, forceKill: jest.fn() }
      }),
    }
    const deps = createDeps([])
    deps.app.vault.cachedRead = jest.fn(async () => '# Task\n\n## Prompt\n\nRun\n')
    deps.app.metadataCache.getFileCache = jest.fn(() => ({
      frontmatter: { ai_task: true },
    }))
    deps.dispatchers = { claude: dispatcher, codex: dispatcher }
    deps.timer = {
      setTimeout: jest.fn(() => 1),
      clearTimeout: jest.fn(),
    }
    const manager = new AiTaskManager(deps)
    await manager.startRun(makeTaskFile(), { mode: 'headless' })
    const saveNow = deps.sessionState.saveNow as jest.Mock
    saveNow.mockClear()

    manager.dispose()

    expect(stop).toHaveBeenCalledTimes(1)
    expect(manager.getRuns()[0]?.status).toBe('stopped')
    const saves = saveNow.mock.calls
    expect(saves).toHaveLength(1)
    expect(saves[0]?.[0]?.[0]?.record.status).toBe('running')
  })
})
