/**
 * AI Task - run pane controller (NOW PLAYING layout + split panels)
 *
 * Renders the collapsible "AI runs" pane below the task list, mirroring the
 * reference app's NOW PLAYING structure: a LEFT vertical sidebar with one
 * row per run (status dot + truncated task name + × control) and a RIGHT
 * content area made of one or more side-by-side PANELS. Each panel carries a
 * slim tab strip (one tab for the panel's selected run: status dot + content
 * label + × control, plus a + new-shell button) and its own bodies element;
 * the primary panel's corner actions additionally hold the ◫ split control
 * and the ⤢ expand toggle. Bodies are kept per run in a Map and only each
 * panel's selected body is visible, so state (scroll position, terminal
 * screen) survives selection switches.
 *
 * SPLIT (U2, mirrors the reference panel-reducer): the ◫ control splits the
 * content area by inserting a new panel after its own. The split is refused
 * with a Notice when the resulting panels would fall below
 * SPLIT_MIN_PANEL_WIDTH_PX (the reference's canSplitPanel), and the new
 * panel IMMEDIATELY spawns a NEW plain shell terminal session
 * (manager.startShellSession) which it displays and focuses. Exactly one
 * panel is FOCUSED at any time (subtle highlight; clicking a panel focuses
 * it): sidebar clicks show the clicked run in the FOCUSED panel — unless the
 * run is already on screen in another panel, in which case that panel is
 * focused instead of duplicating the view. The + button spawns a new shell
 * session in its own panel (focusing it first). Closing the selected run of
 * a secondary panel (tab ×, sidebar ×, or the stopped-run auto-close)
 * unsplits that panel; leftover hidden bodies migrate to the primary panel.
 * When the PRIMARY panel's last run closes while split, the next panel is
 * merged into the primary instead (the reference reducer removes any panel
 * whose last tab closes — a dead primary never stays on screen).
 *
 * × semantics (tab and sidebar row alike): on an ACTIVE run it requests a
 * stop AND closes the run's view in one action — the teardown waits for the
 * manager's 'persisted' notification (the end of the log persist chain), so
 * the exit-time terminal snapshot is always taken from a live adapter. On
 * an already-finished run it closes immediately. Runs that reach 'stopped'
 * keep auto-closing on 'persisted' even without a × click; stopped runs
 * never regain a view on a mount replay.
 *
 * The ⤢ toggle expands the pane to near the full view height (.is-expanded
 * on the pane, the --expanded chrome class on the host container). The PTY
 * grid of runs already started stays fixed — only the xterm viewport grows.
 * The expanded state persists per device through the host's
 * App#saveLocalStorage bridge and is restored on mount.
 *
 * Headless runs render their stream events as text lines and can send
 * resume-based follow-ups through the composer bar under the panels
 * (bound to the FOCUSED panel's selected run; enabled only when that run is
 * finished, has a session id, and its task has no other active run).
 *
 * Terminal runs host an embedded terminal instead: a TerminalViewAdapter is
 * created LAZILY the first time the run's body is shown (pane expanded),
 * opened with the record's fixed PTY grid, wired both ways
 * (manager.onTerminalData -> adapter.write, adapter.onData ->
 * manager.sendTerminalInput), and focused when its panel holds the focus.
 * Every panel keeps its own wiring, so keystrokes never cross sessions. The
 * composer is hidden for terminal runs — input goes straight into the
 * terminal. While any panel shows a terminal run and the pane is expanded,
 * the host container carries the ai-pane-container--terminal chrome class
 * so styles.css can give the pane a real height.
 *
 * On mount the pane also registers itself as the manager's terminal
 * snapshot provider: at run exit the manager reads the run's live xterm
 * buffer (adapter.snapshotText()) as the log-note transcript instead of the
 * ANSI-stripped PTY transcript file. Adapters are therefore never disposed
 * on the final status update — closing a view (auto or ×) happens on
 * 'persisted', selects the most recent remaining run of the panel, and
 * hides the pane again when no runs remain.
 *
 * All content is written through createEl/createDiv/createSpan with
 * textContent only (xterm renders inside its own subtree via the adapter).
 */

