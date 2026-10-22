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
  AiTerminalFailureKind,
} from './dispatchers/Dispatcher'
import { Platform } from 'obsidian'

import {
  BROKER_PROTOCOL_VERSION,
  challengeBroker,
  UntrustedBrokerError,
} from './BrokerProof'
import {
  orphanStorePath,
  readOrphans,
  updateOrphans,
  type OrphanChange,
} from './BrokerOrphanStore'
import type { SpawnProcessRequest } from './NodeProcessGateway'
import { listNodeExecutableCandidates } from './NodeExecutableLocator'
import { buildTerminalBrokerSource } from './TerminalSessionBrokerSource'
import {
  sleepWithStableTimer,
  stableTimeoutSource,
  type StableTimeoutId,
} from '@/utils/stableTimer'

export { buildTerminalBrokerSource } from './TerminalSessionBrokerSource'

declare function require(moduleId: string): unknown

/** Every Node builtin below is reachable only from the desktop runtime. */
const DESKTOP_ONLY_BROKER = 'The AI terminal broker is desktop only.'
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
  constants: { X_OK: number }
  accessSync(path: string, mode: number): void
  statSync(path: string): { isFile(): boolean }
  readdirSync(path: string): string[]
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
  writeFileSync(
    path: string,
    data: string,
    options: { mode: number; flag: string },
  ): void
  renameSync(from: string, to: string): void
}

interface NodeOsModuleLike {
  tmpdir(): string
  homedir(): string
}

interface NodePathModuleLike {
  join(...parts: string[]): string
}

interface NodeCryptoModuleLike {
  createHash(algorithm: string): {
    update(value: string): { digest(encoding: 'hex'): string }
  }
  createHmac(
    algorithm: string,
    key: string,
  ): { update(value: string): { digest(encoding: 'hex'): string } }
  randomBytes(size: number): NodeBufferLike
}

interface NodeChildProcessLike {
  unref(): void
  on(event: 'error', listener: (error: unknown) => void): void
  on(
    event: 'exit',
    listener: (code: number | null, signal: string | null) => void,
  ): void
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
  version: 2
  port: number
  token: string
  pid: number
}

type BrokerClientMessage =
  (
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
  | { token: string; op: 'schedule-shutdown'; graceMs: number }
  | { token: string; op: 'cancel-deferred-shutdown' }
  | { token: string; op: 'activate-renderer-lease'; keepShutdown?: true }
  | { token: string; op: 'shutdown' }
  ) & {
    rendererLeaseToken?: string
    rendererLeaseOwnerId?: string
    rendererLeaseGeneration?: number
  }

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
  | { type: 'shutdown-scheduled' }
  | { type: 'shutdown-canceled' }
  | { type: 'renderer-lease-activated' }
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
  /**
   * The session stopped answering and its termination is being confirmed.
   * onUnavailable or onExit follows within the bounded confirmation window.
   */
  onConnectionLost?(): void
  /** Keyboard input could not be delivered to the session. */
  onInputDropped?(): void
}

/** This client's bookkeeping for one spawned or attached session. */
interface SessionRecord {
  /** Pid of the session's root process, as its broker reported it. */
  pid?: number
  /** The broker the session's spawn/attach frame was last written to. */
  descriptor?: BrokerDescriptor
  /** Input failed while the transport was reconnecting. */
  inputLost: boolean
  /** This outage has already been reported as dropped input. */
  inputDropNotified: boolean
}

/** A session written off as unreachable, its termination being confirmed. */
interface UnavailableSession {
  callbacks: TerminalBrokerSessionCallbacks
  /** The broker that owns it; resolved at recovery time while unknown. */
  descriptor: BrokerDescriptor | null
  /** Monotonic time it was first left unconfirmed. */
  since: number
  /** Recovery rounds that have tried it. */
  attempts: number
  /** Its termination was also queued on the verified data transport. */
  queuedOnTransport?: boolean
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
  /** Test/embedding override for deferred-shutdown scheduling ACK. */
  deferredShutdownTimeoutMs?: number
  /** Deadline for spawn/attach to receive attached/missing/error. */
  sessionAckTimeoutMs?: number
  /** Initial retry delay after an unavailable-session termination is unconfirmed. */
  unavailableRecoveryBaseMs?: number
  /** Maximum retry delay after repeated unavailable-session failures. */
  unavailableRecoveryMaxMs?: number
  /** How long an unconfirmed termination is retried before it is given up. */
  unavailableConfirmationGiveUpMs?: number
  /** Attempts an unconfirmed termination gets before the window can end it. */
  unavailableConfirmationMinAttempts?: number
  /** Interval of the background retry for terminations given up undelivered. */
  orphanCleanupIntervalMs?: number
  /**
   * Clock for the confirmation window; defaults to performance.now, which
   * does not advance while the machine sleeps.
   */
  monotonicNow?(): number
  /**
   * Resolves once the login shell's PATH has been merged into getEnv(). Only
   * awaited when no Node.js can be found without it.
   */
  prepareEnv?(): Promise<void>
  /** Upper bound on the prepareEnv wait. */
  prepareEnvTimeoutMs?: number
  /** Test/embedding override for the Node.js executables to start the broker with. */
  locateNode?(env: Record<string, string | undefined>): string[]
  /** Test/embedding override for the renderer crash-reconnect window. */
  idleTtlMs?: number
  /** Deterministic renderer-lease override used by lifecycle tests. */
  rendererLeaseToken?: string
  rendererLeaseOwnerId?: string
  rendererLeaseGeneration?: number
  /** Bounded retry window for renderer-lease activation control IPC. */
  rendererLeaseActivationRetryWindowMs?: number
}

// Version 2 brokers prove they hold the token before the client sends it
// (LEV-391). Version 1 brokers cannot, so they are never trusted: their
// descriptor is retired and a fresh broker started. A version 1 broker left
// without clients stops itself, and its sessions, after its idle TTL.
const BROKER_VERSION = BROKER_PROTOCOL_VERSION
const LEGACY_BROKER_VERSION = 1
const BROKER_CONNECT_TIMEOUT_MS = 700
const BROKER_STARTUP_TIMEOUT_MS = 5_000
const BROKER_RETRY_MS = 50
const BROKER_SHUTDOWN_TIMEOUT_MS = 2_500
const BROKER_DEFERRED_SHUTDOWN_TIMEOUT_MS = 2_500
const BROKER_DEFERRED_SHUTDOWN_MIN_MS = 100
const BROKER_DEFERRED_SHUTDOWN_MAX_MS = 120_000
const BROKER_SESSION_ACK_TIMEOUT_MS = 5_000
const BROKER_UNAVAILABLE_TERMINATION_TIMEOUT_MS = 2_500
const BROKER_UNAVAILABLE_RECOVERY_BASE_MS = 250
const BROKER_UNAVAILABLE_RECOVERY_MAX_MS = 30_000
/**
 * An unconfirmed termination used to be retried forever, and while it was,
 * every new terminal was refused and every keystroke dropped. Past this
 * window the session is reported unavailable and its run turns interrupted;
 * the termination requests already written stay queued for a broker that
 * answers later.
 */
