/**
 * Renderer-independent terminal session broker.
 *
 * The broker is an inline Node program started through Electron's
 * `ELECTRON_RUN_AS_NODE` mode. It owns the PTY-wrapper child process and a
 * bounded replay buffer, while renderer clients connect over an authenticated
 * loopback socket. No extra release artifact is required: the source string
 * is bundled into main.js and passed to the user's PATH-resolved Node.js.
 * Obsidian's renderer `process.execPath` points at a Helper executable (and
 * the app executable owns Obsidian's own CLI), so neither is a Node runtime.
 */

import type {
  AiRunExitOutcome,
} from './dispatchers/Dispatcher'
import type { SpawnProcessRequest } from './NodeProcessGateway'
import { TERMINAL_BROKER_SOURCE } from './TerminalSessionBrokerSource'

export { TERMINAL_BROKER_SOURCE } from './TerminalSessionBrokerSource'

declare function require(moduleId: string): unknown
declare const process: {
  env: Record<string, string | undefined>
  kill?(pid: number, signal?: string | number): boolean
}

interface NodeBufferLike {
  toString(encoding?: string): string
}

interface NodeSocketLike {
  destroyed?: boolean
  setEncoding(encoding: string): void
  setTimeout(timeoutMs: number, callback?: () => void): void
  write(data: string): boolean
  end(): void
  destroy(): void
  on(event: 'connect' | 'close' | 'timeout', listener: () => void): void
  on(event: 'data', listener: (chunk: string) => void): void
  on(event: 'error', listener: (error: unknown) => void): void
}

interface NodeNetModuleLike {
  createConnection(
    options: { host: string; port: number },
    listener?: () => void,
  ): NodeSocketLike
}

interface NodeFsModuleLike {
  readFileSync(path: string, encoding: 'utf8'): string
  unlinkSync(path: string): void
}

interface NodeOsModuleLike {
  tmpdir(): string
}

interface NodePathModuleLike {
  join(...parts: string[]): string
}

interface NodeCryptoModuleLike {
  createHash(algorithm: string): {
    update(value: string): { digest(encoding: 'hex'): string }
  }
  randomBytes(size: number): NodeBufferLike
}

interface NodeChildProcessLike {
  unref(): void
  on(event: 'error', listener: (error: unknown) => void): void
}

interface NodeChildProcessModuleLike {
  spawn(
    command: string,
    args: string[],
    options: {
      detached: boolean
      windowsHide: boolean
      env: Record<string, string | undefined>
      stdio: 'ignore'
    },
  ): NodeChildProcessLike
}

interface BrokerDescriptor {
  version: 1
  port: number
  token: string
  pid: number
}

type BrokerClientMessage =
  | {
      token: string
      op: 'spawn'
      sessionId: string
      spawn: SpawnProcessRequest
      transcriptPath: string
      initialInput?: string
    }
  | { token: string; op: 'attach'; sessionId: string }
  | { token: string; op: 'input'; sessionId: string; data: string }
  | {
      token: string
      op: 'resize'
      sessionId: string
      cols: number
      rows: number
    }
  | { token: string; op: 'stop'; sessionId: string; force?: boolean }
  | { token: string; op: 'shutdown' }

type BrokerClientCommand =
  BrokerClientMessage extends infer Message
    ? Message extends { token: string }
      ? Omit<Message, 'token'>
      : never
    : never

type BrokerServerMessage =
  | {
      type: 'attached'
      sessionId: string
      status: 'running' | 'completed'
      replay: string
      pid?: number
      transcriptPath?: string
      outcome?: AiRunExitOutcome
    }
  | { type: 'data'; sessionId: string; data: string }
  | { type: 'exit'; sessionId: string; outcome: AiRunExitOutcome }
  | { type: 'missing'; sessionId: string }
  | { type: 'error'; sessionId?: string; message: string }
  | { type: 'shutdown-ack' }

export interface TerminalBrokerSessionCallbacks {
  onData(data: string): void
  onExit(outcome: AiRunExitOutcome): void
  onAttached?(pid?: number, transcriptPath?: string): void
  onUnavailable?(): void
}

