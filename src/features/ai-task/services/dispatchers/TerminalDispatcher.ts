/**
 * AI Task - terminal (PTY) dispatcher
 *
 * Runs a host CLI interactively inside an OS PTY wrapper (the gateway's
 * buildPtyCommand) so the full TUI renders and the user can type into it.
 * The argv is `[...extraArgs, '--', prompt]` for every host — no `-p`, no
 * `--output-format`: the positional prompt drops the CLI into its REPL with
 * the prompt pre-submitted, and an empty prompt opens a plain REPL (no `--`
 * emitted). The `--` end-of-options separator mirrors the headless
 * dispatchers' fix (commit a6e3ca5): a dash-leading prompt body (e.g. a
 * bulleted `## Prompt` section) must never be parsed as a CLI flag.
 * Verified interactively on-device: `claude -- <prompt>` (2.1.205) and
 * `codex -- <prompt>` (0.144.1) both accept the separator.
 *
 * Output is relayed as RAW utf8 chunks (no line splitting, no JSON parsing);
 * keystrokes go back through write() -> child stdin. stop() keeps the
 * headless SIGTERM -> SIGKILL group-kill semantics for the wrapper pipeline;
 * the CLI itself sits in `script`'s own session and dies via the PTY SIGHUP
 * raised when the wrapper exits (see the gateway's spawn comment).
 */

import { TERMINAL_EXIT_SENTINEL } from '../NodeProcessGateway'
import type { ProcessGateway } from '../NodeProcessGateway'
import { STOP_GRACE_MS } from './Dispatcher'
import type { AiGraceTimer, AiRunExitOutcome } from './Dispatcher'

export interface TerminalRunRequest {
  /** Absolute path to the CLI binary */
  binaryPath: string
  /** Initial prompt submitted into the REPL; '' opens a plain REPL */
  prompt: string
  /** Working directory for the child process */
  cwd?: string
  /** Extra CLI arguments inserted before the prompt */
  extraArgs?: string[]
  /** PTY size, fixed for the lifetime of the session */
  rows: number
  cols: number
  /** Temp file the PTY session transcript is recorded to */
  transcriptPath: string
}

export interface TerminalRunCallbacks {
  /** Raw utf8 output chunks (stdout and stderr merged by the PTY) */
  onData(bytes: string): void
  onExit(outcome: AiRunExitOutcome): void
}

export interface TerminalRunHandle {
  pid?: number
  /** Relay keyboard input to the session's stdin */
  write(data: string): void
  /** Graceful stop: SIGTERM, then SIGKILL after the grace period */
  stop(): void
  /** Immediate SIGKILL (plugin unload path) */
  forceKill?(): void
}

export interface AiTerminalDispatcher {
  start(request: TerminalRunRequest, callbacks: TerminalRunCallbacks): TerminalRunHandle
}

/**
 * Terminal-session environment: the base env (CLAUDECODE removed, login
 * shell PATH merged) minus NO_COLOR, plus explicit color/TERM variables so
 * the TUI renders with full styling inside the PTY.
 */
export function buildTerminalEnv(
  baseEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...baseEnv }
  delete env['NO_COLOR']
  env['FORCE_COLOR'] = '1'
  env['TERM'] = 'xterm-256color'
  env['COLORTERM'] = 'truecolor'
  return env
}

/** `__TASKCHUTE_AI_EXIT__<code>` plus its trailing newline, if present */
const SENTINEL_PATTERN = new RegExp(`${TERMINAL_EXIT_SENTINEL}(\\d+)\\r?\\n?`)

const defaultGraceTimer: AiGraceTimer = {
  setTimeout: (handler, timeoutMs) => activeWindow.setTimeout(handler, timeoutMs),
  clearTimeout: (handle) => {
    activeWindow.clearTimeout(handle)
  },
}

export class TerminalDispatcher implements AiTerminalDispatcher {
  constructor(
    private readonly gateway: ProcessGateway,
    private readonly graceTimer: AiGraceTimer = defaultGraceTimer,
  ) {}

  start(request: TerminalRunRequest, callbacks: TerminalRunCallbacks): TerminalRunHandle {
    const args = [...(request.extraArgs ?? [])]
    if (request.prompt.length > 0) {
      args.push('--', request.prompt)
    }

    const ptyCommand = this.gateway.buildPtyCommand({
      binaryPath: request.binaryPath,
      args,
      rows: request.rows,
      cols: request.cols,
      transcriptPath: request.transcriptPath,
    })

    const handle = this.gateway.spawnProcess({
      command: ptyCommand.command,
      args: ptyCommand.args,
      cwd: request.cwd,
      env: buildTerminalEnv(this.gateway.getBaseEnv()),
      stdinMode: 'pipe',
    })

    let stopRequested = false
    let exited = false
    let killTimerHandle: number | null = null
    let sentinelCode: number | null = null

    handle.onStdout((text) => {
      callbacks.onData(text)
    })
    handle.onStderr((text) => {
      // The PTY merges the session's stderr into the terminal stream, so
      // the raw stderr channel carries only wrapper output: the exit-code
      // sentinel (see TERMINAL_EXIT_SENTINEL) and rare spawn errors. Parse
      // the sentinel out and relay any remaining text onto the screen.
      const match = text.match(SENTINEL_PATTERN)
      if (match) {
        sentinelCode = Number(match[1])
      }
      const visible = text.replace(SENTINEL_PATTERN, '')
      if (visible.length > 0) {
        callbacks.onData(visible)
      }
    })
    handle.onExit((code, signal) => {
      exited = true
      if (killTimerHandle !== null) {
        this.graceTimer.clearTimeout(killTimerHandle)
        killTimerHandle = null
      }
      // The wrapper reaps its own process group with SIGKILL, so the raw
      // exit is (null, SIGKILL) even for clean sessions; the sentinel
      // carries the child's real exit code.
      callbacks.onExit(resolveTerminalExitOutcome(sentinelCode ?? code, signal, stopRequested))
    })

    return {
      pid: handle.pid,
      write: (data) => {
        if (exited) return
        handle.writeStdin?.(data)
      },
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

function resolveTerminalExitOutcome(
  code: number | null,
  signal: string | null,
  stopRequested: boolean,
): AiRunExitOutcome {
  if (stopRequested) {
    return { status: 'stopped', exitCode: code, signal }
  }
  if (code === 0) {
    return { status: 'succeeded', exitCode: code, signal }
  }
  const errorMessage =
    code === null
      ? `Process terminated by signal ${signal ?? 'unknown'}`
      : `Process exited with code ${code}`
  return { status: 'failed', exitCode: code, signal, errorMessage }
}
