import { isBrokerMachineryFailure } from '../BrokerRecovery'
import type { ProcessGateway } from '../NodeProcessGateway'
import { buildTerminalArgs } from '../TerminalArguments'
import {
  buildTerminalEnv,
  type AiTerminalDispatcher,
  type TerminalRunCallbacks,
  type TerminalRunHandle,
  type TerminalRunRequest,
} from './TerminalDispatcher'
import { TerminalSessionBrokerClient } from '../TerminalSessionBroker'
import { buildTerminalShellLaunch } from './TerminalShellBootstrap'
import type { AiRunExitOutcome } from './Dispatcher'

function quoteShellPath(path: string): string {
  if (path.includes('\0')) throw new Error('Terminal shell path must not contain NUL bytes')
  return path
}

/**
 * Terminal dispatcher whose child-process ownership lives in the sidecar
 * broker. Handles contain only authenticated IPC commands, so a new renderer
 * can reconstruct one from the persisted session id.
 *
 * Windows (`conpty` transport): the broker's guard runs the ConPTY host and
 * turns keys and resizes into frames on its control pipe. As in
 * TerminalDispatcher, the CLI runs directly and the host starts PowerShell
 * once it exits, instead of a bootstrap shell around it.
 *
 * A session the broker refuses for reasons of its own machinery (LEV-405) is
 * started once more on a new broker, when no other terminal of this window
 * would go down with the old one (the caller says so: mayReplaceBroker). See
 * BrokerRecovery.
 */
export class BrokerTerminalDispatcher implements AiTerminalDispatcher {
  readonly isPersistent = true

  constructor(
    private readonly gateway: ProcessGateway,
    private readonly broker: TerminalSessionBrokerClient,
    private readonly log?: (level: 'warn' | 'debug', ...args: unknown[]) => void,
  ) {}