export interface TerminalBrokerClientOptions {
  identity: string
  /** Read lazily after BinaryLocator has merged the login-shell PATH. */
  getEnv?(): Record<string, string | undefined>
  log?(level: 'warn' | 'debug', ...args: unknown[]): void
  connectTimeoutMs?: number
  startupTimeoutMs?: number
}

const BROKER_VERSION = 1
const BROKER_CONNECT_TIMEOUT_MS = 700
const BROKER_STARTUP_TIMEOUT_MS = 5_000
const BROKER_RETRY_MS = 50
const BROKER_SHUTDOWN_TIMEOUT_MS = 2_500
const MAX_CLIENT_FRAME_BYTES = 1024 * 1024
const BROKER_SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u

function isValidBrokerSessionId(sessionId: string): boolean {
  return BROKER_SESSION_ID_PATTERN.test(sessionId)
}

function loadNet(): NodeNetModuleLike {
  // eslint-disable-next-line import/no-nodejs-modules
  return require('net') as NodeNetModuleLike
}

function loadFs(): NodeFsModuleLike {
  // eslint-disable-next-line import/no-nodejs-modules
  return require('fs') as NodeFsModuleLike
}

function loadOs(): NodeOsModuleLike {
  // eslint-disable-next-line import/no-nodejs-modules
  return require('os') as NodeOsModuleLike
}

function loadPath(): NodePathModuleLike {
  // eslint-disable-next-line import/no-nodejs-modules
  return require('path') as NodePathModuleLike
}

function loadCrypto(): NodeCryptoModuleLike {
  // eslint-disable-next-line import/no-nodejs-modules
  return require('crypto') as NodeCryptoModuleLike
}

function loadChildProcess(): NodeChildProcessModuleLike {
  // eslint-disable-next-line import/no-nodejs-modules
  return require('child_process') as NodeChildProcessModuleLike
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}

function wait(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => activeWindow.setTimeout(resolve, timeoutMs))
}

function isDescriptor(value: unknown): value is BrokerDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const source = value as Record<string, unknown>
  return (
    source.version === BROKER_VERSION &&
    typeof source.port === 'number' &&
    Number.isInteger(source.port) &&
    source.port > 0 &&
    source.port <= 65535 &&
    typeof source.token === 'string' &&
    /^[a-f0-9]{64}$/u.test(source.token) &&
    typeof source.pid === 'number' &&
    Number.isInteger(source.pid) &&
    source.pid > 0
  )
}

export function getTerminalBrokerDescriptorPath(identity: string): string {
  const hash = loadCrypto()
    .createHash('sha256')
    .update(identity)
    .digest('hex')
    .slice(0, 24)
  return loadPath().join(
    loadOs().tmpdir(),
    `taskchute-plus-ai-broker-${hash}.json`,
  )
}

export class TerminalSessionBrokerClient {
  private readonly descriptorPath: string
  private readonly callbacks = new Map<string, TerminalBrokerSessionCallbacks>()
  private socket: NodeSocketLike | null = null
  private descriptor: BrokerDescriptor | null = null
  private connectPromise: Promise<NodeSocketLike> | null = null
  private receiveBuffer = ''
  private intentionallyDisconnected = false
  private reconnectPromise: Promise<void> | null = null
  private reconnectAttempts = 0
  private shutdownAck: (() => void) | null = null
  private closing = false
  private shutdownCompletion: Promise<void> | null = null

  constructor(private readonly options: TerminalBrokerClientOptions) {
    this.descriptorPath = getTerminalBrokerDescriptorPath(options.identity)
  }

  start(
    sessionId: string,
    spawn: SpawnProcessRequest,
    transcriptPath: string,
    initialInput: string | undefined,
    callbacks: TerminalBrokerSessionCallbacks,
  ): void {
    if (this.closing) {
      callbacks.onExit({
        status: 'failed',
        exitCode: null,
        signal: null,
        errorMessage: 'Terminal broker client is shutting down',
      })
      return
    }
    if (!isValidBrokerSessionId(sessionId)) {
      callbacks.onExit({
        status: 'failed',
        exitCode: null,
        signal: null,
        errorMessage: 'Invalid terminal broker session id',
      })
      return
    }
    this.callbacks.set(sessionId, callbacks)
    void this.send({
      op: 'spawn',
      sessionId,
      spawn,
      transcriptPath,
      initialInput,
    })
      .catch((error) => this.failSession(sessionId, error))
  }

