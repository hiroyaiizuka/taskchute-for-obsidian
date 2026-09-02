/**
 * AI Task - run pane controller (NOW PLAYING layout + split panels)
 *
 * Renders the collapsible "AI runs" pane below the task list, mirroring the
 * reference app's NOW PLAYING structure: a LEFT vertical sidebar with one
 * row per run (status dot + truncated task name + × control) and a RIGHT
 * content area made of one or more side-by-side PANELS. Each panel carries a
 * slim internal tab strip (one replaceable top-level AI-task slot plus any
 * explicit + shell tabs) and its own bodies element;
 * each panel's corner actions hold its local ◫ split control, while the
 * global ⤢ expand toggle lives in the AI Runs header. Bodies are kept per run
 * in a Map and only each
 * panel's selected body is visible, so state (scroll position, terminal
 * screen) survives selection switches. Starting concurrent AI tasks only
 * adds Vertical Tabs; it never multiplies horizontal tabs by itself.
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
 * The expand toggle fills the available view height (.is-expanded on the
 * pane, the --expanded chrome class on the host container). xterm follows
 * body resize events, while the dispatcher can synchronize the real PTY on
 * gateways that expose resizing.
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
 * opened with the record's initial PTY grid, fitted to its body, wired both ways
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
 * Terminal bindings are additionally RECLAIMED while off screen: once a
 * finished run's exit persist has completed, its hidden binding (adapter +
 * subscriptions) is disposed. Bindings of still-ACTIVE runs are NEVER
 * reclaimed, hidden or not: the manager's exit-time snapshot reads the live
 * adapter, and the ANSI-stripped transcript fallback is mostly TUI redraw
 * fragments — disposing an active binding would degrade that run's log note.
 * Reselecting a reclaimed run re-creates the binding lazily through
 * ensureTerminalView, whose subscribe-time replay of the manager's bounded
 * output buffer restores the screen (the same mechanism as a renderer
 * reload). Bindings presented by a visible panel, or whose exit persist is
 * still pending (the exit-time snapshot must read a live adapter), are
 * never reclaimed.
 *
 * Headless stream events render incrementally: bursts of synchronous
 * manager notifications coalesce into one animation frame, and once the
 * manager's bounded buffer overflows (fixed head + elision marker +
 * rotating tail) only the marker text, the pruned oldest tail nodes, and
 * the appended tail nodes change — never a full rebuild per event.
 *
 * All content is written through createEl/createDiv/createSpan with
 * textContent only (xterm renders inside its own subtree via the adapter).
 */

import { Notice, setIcon } from 'obsidian'
import {
  AiRunAlreadyActiveError,
  AiSessionUnavailableError,
  AiShellUnavailableError,
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  type AiRunChangeType,
  type AiShellSessionOptions,
} from '../services/AiTaskManager'
import { formatAiResultSummary } from '../services/AiResultSummary'
import { AiBinaryNotFoundError } from '../services/BinaryLocator'
import {
  formatWorkspacePathForTerminal,
  WORKSPACE_PATH_DRAG_MIME,
} from '../services/TerminalPathFormatter'
import type {
  WorkspaceDirectoryListing,
  WorkspaceFileDocument,
  WorkspaceFileVersion,
} from '../services/WorkspaceFileService'
import type { AiRunRecord, AiRunStatus, AiStreamEvent } from '../types'
import type {
  TerminalViewAdapterFactory,
  TerminalViewAdapterLike,
} from './TerminalViewAdapter'
import type { FileEditorAdapterFactory } from './FileEditorAdapter'
import { AI_PANE_MAX_HEIGHT_RATIO, AiPaneResizer } from './AiPaneResizer'
import { WorkspaceFileEditorController } from './WorkspaceFileEditorController'
import { WorkspaceFileTreeController } from './WorkspaceFileTreeController'

export interface AiRunPaneManagerLike {
  getRuns(): AiRunRecord[]
  getRun(runId: string): AiRunRecord | undefined
  /** Exact persist state for final-status terminal binding reclamation. */
  isRunExitPersisted?(runId: string): boolean
  getActiveRunForTask(taskPath: string): AiRunRecord | undefined
  stopRun(runId: string): void
  followUp(runId: string, prompt: string): Promise<unknown>
  onChange(
    listener: (record: AiRunRecord, changeType?: AiRunChangeType) => void,
  ): () => void
  onTerminalData(runId: string, listener: (chunk: string) => void): () => void
  sendTerminalInput(runId: string, data: string): void
  resizeTerminal?(runId: string, cols: number, rows: number): void
  listWorkspaceDirectory?(
    rootPath: string,
    directoryPath?: string,
  ): Promise<WorkspaceDirectoryListing>
  readWorkspaceFile?(
    rootPath: string,
    filePath: string,
  ): Promise<WorkspaceFileDocument>
  writeWorkspaceFile?(
    rootPath: string,
    filePath: string,
    content: string,
    expectedVersion: WorkspaceFileVersion,
  ): Promise<WorkspaceFileDocument>
  /**
   * Drop a FINISHED run's record from the manager when its view closes for
   * good (× on a finished run, the stopped-run auto-close, a rolled-back
   * shell spawn), so a later pane remount does not resurrect the run.
   * Optional so plain fakes keep working — without it closed runs simply
   * reappear on remount.
   */
  releaseRun?(runId: string): void
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
    provider: (
      runId: string,
    ) => string | undefined | Promise<string | undefined>,
  ): () => void
}

export interface AiRunPaneControllerHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  manager: AiRunPaneManagerLike
  /** Adapter factory; tests substitute a fake so jsdom never loads xterm */
  createTerminalAdapter: TerminalViewAdapterFactory
  /** Optional editor factory for focused pane tests; production uses CM6. */
  createFileEditorAdapter?: FileEditorAdapterFactory
  /**
   * Register a view-lifetime fallback cleanup. Production hosts return an
   * unregister function so an explicitly unmounted pane does not stay
   * retained by the view until the whole leaf closes.
   */
  registerManagedDisposer: (cleanup: () => void) => void | (() => void)
  /**
   * Keep TaskChute's timer state in sync when the user stops a top-level AI
   * run through this pane's × control. Shell tabs and finished-run closes do
   * not call this hook. The manager stop still runs independently so a task
   * persistence failure can never leave the PTY alive.
   */
  onStopAndCloseTaskRun?: (record: AiRunRecord) => void
  /** Reconcile a TaskChute timer when a late broker attach becomes unavailable. */
  onInterruptedTaskRun?: (record: AiRunRecord) => void
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
  /** Unsubscribes fitted xterm grid -> real PTY resizing. */
  disposeResize: () => void
  /** Unsubscribes Cmd/Ctrl-clicked file paths from this run's cwd. */
  disposeFilePath: () => void
}

interface RunView {
  /** Top-level AI runs have a Vertical Tab; panel-local shell runs do not. */
  row: HTMLElement | null
  body: HTMLElement
  /** Panel whose bodies element currently hosts the run's body */
  panelId: string
  isTerminal: boolean
  terminal: TerminalBinding | null
  renderedEventCount: number
  lastStatus: AiRunStatus
  lastOmittedCount: number
  /** Rendered elision marker element (post-overflow in-place updates) */
  elisionEl: HTMLElement | null
  /** Index of the marker among the rendered event nodes (-1 pre-overflow) */
  elisionIndex: number
  /**
   * The run's exit persist chain has completed ('persisted' observed, or
   * the view was created for an already-finished record whose persist ended
   * in a previous pane lifetime). Gate for reclaiming the hidden binding —
   * the manager's exit-time snapshot must never read a disposed adapter.
   */
  exitPersisted: boolean
}

/** One side-by-side content panel (tab strip + bodies + selection) */
interface PanelView {
  id: string
  el: HTMLElement
  tabsEl: HTMLElement
  bodiesEl: HTMLElement
  /**
   * Logical top-level AI run whose card state this panel is currently
   * showing. Explicit + terminals belong to this scope through
   * AiRunRecord.parentRunId, so switching the Vertical Tab swaps the entire
   * task-local tab set instead of leaking another task's terminals.
   *
   * This is deliberately separate from taskRunId: a split panel can show
   * task-owned shell tabs without hosting the task run's body itself.
   */
  taskScopeRunId: string | null
  /**
   * The single top-level AI run represented by this panel's task slot.
   * Other top-level runs stay reachable from the vertical sidebar without
   * automatically multiplying horizontal tabs. Explicit + shell sessions
   * remain independent tabs alongside this slot.
   */
  taskRunId: string | null
  selectedRunId: string | null
}

/**
 * UI state owned by one top-level AI task while the shared primary panel is
 * temporarily presenting another task. Secondary panels retain their own
 * selectedRunId directly; only the shared primary selection and the focused
 * panel need an explicit per-task snapshot.
 */