import { Notice } from 'obsidian'
import {
  AiRunAlreadyActiveError,
  AiSessionUnavailableError,
  AiShellUnavailableError,
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  type AiRunChangeType,
  type AiShellSessionOptions,
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
   * Spawn a plain login-shell terminal session (U2 split panels). Optional
   * so plain fakes keep working — without it the split and + controls
   * surface the shell-unavailable notice instead of spawning.
   */
  startShellSession?(options?: AiShellSessionOptions): AiRunRecord
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
  /**
   * Per-device persistence bridge for the expanded state
   * (App#saveLocalStorage / App#loadLocalStorage — device-local by design,
   * never synced with the vault). Optional so plain fakes keep working;
   * without it the expanded state simply resets on the next mount.
   */
  saveLocalStorage?: (key: string, value: unknown) => void
  loadLocalStorage?: (key: string) => unknown
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
  /** Sidebar row of the run (selection + × control) */
  row: HTMLElement
  body: HTMLElement
  /** Panel whose bodies element currently hosts the run's body */
  panelId: string
  isTerminal: boolean
  terminal: TerminalBinding | null
  renderedEventCount: number
  lastStatus: AiRunStatus
  lastOmittedCount: number
}

/** One side-by-side content panel (tab strip + bodies + selection) */
interface PanelView {
  id: string
  el: HTMLElement
  tabEl: HTMLElement
  bodiesEl: HTMLElement
  selectedRunId: string | null
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
/**
 * Pane chrome above one panel's terminal body when deriving its height:
 * the pane header (~26px incl. padding and border), the per-panel tab
 * strip (26px min-height + 1px border), the pane borders, plus slack —
 * mirrors styles.css. The composer is hidden for terminal runs, so it is
 * not part of this allowance.
 */
const TERMINAL_VERTICAL_INSET_PX = 64
/**
 * Fixed width of the run sidebar (styles.css .ai-run-pane__sidebar). The
 * sidebar lives INSIDE the measured host container but not inside the
 * panels area, so every panel-width computation must exclude it; this
 * constant is the fallback when the mounted sidebar cannot be measured
 * (hidden pane, jsdom) — the sidebar is always visible once a run is on
 * screen.
 */
export const RUN_SIDEBAR_WIDTH_PX = 180
/** Share of the view height the terminal pane occupies (mirrors styles.css) */
const TERMINAL_PANE_HEIGHT_RATIO = 0.4
/** Share of the view height while expanded (mirrors styles.css) */
const TERMINAL_PANE_EXPANDED_HEIGHT_RATIO = 0.9
const TERMINAL_MIN_COLS = 20
const TERMINAL_MAX_COLS = 400
const TERMINAL_MIN_ROWS = 5
const TERMINAL_MAX_ROWS = 200

/**
 * Minimum measured width each side-by-side panel must keep for a split to
 * be allowed (the reference app's canSplitPanel gate, in pixels instead of
 * its 10%-of-total). An unmeasurable width (hidden view, jsdom) does not
 * block the split — the fallback PTY size applies there anyway.
 */
export const SPLIT_MIN_PANEL_WIDTH_PX = 320

/** Chrome class on the host container while a terminal run is on screen */
const TERMINAL_CONTAINER_CLASS = 'ai-pane-container--terminal'
/** Chrome class on the host container while the pane is expanded */
const EXPANDED_CONTAINER_CLASS = 'ai-pane-container--expanded'

/**
 * Per-device persistence key of the pane's expanded state
 * (App#saveLocalStorage / App#loadLocalStorage via the host bridge).
 */
export const AI_PANE_EXPANDED_STORAGE_KEY = 'taskchute-plus.ai-pane-expanded'

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export class AiRunPaneController {
  private readonly runViews = new Map<string, RunView>()
  /**
   * Runs whose × was clicked while they were still active (or mid-persist):
   * their view closes on the manager's 'persisted' notification no matter
   * which terminal status the run ends with.
   */
  private readonly pendingCloseRunIds = new Set<string>()
  private containerEl: HTMLElement | null = null
  private root: HTMLElement | null = null
  private sidebarEl: HTMLElement | null = null
  private panelsEl: HTMLElement | null = null
  private panels: PanelView[] = []
  private focusedPanelId: string | null = null
  private panelSequence = 0
  private expandButton: HTMLElement | null = null
  private collapseButton: HTMLElement | null = null
  private composerEl: HTMLElement | null = null
  private composerInput: HTMLInputElement | null = null
  private composerSend: HTMLButtonElement | null = null
  private expanded = false
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

    // NOW PLAYING layout: sidebar (run list) on the left, the panels area
    // (each panel: tab strip + bodies) plus the composer on the right.
    const layout = root.createDiv({ cls: 'ai-run-pane__layout' })
    this.sidebarEl = layout.createDiv({
      cls: 'ai-run-pane__sidebar',
      attr: { role: 'tablist' },
    })
    const content = layout.createDiv({ cls: 'ai-run-pane__content' })
    this.panelsEl = content.createDiv({ cls: 'ai-run-pane__panels' })
    const primary = this.createPanel(null)
    this.focusPanel(primary)
    this.mountComposer(content)

    // Restore the per-device expanded preference (not a user toggle: nothing
    // is re-persisted).
    this.setExpanded(
      this.host.loadLocalStorage?.(AI_PANE_EXPANDED_STORAGE_KEY) === true,
      false,
    )

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
    // later viewing until unmount, so the exit-time capture always finds
    // them.
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
    this.containerEl?.classList.remove(EXPANDED_CONTAINER_CLASS)
    this.containerEl = null
    this.root?.remove()
    this.root = null
    this.sidebarEl = null
    this.panelsEl = null
    this.panels = []
    this.focusedPanelId = null
    this.panelSequence = 0
    this.expandButton = null
    this.collapseButton = null
    this.composerEl = null
    this.composerInput = null
    this.composerSend = null
    this.expanded = false
    this.runViews.clear()
    this.pendingCloseRunIds.clear()
  }