  attach(sessionId: string, callbacks: TerminalBrokerSessionCallbacks): void {
    if (this.closing) {
      callbacks.onUnavailable?.()
      return
    }
    if (!isValidBrokerSessionId(sessionId)) {
      callbacks.onUnavailable?.()
      return
    }
    this.callbacks.set(sessionId, callbacks)
    void this.send({ op: 'attach', sessionId }, false)
      .catch((error) => this.unavailableSession(sessionId, error))
  }

  write(sessionId: string, data: string): void {
    if (this.closing || !isValidBrokerSessionId(sessionId)) return
    // Only an explicit spawn request may create the broker. A stale handle
    // must never resurrect an empty broker after the real session vanished.
    void this.send({ op: 'input', sessionId, data }, false).catch((error) => {
      this.options.log?.('warn', '[TerminalBroker] Input failed', error)
    })
  }

  resize(
    sessionId: string,
    cols: number,
    rows: number,
  ): void {
    if (this.closing || !isValidBrokerSessionId(sessionId)) return
    void this.send(
      {
        op: 'resize',
        sessionId,
        cols,
        rows,
      },
      false,
    ).catch(() => undefined)
  }

  stop(sessionId: string, force: boolean): void {
    if (this.closing || !isValidBrokerSessionId(sessionId)) return
    void this.send({ op: 'stop', sessionId, force }, false).catch((error) => {
      this.options.log?.('warn', '[TerminalBroker] Stop failed', error)
    })
  }

  shutdown(): Promise<void> {
    if (this.shutdownCompletion) return this.shutdownCompletion
    this.closing = true
    this.shutdownCompletion = this.performShutdown()
    return this.shutdownCompletion
  }

  private async performShutdown(): Promise<void> {
    let brokerPid: number | undefined
    try {
      if (!this.socket || this.socket.destroyed) {
        const existing = this.readDescriptor()
        if (!existing) return
        try {
          await this.connect(existing)
        } catch {
          this.removeDescriptor()
          return
        }
      }
      const acknowledged = new Promise<void>((resolve) => {
        this.shutdownAck = resolve
      })
      await this.send({ op: 'shutdown' }, false, true)
      brokerPid = this.descriptor?.pid
      await Promise.race([
        acknowledged,
        wait(BROKER_SHUTDOWN_TIMEOUT_MS),
      ])
    } finally {
      this.shutdownAck = null
      this.detach()
    }
    await this.waitForBrokerStopped(brokerPid)
  }

  detach(): void {
    this.intentionallyDisconnected = true
    this.socket?.end()
    this.socket?.destroy()
    this.socket = null
    this.connectPromise = null
    this.descriptor = null
    this.receiveBuffer = ''
  }

  private async send(
    message: BrokerClientCommand,
    allowBrokerStart = true,
    allowClosing = false,
  ): Promise<void> {
    if (this.closing && !allowClosing) {
      throw new Error('Terminal broker client is shutting down')
    }
    const socket = allowBrokerStart
      ? await this.ensureConnected()
      : await this.ensureExistingConnected()
    const descriptor = this.descriptor
    if (!descriptor || socket.destroyed) throw new Error('Terminal broker is disconnected')
    const frame = JSON.stringify({ ...message, token: descriptor.token })
    if (frame.length > MAX_CLIENT_FRAME_BYTES) {
      throw new Error('Terminal broker request exceeds the IPC limit')
    }
    socket.write(`${frame}\n`)
  }

