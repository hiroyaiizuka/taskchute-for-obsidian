/**
 * Device-local persistence for the AI Runs workspace.
 *
 * Active terminal records retain only the authenticated broker session id
 * needed to rebuild their renderer-side handle. Process liveness, PID, and
 * transcript ownership are accepted only after the broker confirms them;
 * this store owns bounded serializable UI/replay state, never the process.
 */

import type { AiRunRecord, AiRunStatus, AiStreamEvent } from '../types'
import { stableTimeoutSource } from '../../../utils/stableTimer'

export const AI_RUN_SESSION_STATE_STORAGE_KEY =
  'taskchute-plus.ai-run-session-state.v1'
export const AI_RUN_SESSION_STATE_VERSION = 1 as const
export const AI_RUN_SESSION_MAX_RUNS = 12
export const AI_RUN_SESSION_REPLAY_LIMIT = 128 * 1024
export const AI_RUN_SESSION_EVENT_LIMIT = 400
export const AI_RUN_SESSION_EVENT_TEXT_LIMIT = 4 * 1024
export const AI_RUN_SESSION_SERIALIZED_LIMIT = 2_500_000
export const AI_RUN_SESSION_SAVE_DELAY_MS = 300
/**
 * Lazy tier for terminal-output-driven saves. A busy TUI (spinner frames)
 * produces continuous PTY chunks; snapshotting every run each 300ms just to
 * capture replay churn is wasted main-thread work. Status changes keep the
 * prompt AI_RUN_SESSION_SAVE_DELAY_MS tier, and saveNow/flush still write the
 * complete latest state synchronously regardless of the scheduled tier.
 */
export const AI_RUN_SESSION_SAVE_IDLE_DELAY_MS = 5000

export interface AiRunSessionSnapshot {
  record: AiRunRecord
  terminalReplay?: string
  extraArgs: string[]
  /** Survives repeated reloads until TaskChute running state is reconciled. */
  needsTaskStateReconciliation?: boolean
}

interface AiRunSessionState {
  version: typeof AI_RUN_SESSION_STATE_VERSION
  runs: AiRunSessionSnapshot[]
}

export interface AiRunSessionStorageBridge {
  loadLocalStorage(key: string): unknown
  saveLocalStorage(key: string, value: unknown): void
}

export interface AiRunSessionTimer {
  setTimeout(handler: () => void, timeoutMs: number): number
  clearTimeout(handle: number): void
  /** Clock for deadline comparison across save tiers; defaults to Date.now. */
  now?(): number
}

export interface AiRunSessionStateStoreOptions {
  timer?: AiRunSessionTimer
  saveDelayMs?: number
  log?(level: 'warn' | 'debug', ...args: unknown[]): void
}

export type AiRunSessionSnapshotSource =
  | AiRunSessionSnapshot[]
  | (() => AiRunSessionSnapshot[])

const ACTIVE_STATUSES: ReadonlySet<AiRunStatus> = new Set([
  'starting',
  'running',
  'stopping',
])

const VALID_STATUSES: ReadonlySet<AiRunStatus> = new Set([
  ...ACTIVE_STATUSES,
  'interrupted',
  'succeeded',
  'failed',
  'stopped',
])

const defaultTimer: AiRunSessionTimer = {
  ...stableTimeoutSource,
  now: () => Date.now(),
}

function boundedString(value: unknown, maxLength = AI_RUN_SESSION_EVENT_TEXT_LIMIT): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.length <= maxLength ? value : value.slice(value.length - maxLength)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function finiteInteger(value: unknown): number | undefined {
  const number = finiteNumber(value)
  return number === undefined ? undefined : Math.trunc(number)
}

function cloneSmallJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined
  try {
    const serialized = JSON.stringify(value)
    if (
      serialized === undefined ||
      serialized.length > AI_RUN_SESSION_EVENT_TEXT_LIMIT
    ) {
      return undefined
    }
    return JSON.parse(serialized) as unknown
  } catch {
    return undefined
  }
}

