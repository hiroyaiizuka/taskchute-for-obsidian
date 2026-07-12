/**
 * AiRunPaneController tab lifecycle around run end:
 *   - a run reaching status 'stopped' keeps its sidebar row (and live
 *     adapter) until the manager's 'persisted' notification arrives — the
 *     exit-time transcript snapshot must still find the adapter
 *   - on 'persisted' the stopped run's view closes: adapter disposed, row
 *     and body removed, the most recent remaining run selected, and the pane
 *     hides again once no runs remain (pre-first-run state)
 *   - succeeded/failed runs KEEP their row and their × becomes a plain close
 *     control that disposes the adapter and removes the row on click
 *   - headless stopped runs (no adapter) drop their row just as cleanly
 *   - a mount replay never resurrects rows for already-stopped runs
 * Plus one integration test with the REAL AiTaskManager proving the
 * pane-registered snapshot provider is consulted before the tab teardown.
 */
import { TFile } from 'obsidian'
import { AiRunPaneController } from '../../../src/features/ai-task/ui/AiRunPaneController'
import type { AiRunPaneControllerHost } from '../../../src/features/ai-task/ui/AiRunPaneController'
import {
  AiTaskManager,
  type AiRunChangeType,
  type AiTaskManagerDeps,
} from '../../../src/features/ai-task/services/AiTaskManager'
import type {
  AiTerminalDispatcher,
  TerminalRunCallbacks,
  TerminalRunRequest,
} from '../../../src/features/ai-task/services/dispatchers/TerminalDispatcher'
import type {
  AiDispatcher,
  AiRunExitOutcome,
} from '../../../src/features/ai-task/services/dispatchers/Dispatcher'
import type { TerminalViewAdapterLike } from '../../../src/features/ai-task/ui/TerminalViewAdapter'
import type { AiRunRecord } from '../../../src/features/ai-task/types'

