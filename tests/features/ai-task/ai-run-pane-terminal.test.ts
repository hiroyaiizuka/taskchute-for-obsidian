/**
 * AiRunPaneController terminal-mode behavior (adapter fully mocked):
 *   - terminal runs get a --terminal body and a LAZILY created adapter
 *     (created only when the run's tab is shown, sized from the record's
 *     PTY dimensions)
 *   - manager.onTerminalData chunks are relayed into adapter.write and
 *     adapter keystrokes are relayed into manager.sendTerminalInput
 *   - selecting a terminal tab focuses its adapter
 *   - the follow-up composer is hidden for terminal runs but stays usable
 *     for headless runs
 *   - the host container carries the terminal chrome class only while a
 *     terminal run is selected and the pane is expanded
 *   - unmount disposes every adapter and unsubscribes all listeners
 *   - computeTerminalSize falls back to 120x30 when the pane has no
 *     measurable pixel size (always true in jsdom)
 */
import { AiRunPaneController } from '../../../src/features/ai-task/ui/AiRunPaneController'
import type { AiRunPaneControllerHost } from '../../../src/features/ai-task/ui/AiRunPaneController'
import type { TerminalViewAdapterLike } from '../../../src/features/ai-task/ui/TerminalViewAdapter'
import type { AiRunRecord } from '../../../src/features/ai-task/types'

type ChangeListener = (record: AiRunRecord) => void
type TerminalDataListener = (chunk: string) => void

class FakeTerminalAdapter implements TerminalViewAdapterLike {
  opened: { container: HTMLElement; cols: number; rows: number } | null = null
  openedWithTerminalChrome = false
  openedWithComposerHidden = false
  written: string[] = []
  focus = jest.fn()
  disposed = false
  /** Text returned by snapshotText(); settable per test */
  snapshot = 'fake terminal snapshot'
  private readonly dataListeners = new Set<(data: string) => void>()

  open(container: HTMLElement, cols: number, rows: number): void {
    this.opened = { container, cols, rows }
    const pane = container.closest('.ai-run-pane')
    this.openedWithTerminalChrome =
      pane?.parentElement?.classList.contains('ai-pane-container--terminal') ??
      false
    this.openedWithComposerHidden =
      pane
        ?.querySelector('.ai-run-pane__composer')
        ?.classList.contains('is-hidden') ?? false
  }

  write(data: string): void {
    this.written.push(data)
  }

  snapshotText(): string {
    return this.snapshot
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

  emitData(data: string): void {
    for (const listener of Array.from(this.dataListeners)) {
      listener(data)
    }
  }

  get dataListenerCount(): number {
    return this.dataListeners.size
  }
}

class FakeManager {
  readonly listeners = new Set<ChangeListener>()
  readonly records: AiRunRecord[] = []
  readonly terminalListeners = new Map<string, Set<TerminalDataListener>>()
  /**
   * Buffered output replayed synchronously on subscribe, mirroring the real
   * manager's onTerminalData replay contract (see AiTaskManager).
   */
  readonly terminalBuffers = new Map<string, string>()
  readonly stopRun = jest.fn()
  readonly followUp = jest.fn(() => Promise.resolve())
  readonly sendTerminalInput = jest.fn()
  /** Mirrors the real manager's single-provider snapshot registration */
  snapshotProvider:
    | ((runId: string) => string | undefined | Promise<string | undefined>)
    | null = null
  snapshotProviderUnregisterCount = 0