interface TaskWorkspaceState {
  primarySelectedRunId: string | null
  focusedPanelId: string | null
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
  interrupted: 'Interrupted',
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
/**
 * Default share of the view height the terminal pane occupies (mirrors
 * styles.css). A drag-resized pane reports its own share instead.
 */
const TERMINAL_PANE_HEIGHT_RATIO = 0.4
/** Share of the view height while expanded (mirrors styles.css) */
const TERMINAL_PANE_EXPANDED_HEIGHT_RATIO = 1
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
/** Layout participation class while the pane (or a future artifact) is visible. */
const VISIBLE_CONTAINER_CLASS = 'ai-pane-container--visible'
/** Chrome class while the user dragged the splitter to an explicit height */
const SIZED_CONTAINER_CLASS = 'ai-pane-container--sized'
/** Chrome class while the pane is collapsed to its header row */
const COLLAPSED_CONTAINER_CLASS = 'ai-pane-container--collapsed'
/** Custom property carrying the drag-resized height (mirrors styles.css) */
const PANE_HEIGHT_PROPERTY = '--tc-ai-pane-height'

/**
 * Per-device persistence key of the pane's expanded state
 * (App#saveLocalStorage / App#loadLocalStorage via the host bridge).
 */
export const AI_PANE_EXPANDED_STORAGE_KEY = 'taskchute-plus.ai-pane-expanded'
/** Device-local preference for the independent left sidebar rail. */
export const AI_PANE_SIDEBAR_COLLAPSED_STORAGE_KEY =
  'taskchute-plus.ai-pane-sidebar-collapsed'
/**
 * Device-local drag-resized pane height, stored as a share of the view
 * height so it survives leaf splits and window resizes.
 */
export const AI_PANE_HEIGHT_RATIO_STORAGE_KEY =
  'taskchute-plus.ai-pane-height-ratio'

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
  private sidebarRunsEl: HTMLElement | null = null
  private sidebarFilesEl: HTMLElement | null = null
  private sidebarToggleButton: HTMLButtonElement | null = null
  private sidebarFilesButton: HTMLButtonElement | null = null
  private workspaceFileTree: WorkspaceFileTreeController | null = null
  private workspaceFileEditor: WorkspaceFileEditorController | null = null
  private fileEditorContainer: HTMLElement | null = null
  /** Expanded state to restore after the last file tab closes. */
  private expandedBeforeFilePanel: boolean | null = null
  /** Exact validated Files-tree path authorized for the current drag only. */
  private activeWorkspaceDragPath: string | null = null
  private panelsEl: HTMLElement | null = null
  private panels: PanelView[] = []
  private readonly taskWorkspaceStates = new Map<string, TaskWorkspaceState>()
  /**
   * Vertical Tab currently presented in the work area. The primary panel is
   * shared as the task's main-terminal slot; secondary split panels retain a
   * stable taskScopeRunId and are hidden while another task is selected.
   */
  private activeTaskScopeRunId: string | null = null
  private focusedPanelId: string | null = null
  private panelSequence = 0
  private expandButton: HTMLElement | null = null
  private collapseButton: HTMLElement | null = null
  private composerEl: HTMLElement | null = null
  private composerInput: HTMLInputElement | null = null
  private composerSend: HTMLButtonElement | null = null
  private expanded = false
  private sidebarCollapsed = false
  private paneResizer: AiPaneResizer | null = null
  /** Drag-resized height share; null while the stylesheet default applies. */
  private paneHeightRatio: number | null = null
  private sidebarMode: 'runs' | 'files' = 'runs'
  private unsubscribe: (() => void) | null = null
  private unregisterSnapshotProvider: (() => void) | null = null
  private readonly unregisterManagedDisposers: Array<() => void> = []
  /** Headless runs with events to render on the next coalescing frame */
  private readonly pendingEventSyncRunIds = new Set<string>()
  private eventSyncFrame: number | null = null
  /** Window that owns eventSyncFrame; cancellation must use the same owner. */
  private eventSyncFrameOwner: Window | null = null

  constructor(private readonly host: AiRunPaneControllerHost) {}

  mount(container: HTMLElement): void {
    if (this.root) return
    this.containerEl = container

    this.paneResizer = new AiPaneResizer({
      container,
      label: this.host.tv('aiTask.resizePane', 'Resize AI run pane'),
      // Same measurement source computeTerminalSize uses, so the PTY grid
      // and the CSS share always describe the same box.
      getViewHeight: () => container.parentElement?.clientHeight ?? 0,
      getPaneHeight: () => container.getBoundingClientRect().height,
      onResize: (ratio) => {
        // Dragging out of ⤢ hands control back to the splitter; the toggle
        // then flips between this height and full height.
        if (this.expanded) this.setExpanded(false, true)
        this.applyPaneHeightRatio(ratio, false)
      },
      onCommit: (ratio) => {
        if (this.expanded) this.setExpanded(false, true)
        this.applyPaneHeightRatio(ratio, true)
      },
      onReset: () => this.applyPaneHeightRatio(null, true),
    })

    const root = container.createDiv({ cls: 'ai-run-pane is-hidden' })
    this.root = root

    const header = root.createDiv({ cls: 'ai-run-pane__header' })
    const toggleLabel = this.host.tv('aiTask.togglePane', 'Toggle AI run pane')
    const collapseButton = header.createEl('button', {
      cls: 'ai-run-pane__collapse',
      attr: {
        'aria-label': toggleLabel,
        title: toggleLabel,
        'aria-expanded': 'true',
      },
    })
    setIcon(collapseButton, 'chevron-down')
    collapseButton.addEventListener('click', (event) => {
      event.stopPropagation()
      this.setCollapsed(!this.isCollapsed())
    })
    this.collapseButton = collapseButton

    header.createSpan({
      cls: 'ai-run-pane__title',
      text: this.host.tv('aiTask.paneTitle', 'AI runs'),
    })
    const headerActions = header.createDiv({
      cls: 'ai-run-pane__header-actions',
    })
    const expandButton = headerActions.createEl('button', {
      cls: 'ai-run-pane__expand',
      attr: { type: 'button' },
    })
    expandButton.addEventListener('click', (event) => {
      event.stopPropagation()
      if (this.isCollapsed()) {
        const wasExpanded = this.expanded
        this.setCollapsed(false)
        if (wasExpanded) return
      }
      this.setExpanded(!this.expanded, true)
    })
    this.expandButton = expandButton
    this.refreshExpandButton()

    // NOW PLAYING layout: sidebar (run list) on the left, the panels area
    // (each panel: tab strip + bodies) plus the composer on the right.
    const layout = root.createDiv({ cls: 'ai-run-pane__layout' })
    this.sidebarEl = layout.createDiv({ cls: 'ai-run-pane__sidebar' })
    const sidebarToolbar = this.sidebarEl.createDiv({
      cls: 'ai-run-pane__sidebar-toolbar',
    })
    const sidebarToggleLabel = this.host.tv(
      'aiTask.toggleSidebar',
      'Toggle terminal sidebar',
    )
    this.sidebarToggleButton = sidebarToolbar.createEl('button', {
      cls: 'ai-run-pane__sidebar-toggle',
      attr: {
        'aria-label': sidebarToggleLabel,
        title: sidebarToggleLabel,
        'aria-expanded': 'true',
      },
    })
    setIcon(this.sidebarToggleButton, 'panel-left')
    this.sidebarToggleButton.addEventListener('click', (event) => {
      event.stopPropagation()
      this.setSidebarCollapsed(!this.sidebarCollapsed, true)
    })
    const filesLabel = this.host.tv('aiTask.files.label', 'Files')
    this.sidebarFilesButton = sidebarToolbar.createEl('button', {
      cls: 'ai-run-pane__sidebar-files',
      attr: {
        'aria-label': filesLabel,
        title: filesLabel,
        'aria-pressed': 'false',
      },
    })
    setIcon(this.sidebarFilesButton, 'folder-closed')
    this.sidebarFilesButton.addEventListener('click', (event) => {
      event.stopPropagation()
      this.setSidebarMode(this.sidebarMode === 'runs' ? 'files' : 'runs')
    })
    this.sidebarRunsEl = this.sidebarEl.createDiv({
      cls: 'ai-run-pane__sidebar-runs',
      attr: {
        role: 'tablist',
        'aria-orientation': 'vertical',
        'aria-label': this.host.tv('aiTask.runTabs', 'AI run tabs'),
      },
    })
    this.sidebarFilesEl = this.sidebarEl.createDiv({
      cls: 'ai-run-pane__sidebar-files-view is-hidden',
    })
    this.workspaceFileTree = new WorkspaceFileTreeController(
      this.sidebarFilesEl,
      {
        listDirectory: async (rootPath, directoryPath) => {
          if (typeof this.host.manager.listWorkspaceDirectory !== 'function') {
            throw new Error('Workspace files are not available')
          }
          return await this.host.manager.listWorkspaceDirectory(
            rootPath,
            directoryPath,
          )
        },
        loadingLabel: this.host.tv('aiTask.files.loading', 'Loading files…'),
        emptyLabel: this.host.tv('aiTask.files.empty', 'This folder is empty.'),
        unavailableLabel: this.host.tv(
          'aiTask.files.unavailable',
          'Files are unavailable.',
        ),
        onPathDragStart: (path) => {
          this.activeWorkspaceDragPath = path
        },
        onPathDragEnd: () => {
          this.activeWorkspaceDragPath = null
        },
        onFileActivate: (rootPath, entry) => {
          void this.openWorkspaceFile(rootPath, entry.absolutePath, entry.name)
        },
      },
    )
    const content = layout.createDiv({ cls: 'ai-run-pane__content' })
    const workarea = content.createDiv({ cls: 'ai-run-pane__workarea' })
    this.panelsEl = workarea.createDiv({ cls: 'ai-run-pane__panels' })
    this.fileEditorContainer = workarea.createDiv({
      cls: 'ai-run-pane__file-panel-container is-hidden',
    })
    const primary = this.createPanel(null)
    this.focusPanel(primary)
    this.mountComposer(content)

    // Restore the per-device expanded preference (not a user toggle: nothing
    // is re-persisted).
    this.setExpanded(
      this.host.loadLocalStorage?.(AI_PANE_EXPANDED_STORAGE_KEY) === true,
      false,
    )
    this.setSidebarCollapsed(
      this.host.loadLocalStorage?.(AI_PANE_SIDEBAR_COLLAPSED_STORAGE_KEY) === true,
      false,
    )
    const storedHeightRatio = this.host.loadLocalStorage?.(
      AI_PANE_HEIGHT_RATIO_STORAGE_KEY,
    )
    if (typeof storedHeightRatio === 'number' && Number.isFinite(storedHeightRatio)) {
      this.applyPaneHeightRatio(storedHeightRatio, false)
    }

    this.unsubscribe = this.host.manager.onChange((record, changeType) => {
      this.handleChange(record, changeType)
    })
    const unregisterManagedSubscription = this.host.registerManagedDisposer(() => {
      this.unsubscribe?.()
      this.unsubscribe = null
    })
    if (typeof unregisterManagedSubscription === 'function') {
      this.unregisterManagedDisposers.push(unregisterManagedSubscription)
    }

    // The manager snapshots a terminal run's live xterm buffer at run exit
    // as the log-note transcript source (the raw PTY transcript file strips
    // to TUI redraw garbage). Adapters are never disposed before the run's
    // exit persist completed (reclaiming happens only afterwards, and only
    // off screen), so the exit-time capture always finds them.
    this.unregisterSnapshotProvider =
      this.host.manager.registerTerminalSnapshotProvider?.((runId) => {
        const adapter = this.runViews.get(runId)?.terminal?.adapter
        if (!adapter) return undefined
        return adapter.snapshotTextAfterWrites?.() ?? adapter.snapshotText()
      }) ?? null
    const unregisterManagedSnapshot = this.host.registerManagedDisposer(() => {
      this.unregisterSnapshotProvider?.()
      this.unregisterSnapshotProvider = null
    })
    if (typeof unregisterManagedSnapshot === 'function') {
      this.unregisterManagedDisposers.push(unregisterManagedSnapshot)
    }

    for (const record of this.host.manager.getRuns()) {
      if (record.status === 'stopped') {
        // Stopped runs never regain a view (theirs auto-closed on
        // 'persisted'), and that notification is also the only releaseRun
        // trigger — when it fired with no pane mounted, the record was left
        // behind. Sweep it here so it does not sit in the manager (with its
        // buffers) until plugin unload. The manager refuses to release runs
        // that have not actually exited, so this is safe mid-persist too.
        this.host.manager.releaseRun?.(record.id)
        continue
      }
      this.handleChange(record)
    }
  }