function normalizeEvent(value: unknown): AiStreamEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const event = value as Record<string, unknown>
  switch (event.kind) {
    case 'init':
      return {
        kind: 'init',
        ...(boundedString(event.sessionId) !== undefined
          ? { sessionId: boundedString(event.sessionId) }
          : {}),
        ...(boundedString(event.model) !== undefined
          ? { model: boundedString(event.model) }
          : {}),
      }
    case 'assistant-text':
    case 'user-text':
    case 'stderr':
    case 'raw': {
      const text = boundedString(event.text)
      return text === undefined ? null : { kind: event.kind, text }
    }
    case 'tool-use': {
      const toolName = boundedString(event.toolName, 512)
      if (toolName === undefined) return null
      const input = cloneSmallJsonValue(event.input)
      return {
        kind: 'tool-use',
        toolName,
        ...(input !== undefined ? { input } : {}),
      }
    }
    case 'tool-result': {
      const text = boundedString(event.text)
      return {
        kind: 'tool-result',
        ...(text !== undefined ? { text } : {}),
        ...(typeof event.isError === 'boolean' ? { isError: event.isError } : {}),
      }
    }
    case 'result': {
      const subtype = boundedString(event.subtype, 512)
      const text = boundedString(event.text)
      const totalCostUsd = finiteNumber(event.totalCostUsd)
      const numTurns = finiteInteger(event.numTurns)
      return {
        kind: 'result',
        isError: event.isError === true,
        ...(subtype !== undefined ? { subtype } : {}),
        ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
        ...(numTurns !== undefined ? { numTurns } : {}),
        ...(text !== undefined ? { text } : {}),
      }
    }
    case 'elision': {
      const omittedCount = finiteInteger(event.omittedCount)
      if (omittedCount === undefined || omittedCount < 1) return null
      return { kind: 'elision', omittedCount }
    }
    default:
      return null
  }
}

function normalizeEvents(value: unknown): AiStreamEvent[] {
  if (!Array.isArray(value)) return []
  const source: unknown[] = value
  const candidates = source.length <= AI_RUN_SESSION_EVENT_LIMIT
    ? source
    : [
        ...source.slice(0, 50),
        {
          kind: 'elision',
          omittedCount: source.length - (AI_RUN_SESSION_EVENT_LIMIT - 1),
        },
        ...source.slice(-(AI_RUN_SESSION_EVENT_LIMIT - 51)),
      ]
  const normalized: AiStreamEvent[] = []
  for (const candidate of candidates) {
    const event = normalizeEvent(candidate)
    if (event) normalized.push(event)
  }
  return normalized
}

function normalizeRecord(value: unknown): AiRunRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const id = boundedString(source.id, 512)?.trim()
  const taskPath = boundedString(source.taskPath, 8 * 1024)
  const taskName = boundedString(source.taskName, 2 * 1024)
  const startedAt = finiteNumber(source.startedAt)
  const status = source.status as AiRunStatus
  const host = source.host
  const mode = source.mode
  if (
    !id ||
    taskPath === undefined ||
    taskName === undefined ||
    startedAt === undefined ||
    !VALID_STATUSES.has(status) ||
    (host !== 'claude' && host !== 'codex' && host !== 'shell') ||
    (mode !== 'terminal' && mode !== 'headless')
  ) {
    return null
  }

  const record: AiRunRecord = {
    id,
    taskPath,
    taskName,
    host,
    status,
    mode,
    startedAt,
    events: normalizeEvents(source.events),
  }

  const assignString = (key: keyof AiRunRecord, maxLength = 8 * 1024): void => {
    const candidate = boundedString(source[key as string], maxLength)
    if (candidate !== undefined) {
      ;(record as unknown as Record<string, unknown>)[key as string] = candidate
    }
  }
  const assignNumber = (key: keyof AiRunRecord): void => {
    const candidate = finiteNumber(source[key as string])
    if (candidate !== undefined) {
      ;(record as unknown as Record<string, unknown>)[key as string] = candidate
    }
  }

  assignString('cwd')
  assignString('recipePath')
  assignString('recipeContentHash', 512)
  assignString('parentRunId', 512)
  assignString('instanceId', 512)
  assignString('sessionId', 2 * 1024)
  const terminalSessionId = boundedString(source.terminalSessionId, 256)
  if (
    terminalSessionId === id &&
    /^[A-Za-z0-9._:-]{1,256}$/u.test(terminalSessionId)
  ) {
    record.terminalSessionId = terminalSessionId
  }
  assignString('logNotePath')
  assignString('errorMessage', 8 * 1024)
  assignNumber('resumedAt')
  assignNumber('endedAt')
  assignNumber('exitCode')
  assignNumber('cols')
  assignNumber('rows')
  assignNumber('omittedEventCount')
  if (source.exitCode === null) record.exitCode = null
  if (source.recipeVersion === 1 || source.recipeVersion === 2) {
    record.recipeVersion = source.recipeVersion
  }
  return record
}

function normalizeSnapshot(value: unknown): AiRunSessionSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const record = normalizeRecord(source.record)
  if (!record || record.status === 'stopped') return null
  const terminalReplay = boundedString(
    source.terminalReplay,
    AI_RUN_SESSION_REPLAY_LIMIT,
  )
  const extraArgs = Array.isArray(source.extraArgs)
    ? source.extraArgs
        .slice(0, 64)
        .map((arg) => boundedString(arg, AI_RUN_SESSION_EVENT_TEXT_LIMIT))
        .filter((arg): arg is string => arg !== undefined)
    : []
  return {
    record,
    ...(terminalReplay !== undefined && terminalReplay.length > 0
      ? { terminalReplay }
      : {}),
    extraArgs,
    ...(source.needsTaskStateReconciliation === true
      ? { needsTaskStateReconciliation: true }
      : {}),
  }
}

