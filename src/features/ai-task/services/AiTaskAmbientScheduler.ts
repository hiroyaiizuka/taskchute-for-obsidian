import type { AiTaskAmbientCandidate } from './AiTaskAmbientCandidateFinder'
import type { AiTaskAmbientScheduleStateStore } from './AiTaskAmbientScheduleStateStore'
import {
  stableTimerSource,
  type StableIntervalId,
} from '../../../utils/stableTimer'

export const AI_TASK_AMBIENT_CHECK_INTERVAL_MS = 60_000

/** Consecutive-failure retry delays; the last entry caps further attempts. */
export const AI_TASK_AMBIENT_FAILURE_BACKOFF_STEPS_MS: readonly number[] = [
  60_000, 300_000, 900_000, 3_600_000,
]

type AmbientMaybePromise<T> = T | Promise<T>

interface AmbientFailureRecord {
  dateKey: string
  attempts: number
  nextAttemptAt: number
}

export interface AiTaskAmbientTimerHost {
  setInterval: (
    handler: () => void,
    intervalMs: number,
  ) => StableIntervalId
  clearInterval: (
    handle: StableIntervalId,
  ) => void
}

export interface AiTaskAmbientEventTarget {
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}

export interface AiTaskAmbientSchedulerOptions {
  findCandidates(now: Date): AmbientMaybePromise<readonly AiTaskAmbientCandidate[]>
  /**
   * Returns the identities whose normal task + AI launch actually succeeded.
   * Omitted identities count as failed attempts and enter exponential backoff.
   */
  executeCandidates(
    candidates: readonly AiTaskAmbientCandidate[],
    now: Date,
  ): Promise<ReadonlySet<string> | readonly string[]>
  stateStore: Pick<
    AiTaskAmbientScheduleStateStore,
    'isExecuted' | 'markExecuted' | 'prune'
  >
  now?: () => Date
  intervalMs?: number
  timerHost?: AiTaskAmbientTimerHost
  focusTarget?: AiTaskAmbientEventTarget
  visibilityTarget?: AiTaskAmbientEventTarget
  isDocumentVisible?: () => boolean
  log?: (level: 'warn' | 'debug', ...args: unknown[]) => void
}

function defaultTimerHost(): AiTaskAmbientTimerHost {
  return stableTimerSource
}

/**
 * Plugin-lifecycle Ambient scheduler.
 *
 * It owns no UI and no process details. Candidate discovery and execution are
 * callbacks so bootstrap can scan the vault while TaskChuteView remains the
 * authority for running/done state and actual AI dispatch.
 */
export class AiTaskAmbientScheduler {
  private readonly timerHost: AiTaskAmbientTimerHost
  private readonly intervalMs: number
  private intervalHandle: StableIntervalId | null = null
  private inFlight: Promise<readonly AiTaskAmbientCandidate[]> | null = null
  private started = false
  private disposed = false
  /**
   * In-memory failure backoff (identity → record). Not persisted on purpose:
   * a reload retries immediately, but within a session a permanently failing
   * candidate no longer spawns a background view on every timer/focus tick.
   */
  private readonly failureBackoff = new Map<string, AmbientFailureRecord>()

  private readonly handleFocus = (): void => {
    void this.checkNow()
  }

  private readonly handleVisibilityChange = (): void => {
    if (this.options.isDocumentVisible?.() === false) return
    void this.checkNow()
  }

  constructor(private readonly options: AiTaskAmbientSchedulerOptions) {
    this.timerHost = options.timerHost ?? defaultTimerHost()
    const requestedInterval = options.intervalMs ?? AI_TASK_AMBIENT_CHECK_INTERVAL_MS
    this.intervalMs = Number.isFinite(requestedInterval)
      ? Math.max(1, Math.floor(requestedInterval))
      : AI_TASK_AMBIENT_CHECK_INTERVAL_MS
  }

