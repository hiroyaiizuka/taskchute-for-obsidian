/**
 * AI Task - run orchestrator
 *
 * Coordinates one AI run per task note: reads the read-only `ai_task_*`
 * frontmatter and the `## Prompt` section, resolves the CLI binary and cwd,
 * dispatches the child process, buffers stream events with a bounded
 * head + tail cap, and persists a run log note when the run ends. Terminal
 * runs prefer the pane-registered snapshot provider (live xterm buffer) as
 * the transcript source and fall back to the ANSI-stripped PTY transcript
 * file; the temp file is consumed (deleted) either way.
 * followUp() resumes a finished run's CLI session with a new prompt and
 * keeps appending to the same record; each follow-up segment is also
 * collected separately and handed to the log writer so the existing note is
 * appended to (already-persisted transcript is never rebuilt from the
 * bounded in-memory buffer, which may have elided it). Log writes are
 * serialized per run (InternalRun.persistQueue) and followUp() waits for the
 * pending persist before mutating the record.
 *
 * Task-note frontmatter stays READ-ONLY here; the only vault write happens
 * inside AiTaskLogWriter at run end.
 *
 * startShellSession() additionally hosts plain login-shell terminal sessions
 * (host 'shell') through the same terminal infrastructure: they share the
 * run map, stop/dispose semantics (zombie guard included), and the terminal
 * data fan-out, but they belong to NO task note, are excluded from
 * getActiveRunForTask (no play/stop coupling, no row chip), and their exit
 * skips the log note AND the retention prune — only the PTY transcript temp
 * file is consumed before the closing 'persisted' notification.
 */

import type { TFile } from 'obsidian'
import { stableTimeoutSource } from '../../../utils/stableTimer'
import type { AiRunMode, AiRunRecord, AiStreamEvent, AiTaskHost } from '../types'
import { readAiTaskConfig } from './AiTaskFrontmatterReader'
import { extractPromptSection, type PromptHeadingInfo } from './PromptExtractor'
import { stripAnsiSequences } from './streams/AnsiStripper'
import { capEventText } from './streams/StreamJsonParser'
import type {
  AiDispatcher,
  AiGraceTimer,
  AiRunExitOutcome,
  AiRunProcessHandle,
} from './dispatchers/Dispatcher'
import type { AiTerminalDispatcher, TerminalRunHandle } from './dispatchers/TerminalDispatcher'
import type {
  WorkspaceDirectoryListing,
  WorkspaceFileDocument,
  WorkspaceFileService,
  WorkspaceFileVersion,
} from './WorkspaceFileService'
import type { AiBinaryResolution } from './BinaryLocator'
import type { RecipeContextSnapshot } from '../../recipe/services/RecipeDelegationContextBuilder'
import { buildRecipeDelegationPrompt } from '../../recipe/services/RecipeDelegationContextBuilder'
import { assertAiRunLaunchSize } from './AiRunLaunchSizeGuard'
import {
  AI_RUN_SESSION_SAVE_IDLE_DELAY_MS,
  type AiRunSessionSnapshot,
  type AiRunSessionStateStore,
  wasActiveBeforeRestore,
} from './AiRunSessionStateStore'

/** Events kept verbatim at the start of a run before elision kicks in */
export const AI_RUN_EVENT_HEAD_LIMIT = 200
/** Most recent events kept verbatim once the buffer overflows */
export const AI_RUN_EVENT_TAIL_LIMIT = 2000
/** Delay between dispose()'s SIGTERM sweep and the SIGKILL escalation */
export const DISPOSE_FORCE_KILL_MS = 1500
/**
 * Ring-buffer cap (utf16 code units) for a terminal run's replay buffer.
 * Late subscribers (a re-rendered pane) get this much recent output replayed
 * so the screen can be restored.
 */
export const TERMINAL_DATA_BUFFER_LIMIT = 200 * 1024
/** PTY size used when the caller provides no pane-derived dimensions */
export const DEFAULT_TERMINAL_ROWS = 24
export const DEFAULT_TERMINAL_COLS = 80
/**
 * Body written to the run log note when the PTY transcript temp file could
 * not be read at run end (deleted by the OS, permissions, disk error): the
 * note is still created so the run leaves a traceable record.
 */
export const TERMINAL_TRANSCRIPT_UNAVAILABLE_PLACEHOLDER =
  '(The terminal transcript could not be read; the session output was not captured.)'
/**
 * Raw PTY fallback bytes can contain dense redraw/control traffic. The vault
 * log keeps at most 512KiB downstream, so bound the expensive ANSI projection
 * to a 1MiB tail and avoid a transient multi-million-cell renderer array.
 */
export const TERMINAL_TRANSCRIPT_STRIP_INPUT_LIMIT = 1024 * 1024
const TERMINAL_TRANSCRIPT_STRIP_TRUNCATED_MARKER =
  '[transcript projection truncated: showing the final terminal output]'
/**
 * A broken/unmounted adapter must not block the run's persist queue forever.
 * The production xterm adapter has its own shorter write-drain deadline; this
 * manager-level boundary also protects custom/test providers and guarantees
 * transcript cleanup plus the terminal `persisted` notification.
 */
export const TERMINAL_SNAPSHOT_PROVIDER_TIMEOUT_MS = 2500

export const INTERRUPTED_RUN_ERROR_MESSAGE =
  'This run was interrupted by an Obsidian reload or restart. The previous terminal process cannot be reattached.'

/**
 * Arguments a plain shell session passes to the user's login shell
 * ($SHELL): an interactive login shell. Verified on-device: `$SHELL -i -l`
 * stays interactive under the script(1) PTY wrapper (prompt renders, typed
 * commands echo, transcript records) and dies cleanly on a process-group
 * SIGTERM. Mirrors the reference app's interactive spawn, minus its
 * zsh-only `-o NO_PROMPT_CR` option ($SHELL may be bash).
 */
export const SHELL_SESSION_ARGS: readonly string[] = ['-i', '-l']

/** Fallback display name when the caller provides no localized label */
const DEFAULT_SHELL_SESSION_NAME = 'Terminal'

const ACTIVE_STATUSES: ReadonlySet<AiRunRecord['status']> = new Set([
  'starting',
  'running',
  'stopping',
])

export class AiRunAlreadyActiveError extends Error {
  readonly taskPath: string

  constructor(taskPath: string) {
    super(`An AI run is already active for ${taskPath}`)
    this.name = 'AiRunAlreadyActiveError'
    this.taskPath = taskPath
  }
}

export class AiTaskManagerDisposedError extends Error {
  constructor() {
    super('AiTaskManager has been disposed')
    this.name = 'AiTaskManagerDisposedError'
  }
}

export class AiTaskNotConfiguredError extends Error {
  readonly taskPath: string

  constructor(taskPath: string) {
    super(`${taskPath} is not configured as an AI task (ai_task: true)`)
    this.name = 'AiTaskNotConfiguredError'
    this.taskPath = taskPath
  }
}

export class AiPromptNotFoundError extends Error {
  readonly taskPath: string

  constructor(taskPath: string) {
    super(`${taskPath} has no "## Prompt" section`)
    this.name = 'AiPromptNotFoundError'
    this.taskPath = taskPath
  }
}

export class AiRunNotFoundError extends Error {
  readonly runId: string

  constructor(runId: string) {
    super(`No AI run found for id ${runId}`)
    this.name = 'AiRunNotFoundError'
    this.runId = runId
  }
}

export class AiSessionUnavailableError extends Error {
  readonly runId: string

  constructor(runId: string) {
    super(`AI run ${runId} has no session id to resume`)
    this.name = 'AiSessionUnavailableError'
    this.runId = runId
  }
}

export class AiTerminalFollowUpError extends Error {
  readonly runId: string

  constructor(runId: string) {
    super(
      `AI run ${runId} is a terminal session; follow-ups go through the terminal input`,
    )
    this.name = 'AiTerminalFollowUpError'
    this.runId = runId
  }
}

/**
 * Thrown by startShellSession when plain shell sessions cannot run here:
 * terminal capabilities are absent, the platform has no PTY wrapper
 * (win32), or the deps expose no shell path.
 */
export class AiShellUnavailableError extends Error {
  constructor() {
    super('Shell terminal sessions are not available on this platform')
    this.name = 'AiShellUnavailableError'
  }
}

interface AiTaskFileCacheLike {
  frontmatter?: Record<string, unknown>
  headings?: PromptHeadingInfo[]
}

export interface AiTaskManagerDeps {
  app: {
    vault: {
      cachedRead(file: TFile): Promise<string>
      adapter?: unknown
    }
    metadataCache: {
      getFileCache(file: TFile): AiTaskFileCacheLike | null | undefined
    }
  }
  dispatchers: Record<AiTaskHost, AiDispatcher>
  binaryLocator: {
    resolve(host: AiTaskHost): Promise<AiBinaryResolution>
    invalidateCache?(): void
  }
  logWriter: {
    writeRunLog(record: AiRunRecord): Promise<unknown>
    /**
     * Append-or-create path used so follow-ups keep one note per run.
     * `continuationEvents` carries only the events streamed since the last
     * persist (user-text included); the writer appends them to the existing
     * note instead of rebuilding it from the bounded buffer. Optional so
     * plain create-only writers keep working; when absent the manager falls
     * back to writeRunLog.
     */
    upsertRunLog?(
      record: AiRunRecord,
      continuationEvents?: AiStreamEvent[],
    ): Promise<unknown>
    /**
     * Terminal-session note path: creates one note from the ANSI-stripped
     * PTY transcript. Optional; when absent the manager falls back to
     * writeRunLog (metadata-only note, since terminal runs buffer no events).
     */
    writeTerminalRunLog?(record: AiRunRecord, transcript: string): Promise<unknown>
    pruneOldLogs(): Promise<void>
  }
  /**
   * Terminal-mode capabilities. When absent (or isSupported() is false,
   * e.g. win32) every run is forced to headless mode.
   */
  terminal?: {
    dispatcher: AiTerminalDispatcher
    isSupported(): boolean
    /** Gateway helper: unique transcript path in the OS temp directory */
    makeTempFilePath(prefix: string): string
    /** Gateway helper: consume the transcript file at run end */
    readAndDeleteFile(path: string): Promise<string>
    /**
     * The user's login shell ($SHELL with a platform fallback). Required
     * only by startShellSession — optional so existing terminal-capability
     * fakes keep working; without it shell sessions are unavailable.
     */
    getShellPath?(): string
  }
  /** Desktop-only cwd browser used by the pane's lazy Files tree. */
  workspaceFiles?: Pick<WorkspaceFileService, 'listDirectory' | 'readFile' | 'writeFile'>
  /** Effective run mode from settings; consulted when startRun gets none */
  getRunMode?(): AiRunMode
  /** Device-local run workspace metadata + bounded terminal replay. */
  sessionState?: Pick<
    AiRunSessionStateStore,
    'load' | 'scheduleSave' | 'saveNow' | 'flush'
  >
  /** Optional Recipe v2 preflight. Disabled/missing recipes return null. */
  recipeContextProvider?: {
    getSnapshot(
      frontmatter: Record<string, unknown> | undefined,
    ): Promise<RecipeContextSnapshot | null>
  }
  /** Timer override for tests; production uses root-renderer stable timers */
  timer?: AiGraceTimer
  log?(level: 'warn' | 'error' | 'debug', ...args: unknown[]): void
}