const BROKER_UNAVAILABLE_CONFIRMATION_GIVE_UP_MS = 60_000
const BROKER_ORPHAN_CLEANUP_INTERVAL_MS = 30_000
/**
 * Announces, on the window, that a client saved pending terminations. Every
 * client in the renderer shares that window, including those of earlier
 * bundles a hot reload left behind, so the one holding the current lease
 * learns about a session an older client gave up on.
 */
const ORPHANS_SAVED_EVENT = 'taskchute-plus:broker-orphans-saved'
const BROKER_UNAVAILABLE_CONFIRMATION_MIN_ATTEMPTS = 5
/** A login shell normally answers in a few seconds; a hung one must not hold a terminal. */
const BROKER_PREPARE_ENV_TIMEOUT_MS = 12_000
/** Broker exit code for "another broker already owns the descriptor". */
const BROKER_EXIT_DESCRIPTOR_TAKEN = 65
const NODE_NOT_FOUND_MESSAGE =
  'Node.js was not found. The terminal needs Node.js to run; install it and open the terminal again.'
// A renderer crash/relaunch can take longer than the old one-minute window.
// App/plugin shutdown still uses authenticated cleanup, so this TTL is only
// the bounded crash-recovery window—not the normal process lifetime.
const BROKER_RENDERER_RECONNECT_TTL_MS = 30 * 60 * 1000
const BROKER_RENDERER_LEASE_ACTIVATION_RETRY_WINDOW_MS = 10_000
const BROKER_RENDERER_LEASE_ACTIVATION_RETRY_MS = 200
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
const BROKER_RENDERER_LEASE_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u

interface RendererLeaseIdentity {
  token: string
  ownerId: string
  generation: number
}

function isValidBrokerSessionId(sessionId: string): boolean {
  return BROKER_SESSION_ID_PATTERN.test(sessionId)
}

function loadNet(): NodeNetModuleLike {
  if (!Platform.isDesktop) {
    throw new Error(DESKTOP_ONLY_BROKER)
  }
  // eslint-disable-next-line import/no-nodejs-modules -- guarded by Platform.isDesktop above; the session socket is a Node net server
  return require('net') as NodeNetModuleLike
}

function loadFs(): NodeFsModuleLike {
  if (!Platform.isDesktop) {
    throw new Error(DESKTOP_ONLY_BROKER)
  }
  // eslint-disable-next-line import/no-nodejs-modules -- guarded by Platform.isDesktop above; socket paths and lock files live on disk
  return require('fs') as NodeFsModuleLike
}

function loadOs(): NodeOsModuleLike {
  if (!Platform.isDesktop) {
    throw new Error(DESKTOP_ONLY_BROKER)
  }
  // eslint-disable-next-line import/no-nodejs-modules -- guarded by Platform.isDesktop above; the socket directory is derived from the OS temp dir
  return require('os') as NodeOsModuleLike
}

function loadPath(): NodePathModuleLike {
  if (!Platform.isDesktop) {
    throw new Error(DESKTOP_ONLY_BROKER)
  }
  // eslint-disable-next-line import/no-nodejs-modules -- guarded by Platform.isDesktop above; socket and lock paths are joined with Node path
  return require('path') as NodePathModuleLike
}

function loadCrypto(): NodeCryptoModuleLike {
  if (!Platform.isDesktop) {
    throw new Error(DESKTOP_ONLY_BROKER)
  }
  // eslint-disable-next-line import/no-nodejs-modules -- guarded by Platform.isDesktop above; session ids and owner tokens need Node crypto
  return require('crypto') as NodeCryptoModuleLike
}

function loadChildProcess(): NodeChildProcessModuleLike {
  if (!Platform.isDesktop) {
    throw new Error(DESKTOP_ONLY_BROKER)
  }
  // eslint-disable-next-line import/no-nodejs-modules -- guarded by Platform.isDesktop above; the PTY host is spawned as a child process
  return require('child_process') as NodeChildProcessModuleLike
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}

/** The broker could not be brought up at all; no session frame was sent. */
export class TerminalBrokerStartError extends Error {
  constructor(
    readonly kind: Extract<
      AiTerminalFailureKind,
      'node-not-found' | 'broker-start-failed'
    >,
    message: string,
  ) {
    super(message)
    this.name = 'TerminalBrokerStartError'
  }
}

function terminalFailureOf(error: unknown): AiTerminalFailureKind {
  return error instanceof TerminalBrokerStartError
    ? error.kind
    : 'broker-start-failed'
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : ''
}

function locateNodeOnDisk(env: Record<string, string | undefined>): string[] {
  const fs = loadFs()
  let home = env['HOME']
  if (!home) {
    try {
      home = loadOs().homedir() || undefined
    } catch {
      home = undefined
    }
  }
  return listNodeExecutableCandidates(
    process.platform ?? '',
    { ...env, HOME: home },
    {
      isExecutableFile: (path) => {
        try {
          if (!fs.statSync(path).isFile()) return false
          fs.accessSync(path, fs.constants.X_OK)
          return true
        } catch {
          return false
        }
      },
      listDirectory: (path) => {
        try {
          return fs.readdirSync(path)
        } catch {
          return []
        }
      },
    },
  )
}

