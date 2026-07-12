/**
 * AI Task - run pane controller
 *
 * Renders the collapsible "AI runs" pane below the task list: one tab per run
 * (task name + status dot + stop control while active) and one event body per
 * run. Bodies are kept in a Map and only the selected one is visible, so
 * scroll position survives tab switches. A composer bar at the bottom sends
 * resume-based follow-up prompts for the selected run; it is enabled only
 * when that run is finished, has a session id, and its task has no other
 * active run. All content is written through createEl/createDiv/createSpan
 * with textContent only.
 */

import { Notice } from 'obsidian'
import {
  AiRunAlreadyActiveError,
  AiSessionUnavailableError,
} from '../services/AiTaskManager'
import { AiBinaryNotFoundError } from '../services/BinaryLocator'
import type { AiRunRecord, AiRunStatus, AiStreamEvent } from '../types'

export interface AiRunPaneManagerLike {
  getRuns(): AiRunRecord[]
  getRun(runId: string): AiRunRecord | undefined
  getActiveRunForTask(taskPath: string): AiRunRecord | undefined
  stopRun(runId: string): void
  followUp(runId: string, prompt: string): Promise<unknown>
  onChange(listener: (record: AiRunRecord) => void): () => void
}

export interface AiRunPaneControllerHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  manager: AiRunPaneManagerLike
  registerManagedDisposer: (cleanup: () => void) => void
}

interface RunView {
  tab: HTMLElement
  body: HTMLElement
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

export class AiRunPaneController {
  private readonly runViews = new Map<string, RunView>()
  private root: HTMLElement | null = null
  private tabsEl: HTMLElement | null = null
  private bodiesEl: HTMLElement | null = null
  private collapseButton: HTMLElement | null = null
  private composerInput: HTMLInputElement | null = null
  private composerSend: HTMLButtonElement | null = null
  private selectedRunId: string | null = null
  private unsubscribe: (() => void) | null = null

  constructor(private readonly host: AiRunPaneControllerHost) {}

  mount(container: HTMLElement): void {
    if (this.root) return

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

    this.unsubscribe = this.host.manager.onChange((record) => {
      this.handleChange(record)
    })
    this.host.registerManagedDisposer(() => {
      this.unsubscribe?.()
      this.unsubscribe = null
    })

    for (const record of this.host.manager.getRuns()) {
      this.handleChange(record)
    }
  }

  unmount(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.root?.remove()
    this.root = null
    this.tabsEl = null
    this.bodiesEl = null
    this.collapseButton = null
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
  }

  private isCollapsed(): boolean {
    return this.root?.classList.contains('is-collapsed') ?? false
  }

  private revealPane(): void {
    this.root?.classList.remove('is-hidden')
  }

  private handleChange(record: AiRunRecord): void {
    if (!this.root) return
    const existing = this.runViews.get(record.id)
    if (!existing) {
      this.createRunView(record)
      this.updateComposerState()
      return
    }
    if (existing.lastStatus !== record.status) {
      existing.lastStatus = record.status
      this.refreshTab(existing, record)
    }
    this.syncEvents(existing, record)
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

    const body = this.bodiesEl.createDiv({
      cls: 'ai-run-pane__body',
      attr: { 'data-run-id': record.id },
    })

    const view: RunView = {
      tab,
      body,
      renderedEventCount: 0,
      lastStatus: record.status,
      lastOmittedCount: record.omittedEventCount ?? 0,
    }
    this.runViews.set(record.id, view)
    this.refreshTab(view, record)
    this.renderAllEvents(view, record)

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
    this.updateComposerState()
  }

  // -------------------------------------------------------------------------
  // Follow-up composer
  // -------------------------------------------------------------------------

  private mountComposer(root: HTMLElement): void {
    const composer = root.createDiv({ cls: 'ai-run-pane__composer' })
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
   * The composer is usable only when the SELECTED run is finished, has a
   * session id to resume, AND its task has no other active run (the manager
   * would deterministically reject the follow-up otherwise); in every other
   * case it is disabled with a hint placeholder.
   */
  private updateComposerState(): void {
    const input = this.composerInput
    const send = this.composerSend
    if (!input || !send) return

    const record =
      this.selectedRunId !== null
        ? this.host.manager.getRun(this.selectedRunId)
        : undefined
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
