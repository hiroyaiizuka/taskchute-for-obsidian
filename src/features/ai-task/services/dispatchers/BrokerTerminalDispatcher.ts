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
 */
export class BrokerTerminalDispatcher implements AiTerminalDispatcher {
  readonly isPersistent = true

  constructor(
    private readonly gateway: ProcessGateway,
    private readonly broker: TerminalSessionBrokerClient,
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

    this.broker.start(
      sessionId,
      {
        command: ptyCommand.command,
        args: ptyCommand.args,
        cwd: request.cwd,
        env: { ...terminalEnv, ...(ptyCommand.env ?? {}) },
        stdinMode: 'pipe',
        ...(conpty ? { controlPipe: true } : {}),
      },
      request.transcriptPath,
      undefined,
      callbacks,
    )
    return this.createHandle(sessionId)
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