  unmount(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.eventSyncFrame !== null) {
      ;(this.eventSyncFrameOwner ?? window).cancelAnimationFrame(
        this.eventSyncFrame,
      )
      this.eventSyncFrame = null
      this.eventSyncFrameOwner = null
    }
    this.pendingEventSyncRunIds.clear()
    // Unregister BEFORE disposing adapters: a snapshot must never be taken
    // from a disposed terminal mid-teardown.
    this.unregisterSnapshotProvider?.()
    this.unregisterSnapshotProvider = null
    while (this.unregisterManagedDisposers.length > 0) {
      this.unregisterManagedDisposers.pop()?.()
    }
    for (const view of this.runViews.values()) {
      this.disposeTerminalBinding(view)
    }
    this.paneResizer?.dispose()
    this.paneResizer = null
    this.paneHeightRatio = null
    this.containerEl?.classList.remove(TERMINAL_CONTAINER_CLASS)
    this.containerEl?.classList.remove(EXPANDED_CONTAINER_CLASS)
    this.containerEl?.classList.remove(VISIBLE_CONTAINER_CLASS)
    this.containerEl?.classList.remove(SIZED_CONTAINER_CLASS)
    this.containerEl?.classList.remove(COLLAPSED_CONTAINER_CLASS)
    this.containerEl?.style.removeProperty(PANE_HEIGHT_PROPERTY)
    this.containerEl = null
    this.root?.remove()
    this.root = null
    this.sidebarEl = null
    this.sidebarRunsEl = null
    this.sidebarFilesEl = null
    this.sidebarToggleButton = null
    this.sidebarFilesButton = null
    this.workspaceFileTree?.dispose()
    this.workspaceFileTree = null
    this.workspaceFileEditor?.dispose()
    this.workspaceFileEditor = null
    this.fileEditorContainer = null
    this.expandedBeforeFilePanel = null
    this.activeWorkspaceDragPath = null
    this.panelsEl = null
    this.panels = []
    this.taskWorkspaceStates.clear()
    this.activeTaskScopeRunId = null
    this.focusedPanelId = null
    this.panelSequence = 0
    this.expandButton = null
    this.collapseButton = null
    this.composerEl = null
    this.composerInput = null
    this.composerSend = null
    this.expanded = false
    this.sidebarCollapsed = false
    this.sidebarMode = 'runs'
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
    this.showRunInFocusedPanel(runId)
  }

  setCollapsed(collapsed: boolean): void {
    if (!this.root) return
    this.root.classList.toggle('is-collapsed', collapsed)
    if (this.collapseButton) {
      setIcon(this.collapseButton, collapsed ? 'chevron-right' : 'chevron-down')
      this.collapseButton.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
    }
    if (!collapsed) {
      // Terminal runs selected while collapsed deferred their adapters; the
      // bodies just became visible, so create (and focus) them now.
      this.ensureVisibleTerminalViews()
    }
    this.refreshExpandButton()
    this.updateContainerChrome()
    this.fitVisibleTerminalViews()
  }

  /** Collapse only the left Vertical Tabs/Files sidebar to a 24px icon rail. */
  private setSidebarCollapsed(collapsed: boolean, persist: boolean): void {
    this.sidebarCollapsed = collapsed
    this.root?.classList.toggle('is-sidebar-collapsed', collapsed)
    this.sidebarToggleButton?.setAttribute(
      'aria-expanded',
      collapsed ? 'false' : 'true',
    )
    if (persist) {
      this.host.saveLocalStorage?.(
        AI_PANE_SIDEBAR_COLLAPSED_STORAGE_KEY,
        collapsed,
      )
    }
    this.ensureVisibleTerminalViews()
    this.fitVisibleTerminalViews()
  }

  private setSidebarMode(mode: 'runs' | 'files'): void {
    this.sidebarMode = mode
    const files = mode === 'files'
    this.root?.classList.toggle('is-files-mode', files)
    this.sidebarFilesButton?.setAttribute('aria-pressed', files ? 'true' : 'false')
    this.sidebarRunsEl?.classList.toggle('is-hidden', files)
    this.sidebarFilesEl?.classList.toggle('is-hidden', !files)
    if (files) this.refreshWorkspaceFiles()
  }

  private refreshWorkspaceFiles(): void {
    if (this.sidebarMode !== 'files') return
    const selectedRunId = this.getFocusedPanel()?.selectedRunId
    const cwd = selectedRunId
      ? this.host.manager.getRun(selectedRunId)?.cwd
      : undefined
    this.workspaceFileTree?.showRoot(cwd)
  }

  /** Common file-opening route for Files clicks and terminal path links. */
  private async openWorkspaceFile(
    rootPath: string,
    filePath: string,
    title?: string,
  ): Promise<void> {
    if (
      typeof this.host.manager.readWorkspaceFile !== 'function' ||
      typeof this.host.manager.writeWorkspaceFile !== 'function'
    ) {
      this.notifyWorkspaceFileError(new Error('Workspace files are not available'))
      return
    }
    const container = this.fileEditorContainer
    if (!container) return
    if (!this.workspaceFileEditor) {
      this.workspaceFileEditor = new WorkspaceFileEditorController(
        container,
        {
          readWorkspaceFile: (root, path) =>
            this.host.manager.readWorkspaceFile!(root, path),
          writeWorkspaceFile: (root, path, content, expectedVersion) =>
            this.host.manager.writeWorkspaceFile!(
              root,
              path,
              content,
              expectedVersion,
            ),
          onVisibilityChange: (visible) => this.setFilePanelVisible(visible),
          onError: (error) => this.notifyWorkspaceFileError(error),
          labels: {
            edit: this.host.tv('aiTask.fileEditor.edit', 'Edit'),
            save: this.host.tv('aiTask.fileEditor.save', 'Save (Cmd/Ctrl+S)'),
            cancel: this.host.tv('aiTask.fileEditor.cancel', 'Cancel'),
            saved: this.host.tv('aiTask.fileEditor.saved', 'Saved'),
            saving: this.host.tv('aiTask.fileEditor.saving', 'Saving…'),
            loading: this.host.tv('aiTask.fileEditor.loading', 'Loading…'),
            saveFailed: this.host.tv('aiTask.fileEditor.saveFailed', 'Save failed'),
            close: this.host.tv('aiTask.fileEditor.close', 'Close file'),
            discardConfirmation: this.host.tv(
              'aiTask.fileEditor.discardConfirmation',
              'You have unsaved changes. Discard them?',
            ),
          },
        },
        this.host.createFileEditorAdapter,
      )
    }
    await this.workspaceFileEditor.openFile(rootPath, filePath, title)
  }

  /** Enter/leave the reference-style terminal + file 50/50 work area. */
  private setFilePanelVisible(visible: boolean): void {
    this.fileEditorContainer?.classList.toggle('is-hidden', !visible)
    this.root?.classList.toggle('has-file-panel', visible)
    if (visible) {
      if (this.expandedBeforeFilePanel === null) {
        this.expandedBeforeFilePanel = this.expanded
      }
      this.revealPane()
      this.setCollapsed(false)
      if (!this.expanded) this.setExpanded(true, false)
    } else if (this.expandedBeforeFilePanel !== null) {
      const restoreExpanded = this.expandedBeforeFilePanel
      this.expandedBeforeFilePanel = null
      if (this.expanded !== restoreExpanded) {
        this.setExpanded(restoreExpanded, false)
      }
      if (this.runViews.size === 0) this.root?.classList.add('is-hidden')
    }
    this.updateContainerChrome()
    this.fitVisibleTerminalViews()
  }

  private notifyWorkspaceFileError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    new Notice(
      this.host.tv(
        'aiTask.notices.fileOpenFailed',
        'Could not open or save the file: {message}',
        { message },
      ),
    )
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
    const panelCount = Math.max(1, this.getVisiblePanels().length)
    const width = this.measureContentWidth() / panelCount
    const parentHeight = container?.parentElement?.clientHeight ?? 0
    if (width <= 0 || parentHeight <= 0) {
      return { cols: TERMINAL_FALLBACK_COLS, rows: TERMINAL_FALLBACK_ROWS }
    }
    const heightRatio = this.expanded
      ? TERMINAL_PANE_EXPANDED_HEIGHT_RATIO
      : (this.paneHeightRatio ?? TERMINAL_PANE_HEIGHT_RATIO)
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
    const sidebarWidth =
      measuredSidebar > 0
        ? measuredSidebar
        : this.sidebarCollapsed
          ? 24
          : RUN_SIDEBAR_WIDTH_PX
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
    this.fitVisibleTerminalViews()
  }

  /**
   * Adopt a drag-resized pane height, or `null` to drop back to the
   * stylesheet default (content height, or the fixed terminal share).
   * `persist` is true only for settled gestures — continuous pointer moves
   * and the mount-time restore must not write to storage.
   */
  private applyPaneHeightRatio(ratio: number | null, persist: boolean): void {
    const container = this.containerEl
    if (!container) return
    const next =
      ratio === null || !Number.isFinite(ratio)
        ? null
        : clamp(ratio, 0, AI_PANE_MAX_HEIGHT_RATIO)
    this.paneHeightRatio = next
    if (next === null) {
      container.style.removeProperty(PANE_HEIGHT_PROPERTY)
      container.classList.remove(SIZED_CONTAINER_CLASS)
    } else {
      container.style.setProperty(
        PANE_HEIGHT_PROPERTY,
        `${(next * 100).toFixed(2)}%`,
      )
      container.classList.add(SIZED_CONTAINER_CLASS)
    }
    if (persist) {
      this.host.saveLocalStorage?.(AI_PANE_HEIGHT_RATIO_STORAGE_KEY, next)
    }
    // The xterm viewport just changed height; refitting propagates the new
    // grid to the PTY.
    this.fitVisibleTerminalViews()
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
    this.fitVisibleTerminalViews()
  }

  private refreshExpandButton(): void {
    const button = this.expandButton
    if (!button) return
    const visiblyExpanded = this.expanded && !this.isCollapsed()
    setIcon(button, visiblyExpanded ? 'minimize-2' : 'maximize-2')
    const label = visiblyExpanded
      ? this.host.tv('aiTask.restorePane', 'Restore AI run pane size')
      : this.host.tv('aiTask.expandPane', 'Expand AI run pane')
    button.setAttribute('aria-label', label)
    button.setAttribute('title', label)
    button.setAttribute('aria-pressed', visiblyExpanded ? 'true' : 'false')
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

  private getVisiblePanels(): PanelView[] {
    const primary = this.getPrimaryPanel()
    return this.panels.filter(
      (panel) =>
        panel === primary ||
        (this.activeTaskScopeRunId !== null &&
          panel.taskScopeRunId === this.activeTaskScopeRunId),
    )
  }

  private isPanelVisible(panel: PanelView): boolean {
    return this.getVisiblePanels().includes(panel)
  }

  private getFocusedPanel(): PanelView | undefined {
    if (this.focusedPanelId !== null) {
      const focused = this.getPanel(this.focusedPanelId)
      if (focused && this.isPanelVisible(focused)) return focused
    }
    return this.getPrimaryPanel()
  }

  /**
   * Build one content panel (tab strip with the +/◫ controls and a bodies
   * element) and insert it after `afterPanel` (or append it). Global pane
   * actions stay in the AI Runs header rather than belonging to a panel.
   */
  private createPanel(
    afterPanel: PanelView | null,
    taskScopeRunId: string | null = null,
  ): PanelView {
    const panelsEl = this.panelsEl
    if (!panelsEl) throw new Error('AiRunPaneController is not mounted')
    const el = panelsEl.createDiv({ cls: 'ai-run-pane__panel' })
    if (afterPanel) {
      afterPanel.el.after(el)
    }

    const tabstrip = el.createDiv({
      cls: 'ai-run-pane__tabstrip ai-run-pane__work-tabbar',
    })
    const tabsEl = tabstrip.createDiv({
      cls: 'ai-run-pane__tabs',
      attr: {
        role: 'tablist',
        'aria-orientation': 'horizontal',
        'aria-label': this.host.tv('aiTask.contentTabs', 'Terminal tabs'),
      },
    })

    const panel: PanelView = {
      id: `panel-${(this.panelSequence += 1)}`,
      el,
      tabsEl,
      bodiesEl: null as unknown as HTMLElement,
      taskScopeRunId,
      taskRunId: null,
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
      attr: { 'aria-label': addLabel, title: addLabel },
    })
    setIcon(addButton, 'plus')
    addButton.addEventListener('click', (event) => {
      event.stopPropagation()
      this.handleNewShell(panel)
    })

    const actions = tabstrip.createDiv({ cls: 'ai-run-pane__actions' })
    const splitLabel = this.host.tv('aiTask.splitPane', 'Split the run pane')
    const splitButton = actions.createEl('button', {
      cls: 'ai-run-pane__split',
      attr: { 'aria-label': splitLabel, title: splitLabel },
    })
    setIcon(splitButton, 'columns-2')
    splitButton.addEventListener('click', (event) => {
      event.stopPropagation()
      this.handleSplit(panel)
    })
    panel.bodiesEl = el.createDiv({ cls: 'ai-run-pane__bodies' })

    const afterIndex = afterPanel ? this.panels.indexOf(afterPanel) : -1
    if (afterIndex >= 0) {
      this.panels.splice(afterIndex + 1, 0, panel)
    } else {
      this.panels.push(panel)
    }
    this.syncTaskWorkspaceVisibility()
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
    const wasFocused = this.focusedPanelId === panel.id
    for (const view of this.runViews.values()) {
      if (view.panelId !== panel.id) continue
      view.panelId = primary.id
      view.body.classList.remove('is-active')
      primary.bodiesEl.appendChild(view.body)
    }
    if (primary.taskRunId === null) {
      primary.taskRunId = panel.taskRunId
      primary.taskScopeRunId = panel.taskScopeRunId
    }
    this.panels = this.panels.filter((other) => other !== panel)
    panel.el.remove()
    this.ensurePanelTaskSlot(primary)
    this.syncTaskWorkspaceVisibility()
    if (wasFocused) {
      // The keyboard focus follows the ring (same contract as clicking a
      // panel): without ensureTerminalView the highlight would move to the
      // primary panel while keystrokes kept going nowhere until a click.
      this.focusPanel(primary)
      if (!this.isCollapsed()) {
        this.ensureTerminalView(primary)
      }
    }
    this.refreshPanelsSplitState()
    this.refreshContentTab(primary)
    this.syncPanelSelectionClasses()
  }

  private focusPanel(panel: PanelView): void {
    if (!this.isPanelVisible(panel)) return
    this.focusedPanelId = panel.id
    for (const other of this.panels) {
      other.el.classList.toggle('is-focused', other === panel)
    }
    // The sidebar is one global vertical tablist even when the work area is
    // split. Its single selected/roving tab therefore follows the focused
    // panel, rather than exposing one selected row per panel.
    this.syncPanelSelectionClasses()
    this.rememberActiveTaskWorkspaceState()
    this.updateComposerState()
    this.refreshWorkspaceFiles()
  }

  /**
   * Stack each task's secondary split layout behind the selected Vertical
   * Tab, matching the reference's one QuestCard/useSplitPanelState instance
   * per task. The shared primary panel remains mounted because it hosts the
   * replaceable main-task bodies; only secondary panels are task-owned.
   */
  private syncTaskWorkspaceVisibility(): void {
    const primary = this.getPrimaryPanel()
    for (const panel of this.panels) {
      const visible =
        panel === primary ||
        (this.activeTaskScopeRunId !== null &&
          panel.taskScopeRunId === this.activeTaskScopeRunId)
      panel.el.hidden = !visible
      panel.el.setAttribute('aria-hidden', visible ? 'false' : 'true')
    }
    const focused = this.focusedPanelId
      ? this.getPanel(this.focusedPanelId)
      : undefined
    if (primary && (!focused || !this.isPanelVisible(focused))) {
      this.focusedPanelId = primary.id
    }
    for (const panel of this.panels) {
      panel.el.classList.toggle(
        'is-focused',
        panel.id === this.focusedPanelId && this.isPanelVisible(panel),
      )
    }
    this.reclaimHiddenTerminalBindings()
  }

  /**
   * Snapshot the state that cannot live on a task-owned secondary panel
   * before the shared primary panel starts presenting another task.
   */
  private rememberActiveTaskWorkspaceState(): void {
    const taskScopeRunId = this.activeTaskScopeRunId
    const primary = this.getPrimaryPanel()
    if (taskScopeRunId === null || !primary) return

    const primarySelectedRunId =
      primary.selectedRunId !== null &&
      this.runViews.get(primary.selectedRunId)?.panelId === primary.id &&
      this.runBelongsToTaskScope(primary.selectedRunId, taskScopeRunId)
        ? primary.selectedRunId
        : null
    const focused = this.focusedPanelId
      ? this.getPanel(this.focusedPanelId)
      : undefined
    const focusedPanelId =
      focused && this.isPanelVisible(focused) ? focused.id : primary.id

    this.taskWorkspaceStates.set(taskScopeRunId, {
      primarySelectedRunId,
      focusedPanelId,
    })
  }

  private runBelongsToTaskScope(
    runId: string,
    taskScopeRunId: string,
  ): boolean {
    const record = this.host.manager.getRun(runId)
    return record !== undefined && this.getTaskScopeRunId(record) === taskScopeRunId
  }

  /**
   * Apply a task scope after its primary selection/focus have already been
   * chosen. The body classes are synchronized before fit(), so switching
   * A→B never resizes A's now-hidden terminal using B's panel geometry.
   */
  private applyTaskWorkspace(taskScopeRunId: string): void {
    this.activeTaskScopeRunId = taskScopeRunId
    const primary = this.getPrimaryPanel()
    if (primary) {
      primary.taskScopeRunId = taskScopeRunId
      const owner = this.host.manager.getRun(taskScopeRunId)
      const ownerView = this.runViews.get(taskScopeRunId)
      if (
        owner?.host !== 'shell' &&
        ownerView?.panelId === primary.id
      ) {
        primary.taskRunId = taskScopeRunId
      }
    }
    this.syncTaskWorkspaceVisibility()
    if (primary) this.refreshContentTab(primary)
    this.syncPanelSelectionClasses()
    this.refreshPanelsSplitState()
  }

  /** Marker class for styles.css: highlight the focus only while split */
  private refreshPanelsSplitState(): void {
    this.panelsEl?.classList.toggle(
      'is-split',
      this.getVisiblePanels().length > 1,
    )
    this.fitVisibleTerminalViews()
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
    return (
      width / (this.getVisiblePanels().length + 1) >=
      SPLIT_MIN_PANEL_WIDTH_PX
    )
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
    const newPanel = this.createPanel(
      sourcePanel,
      sourcePanel.taskScopeRunId ?? this.activeTaskScopeRunId,
    )
    // Focus BEFORE spawning: the manager emits the new run synchronously and
    // createRunView assigns fresh runs to the focused panel.
    this.focusPanel(newPanel)
    let record: AiRunRecord
    try {
      record = this.startShellSession(sourcePanel)
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
      if (!this.isCollapsed()) {
        this.ensureTerminalView(sourcePanel)
      }
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
      record = this.startShellSession(panel)
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
  private startShellSession(contextPanel: PanelView): AiRunRecord {
    const manager = this.host.manager
    if (typeof manager.startShellSession !== 'function') {
      throw new AiShellUnavailableError()
    }
    const size = this.computeTerminalSize()
    const contextRecord =
      contextPanel.selectedRunId !== null
        ? manager.getRun(contextPanel.selectedRunId)
        : undefined
    const parentRunId =
      contextRecord?.host === 'shell'
        ? (contextRecord.parentRunId ?? contextRecord.id)
        : contextRecord?.id
    return manager.startShellSession({
      cols: size.cols,
      rows: size.rows,
      name: this.host.tv('aiTask.shellSessionName', 'Terminal'),
      ...(contextRecord?.cwd ? { cwd: contextRecord.cwd } : {}),
      ...(parentRunId ? { parentRunId } : {}),
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
        return
      }
      const persistedView = this.runViews.get(record.id)
      if (persistedView) {
        persistedView.exitPersisted = true
        this.reclaimHiddenTerminalBindings()
      }
      return
    }
    if (record.status === 'interrupted' && record.host !== 'shell') {
      this.host.onInterruptedTaskRun?.(record)
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
      // A resumed run's next exit starts a fresh persist chain.
      if (ACTIVE_STATUSES.has(record.status)) existing.exitPersisted = false
      this.refreshRunRow(existing, record)
      this.refreshTabsShowingRun(record.id)
    }
    if (!existing.isTerminal) {
      this.scheduleEventSync(record.id)
    }
    this.updateComposerState()
  }

  /**
   * Coalesce event rendering into one animation frame: the manager notifies
   * synchronously per stream line, so a fast child process would otherwise
   * force a DOM update (and layout) per line. Status/row updates stay
   * synchronous — only the event list defers to the next frame.
   */
  private scheduleEventSync(runId: string): void {
    this.pendingEventSyncRunIds.add(runId)
    if (this.eventSyncFrame !== null) return
    // Obsidian's activeWindow follows focus and can be a short-lived popout.
    // Schedule on the renderer root and retain that exact owner for teardown.
    const frameOwner = window
    const frameId = frameOwner.requestAnimationFrame(() => {
      if (
        this.eventSyncFrame !== frameId ||
        this.eventSyncFrameOwner !== frameOwner
      ) {
        return
      }
      this.eventSyncFrame = null
      this.eventSyncFrameOwner = null
      this.flushEventSync()
    })
    this.eventSyncFrameOwner = frameOwner
    this.eventSyncFrame = frameId
  }

  private flushEventSync(): void {
    const runIds = Array.from(this.pendingEventSyncRunIds)
    this.pendingEventSyncRunIds.clear()
    for (const runId of runIds) {
      const view = this.runViews.get(runId)
      const record = this.host.manager.getRun(runId)
      if (!view || view.isTerminal || !record) continue
      this.syncEvents(view, record)
    }
  }

  /**
   * × entry point shared by the sidebar row and the content tab: an ACTIVE
   * run is stopped first and its view closes when 'persisted' arrives (the
   * exit-time snapshot must be read from a live adapter); a run already in
   * any final-status-but-mid-persist window waits for that same notification;
   * finished runs close immediately only after their persist chain completed.
   */
  private requestCloseRun(runId: string): void {
    const view = this.runViews.get(runId)
    if (!view) return
    const record = this.host.manager.getRun(runId)
    const status = record?.status ?? view.lastStatus
    if (ACTIVE_STATUSES.has(status)) {
      // Treat repeated clicks as one close request. This also prevents the
      // TaskChute instance from being stopped/logged more than once while
      // the manager is still persisting the run transcript.
      if (this.pendingCloseRunIds.has(runId)) return
      this.pendingCloseRunIds.add(runId)
      if (record && record.host !== 'shell') {
        this.host.onStopAndCloseTaskRun?.(record)
      }
      this.host.manager.stopRun(runId)
      return
    }
    if (!view.exitPersisted) {
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
    const ownedShellRunIds = this.host.manager
      .getRuns()
      .filter((record) => record.parentRunId === runId)
      .map((record) => record.id)
    for (const ownedRunId of ownedShellRunIds) {
      this.requestCloseRun(ownedRunId)
    }
    this.disposeTerminalBinding(view)
    view.row?.remove()
    view.body.remove()
    this.runViews.delete(runId)
    this.pendingCloseRunIds.delete(runId)
    this.pendingEventSyncRunIds.delete(runId)
    // The view is gone for good: drop the run's record from the manager so a
    // later pane remount does not resurrect the closed run (the manager
    // refuses to release still-active runs, so a rollback of a mid-dispatch
    // failure can call this unconditionally).
    this.host.manager.releaseRun?.(runId)

    const panel = this.getPanel(view.panelId)
    if (panel?.taskRunId === runId) {
      panel.taskRunId = null
      this.ensurePanelTaskSlot(panel)
    }
    if (panel) this.refreshContentTab(panel)
    if (panel && panel.selectedRunId === runId) {
      panel.selectedRunId = null
      let fallbackRunId =
        panel.taskRunId !== null &&
        this.runViews.get(panel.taskRunId)?.panelId === panel.id
          ? panel.taskRunId
          : undefined
      if (fallbackRunId === undefined) {
        for (const [id, other] of this.runViews) {
          if (other.panelId === panel.id) fallbackRunId = id
        }
      }
      if (fallbackRunId !== undefined) {
        const fallbackRecord = this.host.manager.getRun(fallbackRunId)
        const fallbackTaskScopeRunId = fallbackRecord
          ? this.getTaskScopeRunId(fallbackRecord)
          : null
        const mayActivateWorkspace =
          this.isPanelVisible(panel) &&
          fallbackTaskScopeRunId === this.activeTaskScopeRunId
        this.selectRunInPanel(panel, fallbackRunId, mayActivateWorkspace)
        return
      }
      if (panel === this.getPrimaryPanel()) {
        // The primary emptied. While split, merge the next panel into the
        // primary (the reference reducer removes any panel whose last tab
        // closes) instead of keeping a dead primary panel on screen.
        const nextPanel = this.getVisiblePanels()[1]
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
      if (!this.workspaceFileEditor?.hasOpenFiles()) {
        this.root?.classList.add('is-hidden')
      }
      const primary = this.getPrimaryPanel()
      if (primary) this.refreshContentTab(primary)
    }
    this.syncPanelSelectionClasses()
    this.updateContainerChrome()
    this.updateComposerState()
  }

  private createRunView(record: AiRunRecord): void {
    const sidebarEl = this.sidebarRunsEl
    const isShell = record.host === 'shell'
    // A task's main terminal always lives in the shared primary panel.
    // Otherwise starting task B while task A's split panel is focused would
    // accidentally graft B into A's workspace.
    const target = isShell ? this.getFocusedPanel() : this.getPrimaryPanel()
    if (!sidebarEl || !target) return

    const row = isShell
      ? null
      : sidebarEl.createDiv({
          cls: 'ai-run-pane__run',
          attr: {
            role: 'tab',
            tabindex: '-1',
            'data-run-id': record.id,
            'aria-controls': `ai-run-body-${record.id}`,
          },
        })
    row?.addEventListener('click', () => {
      this.showRunInFocusedPanel(record.id)
    })
    row?.addEventListener('keydown', (event) => {
      this.handleSidebarTabKeydown(record.id, event)
    })

    const isTerminal = record.mode === 'terminal'
    const body = target.bodiesEl.createDiv({
      cls: isTerminal
        ? 'ai-run-pane__body ai-run-pane__body--terminal'
        : 'ai-run-pane__body',
      attr: {
        id: `ai-run-body-${record.id}`,
        role: 'tabpanel',
        'data-run-id': record.id,
      },
    })
    if (isTerminal) {
      body.addEventListener('dragover', (event) => {
        if (!event.dataTransfer) return
        if (this.activeWorkspaceDragPath === null) return
        if (!Array.from(event.dataTransfer.types).includes(WORKSPACE_PATH_DRAG_MIME)) {
          return
        }
        event.preventDefault()
      })
      body.addEventListener('drop', (event) => {
        const path = event.dataTransfer?.getData(WORKSPACE_PATH_DRAG_MIME) ?? ''
        const expectedPath = this.activeWorkspaceDragPath
        // DataTransfer is an untrusted boundary. A feature-specific MIME type
        // alone is forgeable, so require the exact path recorded by this
        // pane's validated Files tree for this one drag operation.
        this.activeWorkspaceDragPath = null
        if (path.length === 0 || expectedPath === null || path !== expectedPath) {
          return
        }
        event.preventDefault()
        try {
          this.host.manager.sendTerminalInput(
            record.id,
            formatWorkspacePathForTerminal(path),
          )
          this.runViews.get(record.id)?.terminal?.adapter.focus()
        } catch {
          // Invalid drag payloads (notably NUL) are ignored, never executed.
        }
      })
    }

    const view: RunView = {
      row,
      body,
      panelId: target.id,
      isTerminal,
      terminal: null,
      renderedEventCount: 0,
      lastStatus: record.status,
      lastOmittedCount: record.omittedEventCount ?? 0,
      elisionEl: null,
      elisionIndex: -1,
      // Final status is published BEFORE the log/transcript chain starts.
      // Ask the manager for the exact state so a pane mount inside that gap
      // cannot reclaim the adapter that the pending snapshot still needs.
      // The fallback preserves compatibility with lightweight test hosts.
      exitPersisted:
        this.host.manager.isRunExitPersisted?.(record.id) ??
        !ACTIVE_STATUSES.has(record.status),
    }
    this.runViews.set(record.id, view)
    if (!isShell && target.taskRunId === null) {
      target.taskRunId = record.id
      target.taskScopeRunId = record.id
    }
    this.refreshRunRow(view, record)
    if (!isTerminal) {
      this.renderAllEvents(view, record)
    }

    this.revealPane()
    if (target.selectedRunId === null) {
      this.selectRunInPanel(target, record.id)
    } else {
      this.refreshContentTab(target)
    }
    this.syncPanelSelectionClasses()
  }

  /** WAI-ARIA vertical tablist keyboard navigation for the task rail. */
  private handleSidebarTabKeydown(runId: string, event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      this.showRunInFocusedPanel(runId)
      return
    }
    const rows = Array.from(
      this.sidebarRunsEl?.querySelectorAll<HTMLElement>(
        '[role="tab"][data-run-id]',
      ) ?? [],
    )
    const currentIndex = rows.findIndex(
      (row) => row.getAttribute('data-run-id') === runId,
    )
    if (currentIndex < 0 || rows.length === 0) return

    let targetIndex: number
    switch (event.key) {
      case 'ArrowUp':
        targetIndex = (currentIndex - 1 + rows.length) % rows.length
        break
      case 'ArrowDown':
        targetIndex = (currentIndex + 1) % rows.length
        break
      case 'Home':
        targetIndex = 0
        break
      case 'End':
        targetIndex = rows.length - 1
        break
      default:
        return
    }
    const target = rows[targetIndex]
    const targetRunId = target?.getAttribute('data-run-id')
    if (!target || !targetRunId) return
    event.preventDefault()
    this.showRunInFocusedPanel(targetRunId)
    target.focus()
  }

  /** Rebuild one sidebar row (status dot, truncated name, × control) */
  private refreshRunRow(view: RunView, record: AiRunRecord): void {
    const row = view.row
    if (!row) return
    row.empty()

    const statusLabel = this.host.tv(
      `aiTask.status.${record.status}`,
      STATUS_FALLBACK_LABELS[record.status],
    )
    row.createSpan({
      cls: `ai-run-pane__run-dot ai-run-pane__run-dot--${record.status}`,
      attr: { title: statusLabel },
    })
    const name =
      record.taskName.trim().length > 0
        ? record.taskName
        : this.host.tv('aiTask.tabUntitled', 'Untitled run')
    row.createSpan({
      cls: 'ai-run-pane__run-name',
      text: name,
      attr: { title: name },
    })
    this.appendCloseControl(row, record, 'ai-run-pane__run-close')
  }

  /**
   * Rebuild one panel's tab strip tab from the panel's SELECTED run (status
   * dot, content-type label, × control). Hidden while the panel shows
   * nothing (pre-first-run and post-last-close states).
   */
  private refreshContentTab(panel: PanelView): void {
    panel.tabsEl.empty()

    const visibleRunIds: string[] = []
    if (
      panel.taskRunId !== null &&
      panel.taskRunId === panel.taskScopeRunId
    ) {
      visibleRunIds.push(panel.taskRunId)
    }
    for (const [runId, view] of this.runViews) {
      if (view.panelId !== panel.id) continue
      const record = this.host.manager.getRun(runId)
      if (!record) continue
      if (
        record.host === 'shell' &&
        this.getTaskScopeRunId(record) === panel.taskScopeRunId
      ) {
        visibleRunIds.push(runId)
      }
    }

    // A panel owns exactly one replaceable top-level AI-task slot. Merely
    // starting another task adds its Vertical Tab/body, but not another
    // horizontal tab. Horizontal tabs only multiply through the explicit
    // + action, whose records use host === 'shell'. Keep the task slot first
    // even when it was activated after an already-open shell tab.
    for (const runId of visibleRunIds) {
      const record = this.host.manager.getRun(runId)
      const view = this.runViews.get(runId)
      if (!record || view?.panelId !== panel.id) continue
      const selected = panel.selectedRunId === runId
      const tab = panel.tabsEl.createDiv({
        cls: selected
          ? 'ai-run-pane__tab ai-run-pane__work-tab is-active'
          : 'ai-run-pane__tab ai-run-pane__work-tab',
        attr: {
          role: 'tab',
          tabindex: selected ? '0' : '-1',
          'aria-selected': selected ? 'true' : 'false',
          'data-run-id': record.id,
          'aria-controls': `ai-run-body-${record.id}`,
        },
      })
      tab.addEventListener('click', () => {
        this.focusPanel(panel)
        this.selectRunInPanel(panel, record.id)
      })
      tab.addEventListener('keydown', (event) => {
        if (event.target !== tab) return
        this.handleContentTabKeydown(panel, record.id, event)
      })
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
      this.appendCloseControl(
        tab,
        record,
        'ai-run-pane__tab-close ai-run-pane__work-tab-close',
      )
    }
  }

  /** WAI-ARIA tablist keyboard navigation for task-slot and + shell tabs. */
  private handleContentTabKeydown(
    panel: PanelView,
    runId: string,
    event: KeyboardEvent,
  ): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      this.focusPanel(panel)
      this.selectRunInPanel(panel, runId)
      return
    }

    const tabs = Array.from(
      panel.tabsEl.querySelectorAll<HTMLElement>('[role="tab"][data-run-id]'),
    )
    const currentIndex = tabs.findIndex(
      (tab) => tab.getAttribute('data-run-id') === runId,
    )
    if (currentIndex < 0 || tabs.length === 0) return

    let targetIndex: number
    switch (event.key) {
      case 'ArrowLeft':
        targetIndex = (currentIndex - 1 + tabs.length) % tabs.length
        break
      case 'ArrowRight':
        targetIndex = (currentIndex + 1) % tabs.length
        break
      case 'Home':
        targetIndex = 0
        break
      case 'End':
        targetIndex = tabs.length - 1
        break
      default:
        return
    }

    const targetRunId = tabs[targetIndex]?.getAttribute('data-run-id')
    if (!targetRunId) return
    event.preventDefault()
    this.focusPanel(panel)
    this.selectRunInPanel(panel, targetRunId)
    // selectRunInPanel rebuilds the tab DOM, so focus its replacement.
    Array.from(
      panel.tabsEl.querySelectorAll<HTMLElement>('[role="tab"][data-run-id]'),
    )
      .find((tab) => tab.getAttribute('data-run-id') === targetRunId)
      ?.focus()
  }

  /** Refresh the tab of every panel currently displaying the run */
  private refreshTabsShowingRun(runId: string): void {
    const view = this.runViews.get(runId)
    const panel = view ? this.getPanel(view.panelId) : undefined
    if (panel) this.refreshContentTab(panel)
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
    if (
      !isActive &&
      record.status !== 'interrupted' &&
      record.status !== 'succeeded' &&
      record.status !== 'failed'
    ) {
      return
    }
    const label = isActive
      ? this.host.tv('aiTask.stopAndClose', 'Stop and close run')
      : this.host.tv('aiTask.closeTab', 'Close run tab')
    const button = parent.createEl('button', {
      cls,
      attr: { 'aria-label': label, title: label },
    })
    setIcon(button, 'x')
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
    const record = this.host.manager.getRun(runId)
    if (!view || !record) return

    // A Vertical Tab switches the complete task-local workspace. Its main
    // body is normalized into the shared primary panel; secondary panels
    // with the same scope become visible again, while every other task's
    // split layout stays mounted but hidden.
    if (record.host !== 'shell') {
      const primary = this.getPrimaryPanel()
      if (!primary) return
      if (view.panelId !== primary.id) {
        const hostPanel = this.getPanel(view.panelId)
        view.panelId = primary.id
        primary.bodiesEl.appendChild(view.body)
        if (hostPanel) {
          if (hostPanel.taskRunId === runId) hostPanel.taskRunId = null
          this.ensurePanelTaskSlot(hostPanel)
          this.refreshContentTab(hostPanel)
        }
      }
      if (this.activeTaskScopeRunId !== runId) {
        this.rememberActiveTaskWorkspaceState()
      }
      const stored = this.taskWorkspaceStates.get(runId)
      const storedPrimaryRunId = stored?.primarySelectedRunId
      primary.taskRunId = runId
      primary.taskScopeRunId = runId
      primary.selectedRunId =
        storedPrimaryRunId &&
        this.runViews.get(storedPrimaryRunId)?.panelId === primary.id &&
        this.runBelongsToTaskScope(storedPrimaryRunId, runId)
          ? storedPrimaryRunId
          : runId

      const storedFocusedPanel = stored?.focusedPanelId
        ? this.getPanel(stored.focusedPanelId)
        : undefined
      const restoredFocusedPanel =
        storedFocusedPanel &&
        (storedFocusedPanel === primary ||
          storedFocusedPanel.taskScopeRunId === runId)
          ? storedFocusedPanel
          : primary
      this.focusedPanelId = restoredFocusedPanel.id
      this.applyTaskWorkspace(runId)
      this.focusPanel(restoredFocusedPanel)
      this.updateContainerChrome()
      this.updateComposerState()
      if (!this.isCollapsed()) {
        // Every visible panel, not just the focused one: a secondary panel
        // whose binding was reclaimed while its workspace was stacked away
        // must get its terminal (and replay) back on the task switch.
        this.ensureVisibleTerminalViews()
      }
      return
    }

    const focused = this.getFocusedPanel()
    if (!focused) return
    if (view.panelId !== focused.id) {
      const hostPanel = this.getPanel(view.panelId)
      if (
        hostPanel &&
        (hostPanel.selectedRunId === runId || hostPanel.taskRunId === runId)
      ) {
        this.focusPanel(hostPanel)
        this.selectRunInPanel(hostPanel, runId)
        return
      }
      // Adopt the hidden body into the focused panel.
      view.panelId = focused.id
      focused.bodiesEl.appendChild(view.body)
      if (hostPanel) {
        if (hostPanel.taskRunId === runId) hostPanel.taskRunId = null
        this.ensurePanelTaskSlot(hostPanel)
        this.refreshContentTab(hostPanel)
      }
    }
    this.selectRunInPanel(focused, runId)
  }

  private selectRunInPanel(
    panel: PanelView,
    runId: string,
    activateWorkspace = true,
  ): void {
    const record = this.host.manager.getRun(runId)
    if (!record) return
    const taskScopeRunId = this.getTaskScopeRunId(record)
    if (
      activateWorkspace &&
      this.activeTaskScopeRunId !== taskScopeRunId
    ) {
      this.rememberActiveTaskWorkspaceState()
    }
    if (record?.host !== 'shell') {
      panel.taskRunId = runId
      panel.taskScopeRunId = runId
    } else {
      panel.taskScopeRunId = taskScopeRunId
    }
    panel.selectedRunId = runId
    if (activateWorkspace) {
      this.applyTaskWorkspace(taskScopeRunId)
    } else {
      this.syncPanelSelectionClasses()
    }
    this.refreshContentTab(panel)
    // Establish the terminal pane's FINAL geometry before xterm opens:
    // updateContainerChrome applies the fixed 40% terminal height, while
    // updateComposerState removes the headless-only composer. Previously
    // both happened after adapter.open()/fit(), so the first grid was
    // measured against a transient, taller body and stayed clipped until a
    // later sidebar/maximize resize forced another fit.
    this.updateContainerChrome()
    this.updateComposerState()
    if (activateWorkspace && !this.isCollapsed()) {
      this.ensureTerminalView(panel)
    }
    if (activateWorkspace) this.rememberActiveTaskWorkspaceState()
    this.reclaimHiddenTerminalBindings()
    this.refreshWorkspaceFiles()
  }

  /**
   * Repair a panel's replaceable AI-task slot after a close/move/unsplit.
   * Shell sessions never occupy this slot: they only exist because the user
   * explicitly pressed + (or split, which creates its own shell panel).
   */
  private ensurePanelTaskSlot(panel: PanelView): void {
    const current = panel.taskRunId
    if (current !== null) {
      const view = this.runViews.get(current)
      const record = this.host.manager.getRun(current)
      if (view?.panelId === panel.id && record?.host !== 'shell') {
        panel.taskScopeRunId = current
        return
      }
    }

    panel.taskRunId = null
    for (const [runId, view] of this.runViews) {
      if (view.panelId !== panel.id) continue
      if (this.host.manager.getRun(runId)?.host === 'shell') continue
      panel.taskRunId = runId
    }
    if (panel.taskRunId !== null) {
      panel.taskScopeRunId = panel.taskRunId
    } else if (panel.selectedRunId !== null) {
      const selectedRecord = this.host.manager.getRun(panel.selectedRunId)
      panel.taskScopeRunId = selectedRecord
        ? this.getTaskScopeRunId(selectedRecord)
        : null
    } else {
      panel.taskScopeRunId = null
    }
  }

  /**
   * Stable owner key used by the task-local horizontal tab set. Top-level
   * runs own themselves. A + terminal inherits parentRunId; an orphan shell
   * (possible through an external quick-launch integration) owns itself.
   */
  private getTaskScopeRunId(record: AiRunRecord): string {
    return record.host === 'shell'
      ? (record.parentRunId ?? record.id)
      : record.id
  }

  /**
   * Resolve the one task row represented by the global Vertical Tabs rail.
   * When the focused panel currently shows an explicit shell tab, retain its
   * replaceable task slot as the roving target. A shell-only panel falls back
   * to the first task row so the tablist never has zero keyboard stops.
   */
  private getSelectedSidebarRunId(): string | null {
    const focused = this.getFocusedPanel()
    const candidates = [focused?.selectedRunId, focused?.taskRunId]
    for (const runId of candidates) {
      if (!runId) continue
      const view = this.runViews.get(runId)
      const record = this.host.manager.getRun(runId)
      if (view?.row && record?.host !== 'shell') return runId
    }
    if (this.activeTaskScopeRunId !== null) {
      const activeView = this.runViews.get(this.activeTaskScopeRunId)
      if (activeView?.row) return this.activeTaskScopeRunId
    }
    for (const [runId, view] of this.runViews) {
      if (view.row) return runId
    }
    return null
  }

  /** Body visibility follows each panel; the global task rail has one tab. */
  private syncPanelSelectionClasses(): void {
    const selectedSidebarRunId = this.getSelectedSidebarRunId()
    for (const [id, view] of this.runViews) {
      const isBodySelected = this.getPanel(view.panelId)?.selectedRunId === id
      const isSidebarSelected = id === selectedSidebarRunId
      view.row?.classList.toggle('is-active', isSidebarSelected)
      view.row?.setAttribute(
        'aria-selected',
        isSidebarSelected ? 'true' : 'false',
      )
      view.row?.setAttribute('tabindex', isSidebarSelected ? '0' : '-1')
      view.body.classList.toggle('is-active', isBodySelected)
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

    // Invariant for every entry point (initial selection, task-workspace
    // switch, uncollapse, and panel focus): xterm never opens against the
    // transient headless/auto-height geometry.
    this.updateContainerChrome()
    this.updateComposerState()

    if (!view.terminal) {
      const record = this.host.manager.getRun(runId)
      const adapter = this.host.createTerminalAdapter()
      const disposeResize =
        adapter.onResize?.(({ cols, rows }) => {
          this.host.manager.resizeTerminal?.(runId, cols, rows)
        }) ?? (() => undefined)
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
      const disposeFilePath =
        adapter.onFilePathActivate?.((target) => {
          const cwd = this.host.manager.getRun(runId)?.cwd
          if (!cwd) return
          void this.openWorkspaceFile(cwd, target.path)
        }) ?? (() => undefined)
      view.terminal = {
        adapter,
        disposeData,
        disposeInput,
        disposeResize,
        disposeFilePath,
      }
    }
    if (this.focusedPanelId === panel.id) {
      view.terminal.adapter.focus()
    }
    view.terminal.adapter.fit?.()
  }

  /** Create/focus the selected terminal view of every panel (uncollapse) */
  private ensureVisibleTerminalViews(): void {
    for (const panel of this.getVisiblePanels()) {
      this.ensureTerminalView(panel)
    }
  }

  private fitVisibleTerminalViews(): void {
    for (const panel of this.getVisiblePanels()) {
      const runId = panel.selectedRunId
      if (runId === null) continue
      this.runViews.get(runId)?.terminal?.adapter.fit?.()
    }
  }

  /** Tear down one run view's terminal wiring (idempotent) */
  private disposeTerminalBinding(view: RunView): void {
    const binding = view.terminal
    if (!binding) return
    view.terminal = null
    binding.disposeData()
    binding.disposeInput()
    binding.disposeResize()
    binding.disposeFilePath()
    binding.adapter.dispose()
  }

  /**
   * Reclaim terminal wiring no visible panel is presenting: a finished
   * run's hidden binding is disposed once its exit persist completed.
   * ACTIVE runs are never reclaimed, hidden or not — the manager captures
   * the exit-time log snapshot from the live adapter, and the transcript
   * fallback (ANSI-stripped TUI redraw stream) is far less readable, so
   * disposing an active binding would degrade that run's eventual log note.
   * Also never touched: bindings a visible panel shows (collapsed pane
   * included), runs whose × teardown is pending on 'persisted', and
   * finished runs whose 'persisted' has not arrived yet. Reselecting a
   * reclaimed run re-creates the binding in ensureTerminalView; the
   * manager's subscribe-time replay restores the screen.
   */
  private reclaimHiddenTerminalBindings(): void {
    const onScreenRunIds = new Set<string>()
    for (const panel of this.getVisiblePanels()) {
      if (panel.selectedRunId !== null) onScreenRunIds.add(panel.selectedRunId)
    }
    for (const [runId, view] of this.runViews) {
      if (!view.isTerminal || !view.terminal) continue
      if (onScreenRunIds.has(runId)) continue
      if (this.pendingCloseRunIds.has(runId)) continue
      const status = this.host.manager.getRun(runId)?.status ?? view.lastStatus
      if (ACTIVE_STATUSES.has(status)) continue
      if (view.exitPersisted) this.disposeTerminalBinding(view)
    }
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
    const paneVisible = !this.isHidden()
    const visible = !this.isCollapsed() && paneVisible
    const anyTerminalOnScreen = this.getVisiblePanels().some(
      (panel) =>
        panel.selectedRunId !== null &&
        this.runViews.get(panel.selectedRunId)?.isTerminal === true,
    )
    container.classList.toggle(
      TERMINAL_CONTAINER_CLASS,
      anyTerminalOnScreen && visible,
    )
    container.classList.toggle(EXPANDED_CONTAINER_CLASS, this.expanded && visible)
    container.classList.toggle(VISIBLE_CONTAINER_CLASS, paneVisible)
    container.classList.toggle(
      COLLAPSED_CONTAINER_CLASS,
      this.isCollapsed() && paneVisible,
    )
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
          'AI CLI was not found: {host}. Install it or check PATH; use the advanced path fallback only for a custom location.',
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
   * Incremental render via a per-run cursor. Before the manager's bounded
   * buffer overflows, notifications only ever append events. After the
   * overflow the buffer keeps a FIXED shape (head + one elision marker +
   * rotating tail of constant length) and every append bumps the omitted
   * count — so the marker text is updated in place, the oldest rendered
   * tail nodes are pruned, and only the new tail events are appended. A
   * full rebuild happens only when the structure genuinely changed (view
   * creation, the first overflow, or a shape this sync cannot reconcile).
   */
  private syncEvents(view: RunView, record: AiRunRecord): void {
    const omittedCount = record.omittedEventCount ?? 0
    const events = record.events
    if (omittedCount === view.lastOmittedCount) {
      if (events.length === view.renderedEventCount) return
      if (events.length < view.renderedEventCount) {
        this.renderAllEvents(view, record)
        return
      }
      const pinned = this.isPinnedToBottom(view.body)
      for (let i = view.renderedEventCount; i < events.length; i += 1) {
        this.appendEventElement(view.body, events[i])
      }
      view.renderedEventCount = events.length
      if (pinned) this.scrollToBottom(view.body)
      return
    }

    // Steady-state overflow: each dropped tail event matches one appended
    // event, so the buffer (and the rendered node count) keeps its length.
    const appended = omittedCount - view.lastOmittedCount
    const marker = view.elisionEl
    const tailLength = events.length - view.elisionIndex - 1
    const canPatchInPlace =
      appended > 0 &&
      marker !== null &&
      marker.parentElement === view.body &&
      events.length === view.renderedEventCount &&
      events[view.elisionIndex]?.kind === 'elision' &&
      appended < tailLength
    if (!canPatchInPlace) {
      this.renderAllEvents(view, record)
      return
    }

    const pinned = this.isPinnedToBottom(view.body)
    marker.textContent = this.formatEventText(events[view.elisionIndex])
    for (let i = 0; i < appended; i += 1) {
      marker.nextElementSibling?.remove()
      this.appendEventElement(view.body, events[events.length - appended + i])
    }
    view.lastOmittedCount = omittedCount
    if (pinned) this.scrollToBottom(view.body)
  }

  private renderAllEvents(view: RunView, record: AiRunRecord): void {
    const pinned = this.isPinnedToBottom(view.body)
    view.body.empty()
    view.elisionEl = null
    view.elisionIndex = -1
    record.events.forEach((event, index) => {
      const el = this.appendEventElement(view.body, event)
      if (event.kind === 'elision') {
        view.elisionEl = el
        view.elisionIndex = index
      }
    })
    view.renderedEventCount = record.events.length
    view.lastOmittedCount = record.omittedEventCount ?? 0
    if (pinned) this.scrollToBottom(view.body)
  }

  /**
   * One node per event, ALWAYS — renderEvents' in-place elision patch pairs
   * each appended event with exactly one node. An event with nothing to say
   * therefore becomes an empty node that the stylesheet collapses, never a
   * skipped one.
   */
  private appendEventElement(body: HTMLElement, event: AiStreamEvent): HTMLElement {
    const isError =
      (event.kind === 'result' || event.kind === 'tool-result') &&
      event.isError === true
    return body.createDiv({
      cls:
        `ai-run-pane__event ai-run-pane__event--${event.kind}` +
        (isError ? ' is-error' : ''),
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
      case 'init':
        // The session id belongs to resume plumbing, not to a reader, and a
        // follow-up restarts the CLI so it repeated on every turn — codex,
        // which sends no model, printed a bare UUID and nothing else.
        return event.model ?? ''
      case 'assistant-text':
        return event.text
      case 'user-text':
        return event.text
      case 'tool-use':
        return this.formatToolUse(event.toolName, event.input)
      case 'tool-result':
        return event.text ?? ''
      case 'result': {
        // `event.text` is the CLI's copy of the final assistant message, which
        // already arrived as an assistant-text event; rendering it here showed
        // every answer twice. Errors are the exception: nothing else carries
        // their body.
        const summary = formatAiResultSummary(event)
        if (event.isError === true) {
          return event.text === undefined ? summary : `${summary}\n${event.text}`
        }
        // A successful turn is worth a row only when it reports something the
        // run pane does not already show. Codex sends neither figure, so its
        // `turn.completed` was a bare protocol word between every exchange.
        const hasFigures =
          event.totalCostUsd !== undefined || event.numTurns !== undefined
        return hasFigures ? summary : ''
      }
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