function isConnectionRefusedError(error: unknown): boolean {
  return (
    errorCode(error) === 'ECONNREFUSED' ||
    /(?:ECONNREFUSED|connection refused)/iu.test(describeError(error))
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
  private readonly sessionRecords = new Map<string, SessionRecord>()
  private readonly explicitlyStoppedSessionIds = new Set<string>()
  private readonly unavailableSessions = new Map<string, UnavailableSession>()
  /**
   * Sessions reported unavailable whose termination no broker has confirmed,
   * by the broker that owns them. Saved to disk; see BrokerOrphanStore and
   * cleanUpOrphanedSessions.
   */
  private readonly orphanedSessions = new Map<string, BrokerDescriptor>()
  private orphanCleanupTimer: StableTimeoutId | null = null
  private orphanCleanupRunning = false
  private readonly onOrphansSaved = (event: Event): void => {
    if ((event as CustomEvent<unknown>).detail !== this.descriptorPath) return
    this.adoptSavedOrphans(false)
  }
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
  private rendererLeaseToken: string
  private rendererLeaseOwnerId: string
  private rendererLeaseGeneration: number
  private rendererLeaseActivationEpoch = 0

  constructor(private readonly options: TerminalBrokerClientOptions) {
    this.descriptorPath = getTerminalBrokerDescriptorPath(options.identity)
    this.rendererLeaseToken =
      options.rendererLeaseToken &&
      BROKER_RENDERER_LEASE_PATTERN.test(options.rendererLeaseToken)
        ? options.rendererLeaseToken
        : loadCrypto().randomBytes(24).toString('hex')
    this.rendererLeaseOwnerId =
      options.rendererLeaseOwnerId &&
      BROKER_RENDERER_LEASE_PATTERN.test(options.rendererLeaseOwnerId)
        ? options.rendererLeaseOwnerId
        : loadCrypto().randomBytes(24).toString('hex')
    this.rendererLeaseGeneration =
      Number.isSafeInteger(options.rendererLeaseGeneration) &&
      (options.rendererLeaseGeneration ?? 0) >= 1
        ? (options.rendererLeaseGeneration as number)
        : 1
    this.adoptSavedOrphans(true)
    try {
      window.addEventListener(ORPHANS_SAVED_EVENT, this.onOrphansSaved)
    } catch {
      // No window: only this client's own retries run.
    }
  }

  async setRendererLeaseToken(
    rendererLeaseToken: string,
    rendererLeaseOwnerId = this.rendererLeaseOwnerId,
    rendererLeaseGeneration = this.rendererLeaseGeneration + 1,
  ): Promise<void> {
    if (!BROKER_RENDERER_LEASE_PATTERN.test(rendererLeaseToken)) {
      throw new Error('Invalid terminal broker renderer lease token')
    }
    if (!BROKER_RENDERER_LEASE_PATTERN.test(rendererLeaseOwnerId)) {
      throw new Error('Invalid terminal broker renderer lease owner')
    }
    if (
      !Number.isSafeInteger(rendererLeaseGeneration) ||
      rendererLeaseGeneration < 1
    ) {
      throw new Error('Invalid terminal broker renderer lease generation')
    }
    this.rendererLeaseToken = rendererLeaseToken
    this.rendererLeaseOwnerId = rendererLeaseOwnerId
    this.rendererLeaseGeneration = rendererLeaseGeneration
    const activationEpoch = this.rendererLeaseActivationEpoch + 1
    this.rendererLeaseActivationEpoch = activationEpoch
    const initialTarget =
      this.descriptor ??
      this.lastAuthenticatedDescriptor ??
      this.readDescriptor()
    // A fresh broker has nothing to supersede; its first spawn claims this
    // lease. Adoption has an existing descriptor and must cross an explicit
    // activation barrier even when AI Runs stays closed.
    if (!initialTarget) return
    const identity = this.captureRendererLeaseIdentity(rendererLeaseToken)
    const deadline =
      Date.now() +
      (this.options.rendererLeaseActivationRetryWindowMs ??
        BROKER_RENDERER_LEASE_ACTIVATION_RETRY_WINDOW_MS)
    let lastError: unknown = new Error(
      'Terminal broker renderer lease activation timed out',
    )
    do {
      if (
        activationEpoch !== this.rendererLeaseActivationEpoch ||
        this.closing
      ) {
        return
      }
      const target =
        this.descriptor ??
        this.lastAuthenticatedDescriptor ??
        this.readDescriptor()
      if (target) {
        try {
          await this.requestAuthenticatedDeferredShutdown(
            target,
            { op: 'activate-renderer-lease' },
            'renderer-lease-activated',
            identity,
            this.options.deferredShutdownTimeoutMs ??
              BROKER_DEFERRED_SHUTDOWN_TIMEOUT_MS,
          )
          return
        } catch (error) {
          lastError = error
        }
      }
      await wait(BROKER_RENDERER_LEASE_ACTIVATION_RETRY_MS)
    } while (Date.now() < deadline)
    throw lastError
  }

  private captureRendererLeaseIdentity(
    token = this.rendererLeaseToken,
    ownerId = this.rendererLeaseOwnerId,
    generation = this.rendererLeaseGeneration,
  ): RendererLeaseIdentity {
    return {
      token,
      ownerId,
      generation,
    }
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
    // Only this session's own unconfirmed termination blocks it. Another
    // session stuck in confirmation used to refuse every new terminal until
    // the renderer reloaded.
    if (this.unavailableSessions.has(sessionId)) {
      callbacks.onExit({
        status: 'failed',
        exitCode: null,
        signal: null,
        errorMessage:
          'Terminal broker is still confirming that this session stopped',
        terminalFailure: 'broker-start-failed',
      })
      return
    }
    this.sessionRecords.set(sessionId, { inputLost: false, inputDropNotified: false })
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
      (descriptor) => {
        this.sessionRecord(sessionId).descriptor = descriptor
        this.armSessionAck(sessionId, ackEpoch)
      },
      (error: unknown) => this.failUnsentSpawn(sessionId, ackEpoch, error),
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
    if (this.unavailableSessions.has(sessionId)) {
      callbacks.onUnavailable?.()
      return
    }
    this.sessionRecords.set(sessionId, { inputLost: false, inputDropNotified: false })
    this.explicitlyStoppedSessionIds.delete(sessionId)
    this.callbacks.set(sessionId, callbacks)
    const ackEpoch = this.prepareSessionAck(sessionId, 'attach')
    void this.send({ op: 'attach', sessionId }, false).then(
      (descriptor) => {
        this.sessionRecord(sessionId).descriptor = descriptor
        this.armSessionAck(sessionId, ackEpoch)
      },
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
    if (this.closing || !isValidBrokerSessionId(sessionId)) return
    const unreachable = this.unavailableSessions.get(sessionId)
    if (unreachable) {
      // The session is being written off; tell the user rather than letting
      // the keystrokes vanish into a terminal that looks alive.
      this.notifyInputDropped(sessionId, unreachable.callbacks)
      return
    }
    // Only an explicit spawn request may create the broker. A stale handle
    // must never resurrect an empty broker after the real session vanished.
    void this.send({ op: 'input', sessionId, data }, false).catch((error) => {
      this.options.log?.('warn', '[TerminalBroker] Input failed', error)
      // Not reported at once: a reconnect is usually underway. It is reported
      // once when the session reattaches or is written off.
      const pending = this.unavailableSessions.get(sessionId)
      if (pending) this.notifyInputDropped(sessionId, pending.callbacks)
      else if (this.callbacks.has(sessionId)) {
        this.sessionRecord(sessionId).inputLost = true
      }
    })
  }

  /** At most once per outage; a recovered connection re-arms it. */
  private notifyInputDropped(
    sessionId: string,
    callbacks: TerminalBrokerSessionCallbacks,
  ): void {
    const record = this.sessionRecord(sessionId)
    record.inputLost = false
    if (record.inputDropNotified) return
    record.inputDropNotified = true
    try {
      callbacks.onInputDropped?.()
    } catch (error) {
      this.options.log?.('warn', '[TerminalBroker] Input-dropped callback failed', error)
    }
  }

  private sessionRecord(sessionId: string): SessionRecord {
    let record = this.sessionRecords.get(sessionId)
    if (!record) {
      record = { inputLost: false, inputDropNotified: false }
      this.sessionRecords.set(sessionId, record)
    }
    return record
  }

  /** Drop every per-session record once the session is over for this client. */
  private forgetSession(sessionId: string): void {
    this.sessionRecords.delete(sessionId)
    this.explicitlyStoppedSessionIds.delete(sessionId)
  }

  resize(
    sessionId: string,
    cols: number,
    rows: number,
  ): void {
    if (
      this.closing ||
      this.unavailableSessions.has(sessionId) ||
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
    if (this.unavailableSessions.has(sessionId)) {
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

  /**
   * Arm cleanup in the broker without marking this renderer client as
   * closing. Obsidian reports both app quit and Page.reload through the same
   * workspace event; a new authenticated renderer cancels this deadline.
   */
  async scheduleShutdownAfterGrace(
    graceMs: number,
    rendererLeaseToken = this.rendererLeaseToken,
    rendererLeaseOwnerId = this.rendererLeaseOwnerId,
    rendererLeaseGeneration = this.rendererLeaseGeneration,
  ): Promise<void> {
    if (this.closing) {
      throw new Error('Terminal broker client is shutting down')
    }
    const normalizedGraceMs = Math.min(
      BROKER_DEFERRED_SHUTDOWN_MAX_MS,
      Math.max(
        BROKER_DEFERRED_SHUTDOWN_MIN_MS,
        Math.round(Number.isFinite(graceMs) ? graceMs : 0),
      ),
    )
    const target =
      this.descriptor ??
      this.lastAuthenticatedDescriptor ??
      this.readDescriptor()
    if (!target) return
    await this.requestAuthenticatedDeferredShutdown(
      target,
      { op: 'schedule-shutdown', graceMs: normalizedGraceMs },
      'shutdown-scheduled',
      this.captureRendererLeaseIdentity(
        rendererLeaseToken,
        rendererLeaseOwnerId,
        rendererLeaseGeneration,
      ),
      this.options.deferredShutdownTimeoutMs ??
        BROKER_DEFERRED_SHUTDOWN_TIMEOUT_MS,
    )
  }

  /**
   * Cancel an ambiguous app-exit deadline after the renderer proves that a
   * workspace quit was canceled. This is explicit on purpose: traffic on an
   * already-authenticated old renderer socket (for example a late resize)
   * must never keep a genuinely exiting app alive.
   */
  async cancelDeferredShutdown(
    rendererLeaseToken = this.rendererLeaseToken,
    rendererLeaseOwnerId = this.rendererLeaseOwnerId,
    rendererLeaseGeneration = this.rendererLeaseGeneration,
  ): Promise<void> {
    if (this.closing) return
    const target =
      this.descriptor ??
      this.lastAuthenticatedDescriptor ??
      this.readDescriptor()
    if (!target) return
    await this.requestAuthenticatedDeferredShutdown(
      target,
      { op: 'cancel-deferred-shutdown' },
      'shutdown-canceled',
      this.captureRendererLeaseIdentity(
        rendererLeaseToken,
        rendererLeaseOwnerId,
        rendererLeaseGeneration,
      ),
      this.options.deferredShutdownTimeoutMs ??
        BROKER_DEFERRED_SHUTDOWN_TIMEOUT_MS,
    )
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
      this.firstPendingDescriptor() ??
      this.readDescriptor()
    if (!target) {
      this.detach()
      this.stopOrphanCleanup()
      return
    }
    const childPids = Array.from(this.sessionRecords.values())
      .map((record) => record.pid)
      .filter((pid): pid is number => pid !== undefined)
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
      this.unavailableSessions.clear()
      this.stopOrphanCleanup()
    }
  }

  private firstPendingDescriptor(): BrokerDescriptor | null {
    for (const pending of this.unavailableSessions.values()) {
      if (pending.descriptor) return pending.descriptor
    }
    return null
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
    this.sessionRecords.clear()
  }

  /** Resolves with the broker the frame was written to. */
  private async send(
    message: BrokerClientCommand,
    allowBrokerStart = true,
  ): Promise<BrokerDescriptor> {
    if (this.closing) {
      throw new Error('Terminal broker client is shutting down')
    }
    // Capture at invocation, before an async connect. Runtime adoption can
    // rotate the live client's lease while this old-renderer request is
    // waiting; the broker must still see (and reject) the old lease.
    const rendererLeaseIdentity = this.captureRendererLeaseIdentity()
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
    const frame = JSON.stringify({
      ...message,
      token: descriptor.token,
      rendererLeaseToken: rendererLeaseIdentity.token,
      rendererLeaseOwnerId: rendererLeaseIdentity.ownerId,
      rendererLeaseGeneration: rendererLeaseIdentity.generation,
    })
    if (frame.length > MAX_CLIENT_FRAME_BYTES) {
      throw new Error('Terminal broker request exceeds the IPC limit')
    }
    socket.write(`${frame}\n`)
    return descriptor
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
        // A wrong proof is different: the port no longer belongs to our
        // broker, so its descriptor is not a trusted owner any more.
        if (error instanceof UntrustedBrokerError) {
          this.removeDescriptorIfMatches(descriptor)
        } else {
          this.removeDescriptorIfMatchesAndStopped(descriptor)
        }
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
    this.retireLegacyDescriptor()
    const existing = this.readDescriptor()
    if (existing) {
      try {
        return await this.connect(existing, generation)
      } catch (error) {
        if (
          isConnectionRefusedError(error) ||
          error instanceof UntrustedBrokerError
        ) {
          this.removeDescriptorIfMatches(existing)
        } else {
          this.removeDescriptorIfMatchesAndStopped(existing)
        }
      }
    }

    const candidates = await this.resolveNodeCandidates()
    if (generation !== this.transportGeneration) {
      throw new Error('Terminal broker connection was superseded')
    }
    if (candidates.length === 0) {
      throw new TerminalBrokerStartError('node-not-found', NODE_NOT_FOUND_MESSAGE)
    }
    const launchFailures: string[] = []
    let allMissing = true
    for (const nodePath of candidates) {
      const launch = this.spawnBroker(nodePath)
      const deadline =
        Date.now() + (this.options.startupTimeoutMs ?? BROKER_STARTUP_TIMEOUT_MS)
      let lastError: unknown = new TerminalBrokerStartError(
        'broker-start-failed',
        'Terminal broker did not start',
      )
      while (Date.now() < deadline) {
        await wait(BROKER_RETRY_MS)
        if (generation !== this.transportGeneration) {
          throw new Error('Terminal broker connection was superseded')
        }
        const descriptor = this.readDescriptor()
        if (descriptor) {
          try {
            return await this.connect(descriptor, generation)
          } catch (error) {
            lastError = error
          }
          continue
        }
        // A Node.js that cannot even start (ENOENT, a broken shim, too old
        // for the program) fails within moments; try the next one instead of
        // spending the whole startup window on it.
        if (launch.failure !== null) break
      }
      if (launch.failure === null) throw lastError
      if (!launch.failure.missing) allMissing = false
      launchFailures.push(`${nodePath}: ${launch.failure.detail}`)
      this.options.log?.(
        'warn',
        '[TerminalBroker] Broker failed to start with this Node.js',
        nodePath,
        launch.failure.detail,
      )
    }
    throw allMissing
      ? new TerminalBrokerStartError('node-not-found', NODE_NOT_FOUND_MESSAGE)
      : new TerminalBrokerStartError(
        'broker-start-failed',
        `Terminal broker could not start (${launchFailures.join('; ')})`,
      )
  }

  /**
   * Node.js executables to start the broker with. When nothing is found with
   * the PATH at hand, wait (bounded) for the login shell's PATH and look again
   * — a Dock-launched Obsidian has no node on its own PATH, and version
   * managers such as nvm only appear in the login shell's.
   */
  private async resolveNodeCandidates(): Promise<string[]> {
    const locate = (env: Record<string, string | undefined>): string[] =>
      this.options.locateNode?.(env) ?? locateNodeOnDisk(env)
    const currentEnv = (): Record<string, string | undefined> =>
      this.options.getEnv?.() ?? { ...process.env }
    const found = locate(currentEnv())
    if (found.length > 0 || !this.options.prepareEnv) return found
    let timer: StableTimeoutId | null = null
    try {
      await Promise.race([
        this.options.prepareEnv(),
        new Promise<void>((resolve) => {
          timer = stableTimeoutSource.setTimeout(
            resolve,
            this.options.prepareEnvTimeoutMs ?? BROKER_PREPARE_ENV_TIMEOUT_MS,
          )
        }),
      ])
    } catch (error) {
      this.options.log?.('warn', '[TerminalBroker] Login shell PATH unavailable', error)
    } finally {
      if (timer !== null) stableTimeoutSource.clearTimeout(timer)
    }
    return locate(currentEnv())
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
      challengeBroker(socket, descriptor.token, loadCrypto(), {
        deadlineMs:
          this.options.connectTimeoutMs ?? BROKER_CONNECT_TIMEOUT_MS,
        timers: stableTimeoutSource,
        verified: () => {
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
        },
        data: (chunk) => {
          if (this.socket === socket) this.handleData(chunk)
        },
        rejected: fail,
      })
      socket.on('timeout', () => fail(new Error('Terminal broker connection timed out')))
      socket.on('error', fail)
      socket.on('close', () =>
        fail(new Error('Terminal broker closed the connection before proving itself')),
      )
    })
  }

  private bindSocket(socket: NodeSocketLike): void {
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
      case 'attached': {
        this.clearSessionAck(sessionId)
        const record = this.sessionRecord(sessionId)
        if (
          typeof message.pid === 'number' &&
          Number.isInteger(message.pid) &&
          message.pid > 0
        ) {
          record.pid = message.pid
        }
        // The connection is back. Input typed while it was down never
        // arrived: say so once, then let a later outage report again.
        if (record.inputLost) this.notifyInputDropped(sessionId, callbacks)
        record.inputDropNotified = false
        callbacks.onAttached?.(message.pid, message.transcriptPath)
        if (message.replay.length > 0) callbacks.onData(message.replay)
        if (message.status === 'completed') {
          this.callbacks.delete(sessionId)
          this.forgetSession(sessionId)
          if (message.outcome) callbacks.onExit(message.outcome)
          else callbacks.onUnavailable?.()
          this.detachIfNoSessions()
        }
        break
      }
      case 'data':
        callbacks.onData(message.data)
        break
      case 'exit':
        this.clearSessionAck(sessionId)
        this.callbacks.delete(sessionId)
        this.forgetSession(sessionId)
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
        this.forgetSession(sessionId)
        callbacks.onUnavailable?.()
        this.detachIfNoSessions()
        break
      case 'error':
        this.clearSessionAck(sessionId)
        this.callbacks.delete(sessionId)
        this.forgetSession(sessionId)
        callbacks.onExit({
          status: 'failed',
          exitCode: null,
          signal: null,
          errorMessage: message.message,
          terminalFailure: 'broker-refused',
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

  /**
   * A broker from before LEV-391 cannot prove it holds its token, so nothing is
   * ever sent to it. Clear its descriptor so a fresh broker can claim the path.
   * The old broker is not signalled: its pid may have been reused, and with no
   * clients left it stops itself, and its sessions, after its idle TTL.
   */
  private retireLegacyDescriptor(): void {
    try {
      const fs = loadFs()
      const before = fs.lstatSync(this.descriptorPath)
      if (!isTrustedDescriptorFile(before)) return
      const parsed = JSON.parse(fs.readFileSync(this.descriptorPath, 'utf8')) as unknown
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        (parsed as { version?: unknown }).version !== LEGACY_BROKER_VERSION
      ) {
        return
      }
      const after = fs.lstatSync(this.descriptorPath)
      if (before.dev !== after.dev || before.ino !== after.ino) return
      fs.unlinkSync(this.descriptorPath)
      this.options.log?.(
        'warn',
        '[TerminalBroker] Retired a broker that cannot prove its token; starting a new one',
      )
    } catch {
      // No descriptor, or it changed underneath us: nothing to retire.
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

  /**
   * Start a broker with one Node.js. The returned record turns non-null once
   * that Node.js has proven unable to run it: a spawn error, or an exit before
   * any descriptor appeared (except losing the descriptor race to a broker
   * another renderer started, which leaves a usable descriptor behind).
   */
  private spawnBroker(nodePath: string): {
    failure: { missing: boolean; detail: string } | null
  } {
    const launch: { failure: { missing: boolean; detail: string } | null } = {
      failure: null,
    }
    const token = loadCrypto().randomBytes(32).toString('hex')
    const env = this.options.getEnv?.() ?? { ...process.env }
    let child: NodeChildProcessLike
    try {
      child = loadChildProcess().spawn(
        nodePath,
        ['-e', buildTerminalBrokerSource()],
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
    } catch (error) {
      launch.failure = {
        missing: errorCode(error) === 'ENOENT',
        detail: describeError(error),
      }
      return launch
    }
    child.on('error', (error) => {
      this.options.log?.('warn', '[TerminalBroker] Spawn failed', error)
      launch.failure ??= {
        missing: errorCode(error) === 'ENOENT',
        detail: describeError(error),
      }
    })
    child.on('exit', (code, signal) => {
      if (code === BROKER_EXIT_DESCRIPTOR_TAKEN) return
      launch.failure ??= {
        missing: false,
        detail:
          code === null
            ? `exited on signal ${signal ?? 'unknown'}`
            : `exited with code ${String(code)}`,
      }
    })
    child.unref()
    return launch
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

  /**
   * send() rejects only before it writes the frame (startup, connect, or the
   * frame-size check), so a rejected spawn provably created no process: fail
   * it at once with the reason. Routing it through unavailable-session
   * recovery instead made a missing Node.js look like a session to confirm.
   */
  private failUnsentSpawn(
    sessionId: string,
    epoch: number,
    error: unknown,
  ): void {
    const pending = this.pendingSessionAcks.get(sessionId)
    if (!pending || pending.epoch !== epoch) return
    this.clearSessionAck(sessionId)
    const callbacks = this.callbacks.get(sessionId)
    if (!callbacks) return
    this.callbacks.delete(sessionId)
    this.forgetSession(sessionId)
    this.options.log?.('warn', '[TerminalBroker] Spawn handshake failed', error)
    callbacks.onExit({
      status: 'failed',
      exitCode: null,
      signal: null,
      errorMessage: describeError(error),
      terminalFailure: terminalFailureOf(error),
    })
    this.detachIfNoSessions()
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
      this.sessionRecords.get(sessionId)?.descriptor ??
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
      this.forgetSession(sessionId)
      if (operation === 'spawn') {
        callbacks.onExit({
          status: 'failed',
          exitCode: null,
          signal: null,
          errorMessage: describeError(error),
          terminalFailure: terminalFailureOf(error),
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
      this.sessionRecords.get(sessionId)?.descriptor ??
      this.lastAuthenticatedDescriptor ??
      this.descriptor ??
      this.readDescriptor()
    if (descriptor) {
      this.terminateUnavailableSessions(descriptor, [[sessionId, callbacks]])
      return
    }
    this.forgetSession(sessionId)
    this.options.log?.(
      'warn',
      '[TerminalBroker] Stop could not reach an existing session',
      error,
    )
    callbacks.onUnavailable?.()
    this.detachIfNoSessions()
  }

  private detachIfNoSessions(): void {
    // detach() abandons pending terminations without notifying anyone, which
    // would leave their runs "running" forever. Wait until they settle.
    if (
      this.callbacks.size === 0 &&
      this.unavailableSessions.size === 0
    ) {
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
   * Recovery is strictly per session and per broker. Each pending session
   * remembers the broker its frames were written to, and only a
   * session-scoped terminate-unavailable is ever sent to it. There is no
   * broker-wide fallback any more: an authenticated `shutdown` kills every
   * group the broker owns, so it took down healthy terminals opened beside
   * the stuck one, and when the broker was frozen the queued frame did it
   * later, on resume, to sessions started after this one was given up.
   * Every released broker (2.1.0 onward) implements terminate-unavailable,
   * which is what the fallback existed to work around.
   */
  private terminateUnavailableSessions(
    descriptor: BrokerDescriptor | null,
    sessions: Array<[string, TerminalBrokerSessionCallbacks]>,
  ): void {
    if (sessions.length === 0) return
    for (const [sessionId, callbacks] of sessions) {
      const existing = this.unavailableSessions.get(sessionId)
      if (existing) {
        existing.callbacks = callbacks
        continue
      }
      this.unavailableSessions.set(sessionId, {
        callbacks,
        descriptor:
          this.sessionRecords.get(sessionId)?.descriptor ?? descriptor,
        since: this.monotonicNow(),
        attempts: 0,
      })
      try {
        callbacks.onConnectionLost?.()
      } catch (error) {
        this.options.log?.(
          'warn',
          '[TerminalBroker] Connection-lost callback failed',
          error,
        )
      }
      // Keystrokes typed while the transport was reconnecting are lost for
      // good once the session is written off; say so now.
      if (this.sessionRecords.get(sessionId)?.inputLost) {
        this.notifyInputDropped(sessionId, callbacks)
      }
    }
    this.scheduleUnavailableRecovery(true)
  }

  private monotonicNow(): number {
    return this.options.monotonicNow?.() ?? window.performance.now()
  }

  private scheduleUnavailableRecovery(immediate: boolean): void {
    if (
      this.closing ||
      this.unavailableSessions.size === 0 ||
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
        if (!this.closing && this.unavailableSessions.size > 0) {
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
      this.unavailableSessions.size === 0
    ) {
      return
    }
    // A session written off before any broker was known (no descriptor at
    // the time) is addressed to whichever broker is known now; it answers
    // 'missing' for a session it never had, which settles it.
    const fallback =
      this.lastAuthenticatedDescriptor ??
      this.descriptor ??
      this.readDescriptor()
    for (const pending of this.unavailableSessions.values()) {
      if (!pending.descriptor && fallback) pending.descriptor = fallback
    }
    const sessions = Array.from(this.unavailableSessions.entries())
    const results = new Map<string, UnavailableTerminationResult>()
    for (const group of this.groupByOwningBroker(sessions)) {
      if (!group.descriptor) continue
      this.queueTerminationOnTransport(group.descriptor, group.sessions)
      try {
        await this.requestUnavailableTermination(
          group.descriptor,
          group.sessions.map(([sessionId]) => sessionId),
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
          group.sessions.every(([sessionId]) =>
            this.explicitlyStoppedSessionIds.has(sessionId)) &&
          this.removeDescriptorIfMatches(group.descriptor)
        ) {
          // A broker writes its descriptor only after listen() succeeds.
          // Therefore a refused descriptor plus an explicit user stop means
          // this is stale (possibly a reused live PID), not a process we may
          // signal. Remove only the matching descriptor and reconcile the UI;
          // never kill descriptor.pid.
          for (const [sessionId, pending] of group.sessions) {
            this.settleUnavailableSession(sessionId, pending)
          }
        }
      }
      if (
        this.closing ||
        generation !== this.unavailableRecoveryGeneration
      ) {
        return
      }
    }
    for (const [sessionId, pending] of sessions) {
      if (
        this.closing ||
        generation !== this.unavailableRecoveryGeneration
      ) {
        return
      }
      if (this.unavailableSessions.get(sessionId) !== pending) continue
      const result = results.get(sessionId)
      // A result is an individual broker acknowledgement. Without one, only
      // proof that the session's own broker is gone confirms the process is
      // gone; otherwise leave the record active instead of falsely
      // repainting it as interrupted while an unattended CLI may be alive.
      if (result !== undefined || this.isUnavailableSessionConfirmedGone(sessionId, pending)) {
        this.settleUnavailableSession(sessionId, pending, result)
      }
    }

    const remaining = sessions.filter(
      ([sessionId, pending]) => this.unavailableSessions.get(sessionId) === pending,
    )
    if (
      !this.closing &&
      generation === this.unavailableRecoveryGeneration &&
      remaining.length > 0
    ) {
      for (const [, pending] of remaining) pending.attempts += 1
      const expired = this.expiredUnavailableSessions(remaining)
      if (expired.length > 0) {
        this.giveUpUnavailableSessions(expired)
      }
      if (expired.length < remaining.length) {
        this.options.log?.(
          'warn',
          '[TerminalBroker] Session termination remains unconfirmed; retrying with backoff',
          remaining
            .filter((entry) => !expired.includes(entry))
            .map(([sessionId]) => sessionId),
        )
      }
    }

    if (this.unavailableSessions.size === 0) {
      this.unavailableRecoveryAttempt = 0
      this.lastAuthenticatedDescriptor = null
      if (
        !this.closing &&
        generation === this.unavailableRecoveryGeneration
      ) {
        this.detachIfNoSessions()
      }
    }
  }

  /**
   * Also queue the termination on the data transport, once, when that socket
   * is open to the same broker. It already proved itself, so the token is safe
   * on it. A frozen (SIGSTOPped) broker cannot answer the control channel's
   * proof challenge, so the control channel never gets as far as sending the
   * termination; the frame queued here is what the broker reads on resume,
   * after the spawn it may still be holding. Its reply is not a confirmation:
   * confirmation still comes from the control channel or a dead broker.
   */
  private queueTerminationOnTransport(
    descriptor: BrokerDescriptor,
    sessions: Array<[string, UnavailableSession]>,
  ): void {
    const socket = this.socket
    if (!socket || socket.destroyed || !descriptorsEqual(this.descriptor, descriptor)) {
      return
    }
    for (const [sessionId, pending] of sessions) {
      if (pending.queuedOnTransport) continue
      pending.queuedOnTransport = true
      const frame: BrokerClientMessage = {
        token: descriptor.token,
        rendererLeaseToken: this.rendererLeaseToken,
        rendererLeaseOwnerId: this.rendererLeaseOwnerId,
        rendererLeaseGeneration: this.rendererLeaseGeneration,
        op: 'terminate-unavailable',
        sessionId,
      }
      socket.write(`${JSON.stringify(frame)}\n`)
    }
  }

  /** Pending sessions grouped by the broker that owns them. */
  private groupByOwningBroker(
    sessions: Array<[string, UnavailableSession]>,
  ): Array<{
    descriptor: BrokerDescriptor | null
    sessions: Array<[string, UnavailableSession]>
  }> {
    const groups = new Map<string, {
      descriptor: BrokerDescriptor | null
      sessions: Array<[string, UnavailableSession]>
    }>()
    for (const entry of sessions) {
      const descriptor = entry[1].descriptor
      const key = descriptor
        ? `${String(descriptor.pid)}:${String(descriptor.port)}:${descriptor.token}`
        : ''
      const group = groups.get(key) ?? { descriptor, sessions: [] }
      group.sessions.push(entry)
      groups.set(key, group)
    }
    return Array.from(groups.values())
  }

  /**
   * Past the window, measured on a clock that stops while the Mac sleeps,
   * and only after enough real attempts. Wall-clock time would count the
   * night and write a session off on the first attempt after wake — which is
   * exactly when its broker is most likely to answer again.
   */
  private expiredUnavailableSessions(
    sessions: Array<[string, UnavailableSession]>,
  ): Array<[string, UnavailableSession]> {
    const giveUpMs =
      this.options.unavailableConfirmationGiveUpMs ??
      BROKER_UNAVAILABLE_CONFIRMATION_GIVE_UP_MS
    const minAttempts =
      this.options.unavailableConfirmationMinAttempts ??
      BROKER_UNAVAILABLE_CONFIRMATION_MIN_ATTEMPTS
    const now = this.monotonicNow()
    return sessions.filter(([, pending]) =>
      pending.attempts >= minAttempts && now - pending.since >= giveUpMs,
    )
  }

  /**
   * Stop confirming and report the sessions unavailable. Whatever kept the
   * broker from answering (a frozen process, a lost socket) has outlasted the
   * window; the alternative was a terminal that looked alive but swallowed
   * every keystroke, and no new terminal until a reload.
   *
   * Its termination is still unconfirmed: a frozen broker answers no proof,
   * and nothing is sent before the proof; a frame that did reach it may be
   * refused under a lease that is no longer current. So it is retried in the
   * background, across renderer reloads, until the broker confirms it or is
   * gone; see cleanUpOrphanedSessions.
   */
  private giveUpUnavailableSessions(
    sessions: Array<[string, UnavailableSession]>,
  ): void {
    this.options.log?.(
      'warn',
      '[TerminalBroker] Gave up confirming session termination; reporting it unavailable',
      sessions.map(([sessionId]) => sessionId),
    )
    const added: Array<{ sessionId: string; pid: number; port: number }> = []
    for (const [sessionId, pending] of sessions) {
      if (pending.descriptor) {
        this.orphanedSessions.set(sessionId, pending.descriptor)
        added.push({ sessionId, pid: pending.descriptor.pid, port: pending.descriptor.port })
      }
      this.settleUnavailableSession(sessionId, pending)
    }
    this.persistOrphanChange({ add: added })
    this.scheduleOrphanCleanup()
  }

  /**
   * Pick up saved retries: at construction, those a previous renderer left;
   * later, those another client in this renderer just saved. Only on the
   * first pass are records of an unreachable broker dropped from the file.
   */
  private adoptSavedOrphans(dropUnreachable: boolean): void {
    if (this.closing) return
    try {
      const fs = loadFs()
      const records = readOrphans(
        fs,
        orphanStorePath(this.descriptorPath),
        isTrustedDescriptorFile,
      )
      if (records.length === 0) return
      // Only the broker in the descriptor can be authenticated.
      const current = this.readDescriptor()
      const unreachable: string[] = []
      for (const record of records) {
        if (this.orphanedSessions.has(record.sessionId)) continue
        if (current && current.pid === record.pid && current.port === record.port) {
          this.orphanedSessions.set(record.sessionId, current)
        } else {
          unreachable.push(record.sessionId)
        }
      }
      if (dropUnreachable && unreachable.length > 0) {
        this.persistOrphanChange({ remove: unreachable })
      }
      this.scheduleOrphanCleanup()
    } catch (error) {
      this.options.log?.('warn', '[TerminalBroker] Could not restore pending terminations', error)
    }
  }

  /** Save only this client's change; another client's records stay. */
  private persistOrphanChange(change: OrphanChange): void {
    try {
      updateOrphans(
        loadFs(),
        orphanStorePath(this.descriptorPath),
        isTrustedDescriptorFile,
        change,
      )
      if ((change.add?.length ?? 0) > 0) {
        window.dispatchEvent(
          new CustomEvent(ORPHANS_SAVED_EVENT, { detail: this.descriptorPath }),
        )
      }
    } catch (error) {
      this.options.log?.('warn', '[TerminalBroker] Could not save pending terminations', error)
    }
  }

  private scheduleOrphanCleanup(): void {
    if (
      this.closing ||
      this.orphanedSessions.size === 0 ||
      this.orphanCleanupTimer !== null ||
      this.orphanCleanupRunning
    ) {
      return
    }
    this.orphanCleanupTimer = stableTimeoutSource.setTimeout(
      () => {
        this.orphanCleanupTimer = null
        void this.cleanUpOrphanedSessions()
      },
      this.options.orphanCleanupIntervalMs ?? BROKER_ORPHAN_CLEANUP_INTERVAL_MS,
    )
  }

  /**
   * Only shutdown stops it. detach() runs whenever the last session settles,
   * which is exactly when orphans are left, and a hot reload keeps this client.
   * The saved list stays: a broker that outlived a failed shutdown may still
   * hold the sessions, and the next client drops records of a gone broker.
   */
  private stopOrphanCleanup(): void {
    try {
      window.removeEventListener(ORPHANS_SAVED_EVENT, this.onOrphansSaved)
    } catch {
      // No window.
    }
    if (this.orphanCleanupTimer !== null) {
      stableTimeoutSource.clearTimeout(this.orphanCleanupTimer)
      this.orphanCleanupTimer = null
    }
    this.orphanedSessions.clear()
  }

  /**
   * Retry the termination of sessions given up on. A session leaves the list
   * once its broker answers for it (terminated, or missing), or once that
   * broker is gone: dead with its descriptor gone, refusing its port, or
   * replaced on it by someone who cannot prove itself (a broker holds its
   * port until it exits). A dead broker's guards and owner watchdog reap its
   * sessions. Its UI was settled when it was given up.
   *
   * Each round first activates this renderer's lease. A broker frozen through
   * a reload still holds the previous renderer's lease and refuses this one's
   * termination until it is activated; activation is the ordinary adoption
   * barrier, so a stale renderer still cannot take over. It keeps any exit
   * grace already armed: the window may be closing, and a retry is not a
   * renderer adopting the sessions.
   */
  private async cleanUpOrphanedSessions(): Promise<void> {
    if (this.closing || this.orphanedSessions.size === 0) return
    this.orphanCleanupRunning = true
    const settled: string[] = []
    try {
      const groups = new Map<string, { descriptor: BrokerDescriptor; ids: string[] }>()
      for (const [sessionId, descriptor] of this.orphanedSessions) {
        const key = `${String(descriptor.pid)}:${String(descriptor.port)}:${descriptor.token}`
        const group = groups.get(key) ?? { descriptor, ids: [] }
        group.ids.push(sessionId)
        groups.set(key, group)
      }
      for (const { descriptor, ids } of groups.values()) {
        if (this.closing) return
        const forget = (sessionIds: string[]): void => {
          for (const sessionId of sessionIds) {
            if (this.orphanedSessions.get(sessionId) === descriptor) {
              this.orphanedSessions.delete(sessionId)
              settled.push(sessionId)
            }
          }
        }
        if (
          this.isProcessAlive(descriptor.pid) === false &&
          !descriptorsEqual(this.readDescriptor(), descriptor)
        ) {
          forget(ids)
          continue
        }
        const results = new Map<string, UnavailableTerminationResult>()
        try {
          await this.requestAuthenticatedDeferredShutdown(
            descriptor,
            // The window may be closing: its exit grace stands.
            { op: 'activate-renderer-lease', keepShutdown: true },
            'renderer-lease-activated',
            this.captureRendererLeaseIdentity(),
            this.options.deferredShutdownTimeoutMs ??
              BROKER_DEFERRED_SHUTDOWN_TIMEOUT_MS,
          )
          await this.requestUnavailableTermination(descriptor, ids, results)
        } catch (error) {
          if (error instanceof UntrustedBrokerError || isConnectionRefusedError(error)) {
            forget(ids)
          }
        }
        // Answers that came in before a timeout still count.
        forget(Array.from(results.keys()))
      }
    } finally {
      this.orphanCleanupRunning = false
      if (settled.length > 0) this.persistOrphanChange({ remove: settled })
      this.scheduleOrphanCleanup()
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
    this.unavailableSessions.clear()
    this.unavailableRecoveryAttempt = 0
  }

  private invalidateUnavailableRecoverySchedule(): void {
    this.invalidateUnavailableRecovery(false)
  }

  private settleUnavailableSession(
    sessionId: string,
    pending: UnavailableSession,
    result?: UnavailableTerminationResult,
  ): void {
    if (this.unavailableSessions.get(sessionId) !== pending) return
    this.unavailableSessions.delete(sessionId)
    this.forgetSession(sessionId)
    const callbacks = pending.callbacks
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

  /**
   * Whether a pending session is provably gone without a broker answer: its
   * own broker is dead and has lost its descriptor (its guards reap their
   * targets when the broker pipe closes, and the owner watchdog reaps the
   * rest), and, when the broker ever reported one, the session pid is dead
   * too. A pid that never arrived (the session died before 'attached') is
   * covered by the first condition. Another broker's death proves nothing.
   */
  private isUnavailableSessionConfirmedGone(
    sessionId: string,
    pending: UnavailableSession,
  ): boolean {
    const descriptor = pending.descriptor
    if (descriptor) {
      if (this.isProcessAlive(descriptor.pid) !== false) return false
      if (descriptorsEqual(this.readDescriptor(), descriptor)) return false
    }
    const pid = this.sessionRecords.get(sessionId)?.pid
    if (pid !== undefined) return this.isProcessAlive(pid) === false
    return descriptor !== null || this.readDescriptor() === null
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
      challengeBroker(socket, descriptor.token, loadCrypto(), {
        deadlineMs:
          this.options.unavailableTerminationTimeoutMs ??
            BROKER_UNAVAILABLE_TERMINATION_TIMEOUT_MS,
        timers: stableTimeoutSource,
        verified: () => {
          for (const sessionId of sessionIds) {
            const frame: BrokerClientMessage = {
              token: descriptor.token,
              rendererLeaseToken: this.rendererLeaseToken,
              rendererLeaseOwnerId: this.rendererLeaseOwnerId,
              rendererLeaseGeneration: this.rendererLeaseGeneration,
              op: 'terminate-unavailable',
              sessionId,
            }
            socket.write(`${JSON.stringify(frame)}\n`)
          }
        },
        data: (chunk) => {
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
        },
        rejected: fail,
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
      challengeBroker(socket, descriptor.token, loadCrypto(), {
        deadlineMs: timeoutMs,
        timers: stableTimeoutSource,
        verified: () => {
          const frame: BrokerClientMessage = {
            token: descriptor.token,
            rendererLeaseToken: this.rendererLeaseToken,
            rendererLeaseOwnerId: this.rendererLeaseOwnerId,
            rendererLeaseGeneration: this.rendererLeaseGeneration,
            op: 'shutdown',
          }
          socket.write(`${JSON.stringify(frame)}\n`)
        },
        data: (chunk) => {
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
        },
        rejected: fail,
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

  private requestAuthenticatedDeferredShutdown(
    descriptor: BrokerDescriptor,
    command:
      | { op: 'schedule-shutdown'; graceMs: number }
      | { op: 'cancel-deferred-shutdown' }
      | { op: 'activate-renderer-lease'; keepShutdown?: true },
    expectedResponse:
      | 'shutdown-scheduled'
      | 'shutdown-canceled'
      | 'renderer-lease-activated',
    rendererLeaseIdentity: RendererLeaseIdentity,
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
        () => fail(new Error('Terminal broker deferred shutdown timed out')),
      )
      challengeBroker(socket, descriptor.token, loadCrypto(), {
        deadlineMs: timeoutMs,
        timers: stableTimeoutSource,
        verified: () => {
          const frame: BrokerClientMessage = {
            token: descriptor.token,
            rendererLeaseToken: rendererLeaseIdentity.token,
            rendererLeaseOwnerId: rendererLeaseIdentity.ownerId,
            rendererLeaseGeneration: rendererLeaseIdentity.generation,
            ...command,
          }
          socket.write(`${JSON.stringify(frame)}\n`)
        },
        data: (chunk) => {
          receiveBuffer += chunk
          if (receiveBuffer.length > MAX_CLIENT_FRAME_BYTES) {
            fail(
              new Error(
                'Terminal broker deferred shutdown response exceeds the IPC limit',
              ),
            )
            return
          }
          let newline = receiveBuffer.indexOf('\n')
          while (newline >= 0 && !settled) {
            const line = receiveBuffer.slice(0, newline)
            receiveBuffer = receiveBuffer.slice(newline + 1)
            if (line.length > 0) {
              try {
                const message = JSON.parse(line) as BrokerServerMessage
                if (message.type === expectedResponse) {
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
        },
        rejected: fail,
      })
      socket.on('timeout', () =>
        fail(new Error('Terminal broker deferred shutdown timed out')),
      )
      socket.on('error', fail)
      socket.on('close', () => {
        if (!settled) {
          fail(
            new Error(
              'Terminal broker deferred shutdown connection closed early',
            ),
          )
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
            rendererLeaseToken: this.rendererLeaseToken,
            rendererLeaseOwnerId: this.rendererLeaseOwnerId,
            rendererLeaseGeneration: this.rendererLeaseGeneration,
            op: 'attach',
            sessionId,
          }
          const ackEpoch = this.prepareSessionAck(sessionId, 'attach')
          try {
            socket.write(`${JSON.stringify(frame)}\n`)
            this.sessionRecord(sessionId).descriptor = descriptor
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
