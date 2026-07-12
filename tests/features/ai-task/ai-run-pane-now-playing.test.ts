/**
 * AiRunPaneController NOW PLAYING layout (U1):
 *   - LEFT vertical sidebar with one row per run (status dot + truncated
 *     task name + small × control); clicking a row selects the run
 *   - RIGHT content area with a slim tab strip showing ONE tab for the
 *     selected run (status dot + content label + × control) and top-right
 *     corner actions (expand toggle; extension point for the U2 split)
 *   - × semantics: on an ACTIVE run it requests stop AND closes the view,
 *     but only after the manager's 'persisted' notification (the exit-time
 *     terminal snapshot must be consumed from a live adapter first); on an
 *     already-finished run it closes immediately
 *   - ⤢ expand toggle: near-full-height pane via .is-expanded (and the
 *     container chrome class), persisted per device through the host's
 *     App#saveLocalStorage bridge and restored on mount
 */
import { TFile } from 'obsidian'
import {
  AiRunPaneController,
  AI_PANE_EXPANDED_STORAGE_KEY,
} from '../../../src/features/ai-task/ui/AiRunPaneController'
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

describe('AiRunPaneController NOW PLAYING layout', () => {
  let container: HTMLElement
  let manager: FakeManager
  let adapters: FakeTerminalAdapter[]
  let saveLocalStorage: jest.Mock
  let loadLocalStorage: jest.Mock
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
    saveLocalStorage = jest.fn()
    loadLocalStorage = jest.fn(() => null)
    host = {
      tv: (_key, fallback, vars) => {
        if (!vars) return fallback
        return Object.entries(vars).reduce(
          (acc, [name, value]) => acc.replace(`{${name}}`, String(value)),
          fallback,
        )
      },
      manager,
      createTerminalAdapter: () => {
        const adapter = new FakeTerminalAdapter()
        adapters.push(adapter)
        return adapter
      },
      registerManagedDisposer: () => undefined,
      saveLocalStorage,
      loadLocalStorage,
    }
    controller = new AiRunPaneController(host)
  })

  describe('vertical sidebar + content area', () => {
    test('renders one sidebar row per run with the status dot and truncated name', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a', taskName: 'Task A' }))
      manager.emit(
        createRun({ id: 'run-b', taskName: 'Task B', status: 'succeeded' }),
      )

      const sidebar = container.querySelector('.ai-run-pane__sidebar')
      expect(sidebar).not.toBeNull()
      expect(rows()).toHaveLength(2)

      const rowA = container.querySelector(
        '.ai-run-pane__run[data-run-id="run-a"]',
      )
      expect(rowA?.querySelector('.ai-run-pane__run-dot--running')).not.toBeNull()
      expect(
        rowA?.querySelector('.ai-run-pane__run-name')?.textContent,
      ).toBe('Task A')

      const rowB = container.querySelector(
        '.ai-run-pane__run[data-run-id="run-b"]',
      )
      expect(rowB?.querySelector('.ai-run-pane__run-dot--succeeded')).not.toBeNull()
    })

    test('clicking a sidebar row selects the run and switches the visible body', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a', taskName: 'Task A' }))
      manager.emit(createRun({ id: 'run-b', taskName: 'Task B' }))

      // run-a was auto-selected as the first run.
      expect(
        container
          .querySelector('.ai-run-pane__run[data-run-id="run-a"]')
          ?.classList.contains('is-active'),
      ).toBe(true)

      container
        .querySelector<HTMLElement>('.ai-run-pane__run[data-run-id="run-b"]')
        ?.click()

      expect(
        container
          .querySelector('.ai-run-pane__run[data-run-id="run-b"]')
          ?.classList.contains('is-active'),
      ).toBe(true)
      expect(
        container
          .querySelector('.ai-run-pane__body[data-run-id="run-b"]')
          ?.classList.contains('is-active'),
      ).toBe(true)
      expect(
        container
          .querySelector('.ai-run-pane__body[data-run-id="run-a"]')
          ?.classList.contains('is-active'),
      ).toBe(false)
    })

    test('the content area shows exactly one slim tab for the selected run', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))
      manager.emit(createRun({ id: 'run-b', mode: 'headless' }))

      const strip = container.querySelector('.ai-run-pane__tabstrip')
      expect(strip).not.toBeNull()
      let tabs = container.querySelectorAll('.ai-run-pane__tab')
      expect(tabs).toHaveLength(1)
      expect(tabs[0].getAttribute('data-run-id')).toBe('run-a')
      expect(tabs[0].querySelector('.ai-run-pane__tab-dot--running')).not.toBeNull()
      // Terminal runs read "Terminal"; the label is the content type, not
      // the task name (that lives in the sidebar).
      expect(
        tabs[0].querySelector('.ai-run-pane__tab-label')?.textContent,
      ).toBe('Terminal')

      controller.openRun('run-b')
      tabs = container.querySelectorAll('.ai-run-pane__tab')
      expect(tabs).toHaveLength(1)
      expect(tabs[0].getAttribute('data-run-id')).toBe('run-b')
      expect(
        tabs[0].querySelector('.ai-run-pane__tab-label')?.textContent,
      ).toBe('Events')
    })

    test('sidebar and content live inside a layout row that collapse hides', () => {
      controller.mount(container)
      manager.emit(createRun())

      const layout = container.querySelector('.ai-run-pane__layout')
      expect(layout).not.toBeNull()
      expect(layout?.querySelector('.ai-run-pane__sidebar')).not.toBeNull()
      expect(layout?.querySelector('.ai-run-pane__content')).not.toBeNull()

      const toggle = container.querySelector<HTMLButtonElement>(
        '.ai-run-pane__collapse',
      )
      toggle?.click()
      expect(pane()?.classList.contains('is-collapsed')).toBe(true)
      toggle?.click()
      expect(pane()?.classList.contains('is-collapsed')).toBe(false)
    })

    test('the composer renders under the content area', () => {
      controller.mount(container)
      manager.emit(createRun({ mode: 'headless', cols: undefined, rows: undefined }))

      const content = container.querySelector('.ai-run-pane__content')
      const composer = container.querySelector('.ai-run-pane__composer')
      expect(composer).not.toBeNull()
      expect(content?.contains(composer)).toBe(true)
    })
  })

  describe('× stop-and-close semantics', () => {
    test('× on an active run requests stop and keeps the view until persisted', () => {
      controller.mount(container)
      const run = createRun({ id: 'run-active' })
      manager.emit(run)

      const close = container.querySelector<HTMLButtonElement>(
        '.ai-run-pane__tab-close',
      )
      expect(close).not.toBeNull()
      expect(close?.getAttribute('aria-label')).toBe('Stop and close run')
      close?.click()

      expect(manager.stopRun).toHaveBeenCalledWith('run-active')
      // Nothing closes on the click itself...
      expect(rows()).toHaveLength(1)
      expect(adapters[0].disposed).toBe(false)

      // ...nor on the final status update (snapshot not yet consumed)...
      run.status = 'stopped'
      manager.emit(run)
      expect(rows()).toHaveLength(1)
      expect(adapters[0].disposed).toBe(false)
      expect(manager.snapshotProvider?.(run.id)).toBe('fake terminal snapshot')

      // ...only the end of the persist chain tears the view down.
      manager.emit(run, 'persisted')
      expect(rows()).toHaveLength(0)
      expect(bodies()).toHaveLength(0)
      expect(adapters[0].disposed).toBe(true)
      expect(pane()?.classList.contains('is-hidden')).toBe(true)
    })

    test('× requested on an active run closes on persisted even when it finishes as succeeded', () => {
      controller.mount(container)
      const run = createRun({ id: 'run-race' })
      manager.emit(run)

      container
        .querySelector<HTMLButtonElement>('.ai-run-pane__tab-close')
        ?.click()

      // The run finished on its own before the stop landed.
      run.status = 'succeeded'
      manager.emit(run)
      expect(rows()).toHaveLength(1)

      manager.emit(run, 'persisted')
      // Without the pending close a succeeded run would keep its row.
      expect(rows()).toHaveLength(0)
      expect(pane()?.classList.contains('is-hidden')).toBe(true)
    })

    test('× on a finished run closes immediately', () => {
      controller.mount(container)
      const run = createRun({ id: 'run-done' })
      manager.emit(run)
      run.status = 'succeeded'
      manager.emit(run)

      const close = container.querySelector<HTMLButtonElement>(
        '.ai-run-pane__tab-close',
      )
      expect(close?.getAttribute('aria-label')).toBe('Close run tab')
      close?.click()

      expect(manager.stopRun).not.toHaveBeenCalled()
      expect(rows()).toHaveLength(0)
      expect(adapters[0].disposed).toBe(true)
      expect(pane()?.classList.contains('is-hidden')).toBe(true)
    })

    test('the sidebar row × mirrors the tab × for active runs', () => {
      controller.mount(container)
      const runA = createRun({ id: 'run-a', taskPath: 'TASKS/a.md' })
      const runB = createRun({ id: 'run-b', taskPath: 'TASKS/b.md' })
      manager.emit(runA)
      manager.emit(runB)

      const rowClose = container.querySelector<HTMLButtonElement>(
        '.ai-run-pane__run[data-run-id="run-b"] .ai-run-pane__run-close',
      )
      expect(rowClose).not.toBeNull()
      expect(rowClose?.getAttribute('aria-label')).toBe('Stop and close run')
      rowClose?.click()

      expect(manager.stopRun).toHaveBeenCalledWith('run-b')
      // Clicking the × must not bubble into row selection.
      expect(
        container
          .querySelector('.ai-run-pane__run[data-run-id="run-a"]')
          ?.classList.contains('is-active'),
      ).toBe(true)

      runB.status = 'stopped'
      manager.emit(runB)
      manager.emit(runB, 'persisted')
      expect(rows()).toHaveLength(1)
    })

    test('the sidebar row × closes a finished run immediately', () => {
      controller.mount(container)
      const run = createRun({ id: 'run-done' })
      manager.emit(run)
      run.status = 'failed'
      manager.emit(run)

      container
        .querySelector<HTMLButtonElement>('.ai-run-pane__run-close')
        ?.click()

      expect(manager.stopRun).not.toHaveBeenCalled()
      expect(rows()).toHaveLength(0)
      expect(pane()?.classList.contains('is-hidden')).toBe(true)
    })
  })

  describe('expand toggle', () => {
    test('toggles the expanded classes and persists the state per device', () => {
      controller.mount(container)
      manager.emit(createRun())

      const expand = container.querySelector<HTMLButtonElement>(
        '.ai-run-pane__expand',
      )
      expect(expand).not.toBeNull()
      expect(expand?.getAttribute('aria-label')).toBeTruthy()

      expand?.click()
      expect(pane()?.classList.contains('is-expanded')).toBe(true)
      expect(container.classList.contains('ai-pane-container--expanded')).toBe(true)
      expect(saveLocalStorage).toHaveBeenCalledWith(
        AI_PANE_EXPANDED_STORAGE_KEY,
        true,
      )

      expand?.click()
      expect(pane()?.classList.contains('is-expanded')).toBe(false)
      expect(container.classList.contains('ai-pane-container--expanded')).toBe(false)
      expect(saveLocalStorage).toHaveBeenLastCalledWith(
        AI_PANE_EXPANDED_STORAGE_KEY,
        false,
      )
    })

    test('mount restores the persisted expanded state', () => {
      loadLocalStorage.mockReturnValue(true)
      controller.mount(container)
      manager.emit(createRun())

      expect(loadLocalStorage).toHaveBeenCalledWith(AI_PANE_EXPANDED_STORAGE_KEY)
      expect(pane()?.classList.contains('is-expanded')).toBe(true)
      expect(container.classList.contains('ai-pane-container--expanded')).toBe(true)
      // Restoring is not a user toggle; nothing is re-persisted.
      expect(saveLocalStorage).not.toHaveBeenCalled()
    })

    test('collapsing drops the expanded container chrome and re-expanding restores it', () => {
      controller.mount(container)
      manager.emit(createRun())
      container
        .querySelector<HTMLButtonElement>('.ai-run-pane__expand')
        ?.click()
      expect(container.classList.contains('ai-pane-container--expanded')).toBe(true)

      controller.setCollapsed(true)
      expect(container.classList.contains('ai-pane-container--expanded')).toBe(false)
      // The pane itself remembers the expanded preference.
      expect(pane()?.classList.contains('is-expanded')).toBe(true)

      controller.setCollapsed(false)
      expect(container.classList.contains('ai-pane-container--expanded')).toBe(true)
    })

    test('closing the last run removes the expanded container chrome with the pane', () => {
      controller.mount(container)
      const run = createRun()
      manager.emit(run)
      container
        .querySelector<HTMLButtonElement>('.ai-run-pane__expand')
        ?.click()

      run.status = 'succeeded'
      manager.emit(run)
      container
        .querySelector<HTMLButtonElement>('.ai-run-pane__tab-close')
        ?.click()

      expect(pane()?.classList.contains('is-hidden')).toBe(true)
      expect(container.classList.contains('ai-pane-container--expanded')).toBe(false)
    })

    test('computeTerminalSize uses the taller share while expanded', () => {
      controller.mount(container)
      Object.defineProperty(container, 'clientWidth', {
        configurable: true,
        value: 816,
      })
      Object.defineProperty(document.body, 'clientHeight', {
        configurable: true,
        value: 1000,
      })
      manager.emit(createRun())

      const normal = controller.computeTerminalSize()
      container
        .querySelector<HTMLButtonElement>('.ai-run-pane__expand')
        ?.click()
      const expanded = controller.computeTerminalSize()

      expect(expanded.rows).toBeGreaterThan(normal.rows)
      expect(expanded.cols).toBe(normal.cols)
    })
  })
})

