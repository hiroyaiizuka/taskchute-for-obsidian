/**
 * AI Task - run orchestrator
 *
 * Coordinates one AI run per task note: reads the read-only `ai_task_*`
 * frontmatter and the `## Prompt` section, resolves the CLI binary and cwd,
 * dispatches the child process, buffers stream events with a bounded
 * head + tail cap, and persists a run log note when the run ends.
 *
 * Task-note frontmatter stays READ-ONLY here; the only vault write happens
 * inside AiTaskLogWriter at run end.
 */

import type { TFile } from 'obsidian'
import type { AiRunRecord, AiStreamEvent, AiTaskHost } from '../types'
import { readAiTaskConfig } from './AiTaskFrontmatterReader'
import { extractPromptSection, type PromptHeadingInfo } from './PromptExtractor'
import type {
  AiDispatcher,
  AiGraceTimer,
  AiRunExitOutcome,
  AiRunProcessHandle,
} from './dispatchers/Dispatcher'

/** Events kept verbatim at the start of a run before elision kicks in */
export const AI_RUN_EVENT_HEAD_LIMIT = 200
/** Most recent events kept verbatim once the buffer overflows */
export const AI_RUN_EVENT_TAIL_LIMIT = 2000
/** Delay between dispose()'s SIGTERM sweep and the SIGKILL escalation */
export const DISPOSE_FORCE_KILL_MS = 1500

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
    pruneOldLogs(): Promise<void>
  }
  /** Timer override for tests; production uses activeWindow timers */
  timer?: AiGraceTimer
  log?(level: 'warn' | 'error' | 'debug', ...args: unknown[]): void
}

export type AiRunChangeListener = (record: AiRunRecord) => void

interface InternalRun {
  record: AiRunRecord
  handle: AiRunProcessHandle | null
  exited: boolean
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
  private readonly listeners = new Set<AiRunChangeListener>()
  private readonly timer: AiGraceTimer
  private disposed = false
  private runSequence = 0

  constructor(private readonly deps: AiTaskManagerDeps) {
    this.timer = deps.timer ?? defaultTimer
  }

  /**
   * Start an AI run for the given task note. Rejects with a typed error when
   * the manager is disposed, the note is not an AI task, has no prompt, or
   * already has an active run. The disposed flag is re-checked after every
   * await so a dispose() during an in-flight start can never spawn a child
   * process that dispose()'s handle sweep would miss.
   */
  async startRun(file: TFile): Promise<AiRunRecord> {
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
      const prompt = extractPromptSection(content, cache?.headings)
      if (prompt === null) throw new AiPromptNotFoundError(taskPath)

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
        startedAt: Date.now(),
        events: [],
      }
      const internal: InternalRun = { record, handle: null, exited: false }
      this.runs.set(record.id, internal)
      this.notifyChange(record)

      try {
        internal.handle = this.deps.dispatchers[config.host].start(
          { binaryPath, prompt, cwd, extraArgs: config.args },
          {
            onEvent: (event) => this.handleEvent(internal, event),
            onExit: (outcome) => this.handleExit(internal, outcome),
          },
        )
      } catch (error) {
        internal.exited = true
        record.status = 'failed'
        record.endedAt = Date.now()
        record.errorMessage = error instanceof Error ? error.message : String(error)
        this.notifyChange(record)
        throw error
      }

      if (!internal.exited && record.status === 'starting') {
        record.pid = internal.handle.pid
        record.status = 'running'
        this.notifyChange(record)
      }
      return record
    } finally {
      this.pendingStarts.delete(taskPath)
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

  getActiveRunForTask(taskPath: string): AiRunRecord | undefined {
    for (const internal of this.runs.values()) {
      if (
        internal.record.taskPath === taskPath &&
        ACTIVE_STATUSES.has(internal.record.status)
      ) {
        return internal.record
      }
    }
    return undefined
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
  }

  private handleEvent(internal: InternalRun, event: AiStreamEvent): void {
    this.appendEvent(internal.record, event)
    this.notifyChange(internal.record)
  }

  /**
   * Bounded append: the first AI_RUN_EVENT_HEAD_LIMIT events and the last
   * AI_RUN_EVENT_TAIL_LIMIT events are kept verbatim; everything in between
   * is represented by a single elision marker event.
   */
  private appendEvent(record: AiRunRecord, event: AiStreamEvent): void {
    const events = record.events
    const capacity = AI_RUN_EVENT_HEAD_LIMIT + AI_RUN_EVENT_TAIL_LIMIT
    const omitted = record.omittedEventCount ?? 0

    if (omitted === 0) {
      if (events.length < capacity) {
        events.push(event)
        return
      }
      // First overflow: replace the oldest tail event with the marker.
      record.omittedEventCount = 1
      events.splice(AI_RUN_EVENT_HEAD_LIMIT, 1, {
        kind: 'elision',
        omittedCount: 1,
      })
      events.push(event)
      return
    }

    record.omittedEventCount = omitted + 1
    events[AI_RUN_EVENT_HEAD_LIMIT] = { kind: 'elision', omittedCount: omitted + 1 }
    events.splice(AI_RUN_EVENT_HEAD_LIMIT + 1, 1)
    events.push(event)
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

    if (this.disposed) return
    void this.persistRunLog(record)
  }

  private async persistRunLog(record: AiRunRecord): Promise<void> {
    try {
      await this.deps.logWriter.writeRunLog(record)
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

  private notifyChange(record: AiRunRecord): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(record)
      } catch (error) {
        this.deps.log?.('warn', '[AiTaskManager] onChange listener failed', error)
      }
    }
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
