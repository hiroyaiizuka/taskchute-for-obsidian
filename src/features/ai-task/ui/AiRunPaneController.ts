/**
 * AI Task - run pane controller
 *
 * Renders the collapsible "AI runs" pane below the task list: one tab per run
 * (task name + status dot + stop control while active) and one body per run.
 * Bodies are kept in a Map and only the selected one is visible, so state
 * (scroll position, terminal screen) survives tab switches.
 *
 * Headless runs render their stream events as text lines and can send
 * resume-based follow-ups through the composer bar at the bottom (enabled
 * only when the run is finished, has a session id, and its task has no other
 * active run).
 *
 * Terminal runs host an embedded terminal instead: a TerminalViewAdapter is
 * created LAZILY the first time the run's tab is shown (pane expanded),
 * opened with the record's fixed PTY grid, wired both ways
 * (manager.onTerminalData -> adapter.write, adapter.onData ->
 * manager.sendTerminalInput), and focused on tab select. The composer is
 * hidden for terminal runs — input goes straight into the terminal. While a
 * terminal run is selected and the pane is expanded, the host container
 * carries the ai-pane-container--terminal chrome class so styles.css can
 * give the pane a real height.
 *
 * On mount the pane also registers itself as the manager's terminal
 * snapshot provider: at run exit the manager reads the run's live xterm
 * buffer (adapter.snapshotText()) as the log-note transcript instead of the
 * ANSI-stripped PTY transcript file. Adapters are therefore never disposed
 * on the final status update.
 *
 * Tab lifecycle at run end: a run that finishes as 'stopped' closes its tab
 * automatically — but only on the manager's 'persisted' notification (the
 * end of the log persist chain), so the exit-time snapshot above always
 * found the adapter alive. Closing a tab disposes its adapter, selects the
 * most recent remaining tab, and hides the pane again when no tabs remain.
 * Runs that finish as 'succeeded' or 'failed' keep their tab and gain a ×
 * close control instead; stopped runs never regain a tab on a mount replay.
 *
 * All content is written through createEl/createDiv/createSpan with
 * textContent only (xterm renders inside its own subtree via the adapter).
 */

import { Notice } from 'obsidian'
import {
  AiRunAlreadyActiveError,
  AiSessionUnavailableError,
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  type AiRunChangeType,
} from '../services/AiTaskManager'
import { AiBinaryNotFoundError } from '../services/BinaryLocator'
import type { AiRunRecord, AiRunStatus, AiStreamEvent } from '../types'
import type {
  TerminalViewAdapterFactory,
  TerminalViewAdapterLike,
} from './TerminalViewAdapter'

export interface AiRunPaneManagerLike {
  getRuns(): AiRunRecord[]
  getRun(runId: string): AiRunRecord | undefined
  getActiveRunForTask(taskPath: string): AiRunRecord | undefined
  stopRun(runId: string): void
  followUp(runId: string, prompt: string): Promise<unknown>
  onChange(
    listener: (record: AiRunRecord, changeType?: AiRunChangeType) => void,
  ): () => void
  onTerminalData(runId: string, listener: (chunk: string) => void): () => void
  sendTerminalInput(runId: string, data: string): void
  /**
   * Single-provider registration used by the manager to read a terminal
   * run's live xterm buffer when its log note is composed at run exit; the
   * returned disposer unregisters. Optional so plain fakes keep working —
   * without it the manager falls back to the ANSI-stripped transcript file.
   */
  registerTerminalSnapshotProvider?(
    provider: (runId: string) => string | undefined,
  ): () => void
}

export interface AiRunPaneControllerHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  manager: AiRunPaneManagerLike
  /** Adapter factory; tests substitute a fake so jsdom never loads xterm */
  createTerminalAdapter: TerminalViewAdapterFactory
  registerManagedDisposer: (cleanup: () => void) => void
}

