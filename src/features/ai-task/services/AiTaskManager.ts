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
import type { AiRunMode, AiRunRecord, AiStreamEvent, AiTaskHost } from '../types'
import { readAiTaskConfig } from './AiTaskFrontmatterReader'
import { extractPromptSection, type PromptHeadingInfo } from './PromptExtractor'
import { stripAnsiSequences } from './streams/AnsiStripper'
import type {
  AiDispatcher,
  AiGraceTimer,
  AiRunExitOutcome,
  AiRunProcessHandle,
} from './dispatchers/Dispatcher'
import type { AiTerminalDispatcher, TerminalRunHandle } from './dispatchers/TerminalDispatcher'

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
    resolve(host: AiTaskHost): Promise<string>
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
  /** Effective run mode from settings; consulted when startRun gets none */
  getRunMode?(): AiRunMode
  /** Timer override for tests; production uses activeWindow timers */
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
export type AiTerminalSnapshotProvider = (runId: string) => string | undefined

export interface AiRunStartOptions {
  /** Overrides the settings-provided run mode for this run */
  mode?: AiRunMode
  /** Task instance the run was started from (row chip scoping) */
  instanceId?: string
  /** PTY size derived from the pane; defaults apply when omitted */
  rows?: number
  cols?: number
}

export interface AiShellSessionOptions {
  /** PTY size derived from the pane panel; defaults apply when omitted */
  cols?: number
  rows?: number
  /** Localized display name (e.g. "ターミナル"); defaults to 'Terminal' */
  name?: string
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

const defaultTimer: AiGraceTimer = {
  setTimeout: (handler, timeoutMs) => activeWindow.setTimeout(handler, timeoutMs),
  clearTimeout: (handle) => {
    activeWindow.clearTimeout(handle)
  },
}

function isAbsolutePathLike(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

function joinCwd(basePath: string, relative: string): string {
  const base = basePath.replace(/[\\/]+$/, '')
  const rest = relative.replace(/^\.\//, '')
  return `${base}/${rest}`
}

export class AiTaskManager {
  private readonly runs = new Map<string, InternalRun>()
  private readonly pendingStarts = new Set<string>()
  /**
   * Task paths whose stop request arrived while startRun()/followUp() was
   * still in its async window (before the run registered or dispatched).
   * The dispatching call honours and clears the flag right after the child
   * spawns, so the stop is never silently lost.
   */
  private readonly stopRequestedDuringStart = new Set<string>()
  private readonly listeners = new Set<AiRunChangeListener>()
  private readonly timer: AiGraceTimer
  private terminalSnapshotProvider: AiTerminalSnapshotProvider | null = null
  private disposed = false
  private runSequence = 0

  constructor(private readonly deps: AiTaskManagerDeps) {
    this.timer = deps.timer ?? defaultTimer
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
   * mode silently degrades to headless where no PTY wrapper exists (win32).
   * A missing or empty '## Prompt' section only rejects for headless runs —
   * a terminal session simply opens the CLI as a plain REPL (the user types
   * the prompt into the terminal).
   */
  async startRun(file: TFile, options?: AiRunStartOptions): Promise<AiRunRecord> {
    this.throwIfDisposed()
    const taskPath = file.path
    if (this.pendingStarts.has(taskPath) || this.getActiveRunForTask(taskPath)) {
      throw new AiRunAlreadyActiveError(taskPath)
    }
    this.pendingStarts.add(taskPath)
    try {
      const cache = this.deps.app.metadataCache.getFileCache(file) ?? undefined
      const config = readAiTaskConfig(cache?.frontmatter)
      if (!config) throw new AiTaskNotConfiguredError(taskPath)

      const content = await this.deps.app.vault.cachedRead(file)
      this.throwIfDisposed()
      // The effective mode decides how a missing/empty '## Prompt' section is
      // treated, so resolve it BEFORE the prompt gate: terminal sessions open
      // a plain interactive REPL with an empty prompt (typing happens in the
      // terminal), while headless runs have nothing to execute without one.
      const mode = this.resolveRunMode(options?.mode)
      const extractedPrompt = extractPromptSection(content, cache?.headings)
      if (extractedPrompt === null && mode !== 'terminal') {
        throw new AiPromptNotFoundError(taskPath)
      }
      const prompt = extractedPrompt ?? ''

      const cwd = this.resolveCwd(config.cwd)
      const binaryPath = await this.deps.binaryLocator.resolve(config.host)
      this.throwIfDisposed()

      this.runSequence += 1
      const record: AiRunRecord = {
        id: `ai-run-${Date.now()}-${this.runSequence}`,
        taskPath,
        taskName: file.basename,
        host: config.host,
        status: 'starting',
        mode,
        instanceId: options?.instanceId,
        startedAt: Date.now(),
        events: [],
      }
      // resolveRunMode only returns 'terminal' when deps.terminal exists and
      // is supported, so `terminal` is set exactly for terminal runs.
      const terminal = mode === 'terminal' ? this.deps.terminal : undefined
      if (terminal) {
        // Stamp the terminal-session fields BEFORE the first notifyChange
        // below: the pane reacts to 'starting' synchronously and opens its
        // ONE-SHOT xterm view with the grid read off the record, so a late
        // stamp would open the view at the 80x24 fallback while the PTY
        // spawns at the pane-derived size — a permanent mismatch that
        // garbles the TUI for the run's entire lifetime. The grid is fixed
        // for the session; recording it lets the pane open a matching view.
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
        extraArgs: config.args,
        continuation: null,
        persistQueue: Promise.resolve(),
      }
      this.runs.set(record.id, internal)
      this.notifyChange(record)

      try {
        if (terminal) {
          const terminalHandle = terminal.dispatcher.start(
            {
              binaryPath,
              prompt,
              cwd,
              extraArgs: config.args,
              rows: record.rows ?? DEFAULT_TERMINAL_ROWS,
              cols: record.cols ?? DEFAULT_TERMINAL_COLS,
              transcriptPath: record.transcriptPath ?? '',
            },
            {
              onData: (chunk) => this.handleTerminalData(internal, chunk),
              onExit: (outcome) => this.handleExit(internal, outcome),
            },
          )
          internal.terminalHandle = terminalHandle
          internal.handle = terminalHandle
        } else {
          internal.handle = this.deps.dispatchers[config.host].start(
            { binaryPath, prompt, cwd, extraArgs: config.args },
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
        // The dispatch failed before any child existed, but the run's
        // lifecycle contract still holds: persist a minimal failed-run note
        // and end with 'persisted' (see AiRunChangeType).
        this.queueExitPersist(internal)
        throw error
      }

      if (!internal.exited && record.status === 'starting') {
        record.pid = internal.handle.pid
        record.status = 'running'
        this.notifyChange(record)
      }
      // A human stop that arrived during the async start window above was
      // queued by requestStopForTask; honour it now that the child exists.
      if (this.stopRequestedDuringStart.has(taskPath)) {
        this.stopRun(record.id)
      }
      return record
    } finally {
      this.pendingStarts.delete(taskPath)
      this.stopRequestedDuringStart.delete(taskPath)
    }
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
      cwd: this.getVaultBasePath(),
      extraArgs: [],
      continuation: null,
      persistQueue: Promise.resolve(),
    }
    this.runs.set(record.id, internal)
    this.notifyChange(record)

    try {
      const terminalHandle = terminal.dispatcher.start(
        {
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
        },
      )
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
      const binaryPath = await this.deps.binaryLocator.resolve(host)
      this.throwIfDisposed()
      this.throwIfReleased(runId, internal)

      const userEvent: AiStreamEvent = { kind: 'user-text', text }
      this.appendEvent(record, userEvent)
      internal.continuation = { events: [], omittedCount: 0 }
      appendBoundedEvent(internal.continuation, userEvent)
      record.status = 'starting'
      record.resumedAt = Date.now()
      record.endedAt = undefined
      record.exitCode = undefined
      record.errorMessage = undefined
      internal.exited = false
      this.notifyChange(record)

      try {
        internal.handle = this.deps.dispatchers[host].start(
          {
            binaryPath,
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
    if (this.pendingStarts.has(taskPath)) {
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
   * Register the SINGLE snapshot provider used to read a terminal run's live
   * xterm buffer when its log note is composed at exit (preferred over the
   * ANSI-stripped PTY transcript file, which is TUI redraw garbage). A later
   * registration replaces the current one; the returned disposer only
   * unregisters its own provider, so a stale disposer never clobbers a newer
   * registration.
   */
  registerTerminalSnapshotProvider(provider: AiTerminalSnapshotProvider): () => void {
    this.terminalSnapshotProvider = provider
    return () => {
      if (this.terminalSnapshotProvider === provider) {
        this.terminalSnapshotProvider = null
      }
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
   * Stop every active run: SIGTERM immediately, SIGKILL via an activeWindow
   * timer (the window outlives the plugin, so no zombie children survive a
   * plugin reload). Idempotent.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true

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

    if (activeHandles.length > 0) {
      this.timer.setTimeout(() => {
        for (const handle of activeHandles) {
          try {
            handle.forceKill?.()
          } catch (error) {
            this.deps.log?.('warn', '[AiTaskManager] Force kill failed', error)
          }
        }
      }, DISPOSE_FORCE_KILL_MS)
    }

    this.listeners.clear()
    this.terminalSnapshotProvider = null
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
          this.notifyPersisted(record)
        })
      return
    }
    if (record.mode === 'terminal') {
      internal.persistQueue = internal.persistQueue
        .then(() => this.persistTerminalRunLog(internal))
        .then(() => {
          this.dropStoppedReplayBuffer(internal)
          this.notifyPersisted(record)
        })
      return
    }
    // Snapshot the continuation synchronously and chain the write onto the
    // run's persist queue (see InternalRun.persistQueue for the guarantees).
    const continuationEvents = internal.continuation?.events
    internal.continuation = null
    internal.persistQueue = internal.persistQueue
      .then(() => this.persistRunLog(internal, continuationEvents))
      .then(() => this.notifyPersisted(record))
  }

  /**
   * End-of-persist-chain notification (see AiRunChangeType). The pane closes
   * a stopped run's tab on this event — never on the status update — so the
   * terminal snapshot consumed by the persist above always found its adapter
   * alive. Skipped after dispose (listeners are cleared there anyway).
   */
  private notifyPersisted(record: AiRunRecord): void {
    if (this.disposed) return
    this.notifyChange(record, 'persisted')
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
    internal.record.transcriptPath = undefined
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
    internal.record.transcriptPath = undefined
    try {
      await this.deps.terminal.readAndDeleteFile(transcriptPath)
    } catch {
      // Best-effort cleanup: a missing/locked temp file is not fatal.
    }
  }

  /**
   * Best-effort snapshot of the run's live xterm buffer through the
   * registered provider. Returns undefined when no provider is registered,
   * the provider has no adapter for the run, the text is blank, or the
   * provider throws — every one of those falls back to the transcript file.
   */
  private captureTerminalSnapshot(runId: string): string | undefined {
    const provider = this.terminalSnapshotProvider
    if (!provider) return undefined
    try {
      const text = provider(runId)
      if (typeof text === 'string' && text.trim().length > 0) return text
    } catch (error) {
      this.deps.log?.(
        'warn',
        '[AiTaskManager] Terminal snapshot provider failed',
        error,
      )
    }
    return undefined
  }

  /**
   * Terminal-run persistence: write ONE log note through the shared writer
   * paths (with retention pruning). The transcript body prefers the live
   * xterm buffer snapshot — the raw `script` transcript is a TUI
   * screen-drawing byte stream (alternate screen, cursor moves) whose
   * ANSI-stripped remains are mostly spinner fragments, while the xterm
   * buffer holds the readable final screen. The snapshot is captured
   * synchronously BEFORE the first await so the pane's adapter (kept alive
   * for finished runs until unmount) is still there. The PTY transcript temp
   * file is always consumed (deleted) either way; its stripped content is
   * only used when no snapshot was available. Never rejects.
   */
  private async persistTerminalRunLog(internal: InternalRun): Promise<void> {
    const record = internal.record
    const snapshot = this.captureTerminalSnapshot(record.id)
    let transcript = snapshot ?? ''
    const transcriptPath = record.transcriptPath
    if (transcriptPath !== undefined && this.deps.terminal) {
      record.transcriptPath = undefined
      try {
        const fileTranscript = stripAnsiSequences(
          await this.deps.terminal.readAndDeleteFile(transcriptPath),
        )
        if (snapshot === undefined) {
          transcript = fileTranscript
        }
      } catch (error) {
        if (snapshot === undefined) {
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
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(record, changeType)
      } catch (error) {
        this.deps.log?.('warn', '[AiTaskManager] onChange listener failed', error)
      }
    }
  }

  /**
   * Effective run mode: an explicit request wins over the settings accessor;
   * terminal degrades to headless when the capability is missing or the
   * platform lacks a PTY wrapper (win32).
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
