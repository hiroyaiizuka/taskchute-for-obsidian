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
  fit = jest.fn()
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
  /** Mirrors the real manager: drops a finished run's record for good */
  readonly releaseRun = jest.fn((runId: string): void => {
    const index = this.records.findIndex((record) => record.id === runId)
    if (index >= 0) {
      this.records.splice(index, 1)
    }
  })
  failNextShellStart: Error | null = null
  private shellSequence = 0
  private readonly exitPersistedRunIds = new Set<string>()

  readonly startShellSession = jest.fn(
    (options?: {
      cols?: number
      rows?: number
      name?: string
      cwd?: string
      parentRunId?: string
    }): AiRunRecord => {
      this.shellSequence += 1
      const record: AiRunRecord = {
        id: `shell-${this.shellSequence}`,
        taskPath: '',
        taskName: options?.name ?? 'Terminal',
        cwd: options?.cwd,
        parentRunId: options?.parentRunId,
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

  isRunExitPersisted(runId: string): boolean {
    return this.exitPersistedRunIds.has(runId)
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
    if (changeType === 'persisted') {
      this.exitPersistedRunIds.add(record.id)
    } else if (
      record.status === 'starting' ||
      record.status === 'running' ||
      record.status === 'stopping'
    ) {
      this.exitPersistedRunIds.delete(record.id)
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
  const visiblePanels = (): HTMLElement[] =>
    panels().filter((panel) => !panel.hidden)
  const rows = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>('.ai-run-pane__run'))
  const splitButton = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>('.ai-run-pane__split')
  const noticeMock = (): jest.Mock => Notice as unknown as jest.Mock

  /** The selected internal tab of one panel */
  function panelTab(panel: HTMLElement): HTMLElement | null {
    return panel.querySelector<HTMLElement>('.ai-run-pane__tab.is-active')
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
    test('keeps split local to the panel and expand global in the AI Runs header', () => {
      controller.mount(container)
      manager.emit(createRun())

      const split = splitButton()
      const expand = container.querySelector('.ai-run-pane__expand')
      expect(split).not.toBeNull()
      expect(expand).not.toBeNull()
      expect(split?.getAttribute('aria-label')).toBeTruthy()
      expect(split?.parentElement?.classList.contains('ai-run-pane__actions')).toBe(
        true,
      )
      expect(expand?.parentElement?.classList.contains('ai-run-pane__header-actions')).toBe(
        true,
      )
      expect(expand?.closest('.ai-run-pane__tabstrip')).toBeNull()
      expect(container.querySelectorAll('.ai-run-pane__expand')).toHaveLength(1)
    })

    test('splitting creates a second panel, spawns a shell session, and focuses it', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a', cwd: '/workspace/project' }))
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
        cwd: '/workspace/project',
        parentRunId: 'run-a',
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

    test('split shell stays in the panel tabs and does not add a vertical tab', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))

      splitButton()?.click()

      const shellRow = container.querySelector<HTMLElement>(
        '.ai-run-pane__run[data-run-id="shell-1"]',
      )
      expect(shellRow).toBeNull()
      expect(rows().map((row) => row.getAttribute('data-run-id'))).toEqual([
        'run-a',
      ])
      expect(
        panels()[1].querySelector(
          '.ai-run-pane__tab[data-run-id="shell-1"]',
        ),
      ).not.toBeNull()
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
        parentRunId: 'run-a',
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
      manager.emit(run, 'persisted')

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
      expect(rows()).toHaveLength(0)
      expect(adapters[1].disposed).toBe(false)
      expect(
        container.querySelector('.ai-run-pane')?.classList.contains('is-hidden'),
      ).toBe(false)
    })
  })

  describe('carried fixes: unsplit keyboard focus + run release', () => {
    test('closing a secondary panel selected run returns the keyboard focus to the primary terminal', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))
      splitButton()?.click()
      const shellRecord = manager.getRun('shell-1')
      if (!shellRecord) throw new Error('shell record missing')
      shellRecord.status = 'succeeded'
      manager.emit(shellRecord)
      manager.emit(shellRecord, 'persisted')
      const focusCallsBefore = adapters[0].focus.mock.calls.length

      panels()[1]
        .querySelector<HTMLButtonElement>('.ai-run-pane__tab-close')
        ?.click()

      // The unsplit moved the focus ring back to the primary panel; the
      // keyboard focus must follow it, or keystrokes go nowhere until a
      // click (same contract as clicking a panel).
      expect(panels()).toHaveLength(1)
      expect(panels()[0].classList.contains('is-focused')).toBe(true)
      expect(adapters[0].focus.mock.calls.length).toBe(focusCallsBefore + 1)
    })

    test('the × on a finished run releases its record from the manager', () => {
      controller.mount(container)
      const run = createRun({ id: 'run-a' })
      manager.emit(run)
      run.status = 'succeeded'
      manager.emit(run)
      manager.emit(run, 'persisted')

      container
        .querySelector<HTMLButtonElement>(
          '.ai-run-pane__run[data-run-id="run-a"] .ai-run-pane__run-close',
        )
        ?.click()

      expect(manager.releaseRun).toHaveBeenCalledWith('run-a')
      // A remount must not resurrect the x-closed run.
      controller.unmount()
      controller.mount(container)
      expect(rows()).toHaveLength(0)
    })

    test('a stopped run auto-closing on persisted releases its record', () => {
      controller.mount(container)
      const run = createRun({ id: 'run-a' })
      manager.emit(run)

      run.status = 'stopped'
      manager.emit(run)
      expect(manager.releaseRun).not.toHaveBeenCalled()
      manager.emit(run, 'persisted')

      expect(manager.releaseRun).toHaveBeenCalledWith('run-a')
    })

    test('a rolled-back shell spawn releases the failed record (no remount ghost)', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))
      manager.failNextShellStart = new Error('spawn failed')

      splitButton()?.click()

      expect(manager.releaseRun).toHaveBeenCalledWith('shell-1')
      controller.unmount()
      controller.mount(container)
      expect(rows().map((row) => row.getAttribute('data-run-id'))).toEqual(['run-a'])
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

    test('sidebar clicks swap the complete task workspace through the primary panel', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a', taskName: 'Task A' }))
      manager.emit(createRun({ id: 'run-b', taskName: 'Task B', taskPath: 'TASKS/b.md' }))
      splitButton()?.click()
      const allPanels = panels()

      // A Vertical Tab never grafts task B into task A's focused split.
      // It swaps to B's own one-panel workspace through the shared primary.
      container
        .querySelector<HTMLElement>('.ai-run-pane__run[data-run-id="run-b"]')
        ?.click()
      expect(panelTab(allPanels[0])?.getAttribute('data-run-id')).toBe('run-b')
      expect(
        allPanels[0].querySelector('.ai-run-pane__body[data-run-id="run-b"]'),
      ).not.toBeNull()
      expect(allPanels[1].hidden).toBe(true)

      // Returning to A restores A's secondary split and main task.
      container
        .querySelector<HTMLElement>('.ai-run-pane__run[data-run-id="run-a"]')
        ?.click()
      expect(allPanels[0].classList.contains('is-focused')).toBe(false)
      expect(allPanels[1].classList.contains('is-focused')).toBe(true)
      expect(panelTab(allPanels[0])?.getAttribute('data-run-id')).toBe('run-a')
      expect(allPanels[1].hidden).toBe(false)
      expect(panelTab(allPanels[1])?.getAttribute('data-run-id')).toBe('shell-1')
    })

    test('vertical task rail keeps one roving tab across split panels', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a', taskName: 'Task A' }))
      manager.emit(
        createRun({
          id: 'run-b',
          taskName: 'Task B',
          taskPath: 'TASKS/b.md',
        }),
      )
      splitButton()?.click()

      container
        .querySelector<HTMLElement>('.ai-run-pane__run[data-run-id="run-b"]')
        ?.click()

      const selectedRows = (): HTMLElement[] =>
        Array.from(
          container.querySelectorAll<HTMLElement>(
            '.ai-run-pane__sidebar-runs [role="tab"][aria-selected="true"]',
          ),
        )
      const rovingRows = (): HTMLElement[] =>
        Array.from(
          container.querySelectorAll<HTMLElement>(
            '.ai-run-pane__sidebar-runs [role="tab"][tabindex="0"]',
          ),
        )

      expect(selectedRows()).toHaveLength(1)
      expect(rovingRows()).toHaveLength(1)
      expect(selectedRows()[0]?.getAttribute('data-run-id')).toBe('run-b')

      container
        .querySelector<HTMLElement>('.ai-run-pane__run[data-run-id="run-a"]')
        ?.click()
      expect(selectedRows()).toHaveLength(1)
      expect(rovingRows()).toHaveLength(1)
      expect(selectedRows()[0]?.getAttribute('data-run-id')).toBe('run-a')
    })

    test('shell-selected panel retains one task row as the roving target', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a', taskName: 'Task A' }))

      container.querySelector<HTMLButtonElement>('.ai-run-pane__add')?.click()

      const selectedRows = container.querySelectorAll(
        '.ai-run-pane__sidebar-runs [role="tab"][aria-selected="true"]',
      )
      const rovingRows = container.querySelectorAll(
        '.ai-run-pane__sidebar-runs [role="tab"][tabindex="0"]',
      )
      expect(selectedRows).toHaveLength(1)
      expect(rovingRows).toHaveLength(1)
      expect(selectedRows[0]?.getAttribute('data-run-id')).toBe('run-a')
    })
  })

  describe('unsplit via the panel tab ×', () => {
    test('closing one of multiple internal tabs keeps the split and selects its sibling', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))
      splitButton()?.click()
      const secondPanel = panels()[1]
      secondPanel.querySelector<HTMLButtonElement>('.ai-run-pane__add')?.click()
      const newest = manager.getRun('shell-2')
      if (!newest) throw new Error('second shell record missing')
      newest.status = 'succeeded'
      manager.emit(newest)
      manager.emit(newest, 'persisted')

      secondPanel
        .querySelector<HTMLButtonElement>(
          '.ai-run-pane__tab.is-active .ai-run-pane__tab-close',
        )
        ?.click()

      expect(panels()).toHaveLength(2)
      expect(panelTab(panels()[1])?.getAttribute('data-run-id')).toBe('shell-1')
      expect(
        panels()[1].querySelector('.ai-run-pane__tab[data-run-id="shell-2"]'),
      ).toBeNull()
      expect(rows().map((row) => row.getAttribute('data-run-id'))).toEqual([
        'run-a',
      ])
    })

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

    test('the × on a persisted finished shell unsplits immediately', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))
      splitButton()?.click()
      const shellRecord = manager.getRun('shell-1')
      if (!shellRecord) throw new Error('shell record missing')
      shellRecord.status = 'succeeded'
      manager.emit(shellRecord)
      manager.emit(shellRecord, 'persisted')

      panels()[1]
        .querySelector<HTMLButtonElement>('.ai-run-pane__tab-close')
        ?.click()

      expect(manager.stopRun).not.toHaveBeenCalled()
      expect(panels()).toHaveLength(1)
      expect(adapters[1].disposed).toBe(true)
    })
  })

  describe('+ button (new shell in the focused panel)', () => {
    test('restores each Vertical Tab own + and split workspace', () => {
      controller.mount(container)
      manager.emit(
        createRun({
          id: 'run-a',
          taskName: 'AAA',
          taskPath: 'TASKS/a.md',
        }),
      )
      manager.emit(
        createRun({
          id: 'run-b',
          taskName: 'GGG',
          taskPath: 'TASKS/b.md',
        }),
      )

      // AAA: main task + an explicit tab + an explicit split panel.
      container
        .querySelector<HTMLElement>('.ai-run-pane__run[data-run-id="run-a"]')
        ?.click()
      container.querySelector<HTMLButtonElement>('.ai-run-pane__add')?.click()
      visiblePanels()[0]
        .querySelector<HTMLButtonElement>('.ai-run-pane__split')
        ?.click()
      expect(visiblePanels()).toHaveLength(2)
      expect(manager.getRun('shell-1')?.parentRunId).toBe('run-a')
      expect(manager.getRun('shell-2')?.parentRunId).toBe('run-a')

      // GGG has never used + or split: it must open as one panel / one tab.
      container
        .querySelector<HTMLElement>('.ai-run-pane__run[data-run-id="run-b"]')
        ?.click()
      expect(visiblePanels()).toHaveLength(1)
      expect(
        Array.from(
          visiblePanels()[0].querySelectorAll<HTMLElement>('.ai-run-pane__tab'),
        ).map((tab) => tab.getAttribute('data-run-id')),
      ).toEqual(['run-b'])

      // GGG's own + is retained only in GGG.
      visiblePanels()[0]
        .querySelector<HTMLButtonElement>('.ai-run-pane__add')
        ?.click()
      expect(manager.getRun('shell-3')?.parentRunId).toBe('run-b')
      expect(
        Array.from(
          visiblePanels()[0].querySelectorAll<HTMLElement>('.ai-run-pane__tab'),
        ).map((tab) => tab.getAttribute('data-run-id')),
      ).toEqual(['run-b', 'shell-3'])

      // Returning to AAA revives AAA's original two-panel layout and tabs.
      container
        .querySelector<HTMLElement>('.ai-run-pane__run[data-run-id="run-a"]')
        ?.click()
      expect(visiblePanels()).toHaveLength(2)
      expect(
        Array.from(
          visiblePanels()[0].querySelectorAll<HTMLElement>('.ai-run-pane__tab'),
        ).map((tab) => tab.getAttribute('data-run-id')),
      ).toEqual(['run-a', 'shell-1'])
      expect(
        Array.from(
          visiblePanels()[1].querySelectorAll<HTMLElement>('.ai-run-pane__tab'),
        ).map((tab) => tab.getAttribute('data-run-id')),
      ).toEqual(['shell-2'])
      expect(
        container.querySelector('.ai-run-pane__panels')?.classList,
      ).toContain('is-split')
    })

    test('restores each task primary selection and focused split panel', () => {
      controller.mount(container)
      manager.emit(
        createRun({
          id: 'run-a',
          taskName: 'AAA',
          taskPath: 'TASKS/a.md',
        }),
      )
      manager.emit(
        createRun({
          id: 'run-b',
          taskName: 'GGG',
          taskPath: 'TASKS/b.md',
        }),
      )

      container
        .querySelector<HTMLElement>('.ai-run-pane__run[data-run-id="run-a"]')
        ?.click()
      visiblePanels()[0]
        .querySelector<HTMLButtonElement>('.ai-run-pane__add')
        ?.click()
      visiblePanels()[0]
        .querySelector<HTMLButtonElement>('.ai-run-pane__split')
        ?.click()

      const taskAPanels = visiblePanels()
      expect(panelTab(taskAPanels[0])?.getAttribute('data-run-id')).toBe(
        'shell-1',
      )
      expect(panelTab(taskAPanels[1])?.getAttribute('data-run-id')).toBe(
        'shell-2',
      )
      expect(taskAPanels[1].classList.contains('is-focused')).toBe(true)

      container
        .querySelector<HTMLElement>('.ai-run-pane__run[data-run-id="run-b"]')
        ?.click()
      expect(panelTab(visiblePanels()[0])?.getAttribute('data-run-id')).toBe(
        'run-b',
      )

      container
        .querySelector<HTMLElement>('.ai-run-pane__run[data-run-id="run-a"]')
        ?.click()

      expect(visiblePanels()).toHaveLength(2)
      expect(panelTab(taskAPanels[0])?.getAttribute('data-run-id')).toBe(
        'shell-1',
      )
      expect(panelTab(taskAPanels[1])?.getAttribute('data-run-id')).toBe(
        'shell-2',
      )
      expect(taskAPanels[1].classList.contains('is-focused')).toBe(true)
      expect(taskAPanels[0].classList.contains('is-focused')).toBe(false)
    })

    test('fits only the newly active task terminals while switching workspaces', () => {
      controller.mount(container)
      manager.emit(
        createRun({
          id: 'run-a',
          taskName: 'AAA',
          taskPath: 'TASKS/a.md',
        }),
      )
      manager.emit(
        createRun({
          id: 'run-b',
          taskName: 'GGG',
          taskPath: 'TASKS/b.md',
        }),
      )
      visiblePanels()[0]
        .querySelector<HTMLButtonElement>('.ai-run-pane__split')
        ?.click()
      expect(adapters).toHaveLength(2)
      adapters[0].fit.mockClear()
      adapters[1].fit.mockClear()

      container
        .querySelector<HTMLElement>('.ai-run-pane__run[data-run-id="run-b"]')
        ?.click()

      expect(adapters).toHaveLength(3)
      expect(adapters[0].fit).not.toHaveBeenCalled()
      expect(adapters[1].fit).not.toHaveBeenCalled()

      adapters[2].fit.mockClear()
      container
        .querySelector<HTMLElement>('.ai-run-pane__run[data-run-id="run-a"]')
        ?.click()
      expect(adapters[2].fit).not.toHaveBeenCalled()
      expect(adapters[0].fit).toHaveBeenCalled()
      expect(adapters[1].fit).toHaveBeenCalled()
    })

    test('a hidden panel close fallback never steals the active task workspace', () => {
      controller.mount(container)
      manager.emit(
        createRun({
          id: 'run-a',
          taskName: 'AAA',
          taskPath: 'TASKS/a.md',
        }),
      )
      manager.emit(
        createRun({
          id: 'run-b',
          taskName: 'GGG',
          taskPath: 'TASKS/b.md',
        }),
      )
      visiblePanels()[0]
        .querySelector<HTMLButtonElement>('.ai-run-pane__split')
        ?.click()
      visiblePanels()[1]
        .querySelector<HTMLButtonElement>('.ai-run-pane__add')
        ?.click()
      const taskAPanels = visiblePanels()
      taskAPanels[1]
        .querySelector<HTMLElement>(
          '.ai-run-pane__tab[data-run-id="shell-1"]',
        )
        ?.click()
      taskAPanels[1]
        .querySelector<HTMLButtonElement>(
          '.ai-run-pane__tab[data-run-id="shell-1"] .ai-run-pane__tab-close',
        )
        ?.click()

      container
        .querySelector<HTMLElement>('.ai-run-pane__run[data-run-id="run-b"]')
        ?.click()
      const stoppedShell = manager.getRun('shell-1')
      if (!stoppedShell) throw new Error('shell record missing')
      stoppedShell.status = 'stopped'
      manager.emit(stoppedShell)
      manager.emit(stoppedShell, 'persisted')

      expect(visiblePanels()).toHaveLength(1)
      expect(panelTab(visiblePanels()[0])?.getAttribute('data-run-id')).toBe(
        'run-b',
      )
      expect(
        container
          .querySelector('.ai-run-pane__run[data-run-id="run-b"]')
          ?.classList.contains('is-active'),
      ).toBe(true)

      container
        .querySelector<HTMLElement>('.ai-run-pane__run[data-run-id="run-a"]')
        ?.click()
      expect(visiblePanels()).toHaveLength(2)
      expect(panelTab(taskAPanels[1])?.getAttribute('data-run-id')).toBe(
        'shell-2',
      )
    })

    test('a + pressed from a shell keeps the original task as root owner', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a', taskName: 'AAA' }))

      const add = (): void => {
        visiblePanels()[0]
          .querySelector<HTMLButtonElement>('.ai-run-pane__add')
          ?.click()
      }
      add()
      expect(panelTab(visiblePanels()[0])?.getAttribute('data-run-id')).toBe(
        'shell-1',
      )
      add()

      expect(manager.getRun('shell-1')?.parentRunId).toBe('run-a')
      expect(manager.getRun('shell-2')?.parentRunId).toBe('run-a')
      expect(
        Array.from(
          visiblePanels()[0].querySelectorAll<HTMLElement>('.ai-run-pane__tab'),
        ).map((tab) => tab.getAttribute('data-run-id')),
      ).toEqual(['run-a', 'shell-1', 'shell-2'])
    })

    test('keeps explicit shell tabs scoped to the Vertical Tab that created them', () => {
      controller.mount(container)
      manager.emit(
        createRun({
          id: 'run-a',
          taskName: 'AAA',
          taskPath: 'TASKS/a.md',
        }),
      )
      manager.emit(
        createRun({
          id: 'run-b',
          taskName: 'GGG',
          taskPath: 'TASKS/b.md',
        }),
      )

      // AAA owns shell-1.
      container
        .querySelector<HTMLElement>('.ai-run-pane__run[data-run-id="run-a"]')
        ?.click()
      container.querySelector<HTMLButtonElement>('.ai-run-pane__add')?.click()
      expect(manager.getRun('shell-1')?.parentRunId).toBe('run-a')
      expect(
        panels()[0].querySelectorAll('.ai-run-pane__tab'),
      ).toHaveLength(2)

      // Switching to GGG swaps the complete task-local tab set. AAA's shell
      // remains alive, but is neither a visible tab nor an active body.
      container
        .querySelector<HTMLElement>('.ai-run-pane__run[data-run-id="run-b"]')
        ?.click()
      expect(
        Array.from(
          panels()[0].querySelectorAll<HTMLElement>('.ai-run-pane__tab'),
        ).map((tab) => tab.getAttribute('data-run-id')),
      ).toEqual(['run-b'])
      expect(
        panels()[0]
          .querySelector('.ai-run-pane__body[data-run-id="shell-1"]')
          ?.classList.contains('is-active'),
      ).toBe(false)

      // GGG's + creates an independent shell set.
      container.querySelector<HTMLButtonElement>('.ai-run-pane__add')?.click()
      expect(manager.getRun('shell-2')?.parentRunId).toBe('run-b')
      expect(
        Array.from(
          panels()[0].querySelectorAll<HTMLElement>('.ai-run-pane__tab'),
        ).map((tab) => tab.getAttribute('data-run-id')),
      ).toEqual(['run-b', 'shell-2'])

      // Returning to AAA restores only AAA + its own shell.
      container
        .querySelector<HTMLElement>('.ai-run-pane__run[data-run-id="run-a"]')
        ?.click()
      expect(
        Array.from(
          panels()[0].querySelectorAll<HTMLElement>('.ai-run-pane__tab'),
        ).map((tab) => tab.getAttribute('data-run-id')),
      ).toEqual(['run-a', 'shell-1'])
      expect(
        panels()[0].querySelector('.ai-run-pane__tab[data-run-id="shell-2"]'),
      ).toBeNull()

      // The persisted parentRunId relationship rebuilds the same task-local
      // tab set after a pane remount (the UI equivalent of plugin reload).
      controller.unmount()
      controller.mount(container)
      expect(
        Array.from(
          panels()[0].querySelectorAll<HTMLElement>('.ai-run-pane__tab'),
        ).map((tab) => tab.getAttribute('data-run-id')),
      ).toEqual(['run-a', 'shell-1'])
    })

    test('closing a selected shell returns to the existing task slot, not a hidden concurrent run', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a', taskName: 'Task A' }))
      manager.emit(
        createRun({
          id: 'run-b',
          taskName: 'Task B',
          taskPath: 'TASKS/b.md',
        }),
      )
      container
        .querySelector<HTMLElement>('.ai-run-pane__run[data-run-id="run-a"]')
        ?.click()
      container.querySelector<HTMLButtonElement>('.ai-run-pane__add')?.click()
      const shell = manager.getRun('shell-1')
      if (!shell) throw new Error('shell record missing')
      shell.status = 'succeeded'
      manager.emit(shell)
      manager.emit(shell, 'persisted')

      panels()[0]
        .querySelector<HTMLButtonElement>(
          '.ai-run-pane__tab[data-run-id="shell-1"] .ai-run-pane__tab-close',
        )
        ?.click()

      expect(panelTab(panels()[0])?.getAttribute('data-run-id')).toBe('run-a')
      expect(
        panels()[0].querySelector('.ai-run-pane__tab[data-run-id="run-b"]'),
      ).toBeNull()
      expect(
        container
          .querySelector('.ai-run-pane__run[data-run-id="run-a"]')
          ?.classList.contains('is-active'),
      ).toBe(true)
    })

    test('task slot and explicit shell tabs expose a roving ARIA tablist', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))
      container.querySelector<HTMLButtonElement>('.ai-run-pane__add')?.click()

      const tablist = panels()[0].querySelector<HTMLElement>(
        '.ai-run-pane__tabs',
      )
      expect(tablist?.getAttribute('role')).toBe('tablist')
      expect(tablist?.getAttribute('aria-orientation')).toBe('horizontal')

      const press = (runId: string, key: string): void => {
        const tab = panels()[0].querySelector<HTMLElement>(
          `.ai-run-pane__tab[data-run-id="${runId}"]`,
        )
        tab?.focus()
        tab?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      }
      const activeRunId = (): string | null =>
        panelTab(panels()[0])?.getAttribute('data-run-id') ?? null

      press('run-a', 'ArrowRight')
      expect(activeRunId()).toBe('shell-1')
      expect(document.activeElement?.getAttribute('data-run-id')).toBe('shell-1')

      press('shell-1', 'ArrowLeft')
      expect(activeRunId()).toBe('run-a')

      press('run-a', 'End')
      expect(activeRunId()).toBe('shell-1')

      press('shell-1', 'Home')
      expect(activeRunId()).toBe('run-a')
      expect(document.activeElement?.getAttribute('data-run-id')).toBe('run-a')
    })

    test('closing a non-selected internal tab removes its stale tab DOM', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))
      container.querySelector<HTMLButtonElement>('.ai-run-pane__add')?.click()
      const shell = manager.getRun('shell-1')
      if (!shell) throw new Error('shell record missing')
      panels()[0]
        .querySelector<HTMLElement>('.ai-run-pane__tab[data-run-id="run-a"]')
        ?.click()
      shell.status = 'succeeded'
      manager.emit(shell)
      manager.emit(shell, 'persisted')

      panels()[0]
        .querySelector<HTMLButtonElement>(
          '.ai-run-pane__tab[data-run-id="shell-1"] .ai-run-pane__tab-close',
        )
        ?.click()

      expect(
        panels()[0].querySelector('.ai-run-pane__tab[data-run-id="shell-1"]'),
      ).toBeNull()
      expect(panelTab(panels()[0])?.getAttribute('data-run-id')).toBe('run-a')
    })

    test('a stopped shell removes its tab after the user switched to its sibling', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))
      container.querySelector<HTMLButtonElement>('.ai-run-pane__add')?.click()
      const shell = manager.getRun('shell-1')
      if (!shell) throw new Error('shell record missing')
      panels()[0]
        .querySelector<HTMLButtonElement>(
          '.ai-run-pane__tab[data-run-id="shell-1"] .ai-run-pane__tab-close',
        )
        ?.click()
      panels()[0]
        .querySelector<HTMLElement>('.ai-run-pane__tab[data-run-id="run-a"]')
        ?.click()

      shell.status = 'stopped'
      manager.emit(shell)
      manager.emit(shell, 'persisted')

      expect(
        panels()[0].querySelector('.ai-run-pane__tab[data-run-id="shell-1"]'),
      ).toBeNull()
      expect(panelTab(panels()[0])?.getAttribute('data-run-id')).toBe('run-a')
    })

    test('closing a parent AI run also stops and removes its owned shell tabs', () => {
      controller.mount(container)
      const parent = createRun({ id: 'run-a', cwd: '/workspace/project' })
      manager.emit(parent)
      splitButton()?.click()
      const shell = manager.getRun('shell-1')
      if (!shell) throw new Error('shell record missing')
      parent.status = 'succeeded'
      manager.emit(parent)

      container
        .querySelector<HTMLButtonElement>(
          '.ai-run-pane__run[data-run-id="run-a"] .ai-run-pane__run-close',
        )
        ?.click()

      // The parent view (and its live terminal snapshot provider) stays until
      // persistence completes; only then does owned-shell teardown begin.
      expect(manager.stopRun).not.toHaveBeenCalledWith('shell-1')
      expect(rows()).toHaveLength(1)
      manager.emit(parent, 'persisted')
      expect(manager.stopRun).toHaveBeenCalledWith('shell-1')
      expect(rows()).toHaveLength(0)
      shell.status = 'stopped'
      manager.emit(shell)
      manager.emit(shell, 'persisted')
      expect(container.querySelectorAll('.ai-run-pane__tab')).toHaveLength(0)
      expect(
        container.querySelector('.ai-run-pane')?.classList.contains('is-hidden'),
      ).toBe(true)
    })

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
      expect(
        panels()[0].querySelectorAll('.ai-run-pane__tab'),
      ).toHaveLength(2)
      expect(rows().map((row) => row.getAttribute('data-run-id'))).toEqual([
        'run-a',
      ])
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
