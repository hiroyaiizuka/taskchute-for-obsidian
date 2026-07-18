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
import {
  sleepWithStableTimer,
  stableTimeoutSource,
  type StableTimeoutId,
} from '../../../utils/stableTimer'

export { TERMINAL_BROKER_SOURCE } from './TerminalSessionBrokerSource'

declare function require(moduleId: string): unknown
declare const process: {
  env: Record<string, string | undefined>
  platform?: string
  getuid?(): number
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
  lstatSync(path: string): {
    dev: number
    ino: number
    mode: number
    uid: number
    isFile(): boolean
    isSymbolicLink(): boolean
  }
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
  | { token: string; op: 'terminate-unavailable'; sessionId: string }
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
  | {
      type: 'terminated-unavailable'
      sessionId: string
      interrupted: boolean
      transcriptPath?: string
      outcome?: AiRunExitOutcome
    }
  | { type: 'missing'; sessionId: string }
  | { type: 'error'; sessionId?: string; message: string }
  | { type: 'shutdown-ack' }

export interface TerminalBrokerSessionCallbacks {
  onData(data: string): void
  onExit(outcome: AiRunExitOutcome): void
  onAttached?(pid?: number, transcriptPath?: string): void
  /**
   * The broker-confirmed transcript path is supplied when abnormal
   * termination completed before the ordinary attached frame was usable.
   */
  onUnavailable?(transcriptPath?: string): void
}

interface UnavailableTerminationResult {
  interrupted: boolean
  transcriptPath?: string
  outcome?: AiRunExitOutcome
}

export interface TerminalBrokerClientOptions {
  identity: string
  /** Read lazily after BinaryLocator has merged the login-shell PATH. */
  getEnv?(): Record<string, string | undefined>
  log?(level: 'warn' | 'debug', ...args: unknown[]): void
  connectTimeoutMs?: number
  startupTimeoutMs?: number
  /** Clock for the overflow-streak window; defaults to Date.now. */
  now?(): number
  /** Test/embedding override for abnormal-session control acknowledgements. */
  unavailableTerminationTimeoutMs?: number
  /** Test/embedding override for graceful broker shutdown confirmation. */
  shutdownTimeoutMs?: number
  /** Deadline for spawn/attach to receive attached/missing/error. */
  sessionAckTimeoutMs?: number
  /** Initial retry delay after an unavailable-session termination is unconfirmed. */
  unavailableRecoveryBaseMs?: number
  /** Maximum retry delay after repeated unavailable-session failures. */
  unavailableRecoveryMaxMs?: number
  /** Test/embedding override for the renderer crash-reconnect window. */
  idleTtlMs?: number
}

const BROKER_VERSION = 1
const BROKER_CONNECT_TIMEOUT_MS = 700
const BROKER_STARTUP_TIMEOUT_MS = 5_000
const BROKER_RETRY_MS = 50
const BROKER_SHUTDOWN_TIMEOUT_MS = 2_500
const BROKER_SESSION_ACK_TIMEOUT_MS = 5_000
const BROKER_UNAVAILABLE_TERMINATION_TIMEOUT_MS = 2_500
const BROKER_UNAVAILABLE_RECOVERY_BASE_MS = 250
const BROKER_UNAVAILABLE_RECOVERY_MAX_MS = 30_000
// A renderer crash/relaunch can take longer than the old one-minute window.
// App/plugin shutdown still uses authenticated cleanup, so this TTL is only
// the bounded crash-recovery window—not the normal process lifetime.
const BROKER_RENDERER_RECONNECT_TTL_MS = 30 * 60 * 1000
const MAX_CLIENT_FRAME_BYTES = 1024 * 1024
const MAX_CONSECUTIVE_OVERFLOW_DESTROYS = 3
/**
 * Overflow destroys are a streak while they stay inside this window; only a
 * quiet period clears the count. A successfully parsed frame must NOT clear
 * it: with several sessions on one connection an old broker can interleave
 * a small valid 'attached' before the oversized one on every reconnect,
 * which would reset a per-frame counter forever and defeat the give-up.
 */
const OVERFLOW_STREAK_RESET_MS = 5000
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

function isConnectionRefusedError(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
  const message = describeError(error)
  return (
    code === 'ECONNREFUSED' ||
    /(?:ECONNREFUSED|connection refused)/iu.test(message)
  )
}

function wait(timeoutMs: number): Promise<void> {
  // Do not bind lifecycle-critical waits to Obsidian's current activeWindow.
  // A focused popout can close while shutdown/recovery is pending, orphaning
  // timers owned by that Window. The shared helper uses the renderer's stable
  // root window instead.
  return sleepWithStableTimer(timeoutMs)
}

function descriptorsEqual(
  left: BrokerDescriptor | null,
  right: BrokerDescriptor,
): boolean {
  return (
    left !== null &&
    left.version === right.version &&
    left.port === right.port &&
    left.token === right.token &&
    left.pid === right.pid
  )
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

function isTrustedDescriptorFile(
  stats: ReturnType<NodeFsModuleLike['lstatSync']>,
): boolean {
  if (!stats.isFile() || stats.isSymbolicLink()) return false
  if (process.platform === 'win32') return true
  if (typeof process.getuid !== 'function') return false
  return stats.uid === process.getuid() && (stats.mode & 0o077) === 0
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
  private readonly sessionPids = new Map<string, number>()
  private readonly explicitlyStoppedSessionIds = new Set<string>()
  private readonly pendingUnavailableTerminations =
    new Map<string, TerminalBrokerSessionCallbacks>()
  private readonly pendingSessionAcks = new Map<
    string,
    {
      epoch: number
      operation: 'spawn' | 'attach'
      timerId: StableTimeoutId | null
    }
  >()
  private nextSessionAckEpoch = 0
  private socket: NodeSocketLike | null = null
  private descriptor: BrokerDescriptor | null = null
  /**
   * Last descriptor proven by a successful authenticated connection.
   * Retained across an unexpected close only long enough for the reconnect
   * give-up path to terminate broker-owned sessions. Explicit detach clears
   * it so a later renderer never signals a stale/reused pid.
   */
  private lastAuthenticatedDescriptor: BrokerDescriptor | null = null
  private connectPromise: Promise<NodeSocketLike> | null = null
  private receiveBuffer = ''
  private consecutiveOverflowDestroys = 0
  private lastOverflowDestroyAt = Number.NEGATIVE_INFINITY
  private intentionallyDisconnected = false
  private reconnectPromise: Promise<void> | null = null
  private reconnectAttempts = 0
  private closing = false
  private shutdownCompletion: Promise<void> | null = null
  private unavailableDescriptor: BrokerDescriptor | null = null
  private unavailableRecoveryPromise: Promise<void> | null = null
  private unavailableRecoveryAttempt = 0
  /**
   * Invalidates delayed/in-flight recovery work after detach or an explicit
   * stop retry. A sleeping old generation may still wake, but it can no
   * longer send control requests or invoke renderer callbacks.
   */
  private unavailableRecoveryGeneration = 0
  /**
   * Invalidates a connect continuation when renderer detach wins the race.
   * Without this fence a late socket could repopulate this.socket after the
   * owner intentionally released the transport.
   */
  private transportGeneration = 0

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
    if (this.pendingUnavailableTerminations.size > 0) {
      callbacks.onExit({
        status: 'failed',
        exitCode: null,
        signal: null,
        errorMessage:
          'Terminal broker is recovering from an unconfirmed session failure',
      })
      return
    }
    this.sessionPids.delete(sessionId)
    this.explicitlyStoppedSessionIds.delete(sessionId)
    this.callbacks.set(sessionId, callbacks)
    const ackEpoch = this.prepareSessionAck(sessionId, 'spawn')
    void this.send({
      op: 'spawn',
      sessionId,
      spawn,
      transcriptPath,
      initialInput,
    }).then(
      () => this.armSessionAck(sessionId, ackEpoch),
      (error: unknown) =>
        this.handleSessionRequestFailure(
          sessionId,
          ackEpoch,
          'spawn',
          error,
        ),
    )
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
    if (this.pendingUnavailableTerminations.size > 0) {
      callbacks.onUnavailable?.()
      return
    }
    this.sessionPids.delete(sessionId)
    this.explicitlyStoppedSessionIds.delete(sessionId)
    this.callbacks.set(sessionId, callbacks)
    const ackEpoch = this.prepareSessionAck(sessionId, 'attach')
    void this.send({ op: 'attach', sessionId }, false).then(
      () => this.armSessionAck(sessionId, ackEpoch),
      (error: unknown) =>
        this.handleSessionRequestFailure(
          sessionId,
          ackEpoch,
          'attach',
          error,
        ),
    )
  }

  write(sessionId: string, data: string): void {
    if (
      this.closing ||
      this.pendingUnavailableTerminations.has(sessionId) ||
      !isValidBrokerSessionId(sessionId)
    ) {
      return
    }
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
    if (
      this.closing ||
      this.pendingUnavailableTerminations.has(sessionId) ||
      !isValidBrokerSessionId(sessionId)
    ) {
      return
    }
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
    this.explicitlyStoppedSessionIds.add(sessionId)
    if (this.pendingUnavailableTerminations.has(sessionId)) {
      // Interrupt an already sleeping exponential-backoff generation. Merely
      // scheduling an immediate retry used to return early while its Promise
      // existed, making an explicit user stop wait up to 30 seconds.
      this.invalidateUnavailableRecoverySchedule()
      this.scheduleUnavailableRecovery(true)
      return
    }
    void this.send({ op: 'stop', sessionId, force }, false).catch((error) => {
      this.options.log?.('warn', '[TerminalBroker] Stop failed', error)
      const pending = this.pendingSessionAcks.get(sessionId)
      if (pending) {
        this.handleSessionRequestFailure(
          sessionId,
          pending.epoch,
          pending.operation,
          error,
        )
        return
      }
      this.handleStopRequestFailure(sessionId, error)
    })
  }

  shutdown(): Promise<void> {
    if (this.shutdownCompletion) return this.shutdownCompletion
    this.closing = true
    const attempt = this.performShutdown()
    this.shutdownCompletion = attempt
    void attempt.catch(() => {
      // A timeout/authentication failure is truthful but not terminal: app
      // quit or a tracked settings-OFF manager must be able to retry later.
      if (this.shutdownCompletion === attempt) this.shutdownCompletion = null
    })
    return attempt
  }

  private async performShutdown(): Promise<void> {
    // A spawn request can be between spawnBroker() and descriptor discovery.
    // Wait for that generation before deciding there is nothing to stop;
    // send() re-checks closing afterwards and never emits the spawn frame.
    const pendingConnection = this.connectPromise
    if (pendingConnection) {
      try {
        await pendingConnection
      } catch {
        // A failed startup may still have left a descriptor to inspect below.
      }
    }
    const target =
      this.descriptor ??
      this.lastAuthenticatedDescriptor ??
      this.unavailableDescriptor ??
      this.readDescriptor()
    if (!target) {
      this.detach()
      return
    }
    const childPids = Array.from(this.sessionPids.values())
    const timeoutMs =
      this.options.shutdownTimeoutMs ?? BROKER_SHUTDOWN_TIMEOUT_MS
    let requestError: unknown
    try {
      try {
        await this.requestAuthenticatedBrokerShutdown(target, timeoutMs)
      } catch (error) {
        requestError = error
      }

      const stopped = await this.waitForBrokerStopped(
        target,
        childPids,
        timeoutMs,
      )
      if (!stopped) {
        const detail =
          requestError === undefined
            ? 'broker or owned child process is still alive'
            : describeError(requestError)
        throw new Error(`Terminal broker shutdown remains unconfirmed: ${detail}`)
      }
    } finally {
      this.detach()
      this.pendingUnavailableTerminations.clear()
      this.unavailableDescriptor = null
    }
  }

  detach(): void {
    this.transportGeneration += 1
    this.invalidateUnavailableRecovery(true)
    this.intentionallyDisconnected = true
    this.socket?.end()
    this.socket?.destroy()
    this.socket = null
    this.connectPromise = null
    this.descriptor = null
    this.lastAuthenticatedDescriptor = null
    this.receiveBuffer = ''
    this.clearAllSessionAcks()
    this.explicitlyStoppedSessionIds.clear()
  }

  private async send(
    message: BrokerClientCommand,
    allowBrokerStart = true,
  ): Promise<void> {
    if (this.closing) {
      throw new Error('Terminal broker client is shutting down')
    }
    const socket = allowBrokerStart
      ? await this.ensureConnected()
      : await this.ensureExistingConnected()
    if (this.closing) {
      throw new Error('Terminal broker client is shutting down')
    }
    const descriptor = this.descriptor
    if (!descriptor || socket.destroyed || socket !== this.socket) {
      throw new Error('Terminal broker is disconnected')
    }
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
    const generation = this.transportGeneration
    const attempt = this.connectOrStart(generation)
    const tracked = attempt.finally(() => {
      if (this.connectPromise === tracked) this.connectPromise = null
    })
    this.connectPromise = tracked
    return tracked
  }

  private ensureExistingConnected(): Promise<NodeSocketLike> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket)
    if (this.connectPromise) return this.connectPromise
    const descriptor = this.readDescriptor()
    if (!descriptor) {
      return Promise.reject(new Error('Terminal broker session is unavailable'))
    }
    this.intentionallyDisconnected = false
    const generation = this.transportGeneration
    const attempt = this.connect(descriptor, generation)
      .catch((error: unknown) => {
        // An attach targets an already-running persistent session. A brief
        // ECONNREFUSED can occur while that broker is starting/listening, so
        // keep a live descriptor available to the authenticated recovery
        // channel. Fresh spawn/start uses connectOrStart below and may replace
        // a refused descriptor; restored attach must not discard its only
        // trusted owner merely because the first socket attempt lost a race.
        this.removeDescriptorIfMatchesAndStopped(descriptor)
        throw error
      })
    const tracked = attempt.finally(() => {
      if (this.connectPromise === tracked) this.connectPromise = null
    })
    this.connectPromise = tracked
    return tracked
  }

  private async connectOrStart(generation: number): Promise<NodeSocketLike> {
    if (generation !== this.transportGeneration) {
      throw new Error('Terminal broker connection was superseded')
    }
    const existing = this.readDescriptor()
    if (existing) {
      try {
        return await this.connect(existing, generation)
      } catch (error) {
        if (isConnectionRefusedError(error)) {
          this.removeDescriptorIfMatches(existing)
        } else {
          this.removeDescriptorIfMatchesAndStopped(existing)
        }
      }
    }

    this.spawnBroker()
    const deadline =
      Date.now() + (this.options.startupTimeoutMs ?? BROKER_STARTUP_TIMEOUT_MS)
    let lastError: unknown = new Error('Terminal broker did not start')
    while (Date.now() < deadline) {
      await wait(BROKER_RETRY_MS)
      if (generation !== this.transportGeneration) {
        throw new Error('Terminal broker connection was superseded')
      }
      const descriptor = this.readDescriptor()
      if (!descriptor) continue
      try {
        return await this.connect(descriptor, generation)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }

  private connect(
    descriptor: BrokerDescriptor,
    generation: number,
  ): Promise<NodeSocketLike> {
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
        if (generation !== this.transportGeneration) {
          fail(new Error('Terminal broker connection was superseded'))
          return
        }
        settled = true
        socket.setTimeout(0)
        this.socket = socket
        this.descriptor = descriptor
        this.lastAuthenticatedDescriptor = descriptor
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
      const now = this.options.now?.() ?? Date.now()
      if (now - this.lastOverflowDestroyAt > OVERFLOW_STREAK_RESET_MS) {
        this.consecutiveOverflowDestroys = 0
      }
      this.lastOverflowDestroyAt = now
      this.consecutiveOverflowDestroys += 1
      if (this.consecutiveOverflowDestroys >= MAX_CONSECUTIVE_OVERFLOW_DESTROYS) {
        // An older broker can resend the same oversized frame on every
        // reattach; reconnecting again would loop at the retry interval
        // forever, so surface the unavailable path instead.
        this.options.log?.(
          'warn',
          '[TerminalBroker] Oversized frames persisted across reconnects; giving up',
        )
        const sessions = Array.from(this.callbacks.entries())
        this.callbacks.clear()
        this.clearAllSessionAcks()
        const descriptor = this.lastAuthenticatedDescriptor
        this.detachTransport()
        void this.terminateUnavailableSessions(descriptor, sessions)
        return
      }
      this.socket?.destroy()
      return
    }
    let newline = this.receiveBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.receiveBuffer.slice(0, newline)
      this.receiveBuffer = this.receiveBuffer.slice(newline + 1)
      if (line.length > 0) {
        try {
          const message = JSON.parse(line) as BrokerServerMessage
          this.handleMessage(message)
        } catch (error) {
          this.options.log?.('warn', '[TerminalBroker] Invalid server frame', error)
        }
      }
      newline = this.receiveBuffer.indexOf('\n')
    }
  }

  private handleMessage(message: BrokerServerMessage): void {
    if (message.type === 'shutdown-ack') {
      return
    }
    if (!('sessionId' in message)) return
    const sessionId = message.sessionId
    if (typeof sessionId !== 'string') return
    const callbacks = this.callbacks.get(sessionId)
    if (!callbacks) return
    switch (message.type) {
      case 'attached':
        this.clearSessionAck(sessionId)
        if (
          typeof message.pid === 'number' &&
          Number.isInteger(message.pid) &&
          message.pid > 0
        ) {
          this.sessionPids.set(sessionId, message.pid)
        }
        callbacks.onAttached?.(message.pid, message.transcriptPath)
        if (message.replay.length > 0) callbacks.onData(message.replay)
        if (message.status === 'completed') {
          this.callbacks.delete(sessionId)
          this.sessionPids.delete(sessionId)
          if (message.outcome) callbacks.onExit(message.outcome)
          else callbacks.onUnavailable?.()
          this.detachIfNoSessions()
        }
        break
      case 'data':
        callbacks.onData(message.data)
        break
      case 'exit':
        this.clearSessionAck(sessionId)
        this.callbacks.delete(sessionId)
        this.sessionPids.delete(sessionId)
        this.explicitlyStoppedSessionIds.delete(sessionId)
        callbacks.onExit(message.outcome)
        this.detachIfNoSessions()
        break
      case 'terminated-unavailable':
        // These acknowledgements are consumed by the isolated termination
        // connection, never by the regular replay/data transport.
        break
      case 'missing':
        this.clearSessionAck(sessionId)
        this.callbacks.delete(sessionId)
        this.sessionPids.delete(sessionId)
        this.explicitlyStoppedSessionIds.delete(sessionId)
        callbacks.onUnavailable?.()
        this.detachIfNoSessions()
        break
      case 'error':
        this.clearSessionAck(sessionId)
        this.callbacks.delete(sessionId)
        this.sessionPids.delete(sessionId)
        this.explicitlyStoppedSessionIds.delete(sessionId)
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
      const fs = loadFs()
      const before = fs.lstatSync(this.descriptorPath)
      if (!isTrustedDescriptorFile(before)) return null
      const parsed = JSON.parse(fs.readFileSync(this.descriptorPath, 'utf8')) as unknown
      const after = fs.lstatSync(this.descriptorPath)
      if (
        !isTrustedDescriptorFile(after) ||
        before.dev !== after.dev ||
        before.ino !== after.ino
      ) {
        return null
      }
      return isDescriptor(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  private removeDescriptorIfMatchesAndStopped(
    expected: BrokerDescriptor,
  ): boolean {
    if (this.isProcessAlive(expected.pid) !== false) return false
    if (!descriptorsEqual(this.readDescriptor(), expected)) return true
    try {
      loadFs().unlinkSync(this.descriptorPath)
      return true
    } catch {
      return !descriptorsEqual(this.readDescriptor(), expected)
    }
  }

  private removeDescriptorIfMatches(expected: BrokerDescriptor): boolean {
    if (!descriptorsEqual(this.readDescriptor(), expected)) return true
    try {
      loadFs().unlinkSync(this.descriptorPath)
      return true
    } catch {
      return !descriptorsEqual(this.readDescriptor(), expected)
    }
  }

  private isProcessAlive(pid: number): boolean | undefined {
    if (typeof process.kill !== 'function') return undefined
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code)
          : ''
      return code === 'ESRCH' ? false : undefined
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
          TASKCHUTE_BROKER_TTL_MS: String(Math.max(
            5_000,
            this.options.idleTtlMs ??
              BROKER_RENDERER_RECONNECT_TTL_MS,
          )),
        },
        stdio: 'ignore',
      },
    )
    child.on('error', (error) => {
      this.options.log?.('warn', '[TerminalBroker] Spawn failed', error)
    })
    child.unref()
  }

  private async waitForBrokerStopped(
    descriptor: BrokerDescriptor,
    childPids: number[],
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const brokerGone = this.isProcessAlive(descriptor.pid) === false
      const childrenGone = childPids.every(
        (pid) => this.isProcessAlive(pid) === false,
      )
      if (brokerGone && childrenGone) {
        this.removeDescriptorIfMatchesAndStopped(descriptor)
        if (!descriptorsEqual(this.readDescriptor(), descriptor)) return true
      }
      await wait(25)
    }
    this.options.log?.(
      'warn',
      '[TerminalBroker] Timed out waiting for broker shutdown',
      descriptor.pid,
    )
    return false
  }

  private prepareSessionAck(
    sessionId: string,
    operation: 'spawn' | 'attach',
  ): number {
    this.clearSessionAck(sessionId)
    this.nextSessionAckEpoch += 1
    const epoch = this.nextSessionAckEpoch
    this.pendingSessionAcks.set(sessionId, {
      epoch,
      operation,
      timerId: null,
    })
    return epoch
  }

  private armSessionAck(sessionId: string, epoch: number): void {
    const pending = this.pendingSessionAcks.get(sessionId)
    if (
      !pending ||
      pending.epoch !== epoch ||
      !this.callbacks.has(sessionId)
    ) {
      return
    }
    const timeoutMs =
      this.options.sessionAckTimeoutMs ?? BROKER_SESSION_ACK_TIMEOUT_MS
    pending.timerId = stableTimeoutSource.setTimeout(() => {
      const current = this.pendingSessionAcks.get(sessionId)
      if (!current || current.epoch !== epoch) return
      current.timerId = null
      this.handleSessionRequestFailure(
        sessionId,
        epoch,
        current.operation,
        new Error('Terminal broker session acknowledgement timed out'),
      )
    }, Math.max(1, timeoutMs))
  }

  private clearSessionAck(sessionId: string): void {
    const pending = this.pendingSessionAcks.get(sessionId)
    if (!pending) return
    this.pendingSessionAcks.delete(sessionId)
    if (pending.timerId !== null) {
      stableTimeoutSource.clearTimeout(pending.timerId)
    }
  }

  private clearAllSessionAcks(): void {
    for (const sessionId of Array.from(this.pendingSessionAcks.keys())) {
      this.clearSessionAck(sessionId)
    }
  }

  private handleSessionRequestFailure(
    sessionId: string,
    epoch: number,
    operation: 'spawn' | 'attach',
    error: unknown,
  ): void {
    const pending = this.pendingSessionAcks.get(sessionId)
    if (!pending || pending.epoch !== epoch) return
    this.clearSessionAck(sessionId)
    const callbacks = this.callbacks.get(sessionId)
    if (!callbacks) return
    this.callbacks.delete(sessionId)
    const descriptor =
      this.lastAuthenticatedDescriptor ??
      this.descriptor ??
      this.readDescriptor()
    this.options.log?.(
      'warn',
      `[TerminalBroker] ${operation === 'spawn' ? 'Spawn' : 'Attach'} handshake failed`,
      error,
    )
    if (descriptor === null) {
      // send() rejected before any trusted descriptor existed. A spawn frame
      // therefore could not have created a CLI. For restore, the broker
      // contract keeps its trusted descriptor for the full session lifetime;
      // without one there is no authentic process owner to address.
      this.sessionPids.delete(sessionId)
      this.explicitlyStoppedSessionIds.delete(sessionId)
      if (operation === 'spawn') {
        callbacks.onExit({
          status: 'failed',
          exitCode: null,
          signal: null,
          errorMessage: describeError(error),
        })
      } else {
        callbacks.onUnavailable?.()
      }
      this.detachIfNoSessions()
      return
    }
    // An attach always refers to a potentially live broker-owned CLI, and a
    // written spawn is ambiguous until attached/error arrives. Do not merely
    // repaint the UI: terminate through the authenticated control channel and
    // notify only after child exit is confirmed.
    this.terminateUnavailableSessions(descriptor, [[sessionId, callbacks]])
  }

  private handleStopRequestFailure(
    sessionId: string,
    error: unknown,
  ): void {
    const callbacks = this.callbacks.get(sessionId)
    if (!callbacks) return
    this.callbacks.delete(sessionId)
    this.clearSessionAck(sessionId)
    const descriptor =
      this.lastAuthenticatedDescriptor ??
      this.descriptor ??
      this.readDescriptor()
    if (descriptor) {
      this.terminateUnavailableSessions(descriptor, [[sessionId, callbacks]])
      return
    }
    this.sessionPids.delete(sessionId)
    this.options.log?.(
      'warn',
      '[TerminalBroker] Stop could not reach an existing session',
      error,
    )
    callbacks.onUnavailable?.()
    this.detachIfNoSessions()
  }

  private detachIfNoSessions(): void {
    if (this.callbacks.size === 0) {
      this.detach()
    }
  }

  /**
   * Close only the ordinary data transport while retaining the descriptor
   * that was authenticated on it. The abnormal-termination control channel
   * needs that descriptor after a malformed replay forced this socket down.
   */
  private detachTransport(): void {
    this.transportGeneration += 1
    this.intentionallyDisconnected = true
    this.socket?.end()
    this.socket?.destroy()
    this.socket = null
    this.connectPromise = null
    this.descriptor = null
    this.receiveBuffer = ''
    this.clearAllSessionAcks()
  }

  /**
   * A transport give-up must not merely repaint the UI as interrupted while
   * the broker-owned CLI continues unattended. Use an isolated authenticated
   * control connection that receives no replay/data, force each live session
   * down, and notify the renderer only after the broker confirms child exit.
   *
   * Older brokers do not understand terminate-unavailable. If the control
   * exchange times out, use their existing authenticated shutdown command;
   * its handler kills all owned process groups before acknowledging. This
   * intentionally favors eliminating an orphan AI process over preserving
   * unrelated sessions after protocol corruption.
   */
  private terminateUnavailableSessions(
    descriptor: BrokerDescriptor | null,
    sessions: Array<[string, TerminalBrokerSessionCallbacks]>,
  ): void {
    if (sessions.length === 0) return
    if (descriptor) this.unavailableDescriptor = descriptor
    for (const [sessionId, callbacks] of sessions) {
      this.pendingUnavailableTerminations.set(sessionId, callbacks)
    }
    this.scheduleUnavailableRecovery(true)
  }

  private scheduleUnavailableRecovery(immediate: boolean): void {
    if (
      this.closing ||
      this.pendingUnavailableTerminations.size === 0 ||
      this.unavailableRecoveryPromise
    ) {
      return
    }
    const baseMs =
      this.options.unavailableRecoveryBaseMs ??
      BROKER_UNAVAILABLE_RECOVERY_BASE_MS
    const maxMs =
      this.options.unavailableRecoveryMaxMs ??
      BROKER_UNAVAILABLE_RECOVERY_MAX_MS
    const delayMs = immediate
      ? 0
      : Math.min(
        maxMs,
        baseMs * (2 ** Math.min(this.unavailableRecoveryAttempt, 16)),
      )
    const generation = this.unavailableRecoveryGeneration + 1
    this.unavailableRecoveryGeneration = generation
    const attempt = (delayMs > 0
      ? wait(delayMs)
      : Promise.resolve())
      .then(() => this.attemptUnavailableRecovery(generation))
      .catch((error: unknown) => {
        if (generation !== this.unavailableRecoveryGeneration) return
        this.options.log?.(
          'warn',
          '[TerminalBroker] Unavailable-session recovery failed',
          error,
        )
      })
      .finally(() => {
        if (
          generation !== this.unavailableRecoveryGeneration ||
          this.unavailableRecoveryPromise !== attempt
        ) {
          return
        }
        this.unavailableRecoveryPromise = null
        if (
          !this.closing &&
          this.pendingUnavailableTerminations.size > 0
        ) {
          this.unavailableRecoveryAttempt += 1
          this.scheduleUnavailableRecovery(false)
        }
      })
    this.unavailableRecoveryPromise = attempt
  }

  private async attemptUnavailableRecovery(generation: number): Promise<void> {
    if (
      this.closing ||
      generation !== this.unavailableRecoveryGeneration ||
      this.pendingUnavailableTerminations.size === 0
    ) {
      return
    }
    const sessions = Array.from(this.pendingUnavailableTerminations.entries())
    const descriptor =
      this.unavailableDescriptor ??
      this.lastAuthenticatedDescriptor ??
      this.readDescriptor()
    if (descriptor) this.unavailableDescriptor = descriptor
    const results = new Map<string, UnavailableTerminationResult>()
    let fallbackShutdownConfirmed = false
    if (descriptor) {
      try {
        await this.requestUnavailableTermination(
          descriptor,
          sessions.map(([sessionId]) => sessionId),
          results,
        )
      } catch (error) {
        this.options.log?.(
          'warn',
          '[TerminalBroker] Failed to confirm unavailable-session termination',
          error,
        )
        if (
          isConnectionRefusedError(error) &&
          sessions.length > 0 &&
          sessions.every(([sessionId]) =>
            this.explicitlyStoppedSessionIds.has(sessionId)) &&
          this.removeDescriptorIfMatches(descriptor)
        ) {
          // A broker writes its descriptor only after listen() succeeds.
          // Therefore a refused descriptor plus an explicit user stop means
          // this is stale (possibly a reused live PID), not a process we may
          // signal. Remove only the matching descriptor and reconcile the UI;
          // never kill descriptor.pid.
          for (const [sessionId, callbacks] of sessions) {
            this.settleUnavailableSession(sessionId, callbacks)
          }
          return
        }
        fallbackShutdownConfirmed =
          await this.shutdownAuthenticatedBroker(descriptor, sessions)
      }
    }
    if (
      this.closing ||
      generation !== this.unavailableRecoveryGeneration
    ) {
      return
    }
    for (const [sessionId, callbacks] of sessions) {
      if (
        this.closing ||
        generation !== this.unavailableRecoveryGeneration
      ) {
        return
      }
      if (this.pendingUnavailableTerminations.get(sessionId) !== callbacks) {
        continue
      }
      const result = results.get(sessionId)
      // A result is an individual broker acknowledgement. For sessions that
      // never received one, authenticated shutdown is the only confirmation
      // that the broker-owned process is gone. If both control paths fail,
      // leave the renderer record active instead of falsely repainting it as
      // interrupted while an unattended CLI may still be alive.
      if (result === undefined && !fallbackShutdownConfirmed) {
        continue
      }
      this.settleUnavailableSession(sessionId, callbacks, result)
    }

    const remaining = sessions.filter(
      ([sessionId, callbacks]) =>
        this.pendingUnavailableTerminations.get(sessionId) === callbacks,
    )
    if (
      !this.closing &&
      generation === this.unavailableRecoveryGeneration &&
      remaining.length > 0 &&
      this.areUnavailableProcessesConfirmedGone(descriptor, remaining)
    ) {
      for (const [sessionId, callbacks] of remaining) {
        this.settleUnavailableSession(sessionId, callbacks)
      }
    } else if (
      !this.closing &&
      generation === this.unavailableRecoveryGeneration &&
      remaining.length > 0
    ) {
      this.options.log?.(
        'warn',
        '[TerminalBroker] Session termination remains unconfirmed; retrying with backoff',
        remaining.map(([sessionId]) => sessionId),
      )
    }

    if (this.pendingUnavailableTerminations.size === 0) {
      this.unavailableRecoveryAttempt = 0
      this.unavailableDescriptor = null
      this.lastAuthenticatedDescriptor = null
    }
  }

  /**
   * Supersede a delayed recovery without waiting for its timer. Optionally
   * release renderer callbacks as part of an explicit transport detach.
   */
  private invalidateUnavailableRecovery(clearPending = false): void {
    this.unavailableRecoveryGeneration += 1
    this.unavailableRecoveryPromise = null
    if (!clearPending) return
    this.pendingUnavailableTerminations.clear()
    this.unavailableRecoveryAttempt = 0
    this.unavailableDescriptor = null
  }

  private invalidateUnavailableRecoverySchedule(): void {
    this.invalidateUnavailableRecovery(false)
  }

  private settleUnavailableSession(
    sessionId: string,
    callbacks: TerminalBrokerSessionCallbacks,
    result?: UnavailableTerminationResult,
  ): void {
    if (this.pendingUnavailableTerminations.get(sessionId) !== callbacks) return
    this.pendingUnavailableTerminations.delete(sessionId)
    this.sessionPids.delete(sessionId)
    this.explicitlyStoppedSessionIds.delete(sessionId)
    try {
      if (
        result &&
        !result.interrupted &&
        result.outcome !== undefined
      ) {
        if (result.transcriptPath !== undefined) {
          callbacks.onAttached?.(undefined, result.transcriptPath)
        }
        callbacks.onExit(result.outcome)
      } else {
        callbacks.onUnavailable?.(result?.transcriptPath)
      }
    } catch (error) {
      this.options.log?.(
        'warn',
        '[TerminalBroker] Unavailable-session callback failed',
        error,
      )
    }
  }

  private areUnavailableProcessesConfirmedGone(
    descriptor: BrokerDescriptor | null,
    sessions: Array<[string, TerminalBrokerSessionCallbacks]>,
  ): boolean {
    if (descriptor && this.isProcessAlive(descriptor.pid) !== false) {
      return false
    }
    if (descriptor && descriptorsEqual(this.readDescriptor(), descriptor)) {
      return false
    }
    return sessions.every(([sessionId]) => {
      const pid = this.sessionPids.get(sessionId)
      return pid !== undefined && this.isProcessAlive(pid) === false
    })
  }

  private requestUnavailableTermination(
    descriptor: BrokerDescriptor,
    sessionIds: string[],
    results: Map<string, UnavailableTerminationResult>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const pending = new Set(sessionIds)
      const socket = loadNet().createConnection({
        host: '127.0.0.1',
        port: descriptor.port,
      })
      let settled = false
      let receiveBuffer = ''
      const finish = (): void => {
        if (settled) return
        settled = true
        socket.end()
        socket.destroy()
        resolve()
      }
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        socket.destroy()
        reject(error instanceof Error ? error : new Error(describeError(error)))
      }
      socket.setEncoding('utf8')
      socket.setTimeout(
        this.options.unavailableTerminationTimeoutMs ??
          BROKER_UNAVAILABLE_TERMINATION_TIMEOUT_MS,
        () => fail(new Error('Terminal broker termination timed out')),
      )
      socket.on('connect', () => {
        for (const sessionId of sessionIds) {
          const frame: BrokerClientMessage = {
            token: descriptor.token,
            op: 'terminate-unavailable',
            sessionId,
          }
          socket.write(`${JSON.stringify(frame)}\n`)
        }
      })
      socket.on('data', (chunk) => {
        receiveBuffer += chunk
        if (receiveBuffer.length > MAX_CLIENT_FRAME_BYTES) {
          fail(new Error('Terminal broker termination response exceeds the IPC limit'))
          return
        }
        let newline = receiveBuffer.indexOf('\n')
        while (newline >= 0 && !settled) {
          const line = receiveBuffer.slice(0, newline)
          receiveBuffer = receiveBuffer.slice(newline + 1)
          if (line.length > 0) {
            try {
              const message = JSON.parse(line) as BrokerServerMessage
              if (
                'sessionId' in message &&
                typeof message.sessionId === 'string' &&
                pending.has(message.sessionId)
              ) {
                if (message.type === 'terminated-unavailable') {
                  results.set(message.sessionId, {
                    interrupted: message.interrupted,
                    ...(typeof message.transcriptPath === 'string' &&
                    message.transcriptPath.length > 0 &&
                    message.transcriptPath.length <= 8 * 1024
                      ? { transcriptPath: message.transcriptPath }
                      : {}),
                    ...(message.outcome ? { outcome: message.outcome } : {}),
                  })
                  pending.delete(message.sessionId)
                } else if (message.type === 'missing') {
                  // The authenticated broker confirmed it owns no such
                  // process. Record that confirmation so a later failure for
                  // another session does not suppress this session's
                  // unavailable notification.
                  results.set(message.sessionId, { interrupted: true })
                  pending.delete(message.sessionId)
                }
              }
            } catch (error) {
              fail(error)
              return
            }
          }
          newline = receiveBuffer.indexOf('\n')
        }
        if (pending.size === 0) finish()
      })
      socket.on('timeout', () =>
        fail(new Error('Terminal broker termination timed out')),
      )
      socket.on('error', fail)
      socket.on('close', () => {
        if (!settled && pending.size > 0) {
          fail(new Error('Terminal broker termination connection closed early'))
        }
      })
    })
  }

  /**
   * Compatibility fallback for an older authenticated broker that does not
   * implement terminate-unavailable. Use its existing authenticated shutdown
   * command instead of signalling descriptor.pid directly: a stale
   * descriptor whose pid has been reused must never kill an unrelated OS
   * process. Broker shutdown synchronously SIGKILLs every owned process group
   * before acknowledging.
   */
  private async shutdownAuthenticatedBroker(
    descriptor: BrokerDescriptor,
    sessions: Array<[string, TerminalBrokerSessionCallbacks]>,
  ): Promise<boolean> {
    const childPids = sessions
      .map(([sessionId]) => this.sessionPids.get(sessionId))
      .filter((pid): pid is number => pid !== undefined)
    const timeoutMs =
      this.options.unavailableTerminationTimeoutMs ??
      BROKER_UNAVAILABLE_TERMINATION_TIMEOUT_MS
    try {
      await this.requestAuthenticatedBrokerShutdown(
        descriptor,
        timeoutMs,
      )
      // Older brokers can remove the descriptor and ACK before their child
      // tree actually disappears. Reuse the same truthful broker+known-child
      // confirmation as explicit app shutdown.
      return await this.waitForBrokerStopped(descriptor, childPids, timeoutMs)
    } catch (error) {
      this.options.log?.(
        'warn',
        '[TerminalBroker] Authenticated broker shutdown failed',
        error,
      )
      return false
    }
  }

  private requestAuthenticatedBrokerShutdown(
    descriptor: BrokerDescriptor,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = loadNet().createConnection({
        host: '127.0.0.1',
        port: descriptor.port,
      })
      let settled = false
      let receiveBuffer = ''
      const finish = (): void => {
        if (settled) return
        settled = true
        socket.end()
        socket.destroy()
        resolve()
      }
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        socket.destroy()
        reject(error instanceof Error ? error : new Error(describeError(error)))
      }
      socket.setEncoding('utf8')
      socket.setTimeout(
        timeoutMs,
        () => fail(new Error('Terminal broker shutdown timed out')),
      )
      socket.on('connect', () => {
        const frame: BrokerClientMessage = {
          token: descriptor.token,
          op: 'shutdown',
        }
        socket.write(`${JSON.stringify(frame)}\n`)
      })
      socket.on('data', (chunk) => {
        receiveBuffer += chunk
        if (receiveBuffer.length > MAX_CLIENT_FRAME_BYTES) {
          fail(new Error('Terminal broker shutdown response exceeds the IPC limit'))
          return
        }
        let newline = receiveBuffer.indexOf('\n')
        while (newline >= 0 && !settled) {
          const line = receiveBuffer.slice(0, newline)
          receiveBuffer = receiveBuffer.slice(newline + 1)
          if (line.length > 0) {
            try {
              const message = JSON.parse(line) as BrokerServerMessage
              if (message.type === 'shutdown-ack') {
                finish()
                return
              }
            } catch (error) {
              fail(error)
              return
            }
          }
          newline = receiveBuffer.indexOf('\n')
        }
      })
      socket.on('timeout', () =>
        fail(new Error('Terminal broker shutdown timed out')),
      )
      socket.on('error', fail)
      socket.on('close', () => {
        if (!settled) {
          fail(new Error('Terminal broker shutdown connection closed early'))
        }
      })
    })
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
          const ackEpoch = this.prepareSessionAck(sessionId, 'attach')
          try {
            socket.write(`${JSON.stringify(frame)}\n`)
            this.armSessionAck(sessionId, ackEpoch)
          } catch (error) {
            this.handleSessionRequestFailure(
              sessionId,
              ackEpoch,
              'attach',
              error,
            )
          }
        }
        this.reconnectAttempts = 0
      })
      .catch((error) => {
        this.reconnectAttempts += 1
        this.options.log?.('warn', '[TerminalBroker] Reconnect failed', error)
        if (this.reconnectAttempts >= 3) {
          const sessions = Array.from(this.callbacks.entries())
          this.callbacks.clear()
          const descriptor = this.lastAuthenticatedDescriptor
          this.detachTransport()
          void this.terminateUnavailableSessions(descriptor, sessions)
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