/**
 * Discriminates onChange notifications: 'update' for status/event mutations,
 * 'persisted' fired exactly once per run exit AFTER the run's log persist
 * chain (note write + retention prune) has completed. Every exit path ends
 * with it — child-process exits AND dispatch failures where the child never
 * spawned (those persist a minimal failed-run note). UI that tears down a
 * run's terminal view (whose live buffer is the log-note transcript source)
 * must wait for 'persisted', never act on the final status 'update'.
 */
export type AiRunChangeType = 'update' | 'persisted'

export type AiRunChangeListener = (
  record: AiRunRecord,
  changeType: AiRunChangeType,
) => void

/** Per-run listener for raw terminal output chunks */
export type AiTerminalDataListener = (chunk: string) => void

/**
 * Returns the live xterm buffer of a terminal run as plain text, or
 * undefined when the pane holds no adapter for that run (pane unmounted,
 * tab never shown). Registered by the run pane; consumed once per terminal
 * run at exit as the preferred transcript source.
 */
export type AiTerminalSnapshotProvider = (
  runId: string,
) => string | undefined | Promise<string | undefined>

export interface AiRunStartOptions {
  /** Overrides the settings-provided run mode for this run */
  mode?: AiRunMode
  /** Task instance the run was started from (row chip scoping) */
  instanceId?: string
  /** PTY size derived from the pane; defaults apply when omitted */
  rows?: number
  cols?: number
}

export type AiPreparedRunStartOptions = Omit<AiRunStartOptions, 'mode'>

/**
 * Fully validated, immutable input produced before TaskChute changes a task
 * to Running. No vault read or binary lookup remains after this point.
 */
export interface PreparedAiRun {
  readonly taskPath: string
  readonly taskName: string
  readonly host: AiTaskHost
  readonly mode: AiRunMode
  readonly prompt: string
  readonly cwd?: string
  readonly extraArgs: readonly string[]
  readonly binaryPath: string
  readonly binaryArgsPrefix?: readonly string[]
  readonly recipeSnapshot: RecipeContextSnapshot | null
}

/**
 * Short-lived, manager-wide ownership marker for the gap between
 * prepareRun() and startPreparedRun().
 *
 * TaskChute may reload/rematerialize its rows while moving a just-started
 * timer from a past date to today. Keeping this reservation in the shared
 * manager prevents every mounted view from mistaking that timer for an
 * orphan before the prepared process is dispatched.
 */
export interface AiTaskStartReservation {
  readonly taskPath: string
  readonly reservationId: symbol
}

export interface AiShellSessionOptions {
  /** PTY size derived from the pane panel; defaults apply when omitted */
  cols?: number
  rows?: number
  /** Localized display name (e.g. "ターミナル"); defaults to 'Terminal' */
  name?: string
  /** Inherit the owning AI task's resolved workspace instead of Vault root. */
  cwd?: string
  /** Owning top-level AI run; its closure also closes this internal shell. */
  parentRunId?: string
}

interface InternalRun {
  record: AiRunRecord
  handle: AiRunProcessHandle | null
  /** Set alongside handle for terminal runs; carries the write() capability */
  terminalHandle: TerminalRunHandle | null
  exited: boolean
  /**
   * Bounded ring buffer of raw terminal output (terminal runs only): whole
   * chunks are evicted from the front once the total exceeds
   * TERMINAL_DATA_BUFFER_LIMIT, and the buffer is replayed to late
   * subscribers so a re-rendered pane can restore the screen.
   */
  terminalData: { chunks: string[]; totalLength: number } | null
  terminalListeners: Set<AiTerminalDataListener>
  /** Working directory captured at start, reused by follow-up dispatches */
  cwd?: string
  /** Extra CLI args captured at start, reused by follow-up dispatches */
  extraArgs: string[]
  /**
   * Events streamed since the current follow-up started (user-text included).
   * Null outside a follow-up. Handed to the log writer at exit so it appends
   * only the continuation instead of rebuilding the note from the bounded
   * buffer (which may have elided already-persisted events).
   */
  continuation: BoundedEventBuffer | null
  /**
   * Per-run persistence chain. Every exit appends its log write here, and
   * followUp() awaits it before mutating the record, so the note is never
   * composed from transient starting/running state, logNotePath is set
   * before the next segment persists (no duplicate note), and two upserts
   * never interleave on the same file.
   */
  persistQueue: Promise<void>
  /** Temp transcript paths already claimed for exactly-once consumption. */
  consumedTranscriptPaths: Set<string>
  /**
   * True only after the current exit's log/transcript persist chain completed.
   * A final status is published before persistence starts, so UI reclamation
   * must consult this flag instead of inferring completion from the status.
   */
  exitPersisted: boolean
  /** One-shot reverse timer reconciliation for a restored active task run. */
  needsTaskStateReconciliation: boolean
  /** In-memory claim; the durable marker remains until completion succeeds. */
  taskStateReconciliationClaimed: boolean
  /**
   * Shared reconciliation result scoped to the exact restored timer
   * generation. A settled operation remains observable by late-mounted
   * leaves, but must never be applied to a later timer of the same task.
   */
  taskStateReconciliationOperation: {
    generation: {
      instanceId?: string
      timerStartedAt?: number
    }
    pending: boolean
    promise: Promise<void>
  } | null
}

/** Mutable event buffer bounded by the shared head + tail cap */
interface BoundedEventBuffer {
  events: AiStreamEvent[]
  omittedCount: number
}

/**
 * Bounded append shared by the record buffer and follow-up continuation
 * segments: the first AI_RUN_EVENT_HEAD_LIMIT events and the last
 * AI_RUN_EVENT_TAIL_LIMIT events are kept verbatim; everything in between is
 * represented by a single elision marker event.
 */
function appendBoundedEvent(buffer: BoundedEventBuffer, event: AiStreamEvent): void {
  const events = buffer.events
  const capacity = AI_RUN_EVENT_HEAD_LIMIT + AI_RUN_EVENT_TAIL_LIMIT

  if (buffer.omittedCount === 0) {
    if (events.length < capacity) {
      events.push(event)
      return
    }
    // First overflow: replace the oldest tail event with the marker.
    buffer.omittedCount = 1
    events.splice(AI_RUN_EVENT_HEAD_LIMIT, 1, {
      kind: 'elision',
      omittedCount: 1,
    })
    events.push(event)
    return
  }

  buffer.omittedCount += 1
  events[AI_RUN_EVENT_HEAD_LIMIT] = {
    kind: 'elision',
    omittedCount: buffer.omittedCount,
  }
  events.splice(AI_RUN_EVENT_HEAD_LIMIT + 1, 1)
  events.push(event)
}

function createDefaultTimer(): AiGraceTimer {
  return stableTimeoutSource
}

function isAbsolutePathLike(path: string): boolean {
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return true

  // A Windows UNC path is absolute only after both the server and share
  // components are present. Keeping incomplete UNC, device namespaces, dot
  // segments, and drive-relative forms out of this branch prevents them from
  // bypassing vault-relative handling.
  const unc = /^\\\\([^\\/:*?"<>|]+)[\\/]([^\\/:*?"<>|]+)(?:[\\/]|$)/.exec(path)
  if (unc === null) return false
  return unc[1] !== '.' && unc[1] !== '..' && unc[2] !== '.' && unc[2] !== '..'
}

