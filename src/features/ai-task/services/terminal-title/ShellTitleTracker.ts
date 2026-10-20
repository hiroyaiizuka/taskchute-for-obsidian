import type { AiRunRecord } from '@/features/ai-task/types'
import type { ForegroundProgram, ShellForegroundSample } from './foregroundSnapshot'
import { TerminalTitleParser } from './TerminalTitleParser'

/**
 * Consecutive "cannot tell" answers after which foreground detection is
 * treated as unavailable for the session (no /bin/ps, an unreadable tty):
 * titles then reach the tab as they arrive, like Orca.
 */
export const SHELL_FOREGROUND_FAILURE_LIMIT = 3

/**
 * The tab name of a shell session: what runs in it, never the shell itself.
 *
 *   - foreground unknown (not answered yet): no name yet
 *   - the shell is at its prompt: no name (the tab says "Terminal")
 *   - a program runs: the title it set, else its name (else "Terminal")
 *   - foreground detection unavailable: the latest title, kept
 */
export function resolveShellTerminalLabel(input: {
  title: string | undefined
  foreground: ForegroundProgram | null | undefined
  detecting: boolean
}): string | undefined {
  if (!input.detecting) return input.title
  if (!input.foreground) return undefined
  return input.title ?? input.foreground.name
}

interface ShellTitleState {
  parser: TerminalTitleParser
  title: string | undefined
  /** When the title arrived; a restored title counts as arriving at 0. */
  titleAt: number
  /**
   * pid of the program the title belongs to. Set when the title arrives
   * while a known program runs, or claimed by the next answer otherwise; a
   * different program in the foreground drops the title.
   */
  titleOwner: number | undefined
  /** undefined until answered; null at the prompt. */
  foreground: ForegroundProgram | null | undefined
  failures: number
}

export interface ShellOutputResult {
  /** record.terminalTitle / terminalLabel changed. */
  changed: boolean
  /** Worth asking for the foreground now: a new title, or the foreground is still unknown. */
  pollSoon: boolean
}

/**
 * Per-run title and foreground state for shell sessions. Writes the outcome
 * onto the run record (terminalTitle, terminalLabel) so it survives a hidden
 * tab, a pane remount and — through the session state store — a reload.
 */
export class ShellTitleTracker {
  private readonly states = new Map<string, ShellTitleState>()

  constructor(private readonly now: () => number) {}

  handleOutput(record: AiRunRecord, chunk: string, probeAvailable: boolean): ShellOutputResult {
    const state = this.stateFor(record)
    const raw = state.parser.feed(chunk)
    if (raw === undefined) return { changed: false, pollSoon: false }
    const detecting = this.isDetecting(state, probeAvailable)
    const unknown = detecting && state.foreground === undefined
    const title = raw.length > 0 ? raw : undefined
    // Spinner frames clean to the same title: nothing new.
    if (title === state.title) return { changed: false, pollSoon: unknown }
    state.title = title
    state.titleAt = this.now()
    state.titleOwner = state.foreground ? state.foreground.pid : undefined
    return { changed: this.apply(record, state, detecting), pollSoon: true }
  }

  /** One foreground answer; null when it could not be told. */
  handleSample(
    record: AiRunRecord,
    sample: ShellForegroundSample | null,
    probeStartedAt: number,
  ): boolean {
    const state = this.stateFor(record)
    if (sample === null) {
      state.failures += 1
      return this.apply(record, state, this.isDetecting(state, true))
    }
    state.failures = 0
    state.foreground = sample.program
    // A title newer than this ps may belong to a program it did not see yet.
    if (state.title !== undefined && state.titleAt < probeStartedAt) {
      const program = sample.program
      if (program === null || (state.titleOwner !== undefined && state.titleOwner !== program.pid)) {
        // Back at the prompt, or another program now: the title went with its program.
        state.title = undefined
        state.titleOwner = undefined
      } else if (state.titleOwner === undefined) {
        state.titleOwner = program.pid
      }
    }
    return this.apply(record, state, true)
  }

  forget(runId: string): void {
    this.states.delete(runId)
  }

  clear(): void {
    this.states.clear()
  }

  private isDetecting(state: ShellTitleState, probeAvailable: boolean): boolean {
    return probeAvailable && state.failures < SHELL_FOREGROUND_FAILURE_LIMIT
  }

  private stateFor(record: AiRunRecord): ShellTitleState {
    let state = this.states.get(record.id)
    if (!state) {
      state = {
        parser: new TerminalTitleParser(),
        title: record.terminalTitle,
        titleAt: 0,
        titleOwner: undefined,
        foreground: undefined,
        failures: 0,
      }
      this.states.set(record.id, state)
    }
    return state
  }

  private apply(record: AiRunRecord, state: ShellTitleState, detecting: boolean): boolean {
    // Until the first answer the tab keeps what it shows (a restored name included).
    const label =
      detecting && state.foreground === undefined
        ? record.terminalLabel
        : resolveShellTerminalLabel({ title: state.title, foreground: state.foreground, detecting })
    if (record.terminalTitle === state.title && record.terminalLabel === label) return false
    setOptional(record, 'terminalTitle', state.title)
    setOptional(record, 'terminalLabel', label)
    return true
  }
}

function setOptional(
  record: AiRunRecord,
  key: 'terminalTitle' | 'terminalLabel',
  value: string | undefined,
): void {
  if (value === undefined) delete record[key]
  else record[key] = value
}
