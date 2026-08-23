/**
 * AI Task - dispatcher abstractions
 *
 * AiDispatcher is the seam between the run orchestration layer and a concrete
 * headless CLI (Claude Code, Codex, or a future SDK-based runner). The shared
 * HeadlessCliDispatcher base handles spawning, line splitting, event
 * normalization, exit mapping, and graceful stop semantics; subclasses only
 * provide the argv shape and the per-host line parser.
 */

import type { AiStreamEvent } from '../../types'
import { stableTimeoutSource } from '../../../../utils/stableTimer'
import type { ProcessGateway } from '../NodeProcessGateway'
import type { ProcessLaunchError } from '../NodeProcessGateway'
import { LineSplitter } from '../streams/LineSplitter'
import { capEventText } from '../streams/StreamJsonParser'

export interface AiRunRequest {
  /** Absolute path to the CLI binary */
  binaryPath: string
  /** Package entrypoint argv inserted before the host-specific CLI args. */
  binaryArgsPrefix?: string[]
  /** Launch-only environment delta from the validated CLI LaunchSpec. */
  envPatch?: Readonly<Record<string, string | undefined>>
  prompt: string
  /** Working directory for the child process */
  cwd?: string
  /** Extra CLI arguments appended to the host defaults */
  extraArgs?: string[]
  /**
   * Resume an earlier CLI session instead of starting a fresh one
   * (claude `--resume`, codex `exec resume`). Empty strings are ignored.
   */
  resumeSessionId?: string
}

export type AiRunEndStatus = 'succeeded' | 'failed' | 'stopped'

export interface AiRunExitOutcome {
  status: AiRunEndStatus
  exitCode: number | null
  signal: string | null
  errorMessage?: string
  /** Present only when the OS never launched the requested executable. */
  launchError?: ProcessLaunchError
}

export interface AiRunCallbacks {
  onEvent(event: AiStreamEvent): void
  onExit(outcome: AiRunExitOutcome): void
}

export interface AiRunProcessHandle {
  pid?: number
  stop(): void
  /**
   * Immediately SIGKILL the child, bypassing the SIGTERM grace period.
   * Used by AiTaskManager.dispose() so plugin unload cannot leave zombies.
   */
  forceKill?(): void
}

export interface AiDispatcher {
  start(request: AiRunRequest, callbacks: AiRunCallbacks): AiRunProcessHandle
}

/**
 * Injectable timer for the stop grace period. Production uses the root
 * renderer window so a focused popout cannot strand a kill deadline;
 * tests inject a recording fake.
 */
export interface AiGraceTimer {
  setTimeout(handler: () => void, timeoutMs: number): number
  clearTimeout(handle: number): void
}

/** Grace period between SIGTERM and the SIGKILL escalation */
export const STOP_GRACE_MS = 5000

const defaultGraceTimer: AiGraceTimer = stableTimeoutSource

export abstract class HeadlessCliDispatcher implements AiDispatcher {
  constructor(
    protected readonly gateway: ProcessGateway,
    private readonly graceTimer: AiGraceTimer = defaultGraceTimer,
  ) {}

  /** Build the CLI argv (excluding the binary itself) for one run */
  protected abstract buildArgs(request: AiRunRequest): string[]

  /** Parse one stdout line into normalized stream events */
  protected abstract parseLine(line: string): AiStreamEvent[]

  /**
   * Host-specific stderr noise filter. Lines reported as noise are dropped
   * instead of becoming stderr events (e.g. codex's stdin notice, printed
   * for any non-tty stdin including the /dev/null the gateway provides).
   */
  protected isNoiseStderrLine(line: string): boolean {
    void line
    return false
  }

  start(request: AiRunRequest, callbacks: AiRunCallbacks): AiRunProcessHandle {
    const baseEnv = this.gateway.getBaseEnv()
    const env =
      request.envPatch !== undefined &&
      Object.keys(request.envPatch).length > 0
        ? { ...baseEnv, ...request.envPatch }
        : baseEnv
    const handle = this.gateway.spawnProcess({
      command: request.binaryPath,
      args: [...(request.binaryArgsPrefix ?? []), ...this.buildArgs(request)],
      cwd: request.cwd,
      env,
    })

    const stdoutSplitter = new LineSplitter()
    const stderrSplitter = new LineSplitter()
    let sawErrorResult = false
    let lastErrorResultText: string | undefined
    let stopRequested = false
    let exited = false
    let launchError: ProcessLaunchError | undefined
    let killTimerHandle: number | null = null

    const emitStdoutLine = (line: string): void => {
      for (const event of this.parseLine(line)) {
        if (event.kind === 'result' && event.isError) {
          sawErrorResult = true
          lastErrorResultText = event.text
        }
        callbacks.onEvent(event)
      }
    }

    const emitStderrLine = (line: string): void => {
      if (line.trim().length === 0) return
      if (this.isNoiseStderrLine(line)) return
      callbacks.onEvent({ kind: 'stderr', text: capEventText(line) })
    }

    handle.onLaunchError?.((error) => {
      launchError = error
    })
    handle.onStdout((text) => {
      for (const line of stdoutSplitter.push(text)) emitStdoutLine(line)
    })
    handle.onStderr((text) => {
      if (launchError !== undefined) return
      for (const line of stderrSplitter.push(text)) emitStderrLine(line)
    })
    handle.onExit((code, signal) => {
      exited = true
      if (killTimerHandle !== null) {
        this.graceTimer.clearTimeout(killTimerHandle)
        killTimerHandle = null
      }
      // Reap any descendants snapshotted before SIGTERM, including tools
      // that detached into another process group before the CLI exited.
      if (stopRequested) {
        handle.kill('SIGKILL')
      }
      for (const line of stdoutSplitter.flush()) emitStdoutLine(line)
      for (const line of stderrSplitter.flush()) emitStderrLine(line)
      callbacks.onExit(
        resolveExitOutcome({
          code,
          signal,
          stopRequested,
          sawErrorResult,
          lastErrorResultText,
          launchError,
        }),
      )
    })

    return {
      pid: handle.pid,
      stop: () => {
        if (stopRequested || exited) return
        stopRequested = true
        handle.kill('SIGTERM')
        killTimerHandle = this.graceTimer.setTimeout(() => {
          killTimerHandle = null
          handle.kill('SIGKILL')
        }, STOP_GRACE_MS)
      },
      forceKill: () => {
        if (exited) return
        stopRequested = true
        handle.kill('SIGKILL')
      },
    }
  }
}

function resolveExitOutcome(input: {
  code: number | null
  signal: string | null
  stopRequested: boolean
  sawErrorResult: boolean
  lastErrorResultText: string | undefined
  launchError?: ProcessLaunchError
}): AiRunExitOutcome {
  const {
    code,
    signal,
    stopRequested,
    sawErrorResult,
    lastErrorResultText,
    launchError,
  } = input
  if (stopRequested) {
    return { status: 'stopped', exitCode: code, signal }
  }
  if (code === 0 && !sawErrorResult) {
    return { status: 'succeeded', exitCode: code, signal }
  }
  if (launchError !== undefined) {
    return {
      status: 'failed',
      exitCode: code,
      signal,
      errorMessage: launchError.message,
      launchError,
    }
  }
  let errorMessage: string
  if (sawErrorResult) {
    errorMessage = lastErrorResultText ?? 'The CLI reported an error result'
  } else if (code === null) {
    errorMessage = `Process terminated by signal ${signal ?? 'unknown'}`
  } else {
    errorMessage = `Process exited with code ${code}`
  }
  return { status: 'failed', exitCode: code, signal, errorMessage }
}
