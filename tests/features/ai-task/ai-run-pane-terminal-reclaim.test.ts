/**
 * AiRunPaneController terminal-binding reclamation:
 *   - a finished run's binding (adapter + data subscription) is disposed
 *     once its exit persist completed ('persisted' observed) AND no visible
 *     panel presents the run; the row/body stay, and reselecting re-creates
 *     the adapter with the manager's subscribe-time replay restoring the
 *     screen (the renderer-reload mechanism)
 *   - a VISIBLE finished run keeps its binding (the existing snapshot
 *     contract) and is reclaimed only when it leaves the screen
 *   - a hidden finished run whose 'persisted' has not arrived is never
 *     reclaimed — the exit-time snapshot must read a live adapter
 *   - mount-restored finished records count as persisted (their persist
 *     chain ended in a previous pane lifetime) and are reclaimable
 *   - bindings of still-ACTIVE runs are NEVER reclaimed, hidden or not:
 *     the exit-time log snapshot must read the live adapter, and the
 *     transcript fallback is a degraded TUI redraw stream
 */
import { AiRunPaneController } from '../../../src/features/ai-task/ui/AiRunPaneController'
import type { AiRunPaneControllerHost } from '../../../src/features/ai-task/ui/AiRunPaneController'
import type { AiRunChangeType } from '../../../src/features/ai-task/services/AiTaskManager'
import type { TerminalViewAdapterLike } from '../../../src/features/ai-task/ui/TerminalViewAdapter'
import type { AiRunRecord } from '../../../src/features/ai-task/types'

type ChangeListener = (record: AiRunRecord, changeType?: AiRunChangeType) => void
type TerminalDataListener = (chunk: string) => void

class FakeTerminalAdapter implements TerminalViewAdapterLike {
  opened: { container: HTMLElement; cols: number; rows: number } | null = null
  written: string[] = []
  focus = jest.fn()
  disposed = false
  snapshot = 'fake terminal snapshot'
  private readonly dataListeners = new Set<(data: string) => void>()

  open(container: HTMLElement, cols: number, rows: number): void {
    this.opened = { container, cols, rows }
  }

  write(data: string): void {
    this.written.push(data)
  }

  snapshotText(): string {
    return this.disposed ? '' : this.snapshot
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback)
    return () => {
      this.dataListeners.delete(callback)
    }
  }

  dispose(): void {
    this.disposed = true
    this.dataListeners.clear()
  }
}

class FakeManager {
  readonly listeners = new Set<ChangeListener>()
  readonly records: AiRunRecord[] = []
  readonly terminalListeners = new Map<string, Set<TerminalDataListener>>()
  /** Buffered output replayed synchronously on subscribe (manager contract) */
  readonly terminalBuffers = new Map<string, string>()
  readonly persistedRunIds = new Set<string>()
  readonly stopRun = jest.fn()
  readonly followUp = jest.fn(() => Promise.resolve())
  readonly sendTerminalInput = jest.fn()
  snapshotProvider:
    | ((runId: string) => string | undefined | Promise<string | undefined>)
    | null = null

  registerTerminalSnapshotProvider(
    provider: (
      runId: string,
    ) => string | undefined | Promise<string | undefined>,
  ): () => void {
    this.snapshotProvider = provider
    return () => {
      if (this.snapshotProvider === provider) {
        this.snapshotProvider = null
      }
    }
  }

  getRuns(): AiRunRecord[] {
    return [...this.records]
  }

  getRun(runId: string): AiRunRecord | undefined {
    return this.records.find((record) => record.id === runId)
  }

  isRunExitPersisted(runId: string): boolean {
    return this.persistedRunIds.has(runId)
  }

