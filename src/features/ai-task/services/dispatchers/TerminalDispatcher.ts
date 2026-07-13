/**
 * AI Task - terminal (PTY) dispatcher
 *
 * Runs a host CLI interactively inside an OS PTY wrapper (the gateway's
 * buildPtyCommand) so the full TUI renders and the user can type into it.
 * AI-task runs are shell-backed: the PTY owns the user's login shell and the
 * safely quoted AI command is submitted as its foreground job. Ctrl+C can
 * therefore end Claude/Codex and return to a usable shell prompt without
 * ending the terminal session. Plain shell sessions use direct mode and are
 * not wrapped in a second shell.
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
import { buildTerminalArgs } from '../TerminalArguments'
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
  /** Run binaryPath + argv as a foreground job of a persistent login shell */
  launchInShell?: boolean
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
  /** Resize both xterm's backing PTY dimensions (cols first, then rows) */
  resize?(cols: number, rows: number): void
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

const LOGIN_SHELL_ARGS: readonly string[] = ['-i', '-l']

function normalizeResizeDimension(value: number): number | null {
  if (!Number.isFinite(value)) return null
  const floored = Math.floor(value)
  if (floored < 1) return null
  return Math.min(floored, 999)
}

/** POSIX token quoting; reject NUL because neither argv nor shell input can preserve it. */
function quoteShellToken(token: string): string {
  if (token.includes('\0')) {
    throw new Error('Terminal launch tokens must not contain NUL bytes')
  }
  return `'${token.replace(/'/g, `'\\''`)}'`
}

/** Build one injection-safe command line from an executable and its argv. */
export function buildShellLaunchCommand(binaryPath: string, args: readonly string[]): string {
  return [binaryPath, ...args].map(quoteShellToken).join(' ')
}

export class TerminalDispatcher implements AiTerminalDispatcher {
  constructor(
    private readonly gateway: ProcessGateway,
    private readonly graceTimer: AiGraceTimer = defaultGraceTimer,
  ) {}

  start(request: TerminalRunRequest, callbacks: TerminalRunCallbacks): TerminalRunHandle {
    const args = buildTerminalArgs(request.extraArgs, request.prompt)
    const shellLaunchCommand = request.launchInShell
      ? buildShellLaunchCommand(request.binaryPath, args)
      : null
    const ptyBinaryPath = request.launchInShell
      ? quoteCheckedShellPath(this.gateway.getShellPath())
      : request.binaryPath

    const ptyCommand = this.gateway.buildPtyCommand({
      binaryPath: ptyBinaryPath,
      args: request.launchInShell ? [...LOGIN_SHELL_ARGS] : args,
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
    let pendingResize: { cols: number; rows: number } | null = null

    const applyPendingResize = (): void => {
      if (pendingResize === null || exited) return
      if (
        this.gateway.resizePty(
          request.transcriptPath,
          pendingResize.cols,
          pendingResize.rows,
        )
      ) {
        pendingResize = null
      }
    }

    handle.onStdout((text) => {
      applyPendingResize()
      callbacks.onData(text)
    })
    handle.onStderr((text) => {
      applyPendingResize()
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
      pendingResize = null
      if (killTimerHandle !== null) {
        this.graceTimer.clearTimeout(killTimerHandle)
        killTimerHandle = null
      }
      // The gateway snapshots the wrapper's descendants before stop(). Once
      // the wrapper closes, sweep that snapshot with SIGKILL as well. This
      // catches tools that detached into another process group/session while
      // avoiding a late signal to the already-exited wrapper PID.
      if (stopRequested) {
        handle.kill('SIGKILL')
      }
      // The wrapper reaps its own process group with SIGKILL, so the raw
      // exit is (null, SIGKILL) even for clean sessions; the sentinel
      // carries the child's real exit code.
      callbacks.onExit(resolveTerminalExitOutcome(sentinelCode ?? code, signal, stopRequested))
    })
    // Register every output/exit callback before submitting the startup
    // command: a fast CLI must not emit output or exit into an unwired run.
    if (shellLaunchCommand !== null) {
      handle.writeStdin?.(`${shellLaunchCommand}\r`)
    }

    return {
      pid: handle.pid,
      write: (data) => {
        if (exited) return
        handle.writeStdin?.(data)
      },
      resize: (cols, rows) => {
        if (exited) return
        const normalizedCols = normalizeResizeDimension(cols)
        const normalizedRows = normalizeResizeDimension(rows)
        if (normalizedCols === null || normalizedRows === null) return
        pendingResize = { cols: normalizedCols, rows: normalizedRows }
        applyPendingResize()
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

function quoteCheckedShellPath(shellPath: string): string {
  if (shellPath.includes('\0')) {
    throw new Error('Terminal shell path must not contain NUL bytes')
  }
  return shellPath
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