  private ensureConnected(): Promise<NodeSocketLike> {
    if (this.closing) {
      return Promise.reject(new Error('Terminal broker client is shutting down'))
    }
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket)
    if (this.connectPromise) return this.connectPromise
    this.intentionallyDisconnected = false
    this.connectPromise = this.connectOrStart()
      .finally(() => {
        this.connectPromise = null
      })
    return this.connectPromise
  }

  private ensureExistingConnected(): Promise<NodeSocketLike> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket)
    if (this.connectPromise) return this.connectPromise
    const descriptor = this.readDescriptor()
    if (!descriptor) {
      return Promise.reject(new Error('Terminal broker session is unavailable'))
    }
    this.intentionallyDisconnected = false
    this.connectPromise = this.connect(descriptor)
      .catch((error: unknown) => {
        this.removeDescriptor()
        throw error
      })
      .finally(() => {
        this.connectPromise = null
      })
    return this.connectPromise
  }

  private async connectOrStart(): Promise<NodeSocketLike> {
    const existing = this.readDescriptor()
    if (existing) {
      try {
        return await this.connect(existing)
      } catch {
        this.removeDescriptor()
      }
    }

    this.spawnBroker()
    const deadline =
      Date.now() + (this.options.startupTimeoutMs ?? BROKER_STARTUP_TIMEOUT_MS)
    let lastError: unknown = new Error('Terminal broker did not start')
    while (Date.now() < deadline) {
      await wait(BROKER_RETRY_MS)
      const descriptor = this.readDescriptor()
      if (!descriptor) continue
      try {
        return await this.connect(descriptor)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }

  private connect(descriptor: BrokerDescriptor): Promise<NodeSocketLike> {
    return new Promise((resolve, reject) => {
      let settled = false
      const socket = loadNet().createConnection({
        host: '127.0.0.1',
        port: descriptor.port,
      })
      socket.setEncoding('utf8')
      socket.setTimeout(
        this.options.connectTimeoutMs ?? BROKER_CONNECT_TIMEOUT_MS,
      )
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        socket.destroy()
        reject(error instanceof Error ? error : new Error(describeError(error)))
      }
      socket.on('connect', () => {
        if (settled) return
        settled = true
        socket.setTimeout(0)
        this.socket = socket
        this.descriptor = descriptor
        this.receiveBuffer = ''
        this.reconnectAttempts = 0
        this.bindSocket(socket)
        resolve(socket)
      })
      socket.on('timeout', () => fail(new Error('Terminal broker connection timed out')))
      socket.on('error', fail)
    })
  }

  private bindSocket(socket: NodeSocketLike): void {
    socket.on('data', (chunk) => this.handleData(chunk))
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null
        this.descriptor = null
        this.receiveBuffer = ''
      }
      if (!this.intentionallyDisconnected && this.callbacks.size > 0) {
        this.options.log?.('warn', '[TerminalBroker] Connection closed; input will reconnect')
        this.scheduleReconnect()
      }
    })
    socket.on('error', (error) => {
      this.options.log?.('warn', '[TerminalBroker] Socket error', error)
    })
  }

  private handleData(chunk: string): void {
    this.receiveBuffer += chunk
    if (this.receiveBuffer.length > MAX_CLIENT_FRAME_BYTES) {
      this.socket?.destroy()
      return
    }
    let newline = this.receiveBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.receiveBuffer.slice(0, newline)
      this.receiveBuffer = this.receiveBuffer.slice(newline + 1)
      if (line.length > 0) {
        try {
          this.handleMessage(JSON.parse(line) as BrokerServerMessage)
        } catch (error) {
          this.options.log?.('warn', '[TerminalBroker] Invalid server frame', error)
        }
      }
      newline = this.receiveBuffer.indexOf('\n')
    }
  }

  private handleMessage(message: BrokerServerMessage): void {
    if (message.type === 'shutdown-ack') {
      this.shutdownAck?.()
      return
    }
    if (!('sessionId' in message)) return
    const sessionId = message.sessionId
    if (typeof sessionId !== 'string') return
    const callbacks = this.callbacks.get(sessionId)
    if (!callbacks) return
    switch (message.type) {
      case 'attached':
        callbacks.onAttached?.(message.pid, message.transcriptPath)
        if (message.replay.length > 0) callbacks.onData(message.replay)
        if (message.status === 'completed') {
          this.callbacks.delete(sessionId)
          if (message.outcome) callbacks.onExit(message.outcome)
          else callbacks.onUnavailable?.()
          this.detachIfNoSessions()
        }
        break
      case 'data':
        callbacks.onData(message.data)
        break
      case 'exit':
        this.callbacks.delete(sessionId)
        callbacks.onExit(message.outcome)
        this.detachIfNoSessions()
        break
      case 'missing':
        this.callbacks.delete(sessionId)
        callbacks.onUnavailable?.()
        this.detachIfNoSessions()
        break
      case 'error':
        this.callbacks.delete(sessionId)
        callbacks.onExit({
          status: 'failed',
          exitCode: null,
          signal: null,
          errorMessage: message.message,
        })
        this.detachIfNoSessions()
        break
    }
  }

  private readDescriptor(): BrokerDescriptor | null {
    try {
      const parsed = JSON.parse(
        loadFs().readFileSync(this.descriptorPath, 'utf8'),
      ) as unknown
      return isDescriptor(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  private removeDescriptor(): void {
    try {
      loadFs().unlinkSync(this.descriptorPath)
    } catch {
      // Stale/missing descriptor.
    }
  }

  private spawnBroker(): void {
    const token = loadCrypto().randomBytes(32).toString('hex')
    const env = this.options.getEnv?.() ?? { ...process.env }
    const child = loadChildProcess().spawn(
      'node',
      ['-e', TERMINAL_BROKER_SOURCE],
      {
        detached: true,
        windowsHide: true,
        env: {
          ...env,
          TASKCHUTE_BROKER_DESCRIPTOR: this.descriptorPath,
          TASKCHUTE_BROKER_TOKEN: token,
          TASKCHUTE_BROKER_TTL_MS: '60000',
        },
        stdio: 'ignore',
      },
    )
    child.on('error', (error) => {
      this.options.log?.('warn', '[TerminalBroker] Spawn failed', error)
    })
    child.unref()
  }

  private async waitForBrokerStopped(pid: number | undefined): Promise<void> {
    const deadline = Date.now() + BROKER_SHUTDOWN_TIMEOUT_MS
    while (Date.now() < deadline) {
      const descriptorGone = this.readDescriptor() === null
      let processGone = true
      if (pid !== undefined && typeof process.kill === 'function') {
        try {
          process.kill(pid, 0)
          processGone = false
        } catch {
          processGone = true
        }
      }
      if (descriptorGone && processGone) return
      await wait(25)
    }
    this.options.log?.(
      'warn',
      '[TerminalBroker] Timed out waiting for broker shutdown',
      pid,
    )
  }

  private failSession(sessionId: string, error: unknown): void {
    const callbacks = this.callbacks.get(sessionId)
    if (!callbacks) return
    this.callbacks.delete(sessionId)
    callbacks.onExit({
      status: 'failed',
      exitCode: null,
      signal: null,
      errorMessage: describeError(error),
    })
    this.detachIfNoSessions()
  }

  private unavailableSession(sessionId: string, error: unknown): void {
    const callbacks = this.callbacks.get(sessionId)
    if (!callbacks) return
    this.callbacks.delete(sessionId)
    this.options.log?.('warn', '[TerminalBroker] Attach failed', error)
    callbacks.onUnavailable?.()
    this.detachIfNoSessions()
  }

  private detachIfNoSessions(): void {
    if (this.callbacks.size === 0 && this.shutdownAck === null) {
      this.detach()
    }
  }

  private scheduleReconnect(): void {
    if (this.closing || this.reconnectPromise || this.intentionallyDisconnected) return
    this.reconnectPromise = wait(BROKER_RETRY_MS)
      .then(async () => {
        if (this.closing || this.intentionallyDisconnected || this.callbacks.size === 0) return
        const socket = await this.ensureExistingConnected()
        const descriptor = this.descriptor
        if (!descriptor || socket.destroyed) return
        for (const sessionId of this.callbacks.keys()) {
          const frame: BrokerClientMessage = {
            token: descriptor.token,
            op: 'attach',
            sessionId,
          }
          socket.write(`${JSON.stringify(frame)}\n`)
        }
        this.reconnectAttempts = 0
      })
      .catch((error) => {
        this.reconnectAttempts += 1
        this.options.log?.('warn', '[TerminalBroker] Reconnect failed', error)
        if (this.reconnectAttempts >= 3) {
          const callbacks = Array.from(this.callbacks.values())
          this.callbacks.clear()
          for (const callback of callbacks) callback.onUnavailable?.()
          this.detach()
        }
      })
      .finally(() => {
        this.reconnectPromise = null
        if (
          !this.closing &&
          !this.intentionallyDisconnected &&
          this.callbacks.size > 0 &&
          !this.socket
        ) {
          this.scheduleReconnect()
        }
      })
  }
}