function isCriticalSnapshot(snapshot: AiRunSessionSnapshot): boolean {
  return (
    ACTIVE_STATUSES.has(snapshot.record.status) ||
    snapshot.needsTaskStateReconciliation === true
  )
}

function normalizeSnapshots(value: unknown): AiRunSessionSnapshot[] {
  if (!Array.isArray(value)) return []
  const critical: AiRunSessionSnapshot[] = []
  const history: AiRunSessionSnapshot[] = []
  const seen = new Set<string>()
  // Do not slice before normalization: a long-running task may be older than
  // many completed/shell history entries, but its reconciliation marker is
  // more important than every disposable history item.
  for (const candidate of value) {
    const snapshot = normalizeSnapshot(candidate)
    if (!snapshot || seen.has(snapshot.record.id)) continue
    seen.add(snapshot.record.id)
    if (isCriticalSnapshot(snapshot)) critical.push(snapshot)
    else history.push(snapshot)
  }
  const historySlots = Math.max(0, AI_RUN_SESSION_MAX_RUNS - critical.length)
  return [
    ...critical,
    ...(historySlots > 0 ? history.slice(-historySlots) : []),
  ]
}

function fitStateToSerializedLimit(
  snapshots: AiRunSessionSnapshot[],
): AiRunSessionState {
  const state: AiRunSessionState = {
    version: AI_RUN_SESSION_STATE_VERSION,
    runs: normalizeSnapshots(snapshots),
  }
  // Capacity pressure evicts disposable finished history first. Critical
  // active/reconciliation records are never shifted out: losing one would
  // leave its TaskChute timer permanently running after a restart. Each
  // snapshot is serialized once and evictions adjust a running total, so
  // shedding N snapshots no longer re-stringifies the whole state N times.
  const wrapperLength = JSON.stringify({
    version: state.version,
    runs: [],
  }).length
  const snapshotLengths = state.runs.map(
    (snapshot) => JSON.stringify(snapshot).length,
  )
  let estimatedLength =
    wrapperLength +
    snapshotLengths.reduce((sum, length) => sum + length, 0) +
    Math.max(0, snapshotLengths.length - 1)
  while (estimatedLength > AI_RUN_SESSION_SERIALIZED_LIMIT) {
    const disposableIndex = state.runs.findIndex(
      (snapshot) => !isCriticalSnapshot(snapshot),
    )
    if (disposableIndex < 0) break
    state.runs.splice(disposableIndex, 1)
    const [evictedLength] = snapshotLengths.splice(disposableIndex, 1)
    estimatedLength -=
      (evictedLength ?? 0) + (snapshotLengths.length > 0 ? 1 : 0)
  }
  let serialized = JSON.stringify(state)
  // Correction loop for an estimate miss; the running total is exact for
  // plain JSON data, so this should never iterate.
  while (serialized.length > AI_RUN_SESSION_SERIALIZED_LIMIT) {
    const disposableIndex = state.runs.findIndex(
      (snapshot) => !isCriticalSnapshot(snapshot),
    )
    if (disposableIndex < 0) break
    state.runs.splice(disposableIndex, 1)
    serialized = JSON.stringify(state)
  }

  if (serialized.length > AI_RUN_SESSION_SERIALIZED_LIMIT) {
    // Keep process/task identity + marker, but shed replayable bulk from every
    // critical record. This preserves recovery correctness even when output
    // from multiple live CLIs exceeded the normal local-storage budget.
    for (const snapshot of state.runs) {
      snapshot.record.events = []
      snapshot.terminalReplay = undefined
      snapshot.extraArgs = []
    }
    serialized = JSON.stringify(state)
  }

  if (serialized.length > AI_RUN_SESSION_SERIALIZED_LIMIT) {
    // Last-resort metadata compaction. Fields required to identify and reset
    // the TaskChute instance remain exact; optional display/session metadata
    // is dropped. In realistic use this is far below the storage limit.
    for (const snapshot of state.runs) {
      const record = snapshot.record
      snapshot.record = {
        id: record.id,
        taskPath: record.taskPath,
        taskName: record.taskName,
        host: record.host,
        status: record.status,
        mode: record.mode,
        startedAt: record.startedAt,
        ...(record.instanceId ? { instanceId: record.instanceId } : {}),
        events: [],
      }
    }
  }
  return state
}

