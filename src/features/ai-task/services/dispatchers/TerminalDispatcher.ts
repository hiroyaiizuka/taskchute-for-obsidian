/**
 * AI Task - terminal (PTY) dispatcher
 *
 * Runs a host CLI interactively inside an OS PTY wrapper (the gateway's
 * buildPtyCommand) so the full TUI renders and the user can type into it.
 * AI-task runs are shell-backed: the PTY owns the user's login shell and a
 * fixed bootstrap receives the AI executable + argv as real positional
 * parameters. No startup command is typed into the terminal, so long and
 * multibyte prompts cannot hit the TTY's canonical input-line limit. Ctrl+C
 * can end Claude/Codex and return to a usable shell prompt without ending the
 * terminal session. Plain shell sessions use direct mode and are not wrapped
 * in a second shell.
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
import { stableTimeoutSource } from '../../../../utils/stableTimer'
import type { ProcessGateway } from '../NodeProcessGateway'
import type { ProcessLaunchError } from '../NodeProcessGateway'
import { buildTerminalArgs } from '../TerminalArguments'
import { STOP_GRACE_MS } from './Dispatcher'
import type { AiGraceTimer, AiRunExitOutcome } from './Dispatcher'
import { buildTerminalShellLaunch } from './TerminalShellBootstrap'

export interface TerminalRunRequest {
  /** Stable broker identity; omitted by direct/non-persistent dispatchers. */
  sessionId?: string
  /** Absolute path to the CLI binary */
  binaryPath: string
  /** Package entrypoint argv inserted before the host-specific CLI args. */
  binaryArgsPrefix?: string[]
  /** Launch-only environment delta from the validated CLI LaunchSpec. */
  envPatch?: Readonly<Record<string, string | undefined>>
  /** Fixed `claude`/`codex` command resolved by the fresh login shell. */
  terminalCommand?: 'claude' | 'codex'
  /** Fixed fallback used only when the validated absolute path vanished. */
  terminalFallbackCommand?: 'claude' | 'codex'
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
  /**
   * Persistent broker confirmed the live child identity and the trusted temp
   * transcript path captured when that broker session was first spawned.
   */
  onAttached?(pid?: number, transcriptPath?: string): void
  /**
   * Persistent session became unreachable. A broker-confirmed transcript
   * path may accompany abnormal termination when attach replay was unusable.
   */
  onUnavailable?(transcriptPath?: string): void
}

export interface TerminalRunHandle {
  pid?: number
  /** Renderer-independent session id when a persistent dispatcher is used. */
  sessionId?: string
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
  /** Reattach callbacks/input to a session owned outside this renderer. */
  attach?(
    sessionId: string,
    callbacks: TerminalRunCallbacks,
  ): TerminalRunHandle
  /** True only when active sessions can survive a renderer reload. */
  readonly isPersistent?: boolean
  /** Close this renderer's transport without killing broker-owned sessions. */
  detach?(): void
  /**
   * Arm a broker-owned shutdown deadline for an ambiguous Obsidian
   * workspace quit. A renderer that reconnects before the deadline cancels
   * it; a real app exit leaves the broker to reap every owned process.
   */
  scheduleShutdownAfterGrace?(
    graceMs: number,
    rendererLeaseToken?: string,
    rendererLeaseOwnerId?: string,
    rendererLeaseGeneration?: number,
  ): void | Promise<void>
  /**
   * Cancel a previously armed ambiguous app-exit deadline. Implementations
   * must authenticate this control request; ordinary terminal traffic is not
   * proof that the application close was canceled.
   */
  cancelDeferredShutdown?(
    rendererLeaseToken?: string,
    rendererLeaseOwnerId?: string,
    rendererLeaseGeneration?: number,
  ): void | Promise<void>
  /**
   * Rotate the complete renderer identity. The owner remains stable while a
   * retained manager is adopted in the same renderer; generation is
   * monotonic so a delayed request from the prior plugin instance can never
   * reclaim the broker.
   */
  setRendererLeaseToken?(
    rendererLeaseToken: string,
    rendererLeaseOwnerId?: string,
    rendererLeaseGeneration?: number,
  ): void | Promise<void>
  /** Stop all sessions and terminate the renderer-independent broker. */
  shutdown?(): void | Promise<void>
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

const defaultGraceTimer: AiGraceTimer = stableTimeoutSource

function normalizeResizeDimension(value: number): number | null {
  if (!Number.isFinite(value)) return null
  const floored = Math.floor(value)
  if (floored < 1) return null
  return Math.min(floored, 999)
}

export class TerminalDispatcher implements AiTerminalDispatcher {
  constructor(
    private readonly gateway: ProcessGateway,
    private readonly graceTimer: AiGraceTimer = defaultGraceTimer,
  ) {}

  start(request: TerminalRunRequest, callbacks: TerminalRunCallbacks): TerminalRunHandle {
    const args = buildTerminalArgs(request.extraArgs, request.prompt)
    const binaryArgsPrefix = request.binaryArgsPrefix ?? []
    const executableArgs = [...binaryArgsPrefix, ...args]
    const shellLaunch = request.launchInShell
      ? buildTerminalShellLaunch(
          quoteCheckedShellPath(this.gateway.getShellPath()),
          request.binaryPath,
          binaryArgsPrefix,
          args,
          request.terminalCommand,
          request.terminalFallbackCommand,
        )
      : null

    const ptyCommand = this.gateway.buildPtyCommand({
      binaryPath: shellLaunch?.binaryPath ?? request.binaryPath,
      args: shellLaunch?.args ?? executableArgs,
      rows: request.rows,
      cols: request.cols,
      transcriptPath: request.transcriptPath,
    })

    const handle = this.gateway.spawnProcess({
      command: ptyCommand.command,
      args: ptyCommand.args,
      cwd: request.cwd,
      env: buildTerminalEnv({
        ...this.gateway.getBaseEnv(),
        ...(request.envPatch ?? {}),
      }),
      stdinMode: 'pipe',
    })

    let stopRequested = false
    let exited = false
    let killTimerHandle: number | null = null
    let sentinelCode: number | null = null
    let launchError: ProcessLaunchError | undefined
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

    handle.onLaunchError?.((error) => {
      launchError = error
    })
    handle.onStdout((text) => {
      applyPendingResize()
      callbacks.onData(text)
    })
    handle.onStderr((text) => {
      if (launchError !== undefined) return
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
      callbacks.onExit(
        resolveTerminalExitOutcome(
          sentinelCode ?? code,
          signal,
          stopRequested,
          launchError,
        ),
      )
    })
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
  launchError?: ProcessLaunchError,
): AiRunExitOutcome {
  if (stopRequested) {
    return { status: 'stopped', exitCode: code, signal }
  }
  if (code === 0) {
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
  const errorMessage =
    code === null
      ? `Process terminated by signal ${signal ?? 'unknown'}`
      : `Process exited with code ${code}`
  return { status: 'failed', exitCode: code, signal, errorMessage }
}