/** Live terminal wiring of one terminal-mode run view */
interface TerminalBinding {
  adapter: TerminalViewAdapterLike
  /** Unsubscribes the manager.onTerminalData relay */
  disposeData: () => void
  /** Unsubscribes the adapter.onData keystroke relay */
  disposeInput: () => void
}

interface RunView {
  tab: HTMLElement
  body: HTMLElement
  isTerminal: boolean
  terminal: TerminalBinding | null
  renderedEventCount: number
  lastStatus: AiRunStatus
  lastOmittedCount: number
}

const ACTIVE_STATUSES: ReadonlySet<AiRunStatus> = new Set([
  'starting',
  'running',
  'stopping',
])

const STATUS_FALLBACK_LABELS: Record<AiRunStatus, string> = {
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  succeeded: 'Succeeded',
  failed: 'Failed',
  stopped: 'Stopped',
}

/** Pixel slack when deciding whether the body is pinned to the bottom */
const SCROLL_PIN_THRESHOLD_PX = 8
/** Longest serialized tool input rendered inline before truncation */
const TOOL_INPUT_PREVIEW_LIMIT = 200

/** PTY size handed to startRun when the pane has no measurable pixel size */
export const TERMINAL_FALLBACK_COLS = 120
export const TERMINAL_FALLBACK_ROWS = 30
/**
 * Approximate xterm cell metrics for the pre-spawn size estimate (the exact
 * glyph metrics are only known once xterm has opened, which happens after
 * the PTY was already spawned — a conservative estimate merely leaves some
 * unused margin in the pane).
 */
const TERMINAL_CELL_WIDTH_PX = 8
const TERMINAL_CELL_HEIGHT_PX = 17
/** Horizontal padding/scrollbar allowance inside the terminal body */
const TERMINAL_HORIZONTAL_INSET_PX = 16
/** Pane header + borders allowance when deriving the body height */
const TERMINAL_VERTICAL_INSET_PX = 40
/** Share of the view height the terminal pane occupies (mirrors styles.css) */
const TERMINAL_PANE_HEIGHT_RATIO = 0.4
const TERMINAL_MIN_COLS = 20
const TERMINAL_MAX_COLS = 400
const TERMINAL_MIN_ROWS = 5
const TERMINAL_MAX_ROWS = 200