// ---------------------------------------------------------------------------
// Integration: real AiTaskManager — × ordering around the persist chain
// ---------------------------------------------------------------------------

class IntegrationTerminalDispatcher implements AiTerminalDispatcher {
  callbacks: TerminalRunCallbacks | null = null
  readonly stop = jest.fn()

  start(_request: TerminalRunRequest, callbacks: TerminalRunCallbacks) {
    this.callbacks = callbacks
    return { pid: 4242, write: jest.fn(), stop: this.stop, forceKill: jest.fn() }
  }

  exit(outcome: AiRunExitOutcome): void {
    this.callbacks?.onExit(outcome)
  }
}

describe('AiRunPaneController × + AiTaskManager persist ordering', () => {
  test('the × close never disposes the adapter before the snapshot provider was consumed', async () => {
    const terminalDispatcher = new IntegrationTerminalDispatcher()
    let adapterDisposedAtPersist: boolean | null = null
    const adapters: FakeTerminalAdapter[] = []
    const writeTerminalRunLog = jest.fn<Promise<string>, [AiRunRecord, string]>(
      async () => {
        adapterDisposedAtPersist = adapters[0]?.disposed ?? null
        return 'terminal-log.md'
      },
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

    // × on the running tab: requests the stop through the real manager...
    container
      .querySelector<HTMLButtonElement>('.ai-run-pane__tab-close')
      ?.click()
    expect(terminalDispatcher.stop).toHaveBeenCalledTimes(1)
    expect(adapters[0].disposed).toBe(false)

    // ...the child exits, the persist chain consumes the LIVE snapshot...
    terminalDispatcher.exit({ status: 'stopped', exitCode: null })
    await flushPromises()

    expect(writeTerminalRunLog).toHaveBeenCalledTimes(1)
    expect(writeTerminalRunLog.mock.calls[0][1]).toBe('live screen at exit')
    expect(adapterDisposedAtPersist).toBe(false)
    // ...and only afterwards is the view torn down.
    expect(adapters[0].disposed).toBe(true)
    expect(container.querySelectorAll('.ai-run-pane__run')).toHaveLength(0)
    expect(
      container.querySelector('.ai-run-pane')?.classList.contains('is-hidden'),
    ).toBe(true)

    controller.unmount()
  })
})