type ChangeListener = (record: AiRunRecord, changeType?: AiRunChangeType) => void
type TerminalDataListener = (chunk: string) => void

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

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
  readonly stopRun = jest.fn()
  readonly followUp = jest.fn(() => Promise.resolve())
  readonly sendTerminalInput = jest.fn()
  snapshotProvider: ((runId: string) => string | undefined) | null = null

  registerTerminalSnapshotProvider(
    provider: (runId: string) => string | undefined,
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
    return () => {
      listeners.delete(listener)
    }
  }

  emit(record: AiRunRecord, changeType: AiRunChangeType = 'update'): void {
    if (!this.records.includes(record)) {
      this.records.push(record)
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

describe('AiRunPaneController stopped-run tab cleanup', () => {
  let container: HTMLElement
  let manager: FakeManager
  let adapters: FakeTerminalAdapter[]
  let host: AiRunPaneControllerHost
  let controller: AiRunPaneController

  const pane = (): HTMLElement | null => container.querySelector('.ai-run-pane')
  const rows = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>('.ai-run-pane__run'))
  const bodies = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>('.ai-run-pane__body'))

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

  test('a stopped status change alone keeps the row and the live adapter', () => {
    controller.mount(container)
    const run = createRun()
    manager.emit(run)
    expect(adapters).toHaveLength(1)

    run.status = 'stopped'
    manager.emit(run)

    expect(rows()).toHaveLength(1)
    expect(adapters[0].disposed).toBe(false)
    // The manager's exit-time snapshot still resolves through the provider.
    expect(manager.snapshotProvider?.(run.id)).toBe('fake terminal snapshot')
  })

  test("the 'persisted' notification closes the stopped run, disposes the adapter, and hides the pane when it was the last", () => {
    controller.mount(container)
    const run = createRun()
    manager.emit(run)
    expect(pane()?.classList.contains('is-hidden')).toBe(false)

    run.status = 'stopped'
    manager.emit(run)
    manager.emit(run, 'persisted')

    expect(rows()).toHaveLength(0)
    expect(bodies()).toHaveLength(0)
    expect(adapters[0].disposed).toBe(true)
    expect(manager.terminalListenerCount(run.id)).toBe(0)
    // Back to the pre-first-run state: hidden pane, no terminal chrome.
    expect(pane()?.classList.contains('is-hidden')).toBe(true)
    expect(container.classList.contains('ai-pane-container--terminal')).toBe(false)
  })

  test('closing the selected stopped run selects the most recent remaining run', () => {
    controller.mount(container)
    const runA = createRun({ id: 'run-a', taskPath: 'TASKS/a.md' })
    const runB = createRun({ id: 'run-b', taskPath: 'TASKS/b.md' })
    const runC = createRun({ id: 'run-c', taskPath: 'TASKS/c.md' })
    manager.emit(runA)
    manager.emit(runB)
    manager.emit(runC)
    // run-a was auto-selected as the first run.
    expect(
      container
        .querySelector('.ai-run-pane__run[data-run-id="run-a"]')
        ?.classList.contains('is-active'),
    ).toBe(true)

    runA.status = 'stopped'
    manager.emit(runA)
    manager.emit(runA, 'persisted')

    expect(rows()).toHaveLength(2)
    // Most recent remaining run (run-c) takes over the selection.
    expect(
      container
        .querySelector('.ai-run-pane__run[data-run-id="run-c"]')
        ?.classList.contains('is-active'),
    ).toBe(true)
    expect(
      container
        .querySelector('.ai-run-pane__body[data-run-id="run-c"]')
        ?.classList.contains('is-active'),
    ).toBe(true)
    expect(pane()?.classList.contains('is-hidden')).toBe(false)
  })

  test('closing an unselected stopped run leaves the current selection alone', () => {
    controller.mount(container)
    const runA = createRun({ id: 'run-a', taskPath: 'TASKS/a.md' })
    const runB = createRun({ id: 'run-b', taskPath: 'TASKS/b.md' })
    manager.emit(runA)
    manager.emit(runB)

    runB.status = 'stopped'
    manager.emit(runB)
    manager.emit(runB, 'persisted')

    expect(rows()).toHaveLength(1)
    expect(
      container
        .querySelector('.ai-run-pane__run[data-run-id="run-a"]')
        ?.classList.contains('is-active'),
    ).toBe(true)
  })

  test('active runs carry a stop-and-close ×; finished runs a plain close ×', () => {
    controller.mount(container)
    const run = createRun()
    manager.emit(run)

    const activeClose = container.querySelector<HTMLButtonElement>(
      '.ai-run-pane__tab-close',
    )
    expect(activeClose).not.toBeNull()
    expect(activeClose?.getAttribute('aria-label')).toBe('Stop and close run')
    expect(container.querySelector('.ai-run-pane__tab-stop')).toBeNull()

    run.status = 'succeeded'
    manager.emit(run)
    manager.emit(run, 'persisted')

    expect(rows()).toHaveLength(1)
    expect(adapters[0].disposed).toBe(false)
    expect(
      container
        .querySelector('.ai-run-pane__tab-close')
        ?.getAttribute('aria-label'),
    ).toBe('Close run tab')
  })

  test('failed runs keep their row with a close control too', () => {
    controller.mount(container)
    const run = createRun()
    manager.emit(run)

    run.status = 'failed'
    manager.emit(run)
    manager.emit(run, 'persisted')

    expect(rows()).toHaveLength(1)
    expect(container.querySelector('.ai-run-pane__tab-close')).not.toBeNull()
  })

  test('the close control disposes the adapter, removes the row, and hides the pane when last', () => {
    controller.mount(container)
    const run = createRun()
    manager.emit(run)
    run.status = 'succeeded'
    manager.emit(run)

    const closeButton = container.querySelector<HTMLButtonElement>(
      '.ai-run-pane__tab-close',
    )
    expect(closeButton).not.toBeNull()
    closeButton?.click()

    expect(rows()).toHaveLength(0)
    expect(bodies()).toHaveLength(0)
    expect(adapters[0].disposed).toBe(true)
    expect(pane()?.classList.contains('is-hidden')).toBe(true)
  })

  test('clicking a sidebar row close control does not bubble into row selection', () => {
    controller.mount(container)
    const runA = createRun({ id: 'run-a', taskPath: 'TASKS/a.md' })
    const runB = createRun({ id: 'run-b', taskPath: 'TASKS/b.md' })
    manager.emit(runA)
    manager.emit(runB)
    runB.status = 'succeeded'
    manager.emit(runB)

    container
      .querySelector<HTMLButtonElement>(
        '.ai-run-pane__run[data-run-id="run-b"] .ai-run-pane__run-close',
      )
      ?.click()

    expect(rows()).toHaveLength(1)
    expect(
      container
        .querySelector('.ai-run-pane__run[data-run-id="run-a"]')
        ?.classList.contains('is-active'),
    ).toBe(true)
  })

  test('headless stopped runs (no adapter) drop their row cleanly', () => {
    controller.mount(container)
    const run = createRun({
      mode: 'headless',
      cols: undefined,
      rows: undefined,
    })
    manager.emit(run)
    expect(adapters).toHaveLength(0)
    expect(rows()).toHaveLength(1)

    run.status = 'stopped'
    manager.emit(run)
    manager.emit(run, 'persisted')

    expect(rows()).toHaveLength(0)
    expect(bodies()).toHaveLength(0)
    expect(pane()?.classList.contains('is-hidden')).toBe(true)
  })

  test('a mount replay never resurrects rows for already-stopped runs', () => {
    manager.records.push(createRun({ id: 'old-stopped', status: 'stopped' }))
    manager.records.push(createRun({ id: 'kept-success', status: 'succeeded' }))

    controller.mount(container)

    expect(rows()).toHaveLength(1)
    expect(
      container.querySelector('.ai-run-pane__run[data-run-id="old-stopped"]'),
    ).toBeNull()
    expect(
      container.querySelector('.ai-run-pane__run[data-run-id="kept-success"]'),
    ).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Integration: real AiTaskManager + pane — snapshot before teardown
// ---------------------------------------------------------------------------

class IntegrationTerminalDispatcher implements AiTerminalDispatcher {
  callbacks: TerminalRunCallbacks | null = null

  start(_request: TerminalRunRequest, callbacks: TerminalRunCallbacks) {
    this.callbacks = callbacks
    return { pid: 4242, write: jest.fn(), stop: jest.fn(), forceKill: jest.fn() }
  }

  exit(outcome: AiRunExitOutcome): void {
    this.callbacks?.onExit(outcome)
  }
}

describe('AiRunPaneController + AiTaskManager stopped-run integration', () => {
  test('the log note gets the adapter snapshot BEFORE the tab (and adapter) is torn down', async () => {
    const terminalDispatcher = new IntegrationTerminalDispatcher()
    const writeTerminalRunLog = jest.fn<Promise<string>, [AiRunRecord, string]>(
      async () => 'terminal-log.md',
    )
    const headlessDispatcher: AiDispatcher = {
      start: () => {
        throw new Error('headless dispatch not expected')
      },
    }
    const deps: AiTaskManagerDeps = {
      app: {
        vault: {
          cachedRead: jest.fn(async () => '# Task\n\n## Prompt\n\nGo\n'),
          adapter: { getBasePath: () => '/vault/base' },
        },
        metadataCache: {
          getFileCache: jest.fn(() => ({ frontmatter: { ai_task: true } })),
        },
      },
      dispatchers: { claude: headlessDispatcher, codex: headlessDispatcher },
      binaryLocator: { resolve: jest.fn(async () => '/bin/claude') },
      logWriter: {
        writeRunLog: jest.fn(async () => 'log.md'),
        writeTerminalRunLog,
        pruneOldLogs: jest.fn(async () => undefined),
      },
      terminal: {
        dispatcher: terminalDispatcher,
        isSupported: () => true,
        makeTempFilePath: (prefix: string) => `/tmp/${prefix}.log`,
        readAndDeleteFile: jest.fn(async () => 'raw transcript'),
      },
      getRunMode: () => 'terminal',
    }
    const manager = new AiTaskManager(deps)

    document.body.replaceChildren()
    const container = document.body.createDiv({ cls: 'ai-pane-container' })
    const adapters: FakeTerminalAdapter[] = []
    const controller = new AiRunPaneController({
      tv: (_key, fallback) => fallback,
      manager,
      createTerminalAdapter: () => {
        const adapter = new FakeTerminalAdapter()
        adapter.snapshot = 'live screen at exit'
        adapters.push(adapter)
        return adapter
      },
      registerManagedDisposer: () => undefined,
    })
    controller.mount(container)

    const file = new TFile()
    file.path = 'TASKS/ai.md'
    file.basename = 'ai'
    file.extension = 'md'
    await manager.startRun(file)
    expect(adapters).toHaveLength(1)

    terminalDispatcher.exit({ status: 'stopped', exitCode: null })
    await flushPromises()

    // The persist consumed the LIVE adapter snapshot...
    expect(writeTerminalRunLog).toHaveBeenCalledTimes(1)
    expect(writeTerminalRunLog.mock.calls[0][1]).toBe('live screen at exit')
    // ...and only afterwards did the pane tear the view down.
    expect(adapters[0].disposed).toBe(true)
    expect(container.querySelectorAll('.ai-run-pane__run')).toHaveLength(0)
    expect(
      container.querySelector('.ai-run-pane')?.classList.contains('is-hidden'),
    ).toBe(true)

    controller.unmount()
  })
})
