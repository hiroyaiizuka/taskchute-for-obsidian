/**
 * AiRunPaneController split panels + plain shell terminals (U2):
 *   - a split (◫) button next to the expand toggle splits the RIGHT content
 *     area into side-by-side panels; the new panel IMMEDIATELY spawns and
 *     shows a NEW plain shell terminal session and takes the focus
 *   - each panel independently displays one run; sidebar clicks target the
 *     FOCUSED panel; the focused panel carries a subtle highlight
 *   - split is refused with a Notice when the pane is too narrow (mirrors
 *     the reference app's canSplitPanel)
 *   - a panel's tab × on a shell session stops it and unsplits the panel
 *     once the manager reports 'persisted'
 *   - a + button in each panel's tab strip opens a new shell session in that
 *     (focused) panel
 *   - stdin stays per-session across panels; adapters dispose per panel
 */
import { Notice } from 'obsidian'
import {
  AiRunPaneController,
  RUN_SIDEBAR_WIDTH_PX,
  SPLIT_MIN_PANEL_WIDTH_PX,
  TERMINAL_FALLBACK_COLS,
  TERMINAL_FALLBACK_ROWS,
} from '../../../src/features/ai-task/ui/AiRunPaneController'
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
  private readonly dataListeners = new Set<(data: string) => void>()

  open(container: HTMLElement, cols: number, rows: number): void {
    this.opened = { container, cols, rows }
  }

  write(data: string): void {
    this.written.push(data)
  }

  snapshotText(): string {
    return this.disposed ? '' : 'snapshot'
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback)
    return () => {
      this.dataListeners.delete(callback)
    }
  }

  /** Simulate the user typing into this terminal view */
  type(data: string): void {
    for (const listener of Array.from(this.dataListeners)) {
      listener(data)
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
  failNextShellStart: Error | null = null
  private shellSequence = 0

  readonly startShellSession = jest.fn(
    (options?: { cols?: number; rows?: number; name?: string }): AiRunRecord => {
      this.shellSequence += 1
      const record: AiRunRecord = {
        id: `shell-${this.shellSequence}`,
        taskPath: '',
        taskName: options?.name ?? 'Terminal',
        host: 'shell',
        mode: 'terminal',
        status: 'starting',
        cols: options?.cols ?? 80,
        rows: options?.rows ?? 24,
        startedAt: Date.now(),
        events: [],
      }
      // Mirror the real manager: the run is registered and 'starting' is
      // emitted BEFORE the dispatch, so a dispatch failure leaves an
      // already-announced run behind (status 'failed') and then throws.
      this.emit(record)
      if (this.failNextShellStart) {
        const error = this.failNextShellStart
        this.failNextShellStart = null
        record.status = 'failed'
        record.errorMessage = error.message
        record.endedAt = Date.now()
        this.emit(record)
        throw error
      }
      record.status = 'running'
      this.emit(record)
      return record
    },
  )

  getRuns(): AiRunRecord[] {
    return [...this.records]
  }

  getRun(runId: string): AiRunRecord | undefined {
    return this.records.find((record) => record.id === runId)
  }

  getActiveRunForTask(taskPath: string): AiRunRecord | undefined {
    return this.records.find(
      (record) =>
        record.host !== 'shell' &&
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

describe('AiRunPaneController split panels', () => {
  let container: HTMLElement
  let manager: FakeManager
  let adapters: FakeTerminalAdapter[]
  let host: AiRunPaneControllerHost
  let controller: AiRunPaneController

  const panels = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>('.ai-run-pane__panel'))
  const rows = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>('.ai-run-pane__run'))
  const splitButton = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>('.ai-run-pane__split')
  const noticeMock = (): jest.Mock => Notice as unknown as jest.Mock

  /** The tab element of one panel (each panel owns exactly one) */
  function panelTab(panel: HTMLElement): HTMLElement | null {
    return panel.querySelector<HTMLElement>('.ai-run-pane__tab')
  }

  function setContainerWidth(width: number): void {
    Object.defineProperty(container, 'clientWidth', {
      configurable: true,
      value: width,
    })
  }

  beforeEach(() => {
    document.body.replaceChildren()
    noticeMock().mockClear()
    container = document.body.createDiv({ cls: 'ai-pane-container' })
    manager = new FakeManager()
    adapters = []
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
    }
    controller = new AiRunPaneController(host)
  })

  describe('split button', () => {
    test('renders next to the expand button inside the corner actions', () => {
      controller.mount(container)
      manager.emit(createRun())

      const split = splitButton()
      const expand = container.querySelector('.ai-run-pane__expand')
      expect(split).not.toBeNull()
      expect(expand).not.toBeNull()
      expect(split?.getAttribute('aria-label')).toBeTruthy()
      expect(split?.parentElement).toBe(expand?.parentElement)
      expect(split?.parentElement?.classList.contains('ai-run-pane__actions')).toBe(
        true,
      )
    })

    test('splitting creates a second panel, spawns a shell session, and focuses it', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))
      expect(panels()).toHaveLength(1)
      expect(adapters).toHaveLength(1)

      splitButton()?.click()

      // The new panel exists and holds the focus highlight.
      const allPanels = panels()
      expect(allPanels).toHaveLength(2)
      expect(allPanels[1].classList.contains('is-focused')).toBe(true)
      expect(allPanels[0].classList.contains('is-focused')).toBe(false)

      // The shell session spawned immediately, sized for the split layout.
      expect(manager.startShellSession).toHaveBeenCalledTimes(1)
      expect(manager.startShellSession).toHaveBeenCalledWith({
        cols: TERMINAL_FALLBACK_COLS,
        rows: TERMINAL_FALLBACK_ROWS,
        name: 'Terminal',
      })

      // ...and is displayed in the new panel: tab + body + live adapter.
      const tab = panelTab(allPanels[1])
      expect(tab?.getAttribute('data-run-id')).toBe('shell-1')
      expect(tab?.querySelector('.ai-run-pane__tab-label')?.textContent).toBe(
        'Terminal',
      )
      const body = allPanels[1].querySelector<HTMLElement>(
        '.ai-run-pane__body[data-run-id="shell-1"]',
      )
      expect(body).not.toBeNull()
      expect(body?.classList.contains('is-active')).toBe(true)
      expect(adapters).toHaveLength(2)
      expect(adapters[1].opened).not.toBeNull()
      expect(allPanels[1].contains(adapters[1].opened?.container ?? null)).toBe(true)

      // The first panel keeps showing the original run.
      expect(panelTab(allPanels[0])?.getAttribute('data-run-id')).toBe('run-a')
    })

    test('shell sessions appear in the sidebar with a shell modifier', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))

      splitButton()?.click()

      const shellRow = container.querySelector<HTMLElement>(
        '.ai-run-pane__run[data-run-id="shell-1"]',
      )
      expect(shellRow).not.toBeNull()
      expect(shellRow?.classList.contains('ai-run-pane__run--shell')).toBe(true)
      expect(shellRow?.querySelector('.ai-run-pane__run-name')?.textContent).toBe(
        'Terminal',
      )
      // Task runs keep the plain row class.
      const taskRow = container.querySelector<HTMLElement>(
        '.ai-run-pane__run[data-run-id="run-a"]',
      )
      expect(taskRow?.classList.contains('ai-run-pane__run--shell')).toBe(false)
    })

    test('refuses the split with a Notice when the pane is too narrow', () => {
      controller.mount(container)
      manager.emit(createRun())
      // The 180px run sidebar is part of the measured container but not of
      // the panels area: with it excluded, two panels would each fall 0.5px
      // below the minimum width.
      setContainerWidth(RUN_SIDEBAR_WIDTH_PX + SPLIT_MIN_PANEL_WIDTH_PX * 2 - 1)

      splitButton()?.click()

      expect(noticeMock()).toHaveBeenCalledTimes(1)
      expect(manager.startShellSession).not.toHaveBeenCalled()
      expect(panels()).toHaveLength(1)
    })

    test('a content width wide enough for two panels allows the split', () => {
      controller.mount(container)
      manager.emit(createRun())
      setContainerWidth(RUN_SIDEBAR_WIDTH_PX + SPLIT_MIN_PANEL_WIDTH_PX * 2)

      splitButton()?.click()

      expect(noticeMock()).not.toHaveBeenCalled()
      expect(panels()).toHaveLength(2)
    })

    test('a shell start failure rolls the split back with a Notice and a clean sidebar', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))
      manager.failNextShellStart = new Error('no shell available')

      splitButton()?.click()

      expect(noticeMock()).toHaveBeenCalledTimes(1)
      expect(panels()).toHaveLength(1)
      expect(panels()[0].classList.contains('is-focused')).toBe(true)
      // The manager announced the run ('starting') before the dispatch
      // failed, so the pane briefly held a view for it — the rollback must
      // close it: no failed row lingers in the sidebar, no body remains,
      // and its adapter (if one was created) is disposed.
      expect(rows().map((row) => row.getAttribute('data-run-id'))).toEqual(['run-a'])
      expect(
        container.querySelector('.ai-run-pane__body[data-run-id="shell-1"]'),
      ).toBeNull()
      for (const adapter of adapters.slice(1)) {
        expect(adapter.disposed).toBe(true)
      }
      expect(panelTab(panels()[0])?.getAttribute('data-run-id')).toBe('run-a')
    })
  })

  describe('carried fixes: PTY sizing excludes the run sidebar', () => {
    function setParentHeight(height: number): void {
      Object.defineProperty(document.body, 'clientHeight', {
        configurable: true,
        value: height,
      })
    }

    test('computeTerminalSize subtracts the sidebar width and the pane chrome', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))
      setContainerWidth(1000)
      setParentHeight(500)

      // cols: (1000 total - 180 sidebar - 16 horizontal inset) / 8 px cells
      // rows: (500 * 0.4 pane share - 64 vertical chrome) / 17 px cells —
      // the vertical inset must cover the pane header (~26px), the panel
      // tab strip (27px incl. border), and the pane borders.
      expect(controller.computeTerminalSize()).toEqual({ cols: 100, rows: 8 })
    })

    test('a split spawns the shell with the sidebar-excluded per-panel size', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))
      // Content width of exactly two minimum panels: the split is allowed
      // and each panel measures 320px.
      setContainerWidth(RUN_SIDEBAR_WIDTH_PX + SPLIT_MIN_PANEL_WIDTH_PX * 2)
      setParentHeight(500)

      splitButton()?.click()

      expect(panels()).toHaveLength(2)
      expect(manager.startShellSession).toHaveBeenCalledWith({
        cols: 38, // (320 panel - 16 horizontal inset) / 8 px cells
        rows: 8,
        name: 'Terminal',
      })
    })
  })

  describe('carried fixes: panel focus and empty-primary repair', () => {
    test('clicking a panel moves the keyboard focus to its terminal adapter', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))
      splitButton()?.click()
      const allPanels = panels()
      expect(allPanels[1].classList.contains('is-focused')).toBe(true)
      const focusCallsBefore = adapters[0].focus.mock.calls.length

      allPanels[0].click()

      // The focus ring and the keyboard focus must not diverge: keystrokes
      // now belong to panel 1's terminal, not the previously focused one.
      expect(allPanels[0].classList.contains('is-focused')).toBe(true)
      expect(adapters[0].focus.mock.calls.length).toBe(focusCallsBefore + 1)
    })

    test('closing the primary panel last run while split merges the next panel in', () => {
      controller.mount(container)
      const run = createRun({ id: 'run-a' })
      manager.emit(run)
      splitButton()?.click()
      run.status = 'succeeded'
      manager.emit(run)

      container
        .querySelector<HTMLButtonElement>(
          '.ai-run-pane__run[data-run-id="run-a"] .ai-run-pane__run-close',
        )
        ?.click()

      // The reference reducer removes any panel whose last tab closes: the
      // emptied primary adopts the next panel's shell instead of staying on
      // screen as a dead panel.
      expect(panels()).toHaveLength(1)
      expect(panelTab(panels()[0])?.getAttribute('data-run-id')).toBe('shell-1')
      expect(rows().map((row) => row.getAttribute('data-run-id'))).toEqual(['shell-1'])
      expect(adapters[1].disposed).toBe(false)
      expect(
        container.querySelector('.ai-run-pane')?.classList.contains('is-hidden'),
      ).toBe(false)
    })
  })

  describe('focus semantics', () => {
    test('clicking a panel moves the focus highlight', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))
      splitButton()?.click()
      const allPanels = panels()
      expect(allPanels[1].classList.contains('is-focused')).toBe(true)

      allPanels[0].click()

      expect(allPanels[0].classList.contains('is-focused')).toBe(true)
      expect(allPanels[1].classList.contains('is-focused')).toBe(false)
    })

    test('sidebar clicks show the run in the FOCUSED panel', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a', taskName: 'Task A' }))
      manager.emit(createRun({ id: 'run-b', taskName: 'Task B', taskPath: 'TASKS/b.md' }))
      splitButton()?.click()
      const allPanels = panels()

      // Panel 2 (focused) takes run-b when its sidebar row is clicked.
      container
        .querySelector<HTMLElement>('.ai-run-pane__run[data-run-id="run-b"]')
        ?.click()
      expect(panelTab(allPanels[1])?.getAttribute('data-run-id')).toBe('run-b')
      expect(
        allPanels[1].querySelector('.ai-run-pane__body[data-run-id="run-b"]'),
      ).not.toBeNull()
      // Panel 1 still shows run-a.
      expect(panelTab(allPanels[0])?.getAttribute('data-run-id')).toBe('run-a')

      // Clicking a run already displayed in another panel focuses that panel
      // instead of duplicating the view.
      container
        .querySelector<HTMLElement>('.ai-run-pane__run[data-run-id="run-a"]')
        ?.click()
      expect(allPanels[0].classList.contains('is-focused')).toBe(true)
      expect(panelTab(allPanels[0])?.getAttribute('data-run-id')).toBe('run-a')
      expect(panelTab(allPanels[1])?.getAttribute('data-run-id')).toBe('run-b')
    })
  })

  describe('unsplit via the panel tab ×', () => {
    test('the × on an active shell stops it and unsplits once persisted', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))
      splitButton()?.click()
      const shellRecord = manager.getRun('shell-1')
      expect(shellRecord).toBeDefined()
      if (!shellRecord) return

      const secondPanel = panels()[1]
      secondPanel
        .querySelector<HTMLButtonElement>('.ai-run-pane__tab-close')
        ?.click()

      expect(manager.stopRun).toHaveBeenCalledWith('shell-1')
      // Nothing closes before the persist chain completes.
      expect(panels()).toHaveLength(2)
      expect(adapters[1].disposed).toBe(false)

      shellRecord.status = 'stopped'
      manager.emit(shellRecord)
      expect(panels()).toHaveLength(2)

      manager.emit(shellRecord, 'persisted')
      expect(panels()).toHaveLength(1)
      expect(panels()[0].classList.contains('is-focused')).toBe(true)
      expect(adapters[1].disposed).toBe(true)
      expect(rows().map((row) => row.getAttribute('data-run-id'))).toEqual(['run-a'])
      // The primary panel still shows its run; the pane stays visible.
      expect(panelTab(panels()[0])?.getAttribute('data-run-id')).toBe('run-a')
      expect(
        container.querySelector('.ai-run-pane')?.classList.contains('is-hidden'),
      ).toBe(false)
    })

    test('the × on a finished shell unsplits immediately', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))
      splitButton()?.click()
      const shellRecord = manager.getRun('shell-1')
      if (!shellRecord) throw new Error('shell record missing')
      shellRecord.status = 'succeeded'
      manager.emit(shellRecord)

      panels()[1]
        .querySelector<HTMLButtonElement>('.ai-run-pane__tab-close')
        ?.click()

      expect(manager.stopRun).not.toHaveBeenCalled()
      expect(panels()).toHaveLength(1)
      expect(adapters[1].disposed).toBe(true)
    })
  })

  describe('+ button (new shell in the focused panel)', () => {
    test('spawns a shell session and selects it in the single panel', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))
      expect(adapters).toHaveLength(1)

      container
        .querySelector<HTMLButtonElement>('.ai-run-pane__add')
        ?.click()

      expect(manager.startShellSession).toHaveBeenCalledTimes(1)
      expect(panels()).toHaveLength(1)
      expect(panelTab(panels()[0])?.getAttribute('data-run-id')).toBe('shell-1')
      // The previous run keeps its body (hidden), the shell body is active.
      const panel = panels()[0]
      expect(
        panel
          .querySelector('.ai-run-pane__body[data-run-id="run-a"]')
          ?.classList.contains('is-active'),
      ).toBe(false)
      expect(
        panel
          .querySelector('.ai-run-pane__body[data-run-id="shell-1"]')
          ?.classList.contains('is-active'),
      ).toBe(true)
      expect(adapters).toHaveLength(2)
    })

    test('a + shell start failure leaves no lingering run row', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))
      manager.failNextShellStart = new Error('spawn failed')

      container.querySelector<HTMLButtonElement>('.ai-run-pane__add')?.click()

      expect(noticeMock()).toHaveBeenCalledTimes(1)
      expect(rows().map((row) => row.getAttribute('data-run-id'))).toEqual(['run-a'])
      expect(
        container.querySelector('.ai-run-pane__body[data-run-id="shell-1"]'),
      ).toBeNull()
      expect(panelTab(panels()[0])?.getAttribute('data-run-id')).toBe('run-a')
    })

    test('after a split, each panel has its own + and it targets that panel', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))
      splitButton()?.click()
      const allPanels = panels()

      allPanels[1]
        .querySelector<HTMLButtonElement>('.ai-run-pane__add')
        ?.click()

      expect(manager.startShellSession).toHaveBeenCalledTimes(2)
      expect(panelTab(allPanels[1])?.getAttribute('data-run-id')).toBe('shell-2')
      expect(panelTab(allPanels[0])?.getAttribute('data-run-id')).toBe('run-a')
      expect(allPanels[1].classList.contains('is-focused')).toBe(true)
    })
  })

  describe('per-session wiring across panels', () => {
    test('keystrokes stay routed to their own session (stdin isolation)', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))
      splitButton()?.click()

      const adapterA = adapters[0]
      const adapterB = adapters[1]
      adapterA.type('aaa')
      adapterB.type('bbb')

      expect(manager.sendTerminalInput).toHaveBeenCalledTimes(2)
      expect(manager.sendTerminalInput).toHaveBeenNthCalledWith(1, 'run-a', 'aaa')
      expect(manager.sendTerminalInput).toHaveBeenNthCalledWith(2, 'shell-1', 'bbb')
    })

    test('terminal output reaches only the subscribed panel adapter', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))
      splitButton()?.click()

      for (const listener of manager.terminalListeners.get('run-a') ?? []) {
        listener('for-a')
      }
      for (const listener of manager.terminalListeners.get('shell-1') ?? []) {
        listener('for-shell')
      }

      expect(adapters[0].written).toEqual(['for-a'])
      expect(adapters[1].written).toEqual(['for-shell'])
    })

    test('unmount disposes the adapters of every panel', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))
      splitButton()?.click()
      expect(adapters).toHaveLength(2)

      controller.unmount()

      expect(adapters[0].disposed).toBe(true)
      expect(adapters[1].disposed).toBe(true)
      expect(container.querySelector('.ai-run-pane')).toBeNull()
    })
  })
})
