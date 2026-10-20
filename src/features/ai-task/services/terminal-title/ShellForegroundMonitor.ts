import type { AiGraceTimer } from '../dispatchers/Dispatcher'
import type { ShellForegroundSample } from './foregroundSnapshot'
import type { ShellForegroundProbe } from './ShellForegroundProbe'

/** How often live shell sessions are asked what runs in their foreground. */
export const SHELL_FOREGROUND_POLL_MS = 2000
/** Delay of an early poll requested because a title just arrived. */
export const SHELL_FOREGROUND_PROMPT_POLL_MS = 250

export interface ShellForegroundMonitorOptions {
  /** Read on every poll, so a rebound gateway takes effect without a restart. */
  getProbe(): ShellForegroundProbe | undefined
  timer: AiGraceTimer
  now(): number
  /**
   * One answer for one session; null when it could not be told this time.
   * `probeStartedAt` is when the ps behind the answer was started.
   */
  onSample(runId: string, sample: ShellForegroundSample | null, probeStartedAt: number): void
  log?(level: 'warn' | 'debug', ...args: unknown[]): void
  intervalMs?: number
}

/**
 * Polls the foreground program of every tracked shell session — all of them
 * with one probe call — while at least one is tracked, and stops on its own
 * when none is. Polls never overlap: the next one is scheduled when the
 * previous one has settled. While no probe is available the schedule keeps
 * ticking, so polling resumes when one comes back. Owned by the
 * AiTaskManager, which tracks a shell from the moment its transcript path is
 * known until it exits, and disposes the monitor with itself.
 */
export class ShellForegroundMonitor {
  private readonly tracked = new Map<string, string>()
  private timerHandle: number | null = null
  private dueAt = Number.POSITIVE_INFINITY
  private polling = false
  private pollAgainSoon = false
  private disposed = false

  constructor(private readonly options: ShellForegroundMonitorOptions) {}

  /** Start (or keep) watching a session. Idempotent. */
  track(runId: string, transcriptPath: string): void {
    if (this.disposed) return
    const known = this.tracked.get(runId)
    this.tracked.set(runId, transcriptPath)
    if (known === undefined) this.requestPoll(SHELL_FOREGROUND_PROMPT_POLL_MS)
  }

  untrack(runId: string): void {
    this.tracked.delete(runId)
    if (this.tracked.size === 0) this.cancelTimer()
  }

  isTracking(runId: string): boolean {
    return this.tracked.has(runId)
  }

  /** Ask sooner than the regular interval (a new title arrived). */
  pollSoon(): void {
    if (this.tracked.size === 0) return
    if (this.polling) {
      this.pollAgainSoon = true
      return
    }
    this.requestPoll(SHELL_FOREGROUND_PROMPT_POLL_MS)
  }

  dispose(): void {
    this.disposed = true
    this.tracked.clear()
    this.cancelTimer()
  }

  private requestPoll(delayMs: number): void {
    if (this.disposed || this.polling || this.tracked.size === 0) return
    const dueAt = this.options.now() + delayMs
    if (this.timerHandle !== null && this.dueAt <= dueAt) return
    this.cancelTimer()
    this.dueAt = dueAt
    this.timerHandle = this.options.timer.setTimeout(() => {
      this.timerHandle = null
      this.dueAt = Number.POSITIVE_INFINITY
      void this.poll()
    }, delayMs)
  }

  private cancelTimer(): void {
    if (this.timerHandle !== null) this.options.timer.clearTimeout(this.timerHandle)
    this.timerHandle = null
    this.dueAt = Number.POSITIVE_INFINITY
  }

  private async poll(): Promise<void> {
    if (this.disposed) return
    const probe = this.options.getProbe()
    const sessions = Array.from(this.tracked)
    this.polling = true
    this.pollAgainSoon = false
    try {
      if (probe !== undefined && sessions.length > 0) {
        const startedAt = this.options.now()
        const answers = await probe(sessions.map(([, transcriptPath]) => transcriptPath))
        for (const [runId, transcriptPath] of sessions) {
          // A session untracked (exited) while ps ran gets no late answer.
          if (this.disposed || this.tracked.get(runId) !== transcriptPath) continue
          this.options.onSample(runId, answers.get(transcriptPath) ?? null, startedAt)
        }
      }
    } catch (error) {
      this.options.log?.('warn', '[AiTask] Shell foreground poll failed', error)
    } finally {
      this.polling = false
    }
    this.requestPoll(
      this.pollAgainSoon ? SHELL_FOREGROUND_PROMPT_POLL_MS : this.options.intervalMs ?? SHELL_FOREGROUND_POLL_MS,
    )
  }
}