  /** Reveal the pane, expand it, focus the run's panel, and select the run */
  openRun(runId: string): void {
    if (!this.runViews.has(runId)) {
      const record = this.host.manager.getRun(runId)
      if (!record) return
      this.handleChange(record)
      // handleChange declines some records (e.g. stopped runs never regain
      // a view); without a view there is nothing to reveal or select.
      if (!this.runViews.has(runId)) return
    }
    this.revealPane()
    this.setCollapsed(false)
    const view = this.runViews.get(runId)
    if (!view) return
    const panel = this.getPanel(view.panelId) ?? this.getPrimaryPanel()
    if (!panel) return
    this.focusPanel(panel)
    this.selectRunInPanel(panel, runId)
  }

  setCollapsed(collapsed: boolean): void {
    if (!this.root) return
    this.root.classList.toggle('is-collapsed', collapsed)
    if (this.collapseButton) {
      this.collapseButton.textContent = collapsed ? '▸' : '▾'
      this.collapseButton.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
    }
    if (!collapsed) {
      // Terminal runs selected while collapsed deferred their adapters; the
      // bodies just became visible, so create (and focus) them now.
      this.ensureVisibleTerminalViews()
    }
    this.updateContainerChrome()
  }

  /**
   * Estimate the PTY grid that fits ONE panel of the pane at its terminal
   * height (the expanded or regular share of the view): the measured
   * content width — the container minus the run sidebar — is divided
   * across the side-by-side panels. Falls back to 120x30 when the pane has
   * no measurable pixel size (hidden view, jsdom).
   */
  computeTerminalSize(): { cols: number; rows: number } {
    const container = this.containerEl
    const panelCount = Math.max(1, this.panels.length)
    const width = this.measureContentWidth() / panelCount
    const parentHeight = container?.parentElement?.clientHeight ?? 0
    if (width <= 0 || parentHeight <= 0) {
      return { cols: TERMINAL_FALLBACK_COLS, rows: TERMINAL_FALLBACK_ROWS }
    }
    const heightRatio = this.expanded
      ? TERMINAL_PANE_EXPANDED_HEIGHT_RATIO
      : TERMINAL_PANE_HEIGHT_RATIO
    const bodyHeight = parentHeight * heightRatio - TERMINAL_VERTICAL_INSET_PX
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

  /**
   * Pixel width available to the side-by-side panels (the content right of
   * the run sidebar). Prefer the live panels element; when it is not
   * renderable (hidden pane, jsdom) fall back to the host container width
   * minus the sidebar — measured, or its styles.css width when the sidebar
   * itself cannot be measured. Returns 0 when nothing is measurable.
   */
  private measureContentWidth(): number {
    const panelsWidth = this.panelsEl?.clientWidth ?? 0
    if (panelsWidth > 0) return panelsWidth
    const totalWidth = this.containerEl?.clientWidth ?? 0
    if (totalWidth <= 0) return 0
    const measuredSidebar = this.sidebarEl?.clientWidth ?? 0
    const sidebarWidth = measuredSidebar > 0 ? measuredSidebar : RUN_SIDEBAR_WIDTH_PX
    return Math.max(0, totalWidth - sidebarWidth)
  }

  private isCollapsed(): boolean {
    return this.root?.classList.contains('is-collapsed') ?? false
  }

  private isHidden(): boolean {
    return this.root?.classList.contains('is-hidden') ?? true
  }

  private revealPane(): void {
    this.root?.classList.remove('is-hidden')
    this.updateContainerChrome()
  }

  /**
   * Toggle the near-full-height mode. `persist` is true only for user
   * toggles — the mount-time restore must not write the value back.
   */
  private setExpanded(expanded: boolean, persist: boolean): void {
    this.expanded = expanded
    this.root?.classList.toggle('is-expanded', expanded)
    this.refreshExpandButton()
    if (persist) {
      this.host.saveLocalStorage?.(AI_PANE_EXPANDED_STORAGE_KEY, expanded)
    }
    this.updateContainerChrome()
  }

  private refreshExpandButton(): void {
    const button = this.expandButton
    if (!button) return
    button.textContent = this.expanded ? '⤡' : '⤢'
    const label = this.expanded
      ? this.host.tv('aiTask.restorePane', 'Restore AI run pane size')
      : this.host.tv('aiTask.expandPane', 'Expand AI run pane')
    button.setAttribute('aria-label', label)
    button.setAttribute('title', label)
    button.setAttribute('aria-pressed', this.expanded ? 'true' : 'false')
  }

  // -------------------------------------------------------------------------
  // Panels
  // -------------------------------------------------------------------------

  private getPrimaryPanel(): PanelView | undefined {
    return this.panels[0]
  }

  private getPanel(panelId: string): PanelView | undefined {
    return this.panels.find((panel) => panel.id === panelId)
  }

  private getFocusedPanel(): PanelView | undefined {
    if (this.focusedPanelId !== null) {
      const focused = this.getPanel(this.focusedPanelId)
      if (focused) return focused
    }
    return this.getPrimaryPanel()
  }

  /**
   * Build one content panel (tab strip with the +/◫ controls and a bodies
   * element) and insert it after `afterPanel` (or append it). The primary
   * panel — the first one created — additionally owns the ⤢ expand toggle.
   */
  private createPanel(afterPanel: PanelView | null): PanelView {
    const panelsEl = this.panelsEl
    if (!panelsEl) throw new Error('AiRunPaneController is not mounted')
    const isPrimary = this.panels.length === 0

    const el = panelsEl.createDiv({ cls: 'ai-run-pane__panel' })
    if (afterPanel) {
      afterPanel.el.after(el)
    }

    const tabstrip = el.createDiv({ cls: 'ai-run-pane__tabstrip' })
    const tabEl = tabstrip.createDiv({ cls: 'ai-run-pane__tab is-hidden' })

    const panel: PanelView = {
      id: `panel-${(this.panelSequence += 1)}`,
      el,
      tabEl,
      bodiesEl: null as unknown as HTMLElement,
      selectedRunId: null,
    }

    // Clicking anywhere in the panel focuses it (the reference's SET_FOCUS);
    // inner controls that must not shift the focus stop propagation. The
    // keyboard focus follows the ring: without the ensureTerminalView call
    // the highlight would move while keystrokes kept flowing into the
    // previously focused panel's terminal.
    el.addEventListener('click', () => {
      this.focusPanel(panel)
      if (!this.isCollapsed()) {
        this.ensureTerminalView(panel)
      }
    })

    const addLabel = this.host.tv('aiTask.newShell', 'New terminal session')
    const addButton = tabstrip.createEl('button', {
      cls: 'ai-run-pane__add',
      text: '+',
      attr: { 'aria-label': addLabel, title: addLabel },
    })
    addButton.addEventListener('click', (event) => {
      event.stopPropagation()
      this.handleNewShell(panel)
    })

    const actions = tabstrip.createDiv({ cls: 'ai-run-pane__actions' })
    const splitLabel = this.host.tv('aiTask.splitPane', 'Split the run pane')
    const splitButton = actions.createEl('button', {
      cls: 'ai-run-pane__split',
      text: '◫',
      attr: { 'aria-label': splitLabel, title: splitLabel },
    })
    splitButton.addEventListener('click', (event) => {
      event.stopPropagation()
      this.handleSplit(panel)
    })
    if (isPrimary) {
      const expandButton = actions.createEl('button', {
        cls: 'ai-run-pane__expand',
      })
      expandButton.addEventListener('click', (event) => {
        event.stopPropagation()
        this.setExpanded(!this.expanded, true)
      })
      this.expandButton = expandButton
      this.refreshExpandButton()
    }

    panel.bodiesEl = el.createDiv({ cls: 'ai-run-pane__bodies' })

    const afterIndex = afterPanel ? this.panels.indexOf(afterPanel) : -1
    if (afterIndex >= 0) {
      this.panels.splice(afterIndex + 1, 0, panel)
    } else {
      this.panels.push(panel)
    }
    this.refreshPanelsSplitState()
    return panel
  }

  /**
   * Remove a SECONDARY panel (unsplit). Hidden bodies still hosted by the
   * panel migrate to the primary panel so their runs stay reachable from
   * the sidebar; the focus falls back to the primary panel.
   */
  private closePanel(panel: PanelView): void {
    const primary = this.getPrimaryPanel()
    if (!primary || panel === primary) return
    for (const view of this.runViews.values()) {
      if (view.panelId !== panel.id) continue
      view.panelId = primary.id
      view.body.classList.remove('is-active')
      primary.bodiesEl.appendChild(view.body)
    }
    this.panels = this.panels.filter((other) => other !== panel)
    panel.el.remove()
    if (this.focusedPanelId === panel.id) {
      this.focusPanel(primary)
    }
    this.refreshPanelsSplitState()
    this.syncPanelSelectionClasses()
  }

  private focusPanel(panel: PanelView): void {
    this.focusedPanelId = panel.id
    for (const other of this.panels) {
      other.el.classList.toggle('is-focused', other === panel)
    }
    this.updateComposerState()
  }

  /** Marker class for styles.css: highlight the focus only while split */
  private refreshPanelsSplitState(): void {
    this.panelsEl?.classList.toggle('is-split', this.panels.length > 1)
  }

  /**
   * The reference's canSplitPanel gate: every panel after the split must
   * keep the minimum width. Gated on the sidebar-excluded content width —
   * the run sidebar takes its fixed share of the container without
   * shrinking on a split. An unmeasurable width (hidden view, jsdom) never
   * blocks the split.
   */
  private canSplit(): boolean {
    const width = this.measureContentWidth()
    if (width <= 0) return true
    return width / (this.panels.length + 1) >= SPLIT_MIN_PANEL_WIDTH_PX
  }

  /**
   * ◫: split the content area after `sourcePanel` and IMMEDIATELY spawn a
   * new plain shell session into the new panel (user-confirmed reference
   * behavior: the split lands with a live terminal on screen). A failed
   * spawn rolls the split back.
   */
  private handleSplit(sourcePanel: PanelView): void {
    if (!this.canSplit()) {
      new Notice(
        this.host.tv(
          'aiTask.notices.splitTooNarrow',
          'The pane is too narrow to split.',
        ),
      )
      return
    }
    if (typeof this.host.manager.startShellSession !== 'function') {
      this.notifyShellError(new AiShellUnavailableError())
      return
    }

    const preexistingRunIds = new Set(this.runViews.keys())
    const newPanel = this.createPanel(sourcePanel)
    // Focus BEFORE spawning: the manager emits the new run synchronously and
    // createRunView assigns fresh runs to the focused panel.
    this.focusPanel(newPanel)
    let record: AiRunRecord
    try {
      record = this.startShellSession()
    } catch (error) {
      // The manager registers the run and emits 'starting' BEFORE the
      // dispatch, so a failed spawn may have already given the pane a view
      // (sidebar row + body + adapter) — close it, then roll the split
      // back. closeRun may itself unsplit the new panel (the failed run
      // was its selection), hence the containment check.
      this.closeRunViewsCreatedSince(preexistingRunIds)
      if (this.panels.includes(newPanel)) {
        this.closePanel(newPanel)
      }
      this.focusPanel(sourcePanel)
      this.notifyShellError(error)
      return
    }
    this.adoptRunIntoPanel(newPanel, record.id)
  }

  /** +: spawn a new shell session and show it in the button's own panel */
  private handleNewShell(panel: PanelView): void {
    this.focusPanel(panel)
    if (typeof this.host.manager.startShellSession !== 'function') {
      this.notifyShellError(new AiShellUnavailableError())
      return
    }
    const preexistingRunIds = new Set(this.runViews.keys())
    let record: AiRunRecord
    try {
      record = this.startShellSession()
    } catch (error) {
      // Same rollback as handleSplit: drop the view of the failed spawn so
      // no dead shell row lingers in the sidebar.
      this.closeRunViewsCreatedSince(preexistingRunIds)
      this.notifyShellError(error)
      return
    }
    this.adoptRunIntoPanel(panel, record.id)
  }

  /**
   * Close the views of runs announced after the given snapshot was taken —
   * the rollback path of a failed shell spawn (the manager emits 'starting'
   * for the run before its dispatch throws).
   */
  private closeRunViewsCreatedSince(preexistingRunIds: ReadonlySet<string>): void {
    for (const runId of Array.from(this.runViews.keys())) {
      if (!preexistingRunIds.has(runId)) {
        this.closeRun(runId)
      }
    }
  }

  /** Spawn a shell session sized like a terminal run of the current layout */
  private startShellSession(): AiRunRecord {
    const manager = this.host.manager
    if (typeof manager.startShellSession !== 'function') {
      throw new AiShellUnavailableError()
    }
    const size = this.computeTerminalSize()
    return manager.startShellSession({
      cols: size.cols,
      rows: size.rows,
      name: this.host.tv('aiTask.shellSessionName', 'Terminal'),
    })
  }

  /**
   * Make sure the (just spawned) run is displayed in the given panel. The
   * manager emits synchronously, so the view normally already sits in the
   * focused panel — this guards against managers that defer the emission.
   */
  private adoptRunIntoPanel(panel: PanelView, runId: string): void {
    const view = this.runViews.get(runId)
    if (!view) return
    if (view.panelId !== panel.id) {
      view.panelId = panel.id
      panel.bodiesEl.appendChild(view.body)
    }
    this.selectRunInPanel(panel, runId)
  }

  private notifyShellError(error: unknown): void {
    if (error instanceof AiShellUnavailableError) {
      new Notice(
        this.host.tv(
          'aiTask.notices.shellUnavailable',
          'Terminal sessions are not available on this platform.',
        ),
      )
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    new Notice(
      this.host.tv(
        'aiTask.notices.shellStartFailed',
        'Failed to start terminal session: {message}',
        { message },
      ),
    )
  }

  // -------------------------------------------------------------------------
  // Run views
  // -------------------------------------------------------------------------

  private handleChange(record: AiRunRecord, changeType?: AiRunChangeType): void {
    if (!this.root) return
    if (changeType === 'persisted') {
      // The run's log persist chain completed: the exit-time terminal
      // snapshot has been consumed, so the view (and adapter) is now safe
      // to tear down. Stopped runs always close here; other terminal
      // statuses close only when their × was clicked while still active.
      if (record.status === 'stopped' || this.pendingCloseRunIds.has(record.id)) {
        this.closeRun(record.id)
      }
      return
    }
    const existing = this.runViews.get(record.id)
    if (!existing) {
      // Stopped runs never (re)gain a view: their view auto-closed at
      // persist time, and a mount replay of the manager's records must not
      // resurrect it.
      if (record.status === 'stopped') return
      this.createRunView(record)
      this.updateComposerState()
      return
    }
    if (existing.lastStatus !== record.status) {
      existing.lastStatus = record.status
      this.refreshRunRow(existing, record)
      this.refreshTabsShowingRun(record.id)
    }
    if (!existing.isTerminal) {
      this.syncEvents(existing, record)
    }
    this.updateComposerState()
  }

  /**
   * × entry point shared by the sidebar row and the content tab: an ACTIVE
   * run is stopped first and its view closes when 'persisted' arrives (the
   * exit-time snapshot must be read from a live adapter); a run already in
   * the stopped mid-persist window just waits for that same notification;
   * finished runs close immediately.
   */
  private requestCloseRun(runId: string): void {
    const view = this.runViews.get(runId)
    if (!view) return
    const status = this.host.manager.getRun(runId)?.status ?? view.lastStatus
    if (ACTIVE_STATUSES.has(status)) {
      this.pendingCloseRunIds.add(runId)
      this.host.manager.stopRun(runId)
      return
    }
    if (status === 'stopped') {
      this.pendingCloseRunIds.add(runId)
      return
    }
    this.closeRun(runId)
  }

  /**
   * Close one run's view: dispose its terminal wiring, remove the sidebar
   * row and body, and repair the panel that displayed it — the primary
   * panel moves its selection to the most recent remaining run it hosts,
   * while a secondary panel unsplits. The pane hides again (the
   * pre-first-run state) when no runs remain. Used by the 'persisted'
   * teardown and the × of finished runs.
   */
  private closeRun(runId: string): void {
    const view = this.runViews.get(runId)
    if (!view) return
    this.disposeTerminalBinding(view)
    view.row.remove()
    view.body.remove()
    this.runViews.delete(runId)
    this.pendingCloseRunIds.delete(runId)

    const panel = this.getPanel(view.panelId)
    if (panel && panel.selectedRunId === runId) {
      panel.selectedRunId = null
      if (panel === this.getPrimaryPanel()) {
        let mostRecent: string | undefined
        for (const [id, other] of this.runViews) {
          if (other.panelId === panel.id) mostRecent = id
        }
        if (mostRecent !== undefined) {
          this.selectRunInPanel(panel, mostRecent)
          return
        }
        // The primary emptied. While split, merge the next panel into the
        // primary (the reference reducer removes any panel whose last tab
        // closes) instead of keeping a dead primary panel on screen.
        const nextPanel = this.panels[1]
        if (nextPanel !== undefined) {
          const nextSelected = nextPanel.selectedRunId
          this.closePanel(nextPanel)
          if (nextSelected !== null) {
            this.selectRunInPanel(panel, nextSelected)
            return
          }
        }
        this.refreshContentTab(panel)
      } else {
        this.closePanel(panel)
      }
    }
    if (this.runViews.size === 0) {
      while (this.panels.length > 1) {
        this.closePanel(this.panels[this.panels.length - 1])
      }
      this.root?.classList.add('is-hidden')
      const primary = this.getPrimaryPanel()
      if (primary) this.refreshContentTab(primary)
    }
    this.syncPanelSelectionClasses()
    this.updateContainerChrome()
    this.updateComposerState()
  }

  private createRunView(record: AiRunRecord): void {
    const sidebarEl = this.sidebarEl
    const target = this.getFocusedPanel()
    if (!sidebarEl || !target) return

    const isShell = record.host === 'shell'
    const row = sidebarEl.createDiv({
      cls: isShell ? 'ai-run-pane__run ai-run-pane__run--shell' : 'ai-run-pane__run',
      attr: {
        role: 'tab',
        tabindex: '0',
        'data-run-id': record.id,
      },
    })
    row.addEventListener('click', () => {
      this.showRunInFocusedPanel(record.id)
    })
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      this.showRunInFocusedPanel(record.id)
    })

    const isTerminal = record.mode === 'terminal'
    const body = target.bodiesEl.createDiv({
      cls: isTerminal
        ? 'ai-run-pane__body ai-run-pane__body--terminal'
        : 'ai-run-pane__body',
      attr: { 'data-run-id': record.id },
    })

    const view: RunView = {
      row,
      body,
      panelId: target.id,
      isTerminal,
      terminal: null,
      renderedEventCount: 0,
      lastStatus: record.status,
      lastOmittedCount: record.omittedEventCount ?? 0,
    }
    this.runViews.set(record.id, view)
    this.refreshRunRow(view, record)
    if (!isTerminal) {
      this.renderAllEvents(view, record)
    }

    this.revealPane()
    if (target.selectedRunId === null) {
      this.selectRunInPanel(target, record.id)
    }
  }