  getActiveRunForTask(taskPath: string): AiRunRecord | undefined {
    return this.records.find(
      (record) =>
        record.taskPath === taskPath &&
        (record.status === 'starting' ||
          record.status === 'running' ||
          record.status === 'stopping'),
    )
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onTerminalData(runId: string, listener: TerminalDataListener): () => void {
    const listeners = this.terminalListeners.get(runId) ?? new Set()
    this.terminalListeners.set(runId, listeners)
    listeners.add(listener)
    const buffered = this.terminalBuffers.get(runId)
    if (buffered !== undefined && buffered.length > 0) {
      listener(buffered)
    }
    return () => {
      listeners.delete(listener)
    }
  }

  emit(record: AiRunRecord, changeType: AiRunChangeType = 'update'): void {
    if (!this.records.includes(record)) {
      this.records.push(record)
    }
    if (changeType === 'persisted') {
      this.persistedRunIds.add(record.id)
    } else if (
      record.status === 'starting' ||
      record.status === 'running' ||
      record.status === 'stopping'
    ) {
      this.persistedRunIds.delete(record.id)
    }
    for (const listener of Array.from(this.listeners)) {
      listener(record, changeType)
    }
  }

  terminalListenerCount(runId: string): number {
    return this.terminalListeners.get(runId)?.size ?? 0
  }
}

function createRun(overrides: Partial<AiRunRecord> = {}): AiRunRecord {
  return {
    id: 'run-1',
    taskPath: 'TASKS/ai-sample.md',
    taskName: 'AI sample',
    host: 'claude',
    mode: 'terminal',
    status: 'running',
    cols: 100,
    rows: 25,
    startedAt: Date.now(),
    events: [],
    ...overrides,
  }
}

describe('AiRunPaneController terminal-binding reclamation', () => {
  let container: HTMLElement
  let manager: FakeManager
  let adapters: FakeTerminalAdapter[]
  let host: AiRunPaneControllerHost
  let controller: AiRunPaneController

  beforeEach(() => {
    document.body.replaceChildren()
    container = document.body.createDiv({ cls: 'ai-pane-container' })
    manager = new FakeManager()
    adapters = []
    host = {
      tv: (_key, fallback) => fallback,
      manager,
      createTerminalAdapter: () => {
        const adapter = new FakeTerminalAdapter()
        adapters.push(adapter)
        return adapter
      },
      registerManagedDisposer: () => undefined,
    }
    controller = new AiRunPaneController(host)
  })

  test('disposes a hidden finished binding on persisted and re-creates it on reselect with replay', () => {
    controller.mount(container)
    const runA = createRun({ id: 'run-a', taskPath: 'TASKS/a.md' })
    const runB = createRun({ id: 'run-b', taskPath: 'TASKS/b.md' })
    manager.emit(runA)
    manager.emit(runB)
    controller.openRun('run-b')
    // run-a is hidden but still active: its binding stays wired.
    expect(adapters).toHaveLength(2)
    expect(adapters[0].disposed).toBe(false)

    runA.status = 'succeeded'
    manager.emit(runA)
    // Finished but not yet persisted: the exit snapshot may still be read.
    expect(adapters[0].disposed).toBe(false)

    manager.emit(runA, 'persisted')
    expect(adapters[0].disposed).toBe(true)
    expect(manager.terminalListenerCount('run-a')).toBe(0)
    // Only the binding was reclaimed — the run stays in the sidebar, and the
    // snapshot provider now reports no live adapter (manager falls back).
    expect(
      container.querySelector('.ai-run-pane__run[data-run-id="run-a"]'),
    ).not.toBeNull()
    expect(manager.snapshotProvider?.('run-a')).toBeUndefined()

    manager.terminalBuffers.set('run-a', 'replayed screen')
    controller.openRun('run-a')
    expect(adapters).toHaveLength(3)
    expect(adapters[2].written).toEqual(['replayed screen'])
    expect(manager.terminalListenerCount('run-a')).toBe(1)
  })

  test('keeps a VISIBLE finished binding and reclaims it when the run leaves the screen', () => {
    controller.mount(container)
    const runA = createRun({ id: 'run-a', taskPath: 'TASKS/a.md' })
    manager.emit(runA)
    runA.status = 'succeeded'
    manager.emit(runA)
    manager.emit(runA, 'persisted')
    // Selected in the primary panel: the binding survives the persist.
    expect(adapters[0].disposed).toBe(false)

    const runB = createRun({ id: 'run-b', taskPath: 'TASKS/b.md' })
    manager.emit(runB)
    controller.openRun('run-b')

    expect(adapters[0].disposed).toBe(true)
  })

  test('never reclaims a hidden finished binding before its persisted notification', () => {
    controller.mount(container)
    const runA = createRun({ id: 'run-a', taskPath: 'TASKS/a.md' })
    const runB = createRun({ id: 'run-b', taskPath: 'TASKS/b.md' })
    manager.emit(runA)
    manager.emit(runB)
    controller.openRun('run-b')

    runA.status = 'succeeded'
    manager.emit(runA)
    // Force a reclaim sweep while run-a is hidden + finished + unpersisted.
    controller.openRun('run-b')
    expect(adapters[0].disposed).toBe(false)
    expect(manager.snapshotProvider?.('run-a')).toBe('fake terminal snapshot')

    manager.emit(runA, 'persisted')
    expect(adapters[0].disposed).toBe(true)
  })

  test('mount-restored finished records are reclaimable once hidden', () => {
    manager.persistedRunIds.add('run-old')
    manager.records.push(
      createRun({ id: 'run-old', taskPath: 'TASKS/old.md', status: 'succeeded' }),
    )
    manager.records.push(createRun({ id: 'run-live', taskPath: 'TASKS/live.md' }))
    manager.terminalBuffers.set('run-old', 'restored screen')
    controller.mount(container)

    // The mount replay auto-selected the restored run and replayed its
    // buffered output into the fresh adapter (reload-restore contract).
    expect(adapters).toHaveLength(1)
    expect(adapters[0].written).toEqual(['restored screen'])

    controller.openRun('run-live')
    // Hidden + finished + persisted-in-a-previous-lifetime: reclaimed.
    expect(adapters[0].disposed).toBe(true)
  })

  test('mount during final-status-to-persisted gap keeps the hidden snapshot adapter', () => {
    const runFinished = createRun({
      id: 'run-finishing',
      taskPath: 'TASKS/finishing.md',
      status: 'succeeded',
    })
    const runLive = createRun({
      id: 'run-live',
      taskPath: 'TASKS/live.md',
    })
    manager.records.push(runFinished, runLive)

    controller.mount(container)
    expect(adapters).toHaveLength(1)
    expect(manager.isRunExitPersisted(runFinished.id)).toBe(false)

    controller.openRun(runLive.id)

    // The manager has published the final status but has not emitted the
    // later persisted notification yet, so the snapshot source must survive.
    expect(adapters[0].disposed).toBe(false)
    expect(manager.snapshotProvider?.(runFinished.id)).toBe(
      'fake terminal snapshot',
    )

    manager.emit(runFinished, 'persisted')
    expect(adapters[0].disposed).toBe(true)
  })

  test('never reclaims hidden ACTIVE bindings regardless of how many pile up', () => {
    controller.mount(container)
    const runCount = 8
    const runs = Array.from({ length: runCount }, (_unused, i) =>
      createRun({ id: `run-${i + 1}`, taskPath: `TASKS/${i + 1}.md` }),
    )
    for (const run of runs) manager.emit(run)
    for (let i = 2; i <= runCount; i += 1) controller.openRun(`run-${i}`)

    // Every active run keeps its live binding and data subscription even
    // while hidden: the exit-time snapshot must read the live adapter.
    expect(adapters).toHaveLength(runCount)
    expect(adapters.every((adapter) => !adapter.disposed)).toBe(true)
    for (let i = 1; i <= runCount; i += 1) {
      expect(manager.terminalListenerCount(`run-${i}`)).toBe(1)
    }
    expect(manager.snapshotProvider?.('run-1')).toBe('fake terminal snapshot')

    // A hidden run that finishes AND persists is reclaimed; its still-active
    // hidden neighbours are untouched.
    runs[0].status = 'succeeded'
    manager.emit(runs[0])
    manager.emit(runs[0], 'persisted')
    expect(adapters[0].disposed).toBe(true)
    expect(adapters.slice(1).every((adapter) => !adapter.disposed)).toBe(true)
  })
})