  /** Idempotently start periodic checks and await the immediate catch-up. */
  async start(): Promise<void> {
    if (this.disposed) return
    if (this.started) {
      if (this.inFlight) await this.inFlight
      return
    }
    this.started = true

    this.options.focusTarget?.addEventListener('focus', this.handleFocus)
    this.options.visibilityTarget?.addEventListener(
      'visibilitychange',
      this.handleVisibilityChange,
    )
    this.intervalHandle = this.timerHost.setInterval(() => {
      void this.checkNow()
    }, this.intervalMs)

    await this.checkNow()
  }

  /** Stop timers/listeners and prevent an in-flight scan from launching work. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (!this.started) return
    this.started = false

    if (this.intervalHandle !== null) {
      this.timerHost.clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
    this.options.focusTarget?.removeEventListener('focus', this.handleFocus)
    this.options.visibilityTarget?.removeEventListener(
      'visibilitychange',
      this.handleVisibilityChange,
    )
  }

  /**
   * Run one serialized check. Overlapping interval/focus/resume signals join
   * the same promise instead of starting the same routine twice.
   */
  checkNow(now: Date = (this.options.now ?? (() => new Date()))()): Promise<readonly AiTaskAmbientCandidate[]> {
    if (this.disposed) return Promise.resolve([])
    if (this.inFlight) return this.inFlight

    const operation = this.runCheck(now).finally(() => {
      if (this.inFlight === operation) this.inFlight = null
    })
    this.inFlight = operation
    return operation
  }

  isStarted(): boolean {
    return this.started
  }

  private async runCheck(now: Date): Promise<readonly AiTaskAmbientCandidate[]> {
    if (!Number.isFinite(now.getTime())) return []

    let pending: AiTaskAmbientCandidate[] = []
    try {
      this.options.stateStore.prune(now)
      const discovered = await this.options.findCandidates(now)
      if (this.disposed) return []
      const seen = new Set<string>()
      pending = discovered.filter((candidate) => {
        if (!candidate?.identity || !candidate.dateKey) return false
        if (seen.has(candidate.identity)) return false
        seen.add(candidate.identity)
        if (
          this.options.stateStore.isExecuted(
            candidate.identity,
            candidate.dateKey,
          )
        ) {
          return false
        }
        return !this.isBackedOff(candidate, now)
      })
      if (pending.length === 0) return []

      const result = await this.options.executeCandidates(pending, now)
      if (this.disposed) return []
      const succeeded = result instanceof Set ? result : new Set(result)
      const completed: AiTaskAmbientCandidate[] = []
      for (const candidate of pending) {
        if (!succeeded.has(candidate.identity)) {
          this.recordFailure(candidate, now)
          continue
        }
        this.failureBackoff.delete(candidate.identity)
        if (
          this.options.stateStore.markExecuted(
            candidate.identity,
            candidate.dateKey,
            now,
          )
        ) {
          completed.push(candidate)
        }
      }
      return completed
    } catch (error) {
      if (!this.disposed) {
        for (const candidate of pending) this.recordFailure(candidate, now)
      }
      this.options.log?.(
        'warn',
        '[AiTaskAmbientScheduler] Ambient check failed',
        error,
      )
      return []
    }
  }

  private isBackedOff(candidate: AiTaskAmbientCandidate, now: Date): boolean {
    const record = this.failureBackoff.get(candidate.identity)
    if (!record) return false
    if (record.dateKey !== candidate.dateKey) {
      this.failureBackoff.delete(candidate.identity)
      return false
    }
    return now.getTime() < record.nextAttemptAt
  }

  private recordFailure(candidate: AiTaskAmbientCandidate, now: Date): void {
    const previous = this.failureBackoff.get(candidate.identity)
    const attempts =
      previous && previous.dateKey === candidate.dateKey
        ? previous.attempts + 1
        : 1
    const steps = AI_TASK_AMBIENT_FAILURE_BACKOFF_STEPS_MS
    const delayMs =
      steps[Math.min(attempts, steps.length) - 1] ??
      AI_TASK_AMBIENT_CHECK_INTERVAL_MS
    this.failureBackoff.set(candidate.identity, {
      dateKey: candidate.dateKey,
      attempts,
      nextAttemptAt: now.getTime() + delayMs,
    })
  }
}