  /** Rebuild one sidebar row (status dot, truncated name, × control) */
  private refreshRunRow(view: RunView, record: AiRunRecord): void {
    view.row.empty()

    const statusLabel = this.host.tv(
      `aiTask.status.${record.status}`,
      STATUS_FALLBACK_LABELS[record.status],
    )
    view.row.createSpan({
      cls: `ai-run-pane__run-dot ai-run-pane__run-dot--${record.status}`,
      attr: { title: statusLabel },
    })
    const name =
      record.taskName.trim().length > 0
        ? record.taskName
        : this.host.tv('aiTask.tabUntitled', 'Untitled run')
    view.row.createSpan({
      cls: 'ai-run-pane__run-name',
      text: name,
      attr: { title: name },
    })
    this.appendCloseControl(view.row, record, 'ai-run-pane__run-close')
  }

  /**
   * Rebuild one panel's tab strip tab from the panel's SELECTED run (status
   * dot, content-type label, × control). Hidden while the panel shows
   * nothing (pre-first-run and post-last-close states).
   */
  private refreshContentTab(panel: PanelView): void {
    const tab = panel.tabEl
    tab.empty()
    const record =
      panel.selectedRunId !== null
        ? this.host.manager.getRun(panel.selectedRunId)
        : undefined
    if (!record) {
      tab.classList.add('is-hidden')
      tab.classList.remove('is-active')
      tab.removeAttribute('data-run-id')
      return
    }
    tab.classList.remove('is-hidden')
    tab.classList.add('is-active')
    tab.setAttribute('data-run-id', record.id)

    const statusLabel = this.host.tv(
      `aiTask.status.${record.status}`,
      STATUS_FALLBACK_LABELS[record.status],
    )
    tab.createSpan({
      cls: `ai-run-pane__tab-dot ai-run-pane__tab-dot--${record.status}`,
      attr: { title: statusLabel },
    })
    tab.createSpan({
      cls: 'ai-run-pane__tab-label',
      text:
        record.mode === 'terminal'
          ? this.host.tv('aiTask.contentTab.terminal', 'Terminal')
          : this.host.tv('aiTask.contentTab.events', 'Events'),
    })
    this.appendCloseControl(tab, record, 'ai-run-pane__tab-close')
  }