/** Chrome class on the host container while a terminal run is on screen */
const TERMINAL_CONTAINER_CLASS = 'ai-pane-container--terminal'

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export class AiRunPaneController {
  private readonly runViews = new Map<string, RunView>()
  private containerEl: HTMLElement | null = null
  private root: HTMLElement | null = null
  private tabsEl: HTMLElement | null = null
  private bodiesEl: HTMLElement | null = null
  private collapseButton: HTMLElement | null = null
  private composerEl: HTMLElement | null = null
  private composerInput: HTMLInputElement | null = null
  private composerSend: HTMLButtonElement | null = null
  private selectedRunId: string | null = null
  private unsubscribe: (() => void) | null = null
  private unregisterSnapshotProvider: (() => void) | null = null

  constructor(private readonly host: AiRunPaneControllerHost) {}

  mount(container: HTMLElement): void {
    if (this.root) return
    this.containerEl = container

    const root = container.createDiv({ cls: 'ai-run-pane is-hidden' })
    this.root = root

    const header = root.createDiv({ cls: 'ai-run-pane__header' })
    const toggleLabel = this.host.tv('aiTask.togglePane', 'Toggle AI run pane')
    const collapseButton = header.createEl('button', {
      cls: 'ai-run-pane__collapse',
      text: '▾',
      attr: {
        'aria-label': toggleLabel,
        title: toggleLabel,
        'aria-expanded': 'true',
      },
    })
    collapseButton.addEventListener('click', (event) => {
      event.stopPropagation()
      this.setCollapsed(!this.isCollapsed())
    })
    this.collapseButton = collapseButton

    header.createSpan({
      cls: 'ai-run-pane__title',
      text: this.host.tv('aiTask.paneTitle', 'AI runs'),
    })
    this.tabsEl = header.createDiv({
      cls: 'ai-run-pane__tabs',
      attr: { role: 'tablist' },
    })
    this.bodiesEl = root.createDiv({ cls: 'ai-run-pane__bodies' })
    this.mountComposer(root)

    this.unsubscribe = this.host.manager.onChange((record, changeType) => {
      this.handleChange(record, changeType)
    })
    this.host.registerManagedDisposer(() => {
      this.unsubscribe?.()
      this.unsubscribe = null
    })

    // The manager snapshots a terminal run's live xterm buffer at run exit
    // as the log-note transcript source (the raw PTY transcript file strips
    // to TUI redraw garbage). Adapters of finished runs are kept alive for
    // tab viewing until unmount, so the exit-time capture always finds them.
    this.unregisterSnapshotProvider =
      this.host.manager.registerTerminalSnapshotProvider?.((runId) =>
        this.runViews.get(runId)?.terminal?.adapter.snapshotText(),
      ) ?? null
    this.host.registerManagedDisposer(() => {
      this.unregisterSnapshotProvider?.()
      this.unregisterSnapshotProvider = null
    })

    for (const record of this.host.manager.getRuns()) {
      this.handleChange(record)
    }
  }

  unmount(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    // Unregister BEFORE disposing adapters: a snapshot must never be taken
    // from a disposed terminal mid-teardown.
    this.unregisterSnapshotProvider?.()
    this.unregisterSnapshotProvider = null
    for (const view of this.runViews.values()) {
      this.disposeTerminalBinding(view)
    }
    this.containerEl?.classList.remove(TERMINAL_CONTAINER_CLASS)
    this.containerEl = null
    this.root?.remove()
    this.root = null
    this.tabsEl = null
    this.bodiesEl = null
    this.collapseButton = null
    this.composerEl = null
    this.composerInput = null
    this.composerSend = null
    this.selectedRunId = null
    this.runViews.clear()
  }

  /** Reveal the pane, expand it, and select the given run's tab */
  openRun(runId: string): void {
    if (!this.runViews.has(runId)) {
      const record = this.host.manager.getRun(runId)
      if (!record) return
      this.handleChange(record)
      // handleChange declines some records (e.g. stopped runs never regain
      // a tab); without a view there is nothing to reveal or select.
      if (!this.runViews.has(runId)) return
    }
    this.revealPane()
    this.setCollapsed(false)
    this.selectRun(runId)
  }

  setCollapsed(collapsed: boolean): void {
    if (!this.root) return
    this.root.classList.toggle('is-collapsed', collapsed)
    if (this.collapseButton) {
      this.collapseButton.textContent = collapsed ? '▸' : '▾'
      this.collapseButton.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
    }
    if (!collapsed) {
      // A terminal run selected while collapsed deferred its adapter; the
      // body just became visible, so create and focus it now.
      this.ensureSelectedTerminalView()
    }
    this.updateTerminalChrome()
  }

  /**
   * Estimate the PTY grid that fits the pane at its terminal height
   * (TERMINAL_PANE_HEIGHT_RATIO of the view). Falls back to 120x30 when the
   * pane has no measurable pixel size (hidden view, jsdom).
   */
  computeTerminalSize(): { cols: number; rows: number } {
    const container = this.containerEl
    const width = container?.clientWidth ?? 0
    const parentHeight = container?.parentElement?.clientHeight ?? 0
    if (width <= 0 || parentHeight <= 0) {
      return { cols: TERMINAL_FALLBACK_COLS, rows: TERMINAL_FALLBACK_ROWS }
    }
    const bodyHeight =
      parentHeight * TERMINAL_PANE_HEIGHT_RATIO - TERMINAL_VERTICAL_INSET_PX
    const cols = clamp(
      Math.floor((width - TERMINAL_HORIZONTAL_INSET_PX) / TERMINAL_CELL_WIDTH_PX),
      TERMINAL_MIN_COLS,
      TERMINAL_MAX_COLS,
    )
    const rows = clamp(
      Math.floor(bodyHeight / TERMINAL_CELL_HEIGHT_PX),
      TERMINAL_MIN_ROWS,
      TERMINAL_MAX_ROWS,
    )
    return { cols, rows }
  }

  private isCollapsed(): boolean {
    return this.root?.classList.contains('is-collapsed') ?? false
  }

  private isHidden(): boolean {
    return this.root?.classList.contains('is-hidden') ?? true
  }

  private revealPane(): void {
    this.root?.classList.remove('is-hidden')
  }

  private handleChange(record: AiRunRecord, changeType?: AiRunChangeType): void {
    if (!this.root) return
    if (changeType === 'persisted') {
      // The run's log persist chain completed: the exit-time terminal
      // snapshot has been consumed, so a stopped run's tab (and adapter) is
      // now safe to tear down. Succeeded/failed runs keep their tab.
      if (record.status === 'stopped') {
        this.closeRun(record.id)
      }
      return
    }
    const existing = this.runViews.get(record.id)
    if (!existing) {
      // Stopped runs never (re)gain a tab: their tab auto-closed at persist
      // time, and a mount replay of the manager's records must not resurrect
      // it.
      if (record.status === 'stopped') return
      this.createRunView(record)
      this.updateComposerState()
      return
    }
    if (existing.lastStatus !== record.status) {
      existing.lastStatus = record.status
      this.refreshTab(existing, record)
    }
    if (!existing.isTerminal) {
      this.syncEvents(existing, record)
    }
    this.updateComposerState()
  }

  /**
   * Close one run's tab: dispose its terminal wiring, remove the tab and
   * body, move the selection to the most recent remaining tab, and hide the
   * pane again (the pre-first-run state) when no tabs remain. Used by the
   * stopped-run auto-close and the × control of finished tabs.
   */
  private closeRun(runId: string): void {
    const view = this.runViews.get(runId)
    if (!view) return
    this.disposeTerminalBinding(view)
    view.tab.remove()
    view.body.remove()
    this.runViews.delete(runId)

    if (this.selectedRunId === runId) {
      this.selectedRunId = null
      const remaining = Array.from(this.runViews.keys())
      const mostRecent = remaining[remaining.length - 1]
      if (mostRecent !== undefined) {
        this.selectRun(mostRecent)
        return
      }
    }
    if (this.runViews.size === 0) {
      this.selectedRunId = null
      this.root?.classList.add('is-hidden')
    }
    this.updateTerminalChrome()
    this.updateComposerState()
  }

  private createRunView(record: AiRunRecord): void {
    if (!this.tabsEl || !this.bodiesEl) return

    const tab = this.tabsEl.createDiv({
      cls: 'ai-run-pane__tab',
      attr: {
        role: 'tab',
        tabindex: '0',
        'data-run-id': record.id,
      },
    })
    tab.addEventListener('click', () => {
      this.selectRun(record.id)
    })
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      this.selectRun(record.id)
    })

    const isTerminal = record.mode === 'terminal'
    const body = this.bodiesEl.createDiv({
      cls: isTerminal
        ? 'ai-run-pane__body ai-run-pane__body--terminal'
        : 'ai-run-pane__body',
      attr: { 'data-run-id': record.id },
    })

    const view: RunView = {
      tab,
      body,
      isTerminal,
      terminal: null,
      renderedEventCount: 0,
      lastStatus: record.status,
      lastOmittedCount: record.omittedEventCount ?? 0,
    }
    this.runViews.set(record.id, view)
    this.refreshTab(view, record)
    if (!isTerminal) {
      this.renderAllEvents(view, record)
    }

    this.revealPane()
    if (this.selectedRunId === null) {
      this.selectRun(record.id)
    }
  }

  /** Rebuild the tab contents (status dot, name, stop control) */
  private refreshTab(view: RunView, record: AiRunRecord): void {
    view.tab.empty()

    const statusLabel = this.host.tv(
      `aiTask.status.${record.status}`,
      STATUS_FALLBACK_LABELS[record.status],
    )
    view.tab.createSpan({
      cls: `ai-run-pane__tab-dot ai-run-pane__tab-dot--${record.status}`,
      attr: { title: statusLabel },
    })
    view.tab.createSpan({
      cls: 'ai-run-pane__tab-name',
      text:
        record.taskName.trim().length > 0
          ? record.taskName
          : this.host.tv('aiTask.tabUntitled', 'Untitled run'),
    })

    if (ACTIVE_STATUSES.has(record.status)) {
      const stopLabel = this.host.tv('aiTask.stop', 'Stop AI task')
      const stopButton = view.tab.createEl('button', {
        cls: 'ai-run-pane__tab-stop',
        text: '⏹',
        attr: { 'aria-label': stopLabel, title: stopLabel },
      })
      stopButton.addEventListener('click', (event) => {
        event.stopPropagation()
        this.host.manager.stopRun(record.id)
      })
    } else if (record.status === 'succeeded' || record.status === 'failed') {
      // Finished tabs are kept for review and closed manually. 'stopped'
      // deliberately gets NO control: its tab auto-closes on 'persisted',
      // and a manual close in that window could dispose the adapter before
      // the manager captured the transcript snapshot.
      const closeLabel = this.host.tv('aiTask.closeTab', 'Close run tab')
      const closeButton = view.tab.createEl('button', {
        cls: 'ai-run-pane__tab-close',
        text: '×',
        attr: { 'aria-label': closeLabel, title: closeLabel },
      })
      closeButton.addEventListener('click', (event) => {
        event.stopPropagation()
        this.closeRun(record.id)
      })
    }
  }

  private selectRun(runId: string): void {
    this.selectedRunId = runId
    for (const [id, view] of this.runViews) {
      const isActive = id === runId
      view.tab.classList.toggle('is-active', isActive)
      view.tab.setAttribute('aria-selected', isActive ? 'true' : 'false')
      view.body.classList.toggle('is-active', isActive)
    }
    if (!this.isCollapsed()) {
      this.ensureSelectedTerminalView()
    }
    this.updateTerminalChrome()
    this.updateComposerState()
  }

  // -------------------------------------------------------------------------
  // Terminal bodies
  // -------------------------------------------------------------------------

  /**
   * Lazily create (or just re-focus) the embedded terminal of the SELECTED
   * run. The adapter is opened with the record's fixed PTY grid so the xterm
   * view matches the child process exactly, wired both ways, and focused so
   * the user can type immediately. No-op for headless runs and while the
   * body is not visible (collapsed pane).
   */
  private ensureSelectedTerminalView(): void {
    const runId = this.selectedRunId
    if (runId === null || this.isHidden()) return
    const view = this.runViews.get(runId)
    if (!view || !view.isTerminal) return

    if (!view.terminal) {
      const record = this.host.manager.getRun(runId)
      const adapter = this.host.createTerminalAdapter()
      adapter.open(
        view.body,
        record?.cols ?? DEFAULT_TERMINAL_COLS,
        record?.rows ?? DEFAULT_TERMINAL_ROWS,
      )
      // Subscribe AFTER open: the manager replays its buffered output
      // synchronously on subscribe, restoring the screen of a run that
      // started before the pane showed it.
      const disposeData = this.host.manager.onTerminalData(runId, (chunk) => {
        adapter.write(chunk)
      })
      const disposeInput = adapter.onData((data) => {
        this.host.manager.sendTerminalInput(runId, data)
      })
      view.terminal = { adapter, disposeData, disposeInput }
    }
    view.terminal.adapter.focus()
  }

  /** Tear down one run view's terminal wiring (idempotent) */
  private disposeTerminalBinding(view: RunView): void {
    const binding = view.terminal
    if (!binding) return
    view.terminal = null
    binding.disposeData()
    binding.disposeInput()
    binding.adapter.dispose()
  }

  /**
   * The host container carries the terminal chrome class (fixed pane height
   * in styles.css) exactly while a terminal run is selected and its body is
   * actually on screen.
   */
  private updateTerminalChrome(): void {
    const container = this.containerEl
    if (!container) return
    const selected =
      this.selectedRunId !== null ? this.runViews.get(this.selectedRunId) : undefined
    const showTerminal =
      selected?.isTerminal === true && !this.isCollapsed() && !this.isHidden()
    container.classList.toggle(TERMINAL_CONTAINER_CLASS, showTerminal)
  }

  // -------------------------------------------------------------------------
  // Follow-up composer
  // -------------------------------------------------------------------------

  private mountComposer(root: HTMLElement): void {
    const composer = root.createDiv({ cls: 'ai-run-pane__composer' })
    this.composerEl = composer
    const inputLabel = this.host.tv('aiTask.composer.inputLabel', 'Follow-up prompt')
    this.composerInput = composer.createEl('input', {
      cls: 'ai-run-pane__composer-input',
      attr: { type: 'text', 'aria-label': inputLabel },
    })
    this.composerInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return
      event.preventDefault()
      this.submitComposer()
    })

    const sendLabel = this.host.tv('aiTask.composer.send', 'Send')
    this.composerSend = composer.createEl('button', {
      cls: 'ai-run-pane__composer-send',
      text: sendLabel,
      attr: { 'aria-label': sendLabel },
    })
    this.composerSend.addEventListener('click', (event) => {
      event.stopPropagation()
      this.submitComposer()
    })

    this.updateComposerState()
  }

  /**
   * The composer only applies to headless runs (terminal runs take input in
   * the terminal itself, so the bar is hidden outright for them). It is
   * usable only when the SELECTED run is finished, has a session id to
   * resume, AND its task has no other active run (the manager would
   * deterministically reject the follow-up otherwise); in every other case
   * it is disabled with a hint placeholder.
   */
  private updateComposerState(): void {
    const input = this.composerInput
    const send = this.composerSend
    if (!input || !send) return

    const record =
      this.selectedRunId !== null
        ? this.host.manager.getRun(this.selectedRunId)
        : undefined

    const isTerminal = record?.mode === 'terminal'
    this.composerEl?.classList.toggle('is-hidden', isTerminal)
    if (isTerminal) {
      input.disabled = true
      send.disabled = true
      return
    }

    const isActive = record !== undefined && ACTIVE_STATUSES.has(record.status)
    const hasSession =
      typeof record?.sessionId === 'string' && record.sessionId.length > 0
    const taskHasActiveRun =
      record !== undefined &&
      this.host.manager.getActiveRunForTask(record.taskPath) !== undefined
    const enabled =
      record !== undefined && !isActive && hasSession && !taskHasActiveRun

    input.disabled = !enabled
    send.disabled = !enabled

    let placeholder: string
    if (enabled) {
      placeholder = this.host.tv('aiTask.composer.placeholder', 'Send a follow-up prompt')
    } else if (isActive) {
      placeholder = this.host.tv('aiTask.composer.runningPlaceholder', 'Running…')
    } else {
      placeholder = this.host.tv(
        'aiTask.composer.unavailablePlaceholder',
        'Follow-up is not available for this run',
      )
    }
    input.setAttribute('placeholder', placeholder)
  }

  private submitComposer(): void {
    const input = this.composerInput
    if (!input || input.disabled) return
    const runId = this.selectedRunId
    if (runId === null) return
    const text = input.value.trim()
    if (text.length === 0) return

    input.value = ''
    void this.host.manager.followUp(runId, text).catch((error: unknown) => {
      this.notifyFollowUpError(error)
      // Give the text back so the user can retry, unless they typed anew.
      if (this.composerInput && this.composerInput.value.length === 0) {
        this.composerInput.value = text
      }
    })
  }

  /** Localize typed follow-up errors instead of interpolating raw messages */
  private notifyFollowUpError(error: unknown): void {
    if (error instanceof AiRunAlreadyActiveError) {
      new Notice(
        this.host.tv(
          'aiTask.notices.alreadyRunning',
          'An AI run is already in progress for this task.',
        ),
      )
      return
    }
    if (error instanceof AiBinaryNotFoundError) {
      new Notice(
        this.host.tv(
          'aiTask.notices.binaryNotFound',
          'AI CLI binary was not found: {host}. Set the path in settings.',
          { host: error.host },
        ),
      )
      return
    }
    if (error instanceof AiSessionUnavailableError) {
      new Notice(
        this.host.tv(
          'aiTask.notices.sessionUnavailable',
          'This run has no session to resume.',
        ),
      )
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    new Notice(
      this.host.tv('aiTask.notices.followUpFailed', 'Failed to send follow-up: {message}', {
        message,
      }),
    )
  }

  /**
   * Incremental append via a per-run cursor. When the manager's bounded
   * buffer replaces middle events (the omitted count changed), positional
   * indices are no longer stable, so rebuild the whole body instead.
   */
  private syncEvents(view: RunView, record: AiRunRecord): void {
    const omittedCount = record.omittedEventCount ?? 0
    if (omittedCount !== view.lastOmittedCount) {
      view.lastOmittedCount = omittedCount
      this.renderAllEvents(view, record)
      return
    }
    if (record.events.length <= view.renderedEventCount) return

    const pinned = this.isPinnedToBottom(view.body)
    for (let i = view.renderedEventCount; i < record.events.length; i += 1) {
      this.appendEventElement(view.body, record.events[i])
    }
    view.renderedEventCount = record.events.length
    if (pinned) this.scrollToBottom(view.body)
  }

  private renderAllEvents(view: RunView, record: AiRunRecord): void {
    const pinned = this.isPinnedToBottom(view.body)
    view.body.empty()
    for (const event of record.events) {
      this.appendEventElement(view.body, event)
    }
    view.renderedEventCount = record.events.length
    if (pinned) this.scrollToBottom(view.body)
  }

  private appendEventElement(body: HTMLElement, event: AiStreamEvent): void {
    body.createDiv({
      cls: `ai-run-pane__event ai-run-pane__event--${event.kind}`,
      text: this.formatEventText(event),
    })
  }

  private isPinnedToBottom(body: HTMLElement): boolean {
    return (
      body.scrollHeight - body.scrollTop - body.clientHeight <=
      SCROLL_PIN_THRESHOLD_PX
    )
  }

  private scrollToBottom(body: HTMLElement): void {
    body.scrollTop = body.scrollHeight
  }

  private formatEventText(event: AiStreamEvent): string {
    switch (event.kind) {
      case 'init': {
        const details = [event.model, event.sessionId]
          .filter((part): part is string => typeof part === 'string' && part.length > 0)
          .join(' · ')
        return details.length > 0 ? details : 'init'
      }
      case 'assistant-text':
        return event.text
      case 'user-text':
        return event.text
      case 'tool-use':
        return this.formatToolUse(event.toolName, event.input)
      case 'tool-result':
        return event.text ?? ''
      case 'result':
        return event.text ?? event.subtype ?? 'result'
      case 'stderr':
        return event.text
      case 'raw':
        return event.text
      case 'elision':
        return this.host.tv(
          'aiTask.events.omitted',
          '{count} events omitted',
          { count: event.omittedCount },
        )
    }
  }

  private formatToolUse(toolName: string, input: unknown): string {
    if (input === undefined) return toolName
    let serialized: string
    try {
      serialized = JSON.stringify(input) ?? '[unserializable input]'
    } catch {
      serialized = '[unserializable input]'
    }
    if (serialized.length > TOOL_INPUT_PREVIEW_LIMIT) {
      serialized = `${serialized.slice(0, TOOL_INPUT_PREVIEW_LIMIT)}…`
    }
    return `${toolName} ${serialized}`
  }
}