function joinCwd(basePath: string, relative: string): string {
  const base = basePath.replace(/[\\/]+$/, '')
  const rest = relative.replace(/^\.\//, '')
  return `${base}/${rest}`
}

function normalizeBinaryResolution(resolution: AiBinaryResolution): {
  binaryPath: string
  binaryArgsPrefix?: string[]
} {
  if (typeof resolution === 'string') return { binaryPath: resolution }
  return {
    binaryPath: resolution.binaryPath,
    binaryArgsPrefix:
      resolution.argsPrefix.length > 0 ? [...resolution.argsPrefix] : undefined,
  }
}

export class AiTaskManager {
  private readonly runs = new Map<string, InternalRun>()
  private readonly pendingStarts = new Set<string>()
  private readonly preparedStartReservations =
    new Map<string, AiTaskStartReservation>()
  /**
   * Task paths whose stop request arrived while startRun()/followUp() was
   * still in its async window (before the run registered or dispatched).
   * The dispatching call honours and clears the flag right after the child
   * spawns, so the stop is never silently lost.
   */
  private readonly stopRequestedDuringStart = new Set<string>()
  /** Cross-view lock for orphaned TaskChute timer repair. */
  private readonly orphanedTaskStateReconciliationClaims = new Set<string>()
  /** Prevent a fresh process start from racing an orphan repair write. */
  private readonly orphanedTaskPathReconciliationClaims = new Set<string>()
  /** Prevent a fresh process start while an interrupted timer is repaired. */
  private readonly interruptedTaskPathReconciliationClaims = new Set<string>()
  /**
   * One orphan repair per task path, shared by every mounted TaskChute view.
   * A successful entry is retained for the same timer identity so a late
   * participant can observe completion and clear its own TaskInstance.
   */
  private readonly orphanedTaskStateReconciliations = new Map<
    string,
    {
      ownerKey: string
      pending: boolean
      promise: Promise<void>
    }
  >()
  private readonly listeners = new Set<AiRunChangeListener>()
  private readonly timer: AiGraceTimer
  private readonly terminalSnapshotProviders: Array<{
    provider: AiTerminalSnapshotProvider
  }> = []
  private disposed = false
  private disposeCompletion: Promise<void> | null = null
  private disposeError: Error | null = null
  /** True only after the first broker shutdown attempt was unconfirmed. */
  private disposeShutdownFailed = false
  /** Shares one explicit retry across concurrent quit/settings callers. */
  private disposeShutdownRetry: Promise<void> | null = null
  private runSequence = 0

  constructor(private deps: AiTaskManagerDeps) {
    this.timer = deps.timer ?? createDefaultTimer()
    this.restoreSessionState()
  }

  /**
   * Rebind plugin-owned adapters after an Obsidian plugin hot reload.
   *
   * The manager itself may outlive one Plugin instance so its live process
   * handles and callbacks remain writable. New starts and eventual log writes
   * must nevertheless use the newly loaded settings/path services. Flush the
   * old coalesced store first so it cannot race a later write through the new
   * bridge, then atomically replace the dependency bundle.
   */
  rebindRuntimeDependencies(deps: AiTaskManagerDeps): void {
    this.throwIfDisposed()
    try {
      this.deps.sessionState?.flush()
    } catch (error) {
      this.deps.log?.(
        'warn',
        '[AiTaskManager] Failed to flush state before runtime handoff',
        error,
      )
    }
    this.deps = deps
    this.persistSessionStateNow()
  }

  /** Runtime-lease guard: disposed managers must never be adopted. */
  isDisposed(): boolean {
    return this.disposed
  }

  /**
   * Start an AI run for the given task note. Rejects with a typed error when
   * the manager is disposed, the note is not an AI task, has no prompt (see
   * below), or already has an active run. The disposed flag is re-checked
   * after every await so a dispose() during an in-flight start can never
   * spawn a child process that dispose()'s handle sweep would miss.
   *
   * `options.mode` (or the settings accessor) picks between an interactive
   * terminal (PTY) session and the headless stream-json pipeline; terminal
   * mode degrades to the conversation/headless pipeline where no PTY wrapper
   * exists (currently win32); follow-up input remains available there.
   * A missing or empty '## Prompt' section only rejects for headless runs —
   * a terminal session simply opens the CLI as a plain REPL (the user types
   * the prompt into the terminal).
   */
  async startRun(file: TFile, options?: AiRunStartOptions): Promise<AiRunRecord> {
    this.throwIfDisposed()
    const taskPath = file.path
    this.assertCanStart(taskPath)
    this.pendingStarts.add(taskPath)
    try {
      const prepared = await this.prepareRunCore(file, options?.mode)
      return this.startPreparedRunCore(prepared, options)
    } finally {
      this.pendingStarts.delete(taskPath)
      this.stopRequestedDuringStart.delete(taskPath)
    }
  }

  /**
   * Resolve prompt, recipe snapshot, binary, cwd, and arguments before the
   * caller mutates TaskChute timer state. This method has no process or vault
   * write side effects.
   */
  async prepareRun(file: TFile, options?: Pick<AiRunStartOptions, 'mode'>): Promise<PreparedAiRun> {
    this.throwIfDisposed()
    this.assertCanStart(file.path)
    return this.prepareRunCore(file, options?.mode)
  }

  /**
   * Reserve ownership of a TaskChute timer before the caller mutates and
   * persists it. The returned object is an identity token: only that exact
   * token can consume or release the reservation.
   */
  reserveTaskStart(taskPath: string): AiTaskStartReservation {
    this.throwIfDisposed()
    this.assertCanStart(taskPath)
    const reservation = Object.freeze({
      taskPath,
      reservationId: Symbol(taskPath),
    })
    this.preparedStartReservations.set(taskPath, reservation)
    return reservation
  }

  /**
   * Cancel an unused reservation. Idempotent so callers can release from a
   * finally block even after startPreparedRun() consumed it.
   */
  releaseTaskStartReservation(reservation: AiTaskStartReservation): void {
    const current = this.preparedStartReservations.get(reservation.taskPath)
    if (current !== reservation) return
    this.preparedStartReservations.delete(reservation.taskPath)
    if (
      !this.pendingStarts.has(reservation.taskPath) &&
      !this.getActiveRunForTask(reservation.taskPath)
    ) {
      this.stopRequestedDuringStart.delete(reservation.taskPath)
    }
  }

  /** Spawn a value returned by prepareRun after the caller starts its timer. */
  async startPreparedRun(
    prepared: PreparedAiRun,
    options?: AiPreparedRunStartOptions,
    reservation?: AiTaskStartReservation,
  ): Promise<AiRunRecord> {
    // Preserve the asynchronous public boundary even though a prepared run
    // has no remaining I/O before dispatch.
    await Promise.resolve()
    this.throwIfDisposed()
    this.assertCanStart(prepared.taskPath, reservation)
    this.pendingStarts.add(prepared.taskPath)
    if (reservation) {
      this.preparedStartReservations.delete(prepared.taskPath)
    }
    try {
      return this.startPreparedRunCore(prepared, options)
    } finally {
      this.pendingStarts.delete(prepared.taskPath)
      this.stopRequestedDuringStart.delete(prepared.taskPath)
    }
  }

  private assertCanStart(
    taskPath: string,
    reservation?: AiTaskStartReservation,
  ): void {
    const currentReservation = this.preparedStartReservations.get(taskPath)
    if (
      this.pendingStarts.has(taskPath) ||
      (
        currentReservation !== undefined &&
        currentReservation !== reservation
      ) ||
      (
        reservation !== undefined &&
        (
          reservation.taskPath !== taskPath ||
          currentReservation !== reservation
        )
      ) ||
      this.orphanedTaskPathReconciliationClaims.has(taskPath) ||
      this.interruptedTaskPathReconciliationClaims.has(taskPath) ||
      this.getActiveRunForTask(taskPath)
    ) {
      throw new AiRunAlreadyActiveError(taskPath)
    }
  }

  private async prepareRunCore(
    file: TFile,
    requestedMode?: AiRunMode,
  ): Promise<PreparedAiRun> {
    const taskPath = file.path
    const cache = this.deps.app.metadataCache.getFileCache(file) ?? undefined
    const config = readAiTaskConfig(cache?.frontmatter)
    if (!config) throw new AiTaskNotConfiguredError(taskPath)

    const content = await this.deps.app.vault.cachedRead(file)
    this.throwIfDisposed()
    const mode = this.resolveRunMode(requestedMode)
    const extractedPrompt = extractPromptSection(content, cache?.headings)
    const recipeSnapshot = this.deps.recipeContextProvider
      ? await this.deps.recipeContextProvider.getSnapshot(cache?.frontmatter)
      : null
    this.throwIfDisposed()
    if (extractedPrompt === null && mode !== 'terminal' && recipeSnapshot === null) {
      throw new AiPromptNotFoundError(taskPath)
    }
    const prompt = buildRecipeDelegationPrompt(
      extractedPrompt ?? '',
      recipeSnapshot,
    )

    const cwd = this.resolveCwd(config.cwd)
    const binaryResolution = await this.deps.binaryLocator.resolve(config.host)
    const { binaryPath, binaryArgsPrefix } = normalizeBinaryResolution(binaryResolution)
    this.throwIfDisposed()
    assertAiRunLaunchSize({
      binaryPath,
      binaryArgsPrefix,
      extraArgs: config.args,
      prompt,
    })

    return Object.freeze({
      taskPath,
      taskName: file.basename,
      host: config.host,
      mode,
      prompt,
      cwd,
      extraArgs: Object.freeze([...config.args]),
      binaryPath,
      binaryArgsPrefix: binaryArgsPrefix
        ? Object.freeze([...binaryArgsPrefix])
        : undefined,
      recipeSnapshot,
    })
  }

  private startPreparedRunCore(
    prepared: PreparedAiRun,
    options?: AiPreparedRunStartOptions,
  ): AiRunRecord {
    this.throwIfDisposed()
    const {
      taskPath,
      taskName,
      host,
      mode,
      prompt,
      cwd,
      binaryPath,
      binaryArgsPrefix,
      recipeSnapshot,
    } = prepared
    const extraArgs = [...prepared.extraArgs]

    this.runSequence += 1
    const record: AiRunRecord = {
      id: `ai-run-${Date.now()}-${this.runSequence}`,
      taskPath,
      taskName,
      cwd,
      host,
      status: 'starting',
      mode,
      instanceId: options?.instanceId,
      startedAt: Date.now(),
      events: [],
      ...(recipeSnapshot
        ? {
            recipePath: recipeSnapshot.recipePath,
            recipeVersion: recipeSnapshot.recipeVersion,
            recipeContentHash: recipeSnapshot.recipeContentHash,
          }
        : {}),
    }
    const terminal = mode === 'terminal' ? this.deps.terminal : undefined
    if (terminal) {
      record.transcriptPath = terminal.makeTempFilePath(`taskchute-${record.id}`)
      record.rows = options?.rows ?? DEFAULT_TERMINAL_ROWS
      record.cols = options?.cols ?? DEFAULT_TERMINAL_COLS
    }
    const internal: InternalRun = {
      record,
      handle: null,
      terminalHandle: null,
      exited: false,
      terminalData: terminal ? { chunks: [], totalLength: 0 } : null,
      terminalListeners: new Set(),
      cwd,
      extraArgs,
      continuation: null,
      persistQueue: Promise.resolve(),
      consumedTranscriptPaths: new Set(),
      exitPersisted: false,
      needsTaskStateReconciliation: false,
      taskStateReconciliationClaimed: false,
      taskStateReconciliationOperation: null,
    }
    this.runs.set(record.id, internal)
    this.persistSessionStateNow()
    this.notifyChange(record)

    try {
      if (terminal) {
        const terminalHandle = terminal.dispatcher.start(
          {
            sessionId: record.id,
            binaryPath,
            binaryArgsPrefix: binaryArgsPrefix ? [...binaryArgsPrefix] : undefined,
            prompt,
            cwd,
            extraArgs,
            launchInShell: true,
            rows: record.rows ?? DEFAULT_TERMINAL_ROWS,
            cols: record.cols ?? DEFAULT_TERMINAL_COLS,
            transcriptPath: record.transcriptPath ?? '',
          },
          {
            onData: (chunk) => this.handleTerminalData(internal, chunk),
            onExit: (outcome) => this.handleExit(internal, outcome),
            onAttached: (pid, transcriptPath) =>
              this.handleTerminalAttached(internal, pid, transcriptPath),
            onUnavailable: (transcriptPath) =>
              this.markTerminalUnavailable(
                internal,
                undefined,
                transcriptPath,
              ),
          },
        )
        record.terminalSessionId = terminalHandle.sessionId
        internal.terminalHandle = terminalHandle
        internal.handle = terminalHandle
      } else {
        internal.handle = this.deps.dispatchers[host].start(
          {
            binaryPath,
            binaryArgsPrefix: binaryArgsPrefix ? [...binaryArgsPrefix] : undefined,
            prompt,
            cwd,
            extraArgs,
          },
          {
            onEvent: (event) => this.handleEvent(internal, event),
            onExit: (outcome) => this.handleExit(internal, outcome),
          },
        )
      }
    } catch (error) {
      internal.exited = true
      record.status = 'failed'
      record.endedAt = Date.now()
      record.errorMessage = error instanceof Error ? error.message : String(error)
      this.notifyChange(record)
      this.queueExitPersist(internal)
      throw error
    }

    if (!internal.exited && record.status === 'starting') {
      record.pid = internal.handle.pid
      record.status = 'running'
      this.notifyChange(record)
    }
    if (this.stopRequestedDuringStart.has(taskPath)) {
      this.stopRun(record.id)
    }
    return record
  }

  /**
   * Start a plain login-shell terminal session (host 'shell'). Synchronous
   * by design — no note read and no binary resolution happen — so the split
   * UI can show the session the moment the split lands. The record shares
   * the regular run lifecycle (status transitions, stop, dispose zombie
   * guard, terminal data fan-out) but is never a task run: see the class
   * doc. Throws AiShellUnavailableError where shell sessions cannot run.
   */
  startShellSession(options: AiShellSessionOptions = {}): AiRunRecord {
    this.throwIfDisposed()
    const terminal = this.deps.terminal
    if (
      !terminal ||
      !terminal.isSupported() ||
      typeof terminal.getShellPath !== 'function'
    ) {
      throw new AiShellUnavailableError()
    }
    const shellPath = terminal.getShellPath()
    const name = options.name?.trim()

    this.runSequence += 1
    const record: AiRunRecord = {
      id: `ai-run-${Date.now()}-${this.runSequence}`,
      taskPath: '',
      taskName: name !== undefined && name.length > 0 ? name : DEFAULT_SHELL_SESSION_NAME,
      cwd: options.cwd ?? this.getVaultBasePath(),
      parentRunId: options.parentRunId,
      host: 'shell',
      status: 'starting',
      mode: 'terminal',
      startedAt: Date.now(),
      events: [],
    }
    // Same contract as startRun: the grid and transcript path are stamped
    // BEFORE the first notifyChange so the pane opens its ONE-SHOT xterm
    // view with the exact PTY grid the session spawns at.
    record.transcriptPath = terminal.makeTempFilePath(`taskchute-${record.id}`)
    record.rows = options.rows ?? DEFAULT_TERMINAL_ROWS
    record.cols = options.cols ?? DEFAULT_TERMINAL_COLS

    const internal: InternalRun = {
      record,
      handle: null,
      terminalHandle: null,
      exited: false,
      terminalData: { chunks: [], totalLength: 0 },
      terminalListeners: new Set(),
      cwd: record.cwd,
      extraArgs: [],
      continuation: null,
      persistQueue: Promise.resolve(),
      consumedTranscriptPaths: new Set(),
      exitPersisted: false,
      needsTaskStateReconciliation: false,
      taskStateReconciliationClaimed: false,
      taskStateReconciliationOperation: null,
    }
    this.runs.set(record.id, internal)
    this.persistSessionStateNow()
    this.notifyChange(record)

    try {
      const terminalHandle = terminal.dispatcher.start(
        {
          sessionId: record.id,
          binaryPath: shellPath,
          prompt: '',
          cwd: internal.cwd,
          extraArgs: [...SHELL_SESSION_ARGS],
          rows: record.rows ?? DEFAULT_TERMINAL_ROWS,
          cols: record.cols ?? DEFAULT_TERMINAL_COLS,
          transcriptPath: record.transcriptPath ?? '',
        },
        {
          onData: (chunk) => this.handleTerminalData(internal, chunk),
          onExit: (outcome) => this.handleExit(internal, outcome),
          onAttached: (pid, transcriptPath) =>
            this.handleTerminalAttached(internal, pid, transcriptPath),
          onUnavailable: (transcriptPath) =>
            this.markTerminalUnavailable(
              internal,
              undefined,
              transcriptPath,
            ),
        },
      )
      record.terminalSessionId = terminalHandle.sessionId
      internal.terminalHandle = terminalHandle
      internal.handle = terminalHandle
    } catch (error) {
      internal.exited = true
      record.status = 'failed'
      record.endedAt = Date.now()
      record.errorMessage = error instanceof Error ? error.message : String(error)
      this.notifyChange(record)
      // The lifecycle contract still ends with 'persisted' (transcript
      // cleanup only — shell sessions never write a note).
      this.queueExitPersist(internal)
      throw error
    }

    if (!internal.exited && record.status === 'starting') {
      record.pid = internal.handle.pid
      record.status = 'running'
      this.notifyChange(record)
    }
    return record
  }

  /**
   * Send a follow-up prompt to a finished run by resuming its CLI session.
   * The streamed continuation appends to the SAME record (and the same log
   * note is rewritten at exit). Rejects when the run is unknown, still
   * active, has no session id, another run is active for the task, or the
   * run gets released (view closed) during one of the async windows below
   * (see throwIfReleased).
   */
  async followUp(runId: string, prompt: string): Promise<AiRunRecord> {
    this.throwIfDisposed()
    const internal = this.runs.get(runId)
    if (!internal) throw new AiRunNotFoundError(runId)
    const record = internal.record
    const host = record.host
    if (record.mode === 'terminal' || host === 'shell') {
      // Terminal sessions (shell sessions are always terminal-mode) take
      // input directly (sendTerminalInput); there is no headless resume
      // path for them. The host check also narrows `host` to the CLI hosts
      // for the dispatcher lookup below.
      throw new AiTerminalFollowUpError(runId)
    }
    const taskPath = record.taskPath
    if (
      this.pendingStarts.has(taskPath) ||
      this.preparedStartReservations.has(taskPath) ||
      !internal.exited ||
      ACTIVE_STATUSES.has(record.status) ||
      this.getActiveRunForTask(taskPath)
    ) {
      throw new AiRunAlreadyActiveError(taskPath)
    }
    const sessionId = record.sessionId
    if (sessionId === undefined || sessionId.length === 0) {
      throw new AiSessionUnavailableError(runId)
    }
    const text = prompt.trim()
    if (text.length === 0) {
      throw new Error('Follow-up prompt is empty')
    }

    this.pendingStarts.add(taskPath)
    try {
      // Wait for the previous segment's log persist: the note must be
      // written with its finished frontmatter (and logNotePath recorded)
      // before this follow-up mutates the record back to starting/running.
      await internal.persistQueue
      this.throwIfDisposed()
      this.throwIfReleased(runId, internal)
      // Resolve the binary BEFORE mutating the record so a missing binary
      // leaves the run in its finished state and the follow-up retryable.
      const binaryResolution = await this.deps.binaryLocator.resolve(host)
      const { binaryPath, binaryArgsPrefix } = normalizeBinaryResolution(binaryResolution)
      this.throwIfDisposed()
      this.throwIfReleased(runId, internal)
      assertAiRunLaunchSize({
        binaryPath,
        binaryArgsPrefix,
        extraArgs: internal.extraArgs,
        prompt: text,
      })

      const userEvent: AiStreamEvent = { kind: 'user-text', text: capEventText(text) }
      this.appendEvent(record, userEvent)
      internal.continuation = { events: [], omittedCount: 0 }
      appendBoundedEvent(internal.continuation, userEvent)
      record.status = 'starting'
      record.resumedAt = Date.now()
      record.endedAt = undefined
      record.exitCode = undefined
      record.errorMessage = undefined
      internal.exited = false
      internal.exitPersisted = false
      this.notifyChange(record)

      try {
        internal.handle = this.deps.dispatchers[host].start(
          {
            binaryPath,
            binaryArgsPrefix,
            prompt: text,
            cwd: internal.cwd,
            extraArgs: internal.extraArgs,
            resumeSessionId: sessionId,
          },
          {
            onEvent: (event) => this.handleEvent(internal, event),
            onExit: (outcome) => this.handleExit(internal, outcome),
          },
        )
      } catch (error) {
        internal.exited = true
        internal.continuation = null
        // Roll back the user-text event so a successful retry does not
        // render the prompt twice in the pane and the transcript.
        const userEventIndex = record.events.lastIndexOf(userEvent)
        if (userEventIndex >= 0) {
          record.events.splice(userEventIndex, 1)
        }
        record.status = 'failed'
        record.endedAt = Date.now()
        record.errorMessage = error instanceof Error ? error.message : String(error)
        this.notifyChange(record)
        // This segment's exit also ends with 'persisted': the existing note
        // gets its frontmatter refreshed (failed + error, no continuation —
        // the rolled-back user text is never appended).
        this.queueExitPersist(internal)
        throw error
      }

      if (!internal.exited && record.status === 'starting') {
        record.pid = internal.handle.pid
        record.status = 'running'
        this.notifyChange(record)
      }
      // Honour a stop that was requested while this follow-up was still in
      // its async window (persist + binary resolution above).
      if (this.stopRequestedDuringStart.has(taskPath)) {
        this.stopRun(record.id)
      }
      return record
    } finally {
      this.pendingStarts.delete(taskPath)
      this.stopRequestedDuringStart.delete(taskPath)
    }
  }

  /** Request a graceful stop (SIGTERM, then SIGKILL after the grace period) */
  stopRun(runId: string): void {
    const internal = this.runs.get(runId)
    if (!internal || internal.exited || !internal.handle) return
    if (!ACTIVE_STATUSES.has(internal.record.status)) return
    internal.record.status = 'stopping'
    this.notifyChange(internal.record)
    internal.handle.stop()
  }

  getRuns(): AiRunRecord[] {
    return Array.from(this.runs.values(), (internal) => internal.record)
  }

  getRun(runId: string): AiRunRecord | undefined {
    return this.runs.get(runId)?.record
  }

  /**
   * Whether the current final status has completed its log/transcript chain.
   * The pane uses this during mount so a final-status update followed by a
   * view remount cannot dispose the snapshot source while persistence is
   * still awaiting it.
   */
  isRunExitPersisted(runId: string): boolean {
    return this.runs.get(runId)?.exitPersisted === true
  }

  /**
   * Claim the one-time TaskChute timer reconciliation for a run that was live
   * before this manager instance restored it as interrupted. Multiple mounted
   * views cannot race the same running -> done transition.
   */
  claimInterruptedTaskStateReconciliation(runId: string): boolean {
    const internal = this.runs.get(runId)
    if (
      !internal ||
      !internal.needsTaskStateReconciliation ||
      internal.taskStateReconciliationClaimed ||
      internal.record.status !== 'interrupted' ||
      internal.record.host === 'shell'
    ) {
      return false
    }
    internal.taskStateReconciliationClaimed = true
    return true
  }

  /** Clear the durable marker only after TaskChute's running state settled. */
  completeInterruptedTaskStateReconciliation(runId: string): void {
    const internal = this.runs.get(runId)
    if (!internal || !internal.needsTaskStateReconciliation) return
    internal.needsTaskStateReconciliation = false
    internal.taskStateReconciliationClaimed = false
    if (!this.disposed) this.persistSessionStateNow()
  }

  /** Allow a failed reconciliation attempt to retry without losing history. */
  retryInterruptedTaskStateReconciliation(runId: string): void {
    const internal = this.runs.get(runId)
    if (!internal || !internal.needsTaskStateReconciliation) return
    internal.taskStateReconciliationClaimed = false
  }

  /**
   * Run the durable interrupted-timer repair once and expose that same
   * promise to every mounted view. Callers must still re-read and clear their
   * own TaskInstance objects after this resolves: those objects are not
   * shared between leaves.
   *
   * Returns false when the run has no reconciliation marker. A failed repair
   * rejects for every waiter and re-arms the marker for a later reload.
   */
  async coordinateInterruptedTaskStateReconciliation(
    runId: string,
    generation: { instanceId?: string; timerStartedAt?: number },
    repair: () => Promise<void>,
  ): Promise<boolean> {
    const internal = this.runs.get(runId)
    if (
      !internal ||
      internal.record.status !== 'interrupted' ||
      internal.record.host === 'shell'
    ) {
      return false
    }
    const existing = internal.taskStateReconciliationOperation
    if (existing) {
      if (
        existing.generation.instanceId !== generation.instanceId ||
        existing.generation.timerStartedAt !== generation.timerStartedAt
      ) {
        return false
      }
      await existing.promise
      return true
    }
    if (!internal.needsTaskStateReconciliation) return false
    const restoredCutoff = internal.record.endedAt
    if (
      generation.timerStartedAt === undefined
        ? (
            internal.record.instanceId === undefined ||
            generation.instanceId !== internal.record.instanceId
          )
        : (
            restoredCutoff !== undefined &&
            generation.timerStartedAt > restoredCutoff
          )
    ) {
      return false
    }

    internal.taskStateReconciliationClaimed = true
    if (internal.record.taskPath.length > 0) {
      this.interruptedTaskPathReconciliationClaims.add(internal.record.taskPath)
    }
    const operation = {
      generation: { ...generation },
      pending: true,
      promise: Promise.resolve(),
    }
    const reconciliation = Promise.resolve()
      .then(repair)
      .then(() => {
        this.completeInterruptedTaskStateReconciliation(runId)
        operation.pending = false
        this.interruptedTaskPathReconciliationClaims.delete(
          internal.record.taskPath,
        )
      })
      .catch((error: unknown) => {
        this.interruptedTaskPathReconciliationClaims.delete(
          internal.record.taskPath,
        )
        if (internal.taskStateReconciliationOperation === operation) {
          internal.taskStateReconciliationOperation = null
        }
        this.retryInterruptedTaskStateReconciliation(runId)
        throw error
      })
    operation.promise = reconciliation
    internal.taskStateReconciliationOperation = operation
    await reconciliation
    return true
  }

  async listWorkspaceDirectory(
    rootPath: string,
    directoryPath?: string,
  ): Promise<WorkspaceDirectoryListing> {
    const workspaceFiles = this.requireWorkspaceFiles()
    return await workspaceFiles.listDirectory(rootPath, directoryPath)
  }

  async readWorkspaceFile(
    rootPath: string,
    filePath: string,
  ): Promise<WorkspaceFileDocument> {
    const workspaceFiles = this.requireWorkspaceFiles()
    return await workspaceFiles.readFile(rootPath, filePath)
  }

  async writeWorkspaceFile(
    rootPath: string,
    filePath: string,
    content: string,
    expectedVersion: WorkspaceFileVersion,
  ): Promise<WorkspaceFileDocument> {
    const workspaceFiles = this.requireWorkspaceFiles()
    return await workspaceFiles.writeFile(
      rootPath,
      filePath,
      content,
      expectedVersion,
    )
  }

  /**
   * Drop a FINISHED run's record from the manager. The pane calls this when
   * a run's view closes for good (× on a finished run, the stopped-run
   * auto-close on 'persisted', a rolled-back shell spawn) so a later view
   * remount does not resurrect the closed run and the record's buffers
   * become collectable. Active (not yet exited) runs are never released;
   * unknown ids are a no-op. The pending persist chain is unaffected — it
   * captured its InternalRun reference when the exit was queued.
   */
  releaseRun(runId: string): void {
    const internal = this.runs.get(runId)
    if (!internal) return
    if (!internal.exited || ACTIVE_STATUSES.has(internal.record.status)) return
    internal.terminalListeners.clear()
    this.runs.delete(runId)
    this.persistSessionStateNow()
  }

  /**
   * Stop whatever is (or is about to be) running for the task: stops the
   * registered active run, and when the only activity is an in-flight
   * startRun()/followUp() (the async window before the run registers), the
   * stop is queued and executed right after the dispatch lands. No-op when
   * the task has neither. Preferred entry point for play/stop coupling.
   */
  requestStopForTask(taskPath: string): void {
    const activeRun = this.getActiveRunForTask(taskPath)
    if (activeRun) {
      this.stopRun(activeRun.id)
      return
    }
    if (
      this.pendingStarts.has(taskPath) ||
      this.preparedStartReservations.has(taskPath)
    ) {
      this.stopRequestedDuringStart.add(taskPath)
    }
  }

  /**
   * Subscribe to a terminal run's raw output. The bounded replay buffer is
   * delivered synchronously on subscribe (one concatenated chunk) so a
   * re-rendered pane can restore the screen; live chunks follow. Unknown run
   * ids get a no-op disposer.
   */
  onTerminalData(runId: string, listener: AiTerminalDataListener): () => void {
    const internal = this.runs.get(runId)
    if (!internal || this.disposed) return () => undefined

    internal.terminalListeners.add(listener)
    const buffered = internal.terminalData
    if (buffered && buffered.totalLength > 0) {
      try {
        listener(buffered.chunks.join(''))
      } catch (error) {
        this.deps.log?.('warn', '[AiTaskManager] Terminal replay listener failed', error)
      }
    }
    return () => {
      internal.terminalListeners.delete(listener)
    }
  }

  /**
   * Relay keyboard input to an active terminal run. Silent no-op for
   * unknown, finished, or headless runs (the pane simply has nowhere to
   * type into).
   */
  sendTerminalInput(runId: string, data: string): void {
    const internal = this.runs.get(runId)
    if (!internal || internal.exited || !internal.terminalHandle) return
    if (!ACTIVE_STATUSES.has(internal.record.status)) return
    internal.terminalHandle.write(data)
  }

  /** Keep the live OS PTY grid synchronized with xterm's fitted dimensions. */
  resizeTerminal(runId: string, cols: number, rows: number): void {
    const internal = this.runs.get(runId)
    if (!internal || internal.exited) return
    if (internal.record.mode !== 'terminal') return
    if (!ACTIVE_STATUSES.has(internal.record.status)) return
    internal.record.cols = cols
    internal.record.rows = rows
    // The pane opens synchronously from the first `starting` notification,
    // just before the dispatcher returns a terminal handle. Preserve that
    // exact first fit on the record so startPreparedRunCore spawns the PTY
    // with it; once a handle exists, resize the live PTY as usual.
    internal.terminalHandle?.resize?.(cols, rows)
    this.scheduleSessionStatePersist()
  }

  getActiveRunForTask(taskPath: string): AiRunRecord | undefined {
    for (const internal of this.runs.values()) {
      // Shell sessions belong to no task note: they must never surface as a
      // task's active run (row chip, play/stop coupling, composer gating).
      if (internal.record.host === 'shell') continue
      if (
        internal.record.taskPath === taskPath &&
        ACTIVE_STATUSES.has(internal.record.status)
      ) {
        return internal.record
      }
    }
    return undefined
  }

  /**
   * Whether a TaskChute running timer still has a corresponding AI lifecycle.
   *
   * This is intentionally broader than getActiveRunForTask(): while a start
   * is awaiting note/binary I/O there is no run record yet, and a restored
   * interrupted run remains responsible for resetting its timer until the
   * durable reconciliation marker is cleared.  TaskChuteView uses this as a
   * crash-recovery guard so a missing/corrupt workspace snapshot cannot leave
   * an AI task timer running forever.
   */
  hasTaskRunLifecycle(
    taskPath: string,
    owner?: { instanceId?: string; timerStartedAt?: number },
  ): boolean {
    if (
      this.pendingStarts.has(taskPath) ||
      this.preparedStartReservations.has(taskPath)
    ) {
      return true
    }
    for (const internal of this.runs.values()) {
      const record = internal.record
      if (record.host === 'shell' || record.taskPath !== taskPath) continue
      if (ACTIVE_STATUSES.has(record.status)) return true
      if (
        record.status === 'interrupted' &&
        internal.needsTaskStateReconciliation
      ) {
        return true
      }
      // A headless run may finish before its TaskChute timer is stopped. Its
      // completed record is still valid ownership evidence for that exact
      // timer, but an older run of the same task must not mask a newly
      // orphaned start. `endedAt >= timerStartedAt` separates those cases.
      if (
        owner?.instanceId &&
        record.instanceId === owner.instanceId &&
        owner.timerStartedAt !== undefined &&
        record.endedAt !== undefined &&
        record.endedAt >= owner.timerStartedAt
      ) {
        return true
      }
    }
    return false
  }

  /**
   * Claim an orphan repair across every mounted TaskChute view. Each view has
   * its own TaskInstance objects, so a manager-owned lock prevents two leaves
   * from racing writes to the same running-task.json record.
   */
  claimOrphanedTaskStateReconciliation(
    taskPath: string,
    owner?: { instanceId?: string; timerStartedAt?: number },
  ): boolean {
    if (this.hasTaskRunLifecycle(taskPath, owner)) return false
    const identity = owner?.instanceId || taskPath
    if (
      this.orphanedTaskStateReconciliationClaims.has(identity) ||
      this.orphanedTaskPathReconciliationClaims.has(taskPath)
    ) {
      return false
    }
    this.orphanedTaskStateReconciliationClaims.add(identity)
    this.orphanedTaskPathReconciliationClaims.add(taskPath)
    return true
  }

  /** Release the cross-view orphan lock after success or a retryable failure. */
  releaseOrphanedTaskStateReconciliation(
    taskPath: string,
    instanceId?: string,
  ): void {
    this.orphanedTaskStateReconciliationClaims.delete(instanceId || taskPath)
    this.orphanedTaskPathReconciliationClaims.delete(taskPath)
  }

  /**
   * Coordinate a missing-snapshot repair across mounted views. The durable
   * running-task record is deleted once; every caller awaits that deletion
   * and can then idle its independently restored TaskInstance objects.
   */
  async coordinateOrphanedTaskStateReconciliation(
    taskPath: string,
    owner: { instanceId?: string; timerStartedAt?: number } | undefined,
    repair: () => Promise<void>,
  ): Promise<boolean> {
    const existing = this.orphanedTaskStateReconciliations.get(taskPath)
    if (existing?.pending) {
      await existing.promise
      return true
    }
    if (this.hasTaskRunLifecycle(taskPath, owner)) return false

    const ownerKey = `${owner?.instanceId ?? ''}\u0000${owner?.timerStartedAt ?? ''}`
    if (existing?.ownerKey === ownerKey) {
      await existing.promise
      return true
    }
    if (!this.claimOrphanedTaskStateReconciliation(taskPath, owner)) return false

    const operation = {
      ownerKey,
      pending: true,
      promise: Promise.resolve(),
    }
    const reconciliation = Promise.resolve()
      .then(repair)
      .then(() => {
        operation.pending = false
        this.releaseOrphanedTaskStateReconciliation(taskPath, owner?.instanceId)
      })
      .catch((error: unknown) => {
        this.releaseOrphanedTaskStateReconciliation(taskPath, owner?.instanceId)
        if (this.orphanedTaskStateReconciliations.get(taskPath) === operation) {
          this.orphanedTaskStateReconciliations.delete(taskPath)
        }
        throw error
      })
    operation.promise = reconciliation
    this.orphanedTaskStateReconciliations.set(taskPath, operation)
    await reconciliation
    return true
  }

  /**
   * Register the SINGLE snapshot provider used to read a terminal run's live
   * xterm buffer when its log note is composed at exit (preferred over the
   * ANSI-stripped PTY transcript file, which is TUI redraw garbage). A later
   * registration becomes active; unregistering it restores the most recently
   * registered provider that is still mounted. Registrations are represented
   * by distinct tokens so a stale disposer (or the same callback registered
   * twice) can remove only its own entry without clobbering a newer provider.
   */
  registerTerminalSnapshotProvider(provider: AiTerminalSnapshotProvider): () => void {
    const registration = { provider }
    this.terminalSnapshotProviders.push(registration)
    let unregistered = false
    return () => {
      if (unregistered) return
      unregistered = true
      const index = this.terminalSnapshotProviders.indexOf(registration)
      if (index >= 0) this.terminalSnapshotProviders.splice(index, 1)
    }
  }

  /** Drop cached binary locations (call when the path overrides change) */
  invalidateBinaryCache(): void {
    this.deps.binaryLocator.invalidateCache?.()
  }

  /** Subscribe to run changes. Returns a disposer that removes the listener. */
  onChange(listener: AiRunChangeListener): () => void {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Renderer replacement is not an app quit. Persist live broker identities
   * and close only this renderer's IPC transport; non-persistent processes
   * are stopped because no future renderer can safely own their callbacks.
   */
  prepareForRendererReload(): void {
    if (this.disposed) return
    this.persistSessionStateNow()
    const persistentTerminal =
      this.deps.terminal?.dispatcher.isPersistent === true
    for (const internal of this.runs.values()) {
      internal.terminalListeners.clear()
      if (internal.exited || !internal.handle) continue
      if (internal.record.mode === 'terminal' && persistentTerminal) continue
      try {
        internal.handle.stop()
      } catch (error) {
        this.deps.log?.(
          'warn',
          '[AiTaskManager] Failed to stop non-persistent run on renderer reload',
          error,
        )
      }
    }
    try {
      this.deps.terminal?.dispatcher.detach?.()
    } catch (error) {
      this.deps.log?.(
        'warn',
        '[AiTaskManager] Failed to detach terminal broker',
        error,
      )
    }
    this.listeners.clear()
    this.terminalSnapshotProviders.length = 0
  }

  /** Stop every active run. Idempotent; see disposeAndWait for app quit. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.preparedStartReservations.clear()
    this.stopRequestedDuringStart.clear()

    // Persist the pre-stop statuses first. Exit callbacks may race the
    // SIGTERM sweep below, but once disposed they must not overwrite these
    // snapshots with `stopped`; the next manager restores them safely as
    // interrupted and preserves their replay/history in the pane.
    this.persistSessionStateNow()

    const activeHandles: AiRunProcessHandle[] = []
    for (const internal of this.runs.values()) {
      internal.terminalListeners.clear()
      if (internal.exited || !internal.handle) continue
      activeHandles.push(internal.handle)
      try {
        internal.handle.stop()
      } catch (error) {
        this.deps.log?.('warn', '[AiTaskManager] Failed to stop run on dispose', error)
      }
    }

    let handleStopCompletion: Promise<void>
    if (activeHandles.length > 0) {
      const forceKillHandles = () => {
        for (const handle of activeHandles) {
          try {
            handle.forceKill?.()
          } catch (error) {
            this.deps.log?.('warn', '[AiTaskManager] Force kill failed', error)
          }
        }
      }
      handleStopCompletion = new Promise<void>((resolve) => {
        try {
          this.timer.setTimeout(() => {
            forceKillHandles()
            resolve()
          }, DISPOSE_FORCE_KILL_MS)
        } catch (error) {
          this.deps.log?.('warn', '[AiTaskManager] Dispose timer failed', error)
          forceKillHandles()
          resolve()
        }
      })
    } else {
      handleStopCompletion = Promise.resolve()
    }

    let terminalShutdownCompletion = Promise.resolve()
    try {
      terminalShutdownCompletion = Promise.resolve(
        this.deps.terminal?.dispatcher.shutdown?.(),
      ).catch((error: unknown) => {
        this.disposeError =
          error instanceof Error ? error : new Error(String(error))
        this.disposeShutdownFailed = true
        this.deps.log?.(
          'warn',
          '[AiTaskManager] Terminal broker shutdown failed',
          error,
        )
      })
    } catch (error) {
      this.disposeError =
        error instanceof Error ? error : new Error(String(error))
      this.disposeShutdownFailed = true
      this.deps.log?.(
        'warn',
        '[AiTaskManager] Terminal broker shutdown failed',
        error,
      )
    }
    this.disposeCompletion = Promise.all([
      handleStopCompletion,
      terminalShutdownCompletion,
    ]).then(() => {
      if (this.disposeError !== null) throw this.disposeError
    })
    // Runtime lease expiry can call dispose() without awaiting. Attach a
    // passive rejection observer so a truthful broker-shutdown failure does
    // not become an unhandled rejection; disposeAndWait() still awaits the
    // original promise and receives the same failure after force-kill cleanup.
    void this.disposeCompletion.catch(() => undefined)

    this.listeners.clear()
    this.terminalSnapshotProviders.length = 0
  }

  /**
   * Dispose and resolve only after the SIGKILL escalation has run. Obsidian's
   * workspace quit event can register this Promise in its Tasks collection,
   * keeping the renderer alive long enough for the grace timer to fire.
   */
  async disposeAndWait(): Promise<void> {
    this.dispose()
    // Do not hide the first truthful failure with an automatic tight retry.
    // A later caller (notably workspace quit after settings OFF) gets a fresh
    // authenticated shutdown attempt instead of reusing a rejected Promise.
    if (this.disposeShutdownFailed) {
      const originalCleanup = (
        this.disposeCompletion ?? Promise.resolve()
      ).catch(() => undefined)
      let retryError: unknown
      const observedRetry = this.retryTerminalShutdown().catch((error: unknown) => {
        retryError = error
      })
      // Promise.all would fail fast on the retry and let Obsidian finish quit
      // before the original SIGKILL deadline. Observe the retry rejection,
      // wait for both branches, then report it.
      await Promise.all([originalCleanup, observedRetry])
      if (retryError !== undefined) {
        throw retryError instanceof Error
          ? retryError
          : new Error(
            typeof retryError === 'string'
              ? retryError
              : 'Terminal shutdown retry failed',
          )
      }
      return
    }
    await (this.disposeCompletion ?? Promise.resolve())
  }

  private retryTerminalShutdown(): Promise<void> {
    if (this.disposeShutdownRetry) return this.disposeShutdownRetry
    let retry: Promise<void>
    try {
      retry = Promise.resolve(
        this.deps.terminal?.dispatcher.shutdown?.(),
      )
    } catch (error) {
      retry = Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      )
    }
    const tracked = retry
      .then(() => {
        this.disposeError = null
        this.disposeShutdownFailed = false
      })
      .catch((error: unknown) => {
        this.disposeError =
          error instanceof Error ? error : new Error(String(error))
        this.disposeShutdownFailed = true
        throw this.disposeError
      })
      .finally(() => {
        if (this.disposeShutdownRetry === tracked) {
          this.disposeShutdownRetry = null
        }
      })
    this.disposeShutdownRetry = tracked
    void tracked.catch(() => undefined)
    return tracked
  }

  /**
   * Buffer a raw terminal chunk (bounded ring, whole-chunk eviction) and fan
   * it out to subscribers. Terminal output deliberately bypasses
   * record.events and onChange: the pane consumes it via onTerminalData.
   */
  private handleTerminalData(internal: InternalRun, chunk: string): void {
    if (chunk.length === 0) return
    const buffer = internal.terminalData ?? { chunks: [], totalLength: 0 }
    internal.terminalData = buffer

    // Oversized single chunk: keep only its tail.
    const trimmed =
      chunk.length > TERMINAL_DATA_BUFFER_LIMIT
        ? chunk.slice(chunk.length - TERMINAL_DATA_BUFFER_LIMIT)
        : chunk
    buffer.chunks.push(trimmed)
    buffer.totalLength += trimmed.length
    while (buffer.totalLength > TERMINAL_DATA_BUFFER_LIMIT && buffer.chunks.length > 1) {
      const evicted = buffer.chunks.shift()
      buffer.totalLength -= evicted?.length ?? 0
    }
    // Output-only churn (TUI spinners emit chunks continuously) uses the lazy
    // idle tier; status-driven saves keep the prompt default, and saveNow on
    // renderer reload still captures this buffer synchronously either way.
    this.scheduleSessionStatePersist(AI_RUN_SESSION_SAVE_IDLE_DELAY_MS)

    for (const listener of Array.from(internal.terminalListeners)) {
      try {
        listener(chunk)
      } catch (error) {
        this.deps.log?.('warn', '[AiTaskManager] Terminal data listener failed', error)
      }
    }
  }

  private handleEvent(internal: InternalRun, event: AiStreamEvent): void {
    if (
      event.kind === 'init' &&
      typeof event.sessionId === 'string' &&
      event.sessionId.length > 0
    ) {
      // Keep the LATEST session id: resuming a claude session mints a new
      // one, and the next follow-up must chain from it.
      internal.record.sessionId = event.sessionId
    }
    this.appendEvent(internal.record, event)
    if (internal.continuation) {
      appendBoundedEvent(internal.continuation, event)
    }
    this.notifyChange(internal.record)
  }

  /**
   * The persistent terminal broker reports the wrapper PID asynchronously
   * after spawn/reattach. Keep it on the same run record so TaskChute remains
   * coupled to the exact live process across renderer replacement.
   */
  private handleTerminalAttached(
    internal: InternalRun,
    pid: number | undefined,
    transcriptPath: string | undefined,
  ): void {
    if (
      this.disposed ||
      internal.exited ||
      this.runs.get(internal.record.id) !== internal
    ) {
      return
    }
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
      internal.record.pid = pid
    }
    if (
      typeof transcriptPath === 'string' &&
      transcriptPath.length > 0 &&
      transcriptPath.length <= 8 * 1024
    ) {
      internal.record.transcriptPath = transcriptPath
    }
    if (internal.record.status === 'starting') {
      internal.record.status = 'running'
    }
    this.notifyChange(internal.record)
  }

  /** Bounded append into the record's event buffer (see appendBoundedEvent) */
  private appendEvent(record: AiRunRecord, event: AiStreamEvent): void {
    const buffer: BoundedEventBuffer = {
      events: record.events,
      omittedCount: record.omittedEventCount ?? 0,
    }
    appendBoundedEvent(buffer, event)
    if (buffer.omittedCount > 0) {
      record.omittedEventCount = buffer.omittedCount
    }
  }

  private handleExit(internal: InternalRun, outcome: AiRunExitOutcome): void {
    if (internal.exited) return
    internal.exited = true
    internal.exitPersisted = false

    const record = internal.record
    record.status = outcome.status
    record.endedAt = Date.now()
    record.exitCode = outcome.exitCode
    if (outcome.errorMessage !== undefined) {
      record.errorMessage = outcome.errorMessage
    }
    this.notifyChange(record)
    this.queueExitPersist(internal)
  }

  /**
   * Chain the run-exit persist onto the run's queue and end it with the
   * 'persisted' notification. Shared by child-process exits (handleExit) and
   * the dispatch-throw catch paths in startRun/followUp, so EVERY exit ends
   * with 'persisted'. After dispose the note is skipped, but a terminal
   * run's transcript temp file must still not be left in the OS tmpdir.
   */
  private queueExitPersist(internal: InternalRun): void {
    const record = internal.record
    internal.exitPersisted = false
    if (this.disposed) {
      this.cleanUpTranscript(internal)
      return
    }
    if (record.host === 'shell') {
      // Shell sessions leave NO note and never prune; only the PTY
      // transcript temp file is consumed before the closing notification.
      internal.persistQueue = internal.persistQueue
        .then(() => this.discardTranscript(internal))
        .then(() => {
          this.dropStoppedReplayBuffer(internal)
          this.notifyPersisted(internal)
        })
      return
    }
    if (record.mode === 'terminal') {
      internal.persistQueue = internal.persistQueue
        .then(() => this.persistTerminalRunLog(internal))
        .then(() => {
          this.dropStoppedReplayBuffer(internal)
          this.notifyPersisted(internal)
        })
      return
    }
    // Snapshot the continuation synchronously and chain the write onto the
    // run's persist queue (see InternalRun.persistQueue for the guarantees).
    const continuationEvents = internal.continuation?.events
    internal.continuation = null
    internal.persistQueue = internal.persistQueue
      .then(() => this.persistRunLog(internal, continuationEvents))
      .then(() => this.notifyPersisted(internal))
  }

  /**
   * End-of-persist-chain notification (see AiRunChangeType). The pane closes
   * a stopped run's tab on this event — never on the status update — so the
   * terminal snapshot consumed by the persist above always found its adapter
   * alive. Skipped after dispose (listeners are cleared there anyway).
   */
  private notifyPersisted(internal: InternalRun): void {
    if (this.disposed) return
    internal.exitPersisted = true
    this.notifyChange(internal.record, 'persisted')
  }

  /**
   * Free a STOPPED run's terminal replay buffer at the end of its persist
   * chain: the pane never re-shows stopped runs (their view auto-closed on
   * 'persisted'), so the buffered output could never be replayed again and
   * would sit as dead memory (up to TERMINAL_DATA_BUFFER_LIMIT per run).
   * Succeeded/failed runs keep their buffer — a pane remount re-creates
   * their views and restores the screen from it.
   */
  private dropStoppedReplayBuffer(internal: InternalRun): void {
    if (internal.record.status === 'stopped') {
      internal.terminalData = null
    }
  }

  /** Best-effort removal of a terminal run's transcript temp file */
  private cleanUpTranscript(internal: InternalRun): void {
    const transcriptPath = internal.record.transcriptPath
    if (transcriptPath === undefined || !this.deps.terminal) return
    if (!this.claimTranscriptPath(internal, transcriptPath)) return
    void this.deps.terminal.readAndDeleteFile(transcriptPath).catch(() => undefined)
  }

  /**
   * Awaitable transcript consumption used by the shell-session persist
   * chain (ordering matters there: cleanup completes before 'persisted').
   * Never rejects.
   */
  private async discardTranscript(internal: InternalRun): Promise<void> {
    const transcriptPath = internal.record.transcriptPath
    if (transcriptPath === undefined || !this.deps.terminal) return
    if (!this.claimTranscriptPath(internal, transcriptPath)) return
    try {
      await this.deps.terminal.readAndDeleteFile(transcriptPath)
    } catch {
      // Best-effort cleanup: a missing/locked temp file is not fatal.
    }
  }

  /**
   * Atomically claim a temp transcript before its asynchronous read/delete.
   * Broker `onExit` and `onUnavailable` can race (including after dispose);
   * every path goes through this gate so the same file is never consumed
   * twice while still allowing distinct broker-confirmed paths to be cleaned.
   */
  private claimTranscriptPath(
    internal: InternalRun,
    transcriptPath: string,
  ): boolean {
    if (internal.consumedTranscriptPaths.has(transcriptPath)) return false
    internal.consumedTranscriptPaths.add(transcriptPath)
    if (internal.record.transcriptPath === transcriptPath) {
      internal.record.transcriptPath = undefined
    }
    return true
  }

  /**
   * Best-effort snapshot of the run's live xterm buffer through the registered
   * providers, newest first. A pane may not own every run, so an absent/blank
   * result or a provider failure falls through to the next still-mounted pane.
   * Returns undefined only when none can provide text; the caller then falls
   * back to the transcript file.
   */
  private async captureTerminalSnapshot(
    runId: string,
  ): Promise<string | undefined> {
    const registrations = [...this.terminalSnapshotProviders].reverse()
    for (const { provider } of registrations) {
      let timeoutHandle: number | null = null
      const timeoutMarker = Symbol('terminal-snapshot-timeout')
      try {
        let timeoutPromise: Promise<typeof timeoutMarker>
        try {
          timeoutPromise = new Promise((resolve) => {
            timeoutHandle = this.timer.setTimeout(
              () => resolve(timeoutMarker),
              TERMINAL_SNAPSHOT_PROVIDER_TIMEOUT_MS,
            )
          })
        } catch (error) {
          this.deps.log?.(
            'warn',
            '[AiTaskManager] Terminal snapshot timeout could not be armed',
            error,
          )
          continue
        }
        const text = await Promise.race([
          Promise.resolve().then(() => provider(runId)),
          timeoutPromise,
        ])
        if (text === timeoutMarker) {
          this.deps.log?.(
            'warn',
            '[AiTaskManager] Terminal snapshot provider timed out',
            runId,
          )
          continue
        }
        if (typeof text === 'string' && text.trim().length > 0) return text
      } catch (error) {
        this.deps.log?.(
          'warn',
          '[AiTaskManager] Terminal snapshot provider failed',
          error,
        )
      } finally {
        if (timeoutHandle !== null) {
          try {
            this.timer.clearTimeout(timeoutHandle)
          } catch {
            // The timeout already fired or its owner window is closing.
          }
        }
      }
    }
    return undefined
  }

  /**
   * Terminal-run persistence: write ONE log note through the shared writer
   * paths (with retention pruning). The transcript body prefers the live
   * xterm buffer snapshot — the raw `script` transcript is a TUI
   * screen-drawing byte stream (alternate screen, cursor moves) whose
   * ANSI-stripped remains are mostly spinner fragments, while the xterm
   * buffer holds the readable final screen. The provider first waits for
   * xterm's asynchronous write queue to drain; the pane keeps the adapter
   * alive until the later `persisted` notification. The PTY transcript temp
   * file is always consumed (deleted) either way; its stripped content is
   * only used when no snapshot was available. Never rejects.
   */
  private async persistTerminalRunLog(internal: InternalRun): Promise<void> {
    const record = internal.record
    const snapshot = await this.captureTerminalSnapshot(record.id)
    const bufferedReplay = internal.terminalData?.chunks.join('') ?? ''
    // An unavailable restored session may have neither a mounted xterm nor
    // a broker-confirmed temp path. Its bounded local replay is still better
    // evidence than an empty log, and is safe to use only as the final
    // fallback after ANSI normalization.
    const bufferedTranscript =
      bufferedReplay.length > 0 ? stripAnsiSequences(bufferedReplay) : ''
    let transcript = snapshot ?? bufferedTranscript
    const transcriptPath = record.transcriptPath
    if (
      transcriptPath !== undefined &&
      this.deps.terminal &&
      this.claimTranscriptPath(internal, transcriptPath)
    ) {
      try {
        const rawTranscript =
          await this.deps.terminal.readAndDeleteFile(transcriptPath)
        const projectionInput =
          rawTranscript.length > TERMINAL_TRANSCRIPT_STRIP_INPUT_LIMIT
            ? `${TERMINAL_TRANSCRIPT_STRIP_TRUNCATED_MARKER}\n${rawTranscript.slice(
                -TERMINAL_TRANSCRIPT_STRIP_INPUT_LIMIT,
              )}`
            : rawTranscript
        const fileTranscript = stripAnsiSequences(projectionInput)
        if (
          snapshot === undefined &&
          fileTranscript.trim().length > 0
        ) {
          transcript = fileTranscript
        }
      } catch (error) {
        if (snapshot === undefined && transcript.trim().length === 0) {
          transcript = TERMINAL_TRANSCRIPT_UNAVAILABLE_PLACEHOLDER
        }
        this.deps.log?.(
          'warn',
          '[AiTaskManager] Failed to read the terminal transcript',
          transcriptPath,
          error,
        )
      }
    }

    try {
      const writer = this.deps.logWriter
      const result = writer.writeTerminalRunLog
        ? await writer.writeTerminalRunLog(record, transcript)
        : await writer.writeRunLog(record)
      if (typeof result === 'string' && result.length > 0) {
        record.logNotePath = result
      }
    } catch (error) {
      this.deps.log?.('warn', '[AiTaskManager] Failed to write run log', error)
    }
    try {
      await this.deps.logWriter.pruneOldLogs()
    } catch (error) {
      this.deps.log?.('warn', '[AiTaskManager] Failed to prune old run logs', error)
    }
  }

  /** Never rejects: both the write and the prune failures are logged. */
  private async persistRunLog(
    internal: InternalRun,
    continuationEvents?: AiStreamEvent[],
  ): Promise<void> {
    const record = internal.record
    try {
      const writer = this.deps.logWriter
      const result = writer.upsertRunLog
        ? await writer.upsertRunLog(record, continuationEvents)
        : await writer.writeRunLog(record)
      if (typeof result === 'string' && result.length > 0) {
        record.logNotePath = result
      }
    } catch (error) {
      this.deps.log?.('warn', '[AiTaskManager] Failed to write run log', error)
    }
    try {
      await this.deps.logWriter.pruneOldLogs()
    } catch (error) {
      this.deps.log?.('warn', '[AiTaskManager] Failed to prune old run logs', error)
    }
  }

  private throwIfDisposed(): void {
    if (this.disposed) throw new AiTaskManagerDisposedError()
  }

  private requireWorkspaceFiles(): Pick<
    WorkspaceFileService,
    'listDirectory' | 'readFile' | 'writeFile'
  > {
    const workspaceFiles = this.deps.workspaceFiles
    if (!workspaceFiles) throw new Error('Workspace files are not available')
    return workspaceFiles
  }

  /**
   * Companion to the per-await throwIfDisposed pattern for followUp's async
   * windows (pending persist, binary resolution): the composer enables as
   * soon as a run finishes, so its record can be RELEASED (tab ×,
   * stopped-run auto-close on 'persisted') while a follow-up is parked on an
   * await. Resuming on that stale InternalRun would set exited=false and
   * dispatch a child that exists only on the released record — stopRun would
   * no-op on the unknown id and dispose()'s sweep (runs.values()) would
   * never kill it (zombie). Identity is compared, not mere presence, so a
   * release-then-new-run sequence cannot slip through either.
   */
  private throwIfReleased(runId: string, internal: InternalRun): void {
    if (this.runs.get(runId) !== internal) throw new AiRunNotFoundError(runId)
  }

  private notifyChange(
    record: AiRunRecord,
    changeType: AiRunChangeType = 'update',
  ): void {
    if (!this.disposed) this.scheduleSessionStatePersist()
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(record, changeType)
      } catch (error) {
        this.deps.log?.('warn', '[AiTaskManager] onChange listener failed', error)
      }
    }
  }

  /**
   * Restore serializable run state. Broker-backed terminal sessions rebuild
   * their input/resize handle; every other formerly-active process is safely
   * normalized to interrupted.
   */
  private restoreSessionState(): void {
    const state = this.deps.sessionState
    if (!state) return
    let snapshots: AiRunSessionSnapshot[]
    try {
      snapshots = state.load()
    } catch (error) {
      this.deps.log?.('warn', '[AiTaskManager] Failed to restore run state', error)
      return
    }

    let normalizedActiveState = false
    for (const snapshot of snapshots) {
      const record: AiRunRecord = {
        ...snapshot.record,
        events: snapshot.record.events.map((event) => ({ ...event })),
      }
      const wasActive = wasActiveBeforeRestore(record.status)
      const dispatcher = this.deps.terminal?.dispatcher
      const canAttachLiveTerminal =
        wasActive &&
        record.mode === 'terminal' &&
        typeof record.terminalSessionId === 'string' &&
        record.terminalSessionId.length > 0 &&
        dispatcher?.isPersistent === true &&
        typeof dispatcher.attach === 'function'
      if (wasActive && !canAttachLiveTerminal) {
        record.status = 'interrupted'
        record.endedAt = Date.now()
        record.exitCode = null
        record.errorMessage = INTERRUPTED_RUN_ERROR_MESSAGE
        normalizedActiveState = true
      }
      // Never trust a stale pid. Persistent attach reports the broker-owned
      // process identity again through onAttached.
      record.pid = undefined
      // Never trust a persisted filesystem path. The authenticated broker
      // returns the path it captured at the original spawn.
      record.transcriptPath = undefined
      if (!canAttachLiveTerminal) {
        record.terminalSessionId = undefined
      }
      const replay = snapshot.terminalReplay ?? ''
      const internal: InternalRun = {
        record,
        handle: null,
        terminalHandle: null,
        exited: !canAttachLiveTerminal,
        terminalData:
          record.mode === 'terminal'
            ? {
                // A live broker replays its authoritative buffer on attach;
                // seeding the local snapshot too would render every line
                // twice. Keep the snapshot only as the missing-broker
                // fallback used by markTerminalUnavailable.
                chunks:
                  !canAttachLiveTerminal && replay.length > 0 ? [replay] : [],
                totalLength: !canAttachLiveTerminal ? replay.length : 0,
              }
            : null,
        terminalListeners: new Set(),
        cwd: record.cwd,
        extraArgs: [...snapshot.extraArgs],
        continuation: null,
        persistQueue: Promise.resolve(),
        consumedTranscriptPaths: new Set(),
        // Final records restored into a new manager have no in-flight
        // renderer-local persist chain. Live records remain unpersisted until
        // their eventual exit in this manager lifetime.
        exitPersisted: !ACTIVE_STATUSES.has(record.status),
        needsTaskStateReconciliation:
          record.host !== 'shell' &&
          !canAttachLiveTerminal &&
          (wasActive || snapshot.needsTaskStateReconciliation === true),
        taskStateReconciliationClaimed: false,
        taskStateReconciliationOperation: null,
      }
      this.runs.set(record.id, internal)
      this.runSequence += 1
      if (canAttachLiveTerminal) {
        try {
          const terminalHandle = dispatcher.attach!(
            record.terminalSessionId ?? '',
            {
              onData: (chunk) => this.handleTerminalData(internal, chunk),
              onExit: (outcome) => this.handleExit(internal, outcome),
              onAttached: (pid, transcriptPath) =>
                this.handleTerminalAttached(internal, pid, transcriptPath),
              onUnavailable: (transcriptPath) =>
                this.markTerminalUnavailable(
                  internal,
                  replay,
                  transcriptPath,
                ),
            },
          )
          if (!internal.exited) {
            internal.terminalHandle = terminalHandle
            internal.handle = terminalHandle
          }
        } catch (error) {
          this.deps.log?.(
            'warn',
            '[AiTaskManager] Failed to attach restored terminal',
            error,
          )
          this.markTerminalUnavailable(internal, replay)
          normalizedActiveState = true
        }
      }
    }
    if (normalizedActiveState) this.persistSessionStateNow()
  }

  /**
   * Convert a terminal run to interrupted once its broker session is
   * unreachable: a restored snapshot whose attach failed (fallbackReplay
   * carries the persisted replay), or a LIVE run whose broker connection was
   * given up (fallbackReplay omitted — the in-memory buffer already holds
   * the last output). Without this, a live run would stay 'running' forever
   * against a dead pipe.
   */
  private markTerminalUnavailable(
    internal: InternalRun,
    fallbackReplay?: string,
    trustedTranscriptPath?: string,
  ): void {
    if (this.disposed) {
      // A late broker callback belongs to an old manager lifetime. Never let
      // it rewrite the authoritative pre-stop snapshot (or a newly adopted
      // manager's shared localStorage). A broker-confirmed temp path is still
      // safe to consume best-effort so abnormal termination leaves no file.
      if (
        typeof trustedTranscriptPath === 'string' &&
        trustedTranscriptPath.length > 0 &&
        trustedTranscriptPath.length <= 8 * 1024 &&
        this.deps.terminal
      ) {
        if (this.claimTranscriptPath(internal, trustedTranscriptPath)) {
          void this.deps.terminal
            .readAndDeleteFile(trustedTranscriptPath)
            .catch(() => undefined)
        }
      }
      return
    }
    if (
      internal.exited ||
      this.runs.get(internal.record.id) !== internal
    ) {
      return
    }
    internal.exited = true
    internal.handle = null
    internal.terminalHandle = null
    if (
      fallbackReplay !== undefined &&
      (internal.terminalData?.totalLength ?? 0) === 0
    ) {
      internal.terminalData = {
        chunks: fallbackReplay.length > 0 ? [fallbackReplay] : [],
        totalLength: fallbackReplay.length,
      }
    }
    const record = internal.record
    if (
      typeof trustedTranscriptPath === 'string' &&
      trustedTranscriptPath.length > 0 &&
      trustedTranscriptPath.length <= 8 * 1024
    ) {
      record.transcriptPath = trustedTranscriptPath
    }
    record.status = 'interrupted'
    record.endedAt = Date.now()
    record.exitCode = null
    record.errorMessage = INTERRUPTED_RUN_ERROR_MESSAGE
    record.pid = undefined
    record.terminalSessionId = undefined
    // Keep a broker-confirmed transcript path until the exit-persist chain
    // consumes it. Restored snapshots never trust/preserve a localStorage
    // path, so an unavailable-before-attach run still has undefined here.
    internal.needsTaskStateReconciliation = record.host !== 'shell'
    this.notifyChange(record)
    this.persistSessionStateNow()
    this.queueExitPersist(internal)
  }

  private createSessionSnapshots(): AiRunSessionSnapshot[] {
    const snapshots: AiRunSessionSnapshot[] = []
    for (const internal of this.runs.values()) {
      // Stopped records auto-close once their log persist finishes and should
      // not reappear if the app reloads inside that short window.
      if (internal.record.status === 'stopped') continue
      const preserveLiveTerminalAttachment =
        ACTIVE_STATUSES.has(internal.record.status) &&
        internal.record.mode === 'terminal' &&
        this.deps.terminal?.dispatcher.isPersistent === true &&
        typeof internal.record.terminalSessionId === 'string'
      const record: AiRunRecord = {
        ...internal.record,
        events: internal.record.events.map((event) => ({ ...event })),
        // Temp paths are never trusted after crossing localStorage.
        transcriptPath: undefined,
        terminalSessionId: preserveLiveTerminalAttachment
          ? internal.record.terminalSessionId
          : undefined,
        pid: undefined,
      }
      const terminalReplay = internal.terminalData?.chunks.join('')
      snapshots.push({
        record,
        ...(terminalReplay ? { terminalReplay } : {}),
        extraArgs: [...internal.extraArgs],
        ...(internal.needsTaskStateReconciliation
          ? { needsTaskStateReconciliation: true }
          : {}),
      })
    }
    return snapshots
  }

  private scheduleSessionStatePersist(delayMs?: number): void {
    // dispose() writes the authoritative final state via saveNow; residual
    // PTY output flushed during teardown must not re-arm a delayed save
    // that would overwrite it with post-kill statuses.
    if (this.disposed) return
    try {
      this.deps.sessionState?.scheduleSave(
        () => this.createSessionSnapshots(),
        delayMs,
      )
    } catch (error) {
      this.deps.log?.('warn', '[AiTaskManager] Failed to schedule run state save', error)
    }
  }

  private persistSessionStateNow(): void {
    try {
      this.deps.sessionState?.saveNow(this.createSessionSnapshots())
    } catch (error) {
      this.deps.log?.('warn', '[AiTaskManager] Failed to save run state', error)
    }
  }

  /**
   * Effective run mode: an explicit request wins over the settings accessor;
   * terminal degrades to the conversation/headless pipeline when the
   * capability is missing or the platform lacks a PTY wrapper (win32).
   */
  private resolveRunMode(requested?: AiRunMode): AiRunMode {
    const mode = requested ?? this.deps.getRunMode?.() ?? 'headless'
    if (mode !== 'terminal') return 'headless'
    if (!this.deps.terminal || !this.deps.terminal.isSupported()) return 'headless'
    return 'terminal'
  }

  private resolveCwd(configCwd: string | undefined): string | undefined {
    const basePath = this.getVaultBasePath()
    if (configCwd === undefined) return basePath
    if (isAbsolutePathLike(configCwd)) return configCwd
    if (basePath === undefined) return undefined
    return joinCwd(basePath, configCwd)
  }

  /** Duck-typed FileSystemAdapter.getBasePath (desktop only) */
  private getVaultBasePath(): string | undefined {
    const adapter = this.deps.app.vault.adapter as
      | { getBasePath?: () => unknown }
      | undefined
    if (adapter && typeof adapter.getBasePath === 'function') {
      const basePath = adapter.getBasePath()
      if (typeof basePath === 'string' && basePath.length > 0) return basePath
    }
    return undefined
  }
}
