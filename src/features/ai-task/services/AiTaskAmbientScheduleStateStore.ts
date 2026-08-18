/**
 * Device-local execution ledger for Ambient AI routines.
 *
 * TaskChute for Agents keeps schedule execution state separately from the
 * routine/day state.  TaskChute Plus follows the same boundary here: the
 * ledger only answers whether one logical task already auto-started on a
 * local calendar date.  It deliberately does not mutate task frontmatter.
 */

export const AI_TASK_AMBIENT_SCHEDULE_STATE_STORAGE_KEY =
  'taskchute-plus.ai-task-ambient-schedule-state.v1'

export const AI_TASK_AMBIENT_SCHEDULE_RETENTION_DAYS = 30

export interface AiTaskAmbientScheduleExecutionRecord {
  lastExecutedDate: string
  lastExecutedAt: string
}

export interface AiTaskAmbientScheduleState {
  version: 1
  executions: Record<string, AiTaskAmbientScheduleExecutionRecord>
}

export interface AiTaskAmbientScheduleStorageBridge {
  loadLocalStorage(key: string): unknown
  saveLocalStorage(key: string, value: unknown): void
}

export interface AiTaskAmbientIdentitySource {
  taskId?: unknown
  path?: unknown
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Stable task identity. Task IDs survive renames; path is a legacy fallback. */
export function resolveAiTaskAmbientIdentity(
  source: AiTaskAmbientIdentitySource,
): string | null {
  const taskId = normalizeNonEmptyString(source.taskId)
  if (taskId) return `taskId:${taskId}`

  const path = normalizeNonEmptyString(source.path)
  return path ? `path:${path}` : null
}

/** Format a Date in the user's local timezone, never UTC. */
export function formatAiTaskAmbientDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseDateKey(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(year, month - 1, day)
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null
  }
  parsed.setHours(0, 0, 0, 0)
  return parsed
}

function createEmptyState(): AiTaskAmbientScheduleState {
  return { version: 1, executions: {} }
}

function normalizeState(value: unknown): AiTaskAmbientScheduleState {
  const normalized = createEmptyState()
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return normalized
  }

  const executions = (value as { executions?: unknown }).executions
  if (!executions || typeof executions !== 'object' || Array.isArray(executions)) {
    return normalized
  }

  for (const [rawIdentity, rawRecord] of Object.entries(executions)) {
    const identity = normalizeNonEmptyString(rawIdentity)
    if (!identity || !rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) {
      continue
    }

    const candidate = rawRecord as {
      lastExecutedDate?: unknown
      lastExecutedAt?: unknown
    }
    const dateKey = normalizeNonEmptyString(candidate.lastExecutedDate)
    const executedAt = normalizeNonEmptyString(candidate.lastExecutedAt)
    if (!dateKey || !parseDateKey(dateKey) || !executedAt) continue
    if (!Number.isFinite(Date.parse(executedAt))) continue

    normalized.executions[identity] = {
      lastExecutedDate: dateKey,
      lastExecutedAt: executedAt,
    }
  }

  return normalized
}

/**
 * Small synchronous state store around Obsidian's App local-storage bridge.
 *
 * Storage failures are contained. The in-memory state still prevents repeated
 * starts for the remainder of the current plugin session when persistence is
 * temporarily unavailable.
 */
export class AiTaskAmbientScheduleStateStore {
  private state: AiTaskAmbientScheduleState | null = null

  constructor(
    private readonly storage: AiTaskAmbientScheduleStorageBridge,
    private readonly retentionDays = AI_TASK_AMBIENT_SCHEDULE_RETENTION_DAYS,
  ) {}

  isExecuted(identity: string, dateKey: string): boolean {
    const normalizedIdentity = normalizeNonEmptyString(identity)
    if (!normalizedIdentity || !parseDateKey(dateKey)) return false
    return this.getState().executions[normalizedIdentity]?.lastExecutedDate === dateKey
  }

  markExecuted(identity: string, dateKey: string, executedAt: Date = new Date()): boolean {
    const normalizedIdentity = normalizeNonEmptyString(identity)
    if (!normalizedIdentity || !parseDateKey(dateKey) || !Number.isFinite(executedAt.getTime())) {
      return false
    }

    const state = this.getState()
    state.executions[normalizedIdentity] = {
      lastExecutedDate: dateKey,
      lastExecutedAt: executedAt.toISOString(),
    }
    this.pruneInPlace(state, executedAt, this.retentionDays)
    this.persist(state)
    return true
  }

  prune(
    referenceDate: Date = new Date(),
    retentionDays: number = this.retentionDays,
  ): number {
    if (!Number.isFinite(referenceDate.getTime())) return 0
    const state = this.getState()
    const removed = this.pruneInPlace(state, referenceDate, retentionDays)
    if (removed > 0) this.persist(state)
    return removed
  }

  getRecord(identity: string): AiTaskAmbientScheduleExecutionRecord | null {
    const normalizedIdentity = normalizeNonEmptyString(identity)
    if (!normalizedIdentity) return null
    const record = this.getState().executions[normalizedIdentity]
    return record ? { ...record } : null
  }

  snapshot(): AiTaskAmbientScheduleState {
    return JSON.parse(JSON.stringify(this.getState())) as AiTaskAmbientScheduleState
  }

  private getState(): AiTaskAmbientScheduleState {
    if (this.state) return this.state
    try {
      this.state = normalizeState(
        this.storage.loadLocalStorage(
          AI_TASK_AMBIENT_SCHEDULE_STATE_STORAGE_KEY,
        ),
      )
    } catch {
      this.state = createEmptyState()
    }
    return this.state
  }

  private persist(state: AiTaskAmbientScheduleState): void {
    try {
      this.storage.saveLocalStorage(
        AI_TASK_AMBIENT_SCHEDULE_STATE_STORAGE_KEY,
        this.snapshotValue(state),
      )
    } catch {
      // The updated in-memory state remains authoritative for this session.
    }
  }

  private snapshotValue(
    state: AiTaskAmbientScheduleState,
  ): AiTaskAmbientScheduleState {
    return JSON.parse(JSON.stringify(state)) as AiTaskAmbientScheduleState
  }

  private pruneInPlace(
    state: AiTaskAmbientScheduleState,
    referenceDate: Date,
    retentionDays: number,
  ): number {
    const normalizedRetention = Number.isFinite(retentionDays)
      ? Math.max(0, Math.floor(retentionDays))
      : AI_TASK_AMBIENT_SCHEDULE_RETENTION_DAYS
    const cutoff = new Date(
      referenceDate.getFullYear(),
      referenceDate.getMonth(),
      referenceDate.getDate(),
    )
    cutoff.setDate(cutoff.getDate() - normalizedRetention)

    let removed = 0
    for (const [identity, record] of Object.entries(state.executions)) {
      const executedDate = parseDateKey(record.lastExecutedDate)
      if (!executedDate || executedDate.getTime() < cutoff.getTime()) {
        delete state.executions[identity]
        removed += 1
      }
    }
    return removed
  }
}