  /** Refresh the tab of every panel currently displaying the run */
  private refreshTabsShowingRun(runId: string): void {
    for (const panel of this.panels) {
      if (panel.selectedRunId === runId) {
        this.refreshContentTab(panel)
      }
    }
  }

  /**
   * Append the × control for one run: stop-and-close while the run is
   * active, plain close once finished. Runs in the stopped mid-persist
   * window get NO control — their view auto-closes on 'persisted', and a
   * manual close in that window could dispose the adapter before the
   * manager captured the transcript snapshot.
   */
  private appendCloseControl(
    parent: HTMLElement,
    record: AiRunRecord,
    cls: string,
  ): void {
    const isActive = ACTIVE_STATUSES.has(record.status)
    if (!isActive && record.status !== 'succeeded' && record.status !== 'failed') {
      return
    }
    const label = isActive
      ? this.host.tv('aiTask.stopAndClose', 'Stop and close run')
      : this.host.tv('aiTask.closeTab', 'Close run tab')
    const button = parent.createEl('button', {
      cls,
      text: '×',
      attr: { 'aria-label': label, title: label },
    })
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      this.requestCloseRun(record.id)
    })
  }

  /**
   * Sidebar entry point: show the run in the FOCUSED panel. When the run is
   * already on screen in another panel, that panel is focused instead — a
   * run's body (and its one-shot xterm view) exists exactly once.
   */
  private showRunInFocusedPanel(runId: string): void {
    const view = this.runViews.get(runId)
    const focused = this.getFocusedPanel()
    if (!view || !focused) return
    if (view.panelId !== focused.id) {
      const hostPanel = this.getPanel(view.panelId)
      if (hostPanel && hostPanel.selectedRunId === runId) {
        this.focusPanel(hostPanel)
        if (!this.isCollapsed()) {
          this.ensureTerminalView(hostPanel)
        }
        return
      }
      // Adopt the hidden body into the focused panel.
      view.panelId = focused.id
      focused.bodiesEl.appendChild(view.body)
    }
    this.selectRunInPanel(focused, runId)
  }

  private selectRunInPanel(panel: PanelView, runId: string): void {
    panel.selectedRunId = runId
    this.syncPanelSelectionClasses()
    this.refreshContentTab(panel)
    if (!this.isCollapsed()) {
      this.ensureTerminalView(panel)
    }
    this.updateContainerChrome()
    this.updateComposerState()
  }

  /** Row/body active classes follow each panel's selected run */
  private syncPanelSelectionClasses(): void {
    for (const [id, view] of this.runViews) {
      const isSelected = this.getPanel(view.panelId)?.selectedRunId === id
      view.row.classList.toggle('is-active', isSelected)
      view.row.setAttribute('aria-selected', isSelected ? 'true' : 'false')
      view.body.classList.toggle('is-active', isSelected)
    }
  }

  // -------------------------------------------------------------------------
  // Terminal bodies
  // -------------------------------------------------------------------------

  /**
   * Lazily create (or just re-focus) the embedded terminal of one panel's
   * SELECTED run. The adapter is opened with the record's fixed PTY grid so
   * the xterm view matches the child process exactly, wired both ways, and
   * focused (focused panel only) so the user can type immediately. No-op
   * for headless runs and while the body is not visible (collapsed pane).
   */
  private ensureTerminalView(panel: PanelView): void {
    const runId = panel.selectedRunId
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
    if (this.focusedPanelId === panel.id) {
      view.terminal.adapter.focus()
    }
  }

  /** Create/focus the selected terminal view of every panel (uncollapse) */
  private ensureVisibleTerminalViews(): void {
    for (const panel of this.panels) {
      this.ensureTerminalView(panel)
    }
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
   * Sync the host container's chrome classes: the terminal class (fixed
   * pane height in styles.css) exactly while some panel displays a terminal
   * run on screen, the expanded class exactly while the expanded pane is on
   * screen.
   */
  private updateContainerChrome(): void {
    const container = this.containerEl
    if (!container) return
    const visible = !this.isCollapsed() && !this.isHidden()
    const anyTerminalOnScreen = this.panels.some(
      (panel) =>
        panel.selectedRunId !== null &&
        this.runViews.get(panel.selectedRunId)?.isTerminal === true,
    )
    container.classList.toggle(
      TERMINAL_CONTAINER_CLASS,
      anyTerminalOnScreen && visible,
    )
    container.classList.toggle(EXPANDED_CONTAINER_CLASS, this.expanded && visible)
  }

  // -------------------------------------------------------------------------
  // Follow-up composer
  // -------------------------------------------------------------------------

  private mountComposer(parent: HTMLElement): void {
    const composer = parent.createDiv({ cls: 'ai-run-pane__composer' })
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

  /** The run the composer is bound to: the FOCUSED panel's selected run */
  private getComposerRun(): AiRunRecord | undefined {
    const focused = this.getFocusedPanel()
    if (!focused || focused.selectedRunId === null) return undefined
    return this.host.manager.getRun(focused.selectedRunId)
  }

  /**
   * The composer only applies to headless runs (terminal runs take input in
   * the terminal itself, so the bar is hidden outright for them). It is
   * usable only when the FOCUSED panel's run is finished, has a session id
   * to resume, AND its task has no other active run (the manager would
   * deterministically reject the follow-up otherwise); in every other case
   * it is disabled with a hint placeholder.
   */
  private updateComposerState(): void {
    const input = this.composerInput
    const send = this.composerSend
    if (!input || !send) return

    const record = this.getComposerRun()

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
    const runId = this.getFocusedPanel()?.selectedRunId ?? null
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