  registerTerminalSnapshotProvider(
    provider: (
      runId: string,
    ) => string | undefined | Promise<string | undefined>,
  ): () => void {
    this.snapshotProvider = provider
    return () => {
      this.snapshotProviderUnregisterCount += 1
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

  emit(record: AiRunRecord): void {
    if (!this.records.includes(record)) {
      this.records.push(record)
    }
    for (const listener of this.listeners) {
      listener(record)
    }
  }

  emitTerminalData(runId: string, chunk: string): void {
    for (const listener of this.terminalListeners.get(runId) ?? []) {
      listener(chunk)
    }
  }

  terminalListenerCount(runId: string): number {
    return this.terminalListeners.get(runId)?.size ?? 0
  }
}

function createRun(overrides: Partial<AiRunRecord> = {}): AiRunRecord {
  return {
    id: 'run-terminal-1',
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

describe('AiRunPaneController terminal mode', () => {
  let container: HTMLElement
  let manager: FakeManager
  let adapters: FakeTerminalAdapter[]
  let createTerminalAdapter: jest.Mock<FakeTerminalAdapter, []>
  let host: AiRunPaneControllerHost
  let controller: AiRunPaneController

  beforeEach(() => {
    document.body.replaceChildren()
    container = document.body.createDiv({ cls: 'ai-pane-container' })
    manager = new FakeManager()
    adapters = []
    createTerminalAdapter = jest.fn(() => {
      const adapter = new FakeTerminalAdapter()
      adapters.push(adapter)
      return adapter
    })
    host = {
      tv: (_key, fallback, vars) => {
        if (!vars) return fallback
        return Object.entries(vars).reduce(
          (acc, [name, value]) => acc.replace(`{${name}}`, String(value)),
          fallback,
        )
      },
      manager,
      createTerminalAdapter,
      registerManagedDisposer: () => undefined,
    }
    controller = new AiRunPaneController(host)
  })

  test('creates the adapter for the auto-selected terminal run, opens it inside the body with the record size, and focuses it', () => {
    controller.mount(container)
    manager.emit(createRun())

    expect(createTerminalAdapter).toHaveBeenCalledTimes(1)
    const adapter = adapters[0]
    expect(adapter.opened).not.toBeNull()
    expect(adapter.opened?.cols).toBe(100)
    expect(adapter.opened?.rows).toBe(25)

    const body = container.querySelector('.ai-run-pane__body--terminal')
    expect(body).not.toBeNull()
    expect(body?.classList.contains('is-active')).toBe(true)
    expect(
      body === adapter.opened?.container ||
        body?.contains(adapter.opened?.container ?? null),
    ).toBe(true)
    expect(adapter.openedWithTerminalChrome).toBe(true)
    expect(adapter.openedWithComposerHidden).toBe(true)
    expect(adapter.focus).toHaveBeenCalled()
  })

  test('adapter creation is lazy: unselected terminal runs get no adapter until their tab is shown', () => {
    controller.mount(container)
    manager.emit(createRun({ id: 'run-a', taskName: 'Task A' }))
    manager.emit(createRun({ id: 'run-b', taskName: 'Task B' }))

    expect(createTerminalAdapter).toHaveBeenCalledTimes(1)

    controller.openRun('run-b')
    expect(createTerminalAdapter).toHaveBeenCalledTimes(2)
    expect(adapters[1].opened?.cols).toBe(100)
  })

  test('applies terminal chrome and hides the composer before opening a terminal selected after a headless run', () => {
    controller.mount(container)
    manager.emit(
      createRun({
        id: 'run-headless',
        taskPath: 'TASKS/headless.md',
        mode: 'headless',
        status: 'succeeded',
        cols: undefined,
        rows: undefined,
      }),
    )
    manager.emit(
      createRun({
        id: 'run-terminal',
        taskPath: 'TASKS/terminal.md',
      }),
    )

    expect(createTerminalAdapter).not.toHaveBeenCalled()
    controller.openRun('run-terminal')

    expect(createTerminalAdapter).toHaveBeenCalledTimes(1)
    expect(adapters[0].openedWithTerminalChrome).toBe(true)
    expect(adapters[0].openedWithComposerHidden).toBe(true)
  })

  test('reselecting a tab reuses the existing adapter', () => {
    controller.mount(container)
    manager.emit(createRun({ id: 'run-a' }))
    manager.emit(createRun({ id: 'run-b' }))
    controller.openRun('run-b')
    controller.openRun('run-a')
    controller.openRun('run-b')

    expect(createTerminalAdapter).toHaveBeenCalledTimes(2)
  })

  test('relays manager terminal data into adapter.write', () => {
    controller.mount(container)
    const run = createRun()
    manager.emit(run)

    manager.emitTerminalData(run.id, 'hello [31mworld[0m')
    manager.emitTerminalData(run.id, ' more')

    expect(adapters[0].written).toEqual(['hello [31mworld[0m', ' more'])
  })

  test('relays adapter keystrokes into manager.sendTerminalInput', () => {
    controller.mount(container)
    const run = createRun()
    manager.emit(run)

    adapters[0].emitData('ls -la\r')

    expect(manager.sendTerminalInput).toHaveBeenCalledWith(run.id, 'ls -la\r')
  })

  test('selecting a terminal tab focuses its adapter again', () => {
    controller.mount(container)
    manager.emit(createRun({ id: 'run-a' }))
    manager.emit(createRun({ id: 'run-b' }))
    controller.openRun('run-b')

    adapters[0].focus.mockClear()
    controller.openRun('run-a')

    expect(adapters[0].focus).toHaveBeenCalledTimes(1)
  })

  test('does not render stream events into a terminal body', () => {
    controller.mount(container)
    const run = createRun({
      events: [{ kind: 'assistant-text', text: 'should not appear' }],
    })
    manager.emit(run)
    run.events.push({ kind: 'stderr', text: 'later event' })
    manager.emit(run)

    const body = container.querySelector('.ai-run-pane__body--terminal')
    expect(body?.querySelectorAll('.ai-run-pane__event')).toHaveLength(0)
  })

  test('hides the composer for terminal runs and keeps it for headless runs', () => {
    controller.mount(container)
    const terminalRun = createRun({ id: 'run-terminal' })
    const headlessRun = createRun({
      id: 'run-headless',
      // A different task: the terminal run above is still active, and an
      // active sibling run would legitimately disable the composer.
      taskPath: 'TASKS/other-task.md',
      mode: 'headless',
      status: 'succeeded',
      sessionId: 'sess-1',
      cols: undefined,
      rows: undefined,
    })
    manager.emit(terminalRun)
    manager.emit(headlessRun)

    const composer = container.querySelector('.ai-run-pane__composer')
    expect(composer).not.toBeNull()
    // terminal run is auto-selected first
    expect(composer?.classList.contains('is-hidden')).toBe(true)

    controller.openRun('run-headless')
    expect(composer?.classList.contains('is-hidden')).toBe(false)
    const input = container.querySelector<HTMLInputElement>(
      '.ai-run-pane__composer-input',
    )
    expect(input?.disabled).toBe(false)

    controller.openRun('run-terminal')
    expect(composer?.classList.contains('is-hidden')).toBe(true)
  })

  test('toggles the terminal chrome class on the host container with selection and collapse', () => {
    controller.mount(container)
    const terminalRun = createRun({ id: 'run-terminal' })
    const headlessRun = createRun({ id: 'run-headless', mode: 'headless' })
    manager.emit(terminalRun)

    expect(container.classList.contains('ai-pane-container--terminal')).toBe(true)

    controller.setCollapsed(true)
    expect(container.classList.contains('ai-pane-container--terminal')).toBe(false)

    controller.setCollapsed(false)
    expect(container.classList.contains('ai-pane-container--terminal')).toBe(true)

    manager.emit(headlessRun)
    controller.openRun('run-headless')
    expect(container.classList.contains('ai-pane-container--terminal')).toBe(false)
  })

  test('defers adapter creation while the pane is collapsed and creates it on expand', () => {
    controller.mount(container)
    controller.setCollapsed(true)
    manager.emit(createRun())

    expect(createTerminalAdapter).not.toHaveBeenCalled()

    controller.setCollapsed(false)
    expect(createTerminalAdapter).toHaveBeenCalledTimes(1)
  })

  test('unmount disposes adapters, drops terminal subscriptions, and removes the chrome class', () => {
    controller.mount(container)
    const run = createRun()
    manager.emit(run)
    expect(manager.terminalListenerCount(run.id)).toBe(1)

    controller.unmount()

    expect(adapters[0].disposed).toBe(true)
    expect(adapters[0].dataListenerCount).toBe(0)
    expect(manager.terminalListenerCount(run.id)).toBe(0)
    expect(manager.listeners.size).toBe(0)
    expect(container.classList.contains('ai-pane-container--terminal')).toBe(false)
  })

  test('computeTerminalSize falls back to 120x30 without measurable pixel dimensions', () => {
    controller.mount(container)

    expect(controller.computeTerminalSize()).toEqual({ cols: 120, rows: 30 })
  })

  test('computeTerminalSize derives cols and rows from the container width and parent height', () => {
    controller.mount(container)
    Object.defineProperty(container, 'clientWidth', {
      configurable: true,
      value: 816,
    })
    Object.defineProperty(document.body, 'clientHeight', {
      configurable: true,
      value: 1000,
    })

    const size = controller.computeTerminalSize()
    // 40% of the parent height minus the pane chrome, divided by the cell
    // height; the exact cell constants live in the controller — assert sane
    // bounds (strictly below the 120x30 fallback, so a fallback return
    // cannot masquerade as a measurement) instead of duplicating them here.
    expect(size.cols).toBeGreaterThan(20)
    expect(size.cols).toBeLessThan(120)
    expect(size.rows).toBeGreaterThan(5)
    expect(size.rows).toBeLessThan(30)
  })

  test('the terminal tab × drives manager.stopRun while the run is active', () => {
    controller.mount(container)
    const run = createRun({ status: 'running' })
    manager.emit(run)

    const closeButton = container.querySelector<HTMLButtonElement>(
      '.ai-run-pane__tab-close',
    )
    expect(closeButton).not.toBeNull()
    closeButton?.click()

    expect(manager.stopRun).toHaveBeenCalledTimes(1)
    expect(manager.stopRun).toHaveBeenCalledWith(run.id)
    // The view (and its adapter) stays alive until 'persisted'.
    expect(adapters[0].disposed).toBe(false)
    expect(
      container.querySelector('.ai-run-pane__body--terminal'),
    ).not.toBeNull()
  })

  test('a pane rebuild (unmount + mount) replays the buffered output into a fresh adapter', () => {
    controller.mount(container)
    const run = createRun()
    manager.emit(run)
    manager.emitTerminalData(run.id, 'live output before the reload')
    expect(adapters[0].written).toEqual(['live output before the reload'])

    // View reload: the old pane (and adapter) is torn down...
    controller.unmount()
    expect(adapters[0].disposed).toBe(true)

    // ...and the manager still holds the run + its replay buffer.
    manager.terminalBuffers.set(run.id, 'live output before the reload')
    const rebuilt = new AiRunPaneController(host)
    rebuilt.mount(container)

    // The rebuilt pane recreated the view from getRuns(), auto-selected the
    // run, opened a fresh adapter, and the subscribe-time replay restored
    // the screen — it is NOT blank.
    expect(adapters).toHaveLength(2)
    expect(adapters[1].opened?.cols).toBe(100)
    expect(adapters[1].opened?.rows).toBe(25)
    expect(adapters[1].written).toEqual(['live output before the reload'])

    // Live chunks keep flowing after the replay.
    manager.emitTerminalData(run.id, 'post-reload chunk')
    expect(adapters[1].written).toEqual([
      'live output before the reload',
      'post-reload chunk',
    ])
    rebuilt.unmount()
  })

  test('mount registers a snapshot provider that reads the run adapter buffer', () => {
    controller.mount(container)
    const run = createRun()
    manager.emit(run)
    adapters[0].snapshot = 'final screen text'

    expect(manager.snapshotProvider).not.toBeNull()
    expect(manager.snapshotProvider?.(run.id)).toBe('final screen text')
  })

  test('the snapshot provider returns undefined for runs without a live adapter', () => {
    controller.mount(container)
    // Collapsed pane: the terminal run gets NO adapter (lazy creation).
    controller.setCollapsed(true)
    const run = createRun()
    manager.emit(run)

    expect(manager.snapshotProvider?.(run.id)).toBeUndefined()
    expect(manager.snapshotProvider?.('unknown-run')).toBeUndefined()
  })

  test('a finished run keeps its adapter alive so the exit-time snapshot still resolves', () => {
    controller.mount(container)
    const run = createRun({ status: 'running' })
    manager.emit(run)
    adapters[0].snapshot = 'screen at exit'

    // The manager notifies the final status BEFORE it consumes the snapshot
    // in its persist step; the pane must not tear the adapter down on that
    // status change.
    run.status = 'succeeded'
    manager.emit(run)

    expect(adapters[0].disposed).toBe(false)
    expect(manager.snapshotProvider?.(run.id)).toBe('screen at exit')
  })

  test('unmount unregisters the snapshot provider', () => {
    controller.mount(container)
    manager.emit(createRun())

    controller.unmount()

    expect(manager.snapshotProviderUnregisterCount).toBe(1)
    expect(manager.snapshotProvider).toBeNull()
  })
})