  start(
    request: TerminalRunRequest,
    callbacks: TerminalRunCallbacks,
  ): TerminalRunHandle {
    const sessionId =
      request.sessionId ??
      `terminal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    const args = buildTerminalArgs(request.extraArgs, request.prompt)
    const binaryArgsPrefix = request.binaryArgsPrefix ?? []
    const executableArgs = [...binaryArgsPrefix, ...args]
    const conpty = this.gateway.getPtyTransport?.() === 'conpty'
    const shellLaunch = request.launchInShell && !conpty
      ? buildTerminalShellLaunch(
          quoteShellPath(this.gateway.getShellPath()),
          request.binaryPath,
          binaryArgsPrefix,
          args,
          request.terminalCommand,
          request.terminalFallbackCommand,
        )
      : undefined
    const ptyCommand = this.gateway.buildPtyCommand({
      binaryPath: shellLaunch?.binaryPath ?? request.binaryPath,
      args: shellLaunch?.args ?? executableArgs,
      rows: request.rows,
      cols: request.cols,
      transcriptPath: request.transcriptPath,
      ...(request.launchInShell && conpty ? { thenShell: true } : {}),
    })
    const terminalEnv = buildTerminalEnv({
      ...this.gateway.getBaseEnv(),
      ...(request.envPatch ?? {}),
    })

    const spawn = {
      command: ptyCommand.command,
      args: ptyCommand.args,
      cwd: request.cwd,
      env: { ...terminalEnv, ...(ptyCommand.env ?? {}) },
      stdinMode: 'pipe' as const,
      ...(conpty ? { controlPipe: true } : {}),
    }
    let retried = false
    let stopRequested = false
    // The size asked for last, which a retry starts with: the broker forgets
    // a refused session's size, and the pane resends it only when it changes.
    let latestSize: { cols: number; rows: number } | null = null
    const launch = (): void => {
      this.broker.start(sessionId, spawn, request.transcriptPath, undefined, attempt)
      if (retried && latestSize) {
        this.broker.resize(sessionId, latestSize.cols, latestSize.rows)
      }
    }
    const onExit = (outcome: AiRunExitOutcome): void => {
      if (
        retried ||
        stopRequested ||
        !isBrokerMachineryFailure(outcome) ||
        request.mayReplaceBroker?.() !== true ||
        this.broker.hasSessions()
      ) {
        callbacks.onExit(outcome)
        return
      }
      retried = true
      this.log?.(
        'warn',
        '[BrokerTerminalDispatcher] Broker refused the session; starting it on a new broker',
        outcome.errorMessage,
      )
      this.broker.replaceBroker().then(
        () => {
          if (stopRequested) callbacks.onExit(outcome)
          else launch()
        },
        (error: unknown) => {
          this.log?.('warn', '[BrokerTerminalDispatcher] Broker could not be replaced', error)
          callbacks.onExit(outcome)
        },
      )
    }
    const attempt = withOnExit(callbacks, onExit)
    launch()
    const handle = this.createHandle(sessionId)
    const markStopped = (): void => {
      stopRequested = true
    }
    return {
      ...handle,
      resize: (cols, rows) => {
        latestSize = { cols, rows }
        handle.resize?.(cols, rows)
      },
      stop: () => {
        markStopped()
        handle.stop()
      },
      forceKill: () => {
        markStopped()
        handle.forceKill?.()
      },
    }
  }

  attach(
    sessionId: string,
    callbacks: TerminalRunCallbacks,
  ): TerminalRunHandle {
    this.broker.attach(sessionId, callbacks)
    return this.createHandle(sessionId)
  }

  detach(): void {
    this.broker.detach()
  }

  async scheduleShutdownAfterGrace(
    graceMs: number,
    rendererLeaseToken?: string,
    rendererLeaseOwnerId?: string,
    rendererLeaseGeneration?: number,
  ): Promise<void> {
    if (rendererLeaseToken === undefined) {
      await this.broker.scheduleShutdownAfterGrace(graceMs)
      return
    }
    await this.broker.scheduleShutdownAfterGrace(
      graceMs,
      rendererLeaseToken,
      rendererLeaseOwnerId,
      rendererLeaseGeneration,
    )
  }

  async cancelDeferredShutdown(
    rendererLeaseToken?: string,
    rendererLeaseOwnerId?: string,
    rendererLeaseGeneration?: number,
  ): Promise<void> {
    if (rendererLeaseToken === undefined) {
      await this.broker.cancelDeferredShutdown()
      return
    }
    await this.broker.cancelDeferredShutdown(
      rendererLeaseToken,
      rendererLeaseOwnerId,
      rendererLeaseGeneration,
    )
  }

  async setRendererLeaseToken(
    rendererLeaseToken: string,
    rendererLeaseOwnerId?: string,
    rendererLeaseGeneration?: number,
  ): Promise<void> {
    await this.broker.setRendererLeaseToken(
      rendererLeaseToken,
      rendererLeaseOwnerId,
      rendererLeaseGeneration,
    )
  }

  async shutdown(): Promise<void> {
    await this.broker.shutdown()
  }

  async replaceBroker(): Promise<void> {
    await this.broker.replaceBroker()
  }

  private createHandle(sessionId: string): TerminalRunHandle {
    return {
      sessionId,
      write: (data) => this.broker.write(sessionId, data),
      resize: (cols, rows) =>
        this.broker.resize(sessionId, cols, rows),
      stop: () => this.broker.stop(sessionId, false),
      forceKill: () => this.broker.stop(sessionId, true),
    }
  }
}

/** The same callbacks with a different onExit. */
function withOnExit(
  callbacks: TerminalRunCallbacks,
  onExit: (outcome: AiRunExitOutcome) => void,
): TerminalRunCallbacks {
  return {
    onData: (bytes) => callbacks.onData(bytes),
    onExit,
    ...(callbacks.onAttached
      ? { onAttached: (pid?: number, transcriptPath?: string) => callbacks.onAttached?.(pid, transcriptPath) }
      : {}),
    ...(callbacks.onUnavailable
      ? { onUnavailable: (transcriptPath?: string) => callbacks.onUnavailable?.(transcriptPath) }
      : {}),
    ...(callbacks.onConnectionLost
      ? { onConnectionLost: () => callbacks.onConnectionLost?.() }
      : {}),
    ...(callbacks.onInputDropped
      ? { onInputDropped: () => callbacks.onInputDropped?.() }
      : {}),
  }
}