/**
 * Synchronous local-storage boundary with coalesced writes. Storage failures
 * are contained: the manager keeps its in-memory runs even when persistence
 * is temporarily unavailable or the device quota is exhausted.
 */
export class AiRunSessionStateStore {
  private readonly timer: AiRunSessionTimer
  private readonly saveDelayMs: number
  private pendingSource: AiRunSessionSnapshotSource | null = null
  private pendingTimer: number | null = null
  /** Absolute deadline of pendingTimer; only meaningful while it is armed. */
  private pendingDeadline = 0

  constructor(
    private readonly storage: AiRunSessionStorageBridge,
    private readonly options: AiRunSessionStateStoreOptions = {},
  ) {
    this.timer = options.timer ?? defaultTimer
    this.saveDelayMs = Number.isFinite(options.saveDelayMs)
      ? Math.max(0, Math.round(options.saveDelayMs ?? AI_RUN_SESSION_SAVE_DELAY_MS))
      : AI_RUN_SESSION_SAVE_DELAY_MS
  }

  load(): AiRunSessionSnapshot[] {
    try {
      const value = this.storage.loadLocalStorage(AI_RUN_SESSION_STATE_STORAGE_KEY)
      if (!value || typeof value !== 'object' || Array.isArray(value)) return []
      const state = value as { version?: unknown; runs?: unknown }
      if (state.version !== AI_RUN_SESSION_STATE_VERSION) return []
      return normalizeSnapshots(state.runs)
    } catch (error) {
      this.options.log?.('warn', '[AiRunSessionStateStore] Failed to load state', error)
      return []
    }
  }

  /**
   * Coalesce a save. `delayMs` selects the tier (default
   * AI_RUN_SESSION_SAVE_DELAY_MS; pass AI_RUN_SESSION_SAVE_IDLE_DELAY_MS for
   * output-driven churn) with MIN-DEADLINE-WINS semantics: an earlier
   * request's armed deadline is never extended, and a later request with an
   * earlier deadline re-arms the timer sooner. The latest source always wins
   * regardless of which tier armed the timer.
   */
  scheduleSave(source: AiRunSessionSnapshotSource, delayMs?: number): void {
    // Keep a lazy provider when the caller's snapshot includes a large xterm
    // replay. Repeated PTY chunks then replace one cheap closure instead of
    // joining/cloning the whole buffer before the throttle window expires.
    this.pendingSource = source
    const delay =
      delayMs !== undefined && Number.isFinite(delayMs)
        ? Math.max(0, Math.round(delayMs))
        : this.saveDelayMs
    const deadline = this.now() + delay
    if (this.pendingTimer !== null) {
      if (deadline >= this.pendingDeadline) return
      try {
        this.timer.clearTimeout(this.pendingTimer)
      } catch {
        // Re-armed below; a late duplicate fire flushes an empty queue.
      }
      this.pendingTimer = null
    }
    try {
      this.pendingDeadline = deadline
      this.pendingTimer = this.timer.setTimeout(() => {
        this.pendingTimer = null
        this.flush()
      }, delay)
    } catch (error) {
      this.options.log?.('warn', '[AiRunSessionStateStore] Save timer failed', error)
      this.saveSourceNow(source)
    }
  }

  saveNow(snapshots: AiRunSessionSnapshot[]): void {
    if (this.pendingTimer !== null) {
      try {
        this.timer.clearTimeout(this.pendingTimer)
      } catch {
        // The current snapshot is still written below.
      }
      this.pendingTimer = null
    }
    this.pendingSource = null
    try {
      this.storage.saveLocalStorage(
        AI_RUN_SESSION_STATE_STORAGE_KEY,
        fitStateToSerializedLimit(snapshots),
      )
    } catch (error) {
      this.options.log?.('warn', '[AiRunSessionStateStore] Failed to save state', error)
    }
  }

  flush(): void {
    if (this.pendingTimer !== null) {
      try {
        this.timer.clearTimeout(this.pendingTimer)
      } catch {
        // The pending snapshot is still written below.
      }
      this.pendingTimer = null
    }
    const source = this.pendingSource
    this.pendingSource = null
    if (source) this.saveSourceNow(source)
  }

  private now(): number {
    return this.timer.now?.() ?? Date.now()
  }

  private saveSourceNow(source: AiRunSessionSnapshotSource): void {
    try {
      const snapshots = typeof source === 'function' ? source() : source
      this.saveNow(snapshots)
    } catch (error) {
      this.options.log?.(
        'warn',
        '[AiRunSessionStateStore] Failed to create state snapshot',
        error,
      )
    }
  }
}

export function wasActiveBeforeRestore(status: AiRunStatus): boolean {
  return ACTIVE_STATUSES.has(status)
}
