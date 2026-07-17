import type { ProcessGateway } from '../NodeProcessGateway'
import { buildTerminalArgs } from '../TerminalArguments'
import {
  buildShellLaunchCommand,
  buildTerminalEnv,
  type AiTerminalDispatcher,
  type TerminalRunCallbacks,
  type TerminalRunHandle,
  type TerminalRunRequest,
} from './TerminalDispatcher'
import { TerminalSessionBrokerClient } from '../TerminalSessionBroker'

const LOGIN_SHELL_ARGS: readonly string[] = ['-i', '-l']

function quoteShellPath(path: string): string {
  if (path.includes('\0')) throw new Error('Terminal shell path must not contain NUL bytes')
  return path
}

/**
 * Terminal dispatcher whose child-process ownership lives in the sidecar
 * broker. Handles contain only authenticated IPC commands, so a new renderer
 * can reconstruct one from the persisted session id.
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
    const executableArgs = [...(request.binaryArgsPrefix ?? []), ...args]
    const launchCommand = request.launchInShell
      ? buildShellLaunchCommand(request.binaryPath, executableArgs)
      : undefined
    const ptyCommand = this.gateway.buildPtyCommand({
      binaryPath: request.launchInShell
        ? quoteShellPath(this.gateway.getShellPath())
        : request.binaryPath,
      args: request.launchInShell ? [...LOGIN_SHELL_ARGS] : executableArgs,
      rows: request.rows,
      cols: request.cols,
      transcriptPath: request.transcriptPath,
    })

    this.broker.start(
      sessionId,
      {
        command: ptyCommand.command,
        args: ptyCommand.args,
        cwd: request.cwd,
        env: buildTerminalEnv(this.gateway.getBaseEnv()),
        stdinMode: 'pipe',
      },
      request.transcriptPath,
      launchCommand === undefined ? undefined : `${launchCommand}\r`,
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
