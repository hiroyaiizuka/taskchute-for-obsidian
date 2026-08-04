/**
 * AI Task - Node process gateway
 *
 * THE ONLY Node.js boundary of the AI Task feature (and of src/). Every other
 * module depends on the ProcessGateway interface so tests and future runtimes
 * can substitute fakes. Node access is desktop-only, guarded upstream by
 * `Platform?.isDesktop`, and uses a require-based dynamic lookup; the src
 * build has no Node type definitions, so minimal ambient declarations below
 * describe just the surface this file touches.
 */

import {
  MAX_WORKSPACE_FILE_BYTES,
  WorkspaceFileVersionConflictError,
  type WorkspaceFileDocument,
  type WorkspaceFileVersion,
  WorkspaceDirectoryListing,
  WorkspaceEntry,
  WorkspaceFileGateway,
} from './WorkspaceFileService'
import { stableTimeoutSource } from '../../../utils/stableTimer'

// Ambient declarations for the Electron renderer runtime (no @types/node in
// the src build). These shadow nothing at runtime; they only inform tsc.
declare function require(moduleId: string): unknown

declare const process: {
  env: Record<string, string | undefined>
  execPath?: string
  platform?: string
  kill?(pid: number, signal?: string): boolean
  on?(event: 'exit', listener: () => void): void
  removeListener?(event: 'exit', listener: () => void): void
}

/** Signals the AI Task feature is allowed to send */
export type NodeKillSignal = 'SIGTERM' | 'SIGKILL' | 'SIGINT'

/**
 * stdin wiring for a spawned child: 'ignore' (default) hands it /dev/null so
 * headless CLIs never wait on input; 'pipe' keeps a parent-held pipe open and
 * exposes writeStdin on the handle (terminal sessions).
 */
export type StdinMode = 'pipe' | 'ignore'

export interface SpawnProcessRequest {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  stdinMode?: StdinMode
}

export interface ProcessLaunchError {
  /** Node/libuv or Windows error code, e.g. ENOENT, EACCES, EPERM. */
  code?: string
  message: string
}

export interface SpawnedProcessHandle {
  pid?: number
  onStdout(callback: (text: string) => void): void
  onStderr(callback: (text: string) => void): void
  onExit(callback: (code: number | null, signal: string | null) => void): void
  /** Emitted only when the requested process could not be launched. */
  onLaunchError?(callback: (error: ProcessLaunchError) => void): void
  kill(signal: NodeKillSignal): void
  /**
   * Write utf8 data to the child's stdin. Present ONLY when the process was
   * spawned with stdinMode 'pipe'; a safe no-op once the child has exited.
   */
  writeStdin?(data: string): void
}

export interface ExecCaptureResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Inputs for wrapping a binary in a platform PTY (`script`) invocation */
export interface PtyCommandRequest {
  binaryPath: string
  args: string[]
  rows: number
  cols: number
  /** File the PTY session transcript is recorded to */
  transcriptPath: string
}

/** A spawnable command + argv produced by buildPtyCommand */
export interface PtyCommand {
  command: string
  args: string[]
}

/** Thrown by buildPtyCommand on platforms without a `script` PTY wrapper */
export class TerminalUnsupportedError extends Error {
  readonly platform: string

  constructor(platform: string) {
    super(`Terminal mode is not supported on ${platform}`)
    this.name = 'TerminalUnsupportedError'
    this.platform = platform
  }
}

/**
 * Marker the PTY wrapper prints to STDERR (followed by the child's exit
 * code) just before it force-kills its own process group. Needed because:
 * (1) `script` refuses a socketpair stdin (Node's 'pipe' stdio) with
 * "tcgetattr: Operation not supported on socket", so a `cat |` stage
 * interposes a REAL pipe; (2) `cat` never sees EOF while the plugin holds
 * stdin open, so after `script` exits the wrapper must `kill -9 0` to reap
 * the pipeline - which destroys the shell's exit status; the sentinel
 * carries the child's real code out on the (wrapper-only) stderr channel.
 * Verified on-device: macOS `script -q -F` + this wrapper propagates exit
 * codes, records the transcript, and survives SIGTERM group stops.
 */
export const TERMINAL_EXIT_SENTINEL = '__TASKCHUTE_AI_EXIT__'

/**
 * Upper bound on the transcript bytes readAndDeleteFile loads into memory.
 * TUI redraws can grow a PTY transcript to hundreds of MB; only the tail is
 * ever useful (the log note is capped further downstream), so an oversized
 * file is read from the end instead of being slurped into the renderer heap.
 */
export const MAX_TRANSCRIPT_READ_BYTES = 8 * 1024 * 1024

/** Line prepended when readAndDeleteFile keeps only the transcript tail */
export const TRANSCRIPT_TRUNCATED_MARKER =
  '[transcript truncated: earlier output was dropped]'

export interface ProcessGateway {
  spawnProcess(request: SpawnProcessRequest): SpawnedProcessHandle
  execCapture(command: string, args: string[], timeoutMs: number): Promise<ExecCaptureResult>
  getBaseEnv(): Record<string, string | undefined>
  getShellPath(): string
  /**
   * Capture the user's login-shell PATH once (cached; never rejects) so
   * getBaseEnv can merge it in. GUI-launched Obsidian on macOS inherits a
   * minimal PATH (/usr/bin:/bin:...), which would make `env node` shebangs
   * and in-run agent tools (git, npm, rg) unresolvable in child processes.
   */
  primeLoginShellPath(): Promise<void>
  /**
   * Capture the login-shell PATH again. Concurrent refreshes are coalesced;
   * a failed capture preserves the last successful value.
   */
  refreshLoginShellPath?(): Promise<void>
  /** Whether buildPtyCommand can produce a PTY wrapper on this platform */
  isPtySupported(): boolean
  /**
   * Wrap a binary invocation in the OS `script` utility so the child gets a
   * real TTY (interactive TUIs render and accept input). Throws a typed
   * TerminalUnsupportedError where no wrapper exists (win32).
   */
  buildPtyCommand(request: PtyCommandRequest): PtyCommand
  /** Best-effort resize of a live `script` PTY; false while its tty is unavailable */
  resizePty(transcriptPath: string, cols: number, rows: number): boolean
  /** Unique writable path in the OS temp directory (Node boundary helper) */
  makeTempFilePath(prefix: string): string
  /** Read a temp file as utf8 and delete it (best-effort delete) */
  readAndDeleteFile(path: string): Promise<string>
}

// --- Minimal structural types for the Node modules this file touches -------

interface NodeReadableLike {
  on(event: 'data', listener: (chunk: unknown) => void): void
  setEncoding(encoding: string): void
}

interface NodeWritableLike {
  write(data: string): boolean
  on(event: 'error', listener: (error: unknown) => void): void
}

interface NodeChildProcessLike {
  pid?: number
  stdin: NodeWritableLike | null
  stdout: NodeReadableLike | null
  stderr: NodeReadableLike | null
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): void
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void
  on(event: 'error', listener: (error: unknown) => void): void
  kill(signal?: string): boolean
}

interface ChildProcessModuleLike {
  spawn(
    command: string,
    args: string[],
    options: {
      cwd?: string
      env?: Record<string, string | undefined>
      detached?: boolean
      windowsHide?: boolean
      stdio?: ['ignore' | 'pipe', 'pipe', 'pipe']
    },
  ): NodeChildProcessLike
  execFileSync?(
    command: string,
    args: string[],
    options: {
      encoding: 'utf8'
      maxBuffer?: number
      windowsHide?: boolean
    },
  ): string
}

interface OsModuleLike {
  tmpdir(): string
}

interface FsModuleLike {
  readFileSync(path: string, encoding: 'utf8'): string
  promises: {
    readFile(path: string): Promise<Uint8Array>
    readFile(path: string, encoding: string): Promise<string>
    readdir(
      path: string,
      options: { withFileTypes: true },
    ): Promise<NodeDirectoryEntryLike[]>
    realpath(path: string): Promise<string>
    stat(path: string): Promise<NodeStatsLike>
    open(path: string, flags: 'r' | 'r+'): Promise<NodeFileHandleLike>
    unlink(path: string): Promise<void>
  }
}

interface NodeFileHandleLike {
  stat(): Promise<NodeStatsLike>
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>
  writeFile(data: Uint8Array): Promise<void>
  truncate(length: number): Promise<void>
  close(): Promise<void>
}

interface NodeDirectoryEntryLike {
  name: string
}

interface NodeStatsLike {
  mtimeMs: number
  size: number
  isDirectory(): boolean
  isFile(): boolean
}

interface PathModuleLike {
  sep: string
  isAbsolute(path: string): boolean
  join(...paths: string[]): string
  relative(from: string, to: string): string
  resolve(...paths: string[]): string
}

interface TextCodecModuleLike {
  TextDecoder: typeof TextDecoder
  TextEncoder: typeof TextEncoder
}

function loadChildProcessModule(): ChildProcessModuleLike {
  // eslint-disable-next-line import/no-nodejs-modules
  return require('child_process') as ChildProcessModuleLike
}

function loadOsModule(): OsModuleLike {
  // eslint-disable-next-line import/no-nodejs-modules
  return require('os') as OsModuleLike
}

function loadFsModule(): FsModuleLike {
  // eslint-disable-next-line import/no-nodejs-modules
  return require('fs') as FsModuleLike
}

function loadPathModule(): PathModuleLike {
  // eslint-disable-next-line import/no-nodejs-modules
  return require('path') as PathModuleLike
}

function loadTextCodecModule(): TextCodecModuleLike {
  // Jest's jsdom runtime lacks the browser globals. Electron supplies them,
  // while Node's equivalent strict codecs keep the gateway deterministic in
  // tests and any older renderer runtime.
  // eslint-disable-next-line import/no-nodejs-modules
  return require('util') as TextCodecModuleLike
}

function decodeChunk(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk
  if (
    chunk !== null &&
    typeof chunk === 'object' &&
    typeof (chunk as { toString?: unknown }).toString === 'function'
  ) {
    return (chunk as { toString(encoding: string): string }).toString('utf8')
  }
  return String(chunk)
}

function toProcessLaunchError(error: unknown): ProcessLaunchError {
  const code =
    error !== null &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined
  return {
    ...(code === undefined ? {} : { code }),
    message: describeSpawnError(error),
  }
}

export interface ProcessIdentitySnapshot {
  pid: number
  /** OS process start token, used to reject PID reuse. */
  birthToken?: string
}

type DescendantProcessSnapshot = number | ProcessIdentitySnapshot

function normalizeProcessIdentity(
  value: DescendantProcessSnapshot,
): ProcessIdentitySnapshot | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? { pid: value } : null
  }
  if (!Number.isSafeInteger(value.pid) || value.pid < 1) return null
  return {
    pid: value.pid,
    ...(typeof value.birthToken === 'string' && value.birthToken.length > 0
      ? { birthToken: value.birthToken }
      : {}),
  }
}

function readOsProcessBirthToken(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null
  try {
    const childProcess = loadChildProcessModule()
    if (childProcess.execFileSync === undefined) return null
    if (process.platform === 'win32') {
      const systemRoot =
        process.env['SystemRoot'] ??
        process.env['SYSTEMROOT'] ??
        'C:\\Windows'
      const powershell =
        `${systemRoot.replace(/[\\/]+$/u, '')}` +
        '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
      const value = childProcess.execFileSync(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${String(pid)} -ErrorAction Stop)` +
            ".StartTime.ToUniversalTime().ToString('o')",
        ],
        {
          encoding: 'utf8',
          maxBuffer: 4096,
          windowsHide: true,
        },
      ).trim()
      return value.length > 0 ? value : null
    }
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      return null
    }
    const value = childProcess.execFileSync(
      '/bin/ps',
      ['-p', String(pid), '-o', 'lstart='],
      { encoding: 'utf8' },
    ).trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

/** Snapshot descendants before stopping the wrapper can reparent them. */
function collectDescendantPids(rootPid: number): ProcessIdentitySnapshot[] {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return []
  try {
    const childProcess = loadChildProcessModule()
    if (childProcess.execFileSync === undefined) return []
    const output = childProcess.execFileSync(
      '/bin/ps',
      ['-axo', 'pid=,ppid=,lstart='],
      { encoding: 'utf8' },
    )
    const childrenByParent = new Map<number, ProcessIdentitySnapshot[]>()
    for (const line of output.split('\n')) {
      const match = line
        .trim()
        .match(/^(\d+)\s+(\d+)\s+(.+)$/u)
      if (!match) continue
      const pid = Number(match[1])
      const parentPid = Number(match[2])
      const children = childrenByParent.get(parentPid) ?? []
      children.push({ pid, birthToken: match[3].trim() })
      childrenByParent.set(parentPid, children)
    }

    const descendants: ProcessIdentitySnapshot[] = []
    const pending = [...(childrenByParent.get(rootPid) ?? [])]
    const seen = new Set<number>()
    while (pending.length > 0) {
      const identity = pending.pop()
      if (
        identity === undefined ||
        identity.pid < 1 ||
        seen.has(identity.pid)
      ) {
        continue
      }
      seen.add(identity.pid)
      descendants.push(identity)
      pending.push(...(childrenByParent.get(identity.pid) ?? []))
    }
    return descendants
  } catch {
    // Best effort: the inner PTY supervisor still covers the normal group.
    return []
  }
}

/**
 * Sentinel prefixed to the `echo` output so the PATH line can be recovered
 * from noisy login-shell stdout (nvm banners in .zprofile, .zlogout output).
 */
const LOGIN_SHELL_PATH_MARKER = '__TASKCHUTE_AI_PATH__'

export const LOGIN_SHELL_PATH_TIMEOUT_MS = 10_000

/**
 * Prefer an interactive login shell so version managers configured from
 * `.zshrc` / `.bashrc` (mise, nvm, nodenv, etc.) participate even when
 * Obsidian was launched by the OS with a minimal PATH. Some shells do not
 * support the interactive form, so callers retry the traditional login-only
 * form as a compatibility fallback.
 */
export const POSIX_INTERACTIVE_LOGIN_SHELL_FLAG = '-lic'
export const POSIX_LOGIN_SHELL_FLAG = '-lc'

/** Login-shell entries first, then any process entries not already present */
function mergePathLists(
  loginShellPath: string,
  processPath: string | undefined,
  delimiter: string,
  caseInsensitive: boolean,
): string {
  const merged: string[] = []
  const seen = new Set<string>()
  const append = (entry: string): void => {
    const key = caseInsensitive ? entry.toLowerCase() : entry
    if (entry.length === 0 || seen.has(key)) return
    seen.add(key)
    merged.push(entry)
  }
  for (const entry of loginShellPath.split(delimiter)) append(entry)
  for (const entry of (processPath ?? '').split(delimiter)) append(entry)
  return merged.join(delimiter)
}

function getEnvValueCaseInsensitive(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

function joinWindowsPath(root: string | undefined, ...parts: string[]): string {
  const trimmedRoot = root?.trim().replace(/[\\/]+$/u, '')
  if (trimmedRoot === undefined || !/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(trimmedRoot)) {
    return ''
  }
  return [trimmedRoot, ...parts.map((part) => part.replace(/^[\\/]+|[\\/]+$/gu, ''))]
    .join('\\')
}

/** GUI-launched Windows apps often miss version-manager/global npm paths. */
function getWindowsPathAdditions(env: Record<string, string | undefined>): string[] {
  const userProfile = getEnvValueCaseInsensitive(env, 'USERPROFILE')
  const localAppData = getEnvValueCaseInsensitive(env, 'LOCALAPPDATA')
  const appData = getEnvValueCaseInsensitive(env, 'APPDATA')
  const programFiles = getEnvValueCaseInsensitive(env, 'ProgramFiles') ?? 'C:\\Program Files'
  const programFilesX86 =
    getEnvValueCaseInsensitive(env, 'ProgramFiles(x86)') ?? 'C:\\Program Files (x86)'
  const candidates = [
    getEnvValueCaseInsensitive(env, 'NVM_SYMLINK')?.trim() ?? '',
    getEnvValueCaseInsensitive(env, 'FNM_MULTISHELL_PATH')?.trim() ?? '',
    getEnvValueCaseInsensitive(env, 'FNM_DIR')?.trim() ?? '',
    getEnvValueCaseInsensitive(env, 'npm_config_prefix')?.trim() ?? '',
    joinWindowsPath(userProfile, '.local', 'bin'),
    joinWindowsPath(userProfile, '.volta', 'bin'),
    joinWindowsPath(userProfile, 'scoop', 'shims'),
    joinWindowsPath(localAppData, 'pnpm'),
    joinWindowsPath(localAppData, 'Programs', 'nodejs'),
    joinWindowsPath(appData, 'npm'),
    joinWindowsPath(programFiles, 'nodejs'),
    joinWindowsPath(programFilesX86, 'nodejs'),
    joinWindowsPath(getEnvValueCaseInsensitive(env, 'ChocolateyInstall'), 'bin'),
  ]
  return mergePathLists(candidates.join(';'), undefined, ';', true)
    .split(';')
    .filter((candidate) => /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(candidate))
}

function extractMarkedPathLine(stdout: string): string | undefined {
  const markedLine = stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith(LOGIN_SHELL_PATH_MARKER))
  if (markedLine === undefined) return undefined
  const value = markedLine.slice(LOGIN_SHELL_PATH_MARKER.length).trim()
  return value.length > 0 ? value : undefined
}

/** POSIX single-quote escaping: ' becomes '\'' inside a quoted region */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Positive integer terminal dimension, or the fallback when invalid */
function sanitizeDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  const floored = Math.floor(value)
  if (floored < 1) return fallback
  return Math.min(floored, 999)
}

/** Valid live resize dimension, kept within the same limit as initial stty. */
function normalizeResizeDimension(value: number): number | null {
  if (!Number.isFinite(value)) return null
  const floored = Math.floor(value)
  if (floored < 1) return null
  return Math.min(floored, 999)
}

function getTtySidecarPath(transcriptPath: string): string {
  return `${transcriptPath}.tty`
}

function isTtyDevicePath(path: string): boolean {
  return path.startsWith('/dev/') && !path.includes('\0') && !/[\r\n]/.test(path)
}

/**
 * Read only the trailing MAX_TRANSCRIPT_READ_BYTES of an oversized PTY
 * transcript. The read may start inside a multibyte UTF-8 character, so
 * leading continuation bytes are dropped to land on a character boundary
 * (losing that one torn character of terminal noise).
 */
async function readTranscriptTail(path: string, fileSize: number): Promise<string> {
  const handle = await loadFsModule().promises.open(path, 'r')
  try {
    const buffer = new Uint8Array(MAX_TRANSCRIPT_READ_BYTES)
    const { bytesRead } = await handle.read(
      buffer,
      0,
      MAX_TRANSCRIPT_READ_BYTES,
      fileSize - MAX_TRANSCRIPT_READ_BYTES,
    )
    let start = 0
    while (start < bytesRead && (buffer[start] & 0xc0) === 0x80) {
      start += 1
    }
    const Decoder =
      typeof TextDecoder === 'function'
        ? TextDecoder
        : loadTextCodecModule().TextDecoder
    const tail = new Decoder('utf-8').decode(buffer.subarray(start, bytesRead))
    return `${TRANSCRIPT_TRUNCATED_MARKER}\n${tail}`
  } finally {
    await handle.close()
  }
}

/** Temp-file-name-safe prefix (path separators and shell metachars removed) */
function sanitizeTempPrefix(prefix: string): string {
  const cleaned = prefix.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned : 'taskchute-ai'
}

function describeSpawnError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  if (
    error !== null &&
    typeof error === 'object' &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message
  }
  return 'Process error'
}

export function buildWindowsTaskkillArgs(pid: number, force: boolean): string[] {
  if (!Number.isSafeInteger(pid) || pid < 1) return []
  return force
    ? ['/PID', String(pid), '/T', '/F']
    : ['/PID', String(pid), '/T']
}

type WindowsTreeTerminator = (
  pid: number,
  force: boolean,
  onFailure: () => void,
) => boolean

type WindowsTreeSyncTerminator = (pid: number) => boolean

function terminateWindowsProcessTree(
  pid: number,
  force: boolean,
  onFailure: () => void,
): boolean {
  const args = buildWindowsTaskkillArgs(pid, force)
  if (args.length === 0) return false
  try {
    const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'] ?? 'C:\\Windows'
    const command = `${systemRoot.replace(/[\\/]+$/u, '')}\\System32\\taskkill.exe`
    const child = loadChildProcessModule().spawn(command, args, {
      detached: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // taskkill output is diagnostic only; drain it and prevent a missing
    // executable from becoming an unhandled renderer error.
    child.stdout?.on('data', () => undefined)
    child.stderr?.on('data', () => undefined)
    let failureReported = false
    const reportFailure = (): void => {
      if (failureReported) return
      failureReported = true
      onFailure()
    }
    child.on('error', reportFailure)
    child.on('close', (code) => {
      if (code !== 0) reportFailure()
    })
    return true
  } catch {
    return false
  }
}

function terminateWindowsProcessTreeSync(pid: number): boolean {
  const args = buildWindowsTaskkillArgs(pid, true)
  if (args.length === 0) return false
  const childProcess = loadChildProcessModule()
  if (typeof childProcess.execFileSync !== 'function') return false
  try {
    const systemRoot =
      process.env['SystemRoot'] ??
      process.env['SYSTEMROOT'] ??
      'C:\\Windows'
    const command =
      `${systemRoot.replace(/[\\/]+$/u, '')}\\System32\\taskkill.exe`
    childProcess.execFileSync(command, args, { encoding: 'utf8' })
    return true
  } catch {
    return false
  }
}

const WORKSPACE_EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
])

function isPathInside(
  pathModule: PathModuleLike,
  rootPath: string,
  targetPath: string,
): boolean {
  const relative = pathModule.relative(rootPath, targetPath)
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${pathModule.sep}`) &&
      !pathModule.isAbsolute(relative))
  )
}

function assertWorkspacePath(path: string, label: string): void {
  if (path.includes('\0')) throw new Error(`${label} must not contain NUL`)
  if (path.trim().length === 0) throw new Error(`${label} must not be empty`)
}

function workspaceBoundaryError(path: string): Error {
  return new Error(`Path is outside the workspace root: ${path}`)
}

interface ValidatedWorkspaceFile {
  realRoot: string
  realTarget: string
  stats: NodeStatsLike
}

async function validateWorkspaceFile(
  rootPath: string,
  filePath: string,
): Promise<ValidatedWorkspaceFile> {
  assertWorkspacePath(rootPath, 'Workspace root')
  assertWorkspacePath(filePath, 'Workspace file')

  const fs = loadFsModule().promises
  const path = loadPathModule()
  const resolvedRoot = path.resolve(rootPath)
  const realRoot = await fs.realpath(resolvedRoot)
  const rootStats = await fs.stat(realRoot)
  if (!rootStats.isDirectory()) {
    throw new Error(`Workspace root is not a directory: ${rootPath}`)
  }

  const resolvedTarget = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(resolvedRoot, filePath)
  // An absolute path may use either the lexical root passed by the caller
  // (including a symlink alias) or the canonical root returned by realpath.
  if (
    !isPathInside(path, resolvedRoot, resolvedTarget) &&
    !isPathInside(path, realRoot, resolvedTarget)
  ) {
    throw workspaceBoundaryError(filePath)
  }

  const realTarget = await fs.realpath(resolvedTarget)
  if (!isPathInside(path, realRoot, realTarget)) {
    throw workspaceBoundaryError(filePath)
  }
  const stats = await fs.stat(realTarget)
  if (!stats.isFile()) {
    throw new Error(`Workspace path is not a file: ${filePath}`)
  }
  return { realRoot, realTarget, stats }
}

function toWorkspaceFileVersion(stats: NodeStatsLike): WorkspaceFileVersion {
  return { mtimeMs: stats.mtimeMs, size: stats.size }
}

function versionsMatch(
  left: WorkspaceFileVersion,
  right: WorkspaceFileVersion,
): boolean {
  return left.mtimeMs === right.mtimeMs && left.size === right.size
}

function assertWorkspaceFileSize(size: number): void {
  if (size > MAX_WORKSPACE_FILE_BYTES) {
    throw new Error('Workspace file exceeds the 2 MiB editor limit')
  }
}

const UNPAIRED_UTF16_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u

function hasBinaryControlCharacter(content: string): boolean {
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index)
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      return true
    }
  }
  return false
}

function decodeWorkspaceText(bytes: Uint8Array): string {
  let content: string
  try {
    const Decoder =
      typeof TextDecoder === 'function'
        ? TextDecoder
        : loadTextCodecModule().TextDecoder
    content = new Decoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('Workspace file is not valid UTF-8 text')
  }
  if (hasBinaryControlCharacter(content)) {
    throw new Error('Workspace file is binary, not editable text')
  }
  return content
}

function encodeWorkspaceText(content: string): Uint8Array {
  if (hasBinaryControlCharacter(content)) {
    throw new Error('Workspace file content must be editable text without control bytes')
  }
  if (UNPAIRED_UTF16_SURROGATE.test(content)) {
    throw new Error('Workspace file content is not valid Unicode text')
  }
  const Encoder =
    typeof TextEncoder === 'function'
      ? TextEncoder
      : loadTextCodecModule().TextEncoder
  const bytes = new Encoder().encode(content)
  assertWorkspaceFileSize(bytes.byteLength)
  return bytes
}

export class NodeProcessGateway implements ProcessGateway, WorkspaceFileGateway {
  private loginShellPath: string | null = null
  private loginShellPathPrimed: Promise<void> | null = null
  private loginShellPathRefresh: Promise<void> | null = null
  private tempFileSequence = 0
  /**
   * Only processes spawned directly by this renderer gateway are registered.
   * Broker-owned PTYs are spawned inside TerminalSessionBrokerSource and
   * never enter this map, so a renderer exit cannot destroy reload-persistent
   * sessions.
   */
  private readonly rendererOwnedProcesses =
    new Map<
      number,
      {
        child: NodeChildProcessLike
        birthToken: string | null
      }
    >()
  private rendererExitReaperInstalled = false
  private readonly rendererExitReaper = (): void => {
    this.reapRendererOwnedProcessesForExit()
  }

  constructor(
    private readonly snapshotDescendantPids: (
      rootPid: number,
    ) => DescendantProcessSnapshot[] =
      collectDescendantPids,
    private readonly platformOverride?: string,
    private readonly terminateWindowsTree: WindowsTreeTerminator =
      terminateWindowsProcessTree,
    private readonly readProcessBirthToken: (pid: number) => string | null =
      readOsProcessBirthToken,
    private readonly terminateWindowsTreeSync: WindowsTreeSyncTerminator =
      terminateWindowsProcessTreeSync,
  ) {}

  /**
   * Synchronous last-resort cleanup for renderer-owned children. pagehide
   * normally starts the graceful/bounded stop first; Node's exit event covers
   * Electron teardown paths where pagehide never fires or its timer cannot
   * finish. This must stay synchronous because no async work is guaranteed
   * once the renderer process begins exiting.
   */
  reapRendererOwnedProcessesForExit(): void {
    const active = Array.from(this.rendererOwnedProcesses.entries())
    this.rendererOwnedProcesses.clear()
    this.removeRendererExitReaper()
    for (const [pid, tracked] of active) {
      const { child, birthToken } = tracked
      if (this.getPlatform() === 'win32') {
        // The map snapshot and synchronous taskkill are not atomic. The root
        // can exit and Windows can reuse its numeric PID while renderer exit
        // cleanup is iterating, so prove process birth identity immediately
        // before every numeric-PID signal.
        if (
          birthToken === null ||
          this.readProcessBirthToken(pid) !== birthToken
        ) {
          continue
        }
        if (this.terminateWindowsTreeSync(pid)) continue
        if (this.readProcessBirthToken(pid) !== birthToken) continue
        try {
          child.kill('SIGKILL')
        } catch {
          // The child already exited while renderer teardown was beginning.
        }
        continue
      }
      let groupKilled = false
      if (typeof process.kill === 'function') {
        try {
          process.kill(-pid, 'SIGKILL')
          groupKilled = true
        } catch {
          // Fall back to the still-owned direct ChildProcess handle.
        }
      }
      if (groupKilled) continue
      try {
        child.kill('SIGKILL')
      } catch {
        // The process already exited.
      }
    }
  }

  private trackRendererOwnedProcess(child: NodeChildProcessLike): void {
    const pid = child.pid
    if (!Number.isSafeInteger(pid) || (pid ?? 0) < 1) return
    this.rendererOwnedProcesses.set(pid as number, {
      child,
      birthToken:
        this.getPlatform() === 'win32'
          ? this.readProcessBirthToken(pid as number)
          : null,
    })
    if (this.rendererExitReaperInstalled) return
    process.on?.('exit', this.rendererExitReaper)
    this.rendererExitReaperInstalled = true
  }

  private untrackRendererOwnedProcess(pid: number | undefined): void {
    if (typeof pid !== 'number') return
    this.rendererOwnedProcesses.delete(pid)
    if (this.rendererOwnedProcesses.size === 0) {
      this.removeRendererExitReaper()
    }
  }

  private removeRendererExitReaper(): void {
    if (!this.rendererExitReaperInstalled) return
    process.removeListener?.('exit', this.rendererExitReaper)
    this.rendererExitReaperInstalled = false
  }

  spawnProcess(request: SpawnProcessRequest): SpawnedProcessHandle {
    const stdoutCallbacks: Array<(text: string) => void> = []
    const stderrCallbacks: Array<(text: string) => void> = []
    const exitCallbacks: Array<(code: number | null, signal: string | null) => void> = []
    const launchErrorCallbacks: Array<(error: ProcessLaunchError) => void> = []
    let exited = false
    let rootExited = false
    let launchError: ProcessLaunchError | null = null

    const notifyLaunchError = (error: ProcessLaunchError): void => {
      if (launchError !== null) return
      launchError = error
      for (const callback of launchErrorCallbacks) callback(error)
    }

    const notifyExit = (code: number | null, signal: string | null): void => {
      if (exited) return
      exited = true
      this.untrackRendererOwnedProcess(child?.pid)
      for (const callback of exitCallbacks) callback(code, signal)
    }

    let child: NodeChildProcessLike | null = null
    const stdinMode: StdinMode = request.stdinMode ?? 'ignore'
    try {
      // detached:true makes the child a process-group leader (POSIX) so
      // kill() below can signal the WHOLE group: if a headless CLI ignores
      // SIGTERM and spawned its own tool subprocesses, the SIGKILL
      // escalation still reaps the grandchildren instead of leaving orphans.
      // PTY (terminal) runs differ: /usr/bin/script gives the CLI its OWN
      // session on the pty, so group signals reach only the wrapper pipeline
      // (cat | sh | script). buildPtyCommand therefore runs the CLI under an
      // inner shell supervisor. The real CLI runs as its background child so
      // the shell is not stuck deferring its HUP/TERM trap while waiting on a
      // hostile foreground CLI; the trap can immediately SIGKILL the PTY
      // group when script closes the master side.
      // The default stdio[0]='ignore' gives the child /dev/null as stdin so
      // headless CLIs never wait on (or announce reading from) a parent-held
      // stdin pipe, e.g. codex's "Reading additional input from stdin..."
      // message. Terminal sessions opt into stdinMode 'pipe' so keystrokes
      // can be relayed via writeStdin.
      child = loadChildProcessModule().spawn(request.command, request.args, {
        cwd: request.cwd,
        env: request.env,
        // POSIX uses a process group for descendant cleanup. A detached
        // Windows child creates an independent console and is harder to reap;
        // keep it attached and use the Windows tree-stop path instead.
        detached: this.getPlatform() !== 'win32',
        windowsHide: true,
        stdio: [stdinMode, 'pipe', 'pipe'],
      })
    } catch (error) {
      launchError = toProcessLaunchError(error)
    }

    if (child) {
      // `exit` precedes `close` when descendants still hold inherited stdio.
      // Stop tracking immediately: after OS exit the numeric Windows PID can
      // be reused before close drains, and taskkill /PID would then target an
      // unrelated process.
      child.on('exit', () => {
        rootExited = true
        this.untrackRendererOwnedProcess(child?.pid)
      })
      // Install the exit fence before the Windows StartTime lookup used by
      // tracking. PowerShell is synchronous and a short-lived child can exit
      // while that lookup is in progress.
      this.trackRendererOwnedProcess(child)
      // Decode via Node's StringDecoder so a multibyte UTF-8 character split
      // across pipe chunks is buffered instead of degrading to U+FFFD.
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk) => {
        const text = decodeChunk(chunk)
        for (const callback of stdoutCallbacks) callback(text)
      })
      child.stderr?.on('data', (chunk) => {
        const text = decodeChunk(chunk)
        for (const callback of stderrCallbacks) callback(text)
      })
      child.on('close', (code, signal) => {
        notifyExit(code ?? null, signal ?? null)
      })
      child.on('error', (error) => {
        const launchFailure = toProcessLaunchError(error)
        notifyLaunchError(launchFailure)
        for (const callback of stderrCallbacks) {
          callback(`${launchFailure.message}\n`)
        }
        notifyExit(null, null)
      })
      if (stdinMode === 'pipe') {
        // Keystrokes can race pipeline teardown: a write still pending in
        // libuv when the child dies (e.g. the PTY wrapper's `kill -9 0`)
        // completes with EPIPE as an ASYNC 'error' event on the stdin
        // stream — the try/catch in writeStdin only covers the synchronous
        // call. Without a listener the event escalates to an unhandled
        // "write EPIPE" exception in the renderer, so swallow it here.
        child.stdin?.on('error', () => undefined)
      }
    }

    const failedChild = child === null
    const knownDescendantPids = new Map<number, string | null>()
    const writeStdin =
      stdinMode === 'pipe'
        ? (data: string): void => {
            if (child === null || exited) return
            try {
              child.stdin?.write(data)
            } catch {
              // The pipe already closed (child exiting); drop the write.
            }
          }
        : undefined

    return {
      pid: child?.pid,
      writeStdin,
      onStdout: (callback) => {
        stdoutCallbacks.push(callback)
      },
      onStderr: (callback) => {
        stderrCallbacks.push(callback)
        if (failedChild && launchError !== null) {
          callback(`${launchError.message}\n`)
        }
      },
      onLaunchError: (callback) => {
        launchErrorCallbacks.push(callback)
        if (launchError !== null) callback(launchError)
      },
      onExit: (callback) => {
        exitCallbacks.push(callback)
        if (failedChild) {
          // Report the synchronous spawn failure asynchronously so callers
          // finish registering their callbacks first.
          stableTimeoutSource.setTimeout(() => {
            notifyExit(null, null)
          }, 0)
        }
      },
      kill: (signal) => {
        if (child === null) return
        // Prefer signalling the process group (negative pid) so grandchild
        // tool subprocesses die with the CLI. Fall back to a direct child
        // kill where group signalling is unsupported (Windows) or the group
        // is already gone.
        const pid = child.pid
        if (this.getPlatform() === 'win32') {
          // `exit` precedes `close` while descendants keep inherited stdio.
          // The numeric root PID is reusable as soon as exit fires, so neither
          // the regular handle nor a delayed taskkill failure callback may
          // target it during that gap.
          if (rootExited || exited) return
          const killChildDirectly = (): void => {
            if (rootExited || exited) return
            try {
              child?.kill(signal)
            } catch {
              // The child disappeared between taskkill failure and fallback.
            }
          }
          const forceTreeOrKillChild = (): void => {
            if (rootExited || exited) return
            // A graceful /T can fail before it reaches descendants (missing
            // executable, access error, unsupported termination). Retry the
            // same still-live PID with /T /F before falling back to the root
            // handle; otherwise an agent subprocess could outlive the UI run.
            if (
              signal !== 'SIGKILL' &&
              typeof pid === 'number' &&
              pid > 0 &&
              this.terminateWindowsTree(pid, true, killChildDirectly)
            ) {
              return
            }
            killChildDirectly()
          }
          if (
            typeof pid === 'number' &&
            pid > 0 &&
            this.terminateWindowsTree(
              pid,
              signal === 'SIGKILL',
              forceTreeOrKillChild,
            )
          ) {
            return
          }
          forceTreeOrKillChild()
          return
        }
        if (typeof pid === 'number' && pid > 0 && typeof process.kill === 'function') {
          if (!exited) {
            for (const rawIdentity of this.snapshotDescendantPids(pid)) {
              const identity = normalizeProcessIdentity(rawIdentity)
              if (!identity || identity.pid === pid) continue
              knownDescendantPids.set(
                identity.pid,
                identity.birthToken ??
                  this.readProcessBirthToken(identity.pid),
              )
            }
          }
          let groupSignalled = false
          if (!exited) {
            try {
              process.kill(-pid, signal)
              groupSignalled = true
            } catch {
              // Fall through to the direct child kill below.
            }
          }
          for (const [descendantPid, birthToken] of knownDescendantPids) {
            if (
              birthToken !== null &&
              this.readProcessBirthToken(descendantPid) !== birthToken
            ) {
              // The original descendant exited and the numeric PID has been
              // reused. Never signal the unrelated replacement process.
              knownDescendantPids.delete(descendantPid)
              continue
            }
            try {
              process.kill(descendantPid, signal)
            } catch {
              // The snapshotted descendant has already exited.
            }
          }
          if (groupSignalled) return
        }
        if (exited) return
        try {
          child.kill(signal)
        } catch {
          // The process is already gone; treat the kill as a no-op.
        }
      },
    }
  }

  execCapture(command: string, args: string[], timeoutMs: number): Promise<ExecCaptureResult> {
    return new Promise((resolve) => {
      const handle = this.spawnProcess({ command, args, env: this.getBaseEnv() })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timerId = stableTimeoutSource.setTimeout(() => {
        timedOut = true
        handle.kill('SIGKILL')
      }, timeoutMs)

      handle.onStdout((text) => {
        stdout += text
      })
      handle.onStderr((text) => {
        stderr += text
      })
      handle.onExit((code) => {
        stableTimeoutSource.clearTimeout(timerId)
        resolve({ code: timedOut ? null : code, stdout, stderr, timedOut })
      })
    })
  }

  getBaseEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env }
    delete env['CLAUDECODE']
    delete env['CLAUDE_CODE_ENTRYPOINT']
    env['NO_COLOR'] = '1'
    const isWindows = this.getPlatform() === 'win32'
    const pathKey = isWindows
      ? Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
      : 'PATH'
    if (isWindows) {
      env[pathKey] = mergePathLists(
        getWindowsPathAdditions(env).join(';'),
        env[pathKey],
        ';',
        true,
      )
    }
    if (this.loginShellPath !== null) {
      env[pathKey] = mergePathLists(
        this.loginShellPath,
        env[pathKey],
        isWindows ? ';' : ':',
        isWindows,
      )
    }
    return env
  }

  getShellPath(): string {
    if (this.getPlatform() === 'win32') {
      const comspec = process.env['COMSPEC']
      if (typeof comspec === 'string' && comspec.trim().length > 0) return comspec
      const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'] ?? 'C:\\Windows'
      return `${systemRoot.replace(/[\\/]+$/u, '')}\\System32\\cmd.exe`
    }
    const shell = process.env['SHELL']
    if (typeof shell === 'string' && shell.trim().length > 0) return shell
    // POSIX-guaranteed fallback: /bin/zsh is not present on all Linux
    // desktops, and a missing fallback shell would make every shell-session
    // spawn fail when $SHELL is unset.
    return '/bin/sh'
  }

  /** Runtime platform seam used by the cross-platform CLI locator tests. */
  getPlatform(): string {
    return this.platformOverride ?? process.platform ?? 'unknown'
  }

  /** Cross-platform file probe kept inside the sole Node.js boundary. */
  async isFile(path: string): Promise<boolean> {
    try {
      return (await loadFsModule().promises.stat(path)).isFile()
    } catch {
      return false
    }
  }

  /**
   * List one directory below a workspace root for lazy Files-tree expansion.
   *
   * The root, requested directory, and every returned child are checked by
   * realpath. A symlink may remain visible when it resolves inside the root;
   * escape links are rejected as a target or omitted as children. Per-entry
   * failures are isolated so one broken/inaccessible link does not blank the
   * whole folder.
   */
  async listWorkspaceDirectory(
    rootPath: string,
    directoryPath = '',
  ): Promise<WorkspaceDirectoryListing> {
    assertWorkspacePath(rootPath, 'Workspace root')
    if (directoryPath.includes('\0')) {
      throw new Error('Workspace directory must not contain NUL')
    }

    const fs = loadFsModule().promises
    const path = loadPathModule()
    const resolvedRoot = path.resolve(rootPath)
    const realRoot = await fs.realpath(resolvedRoot)
    const rootStats = await fs.stat(realRoot)
    if (!rootStats.isDirectory()) {
      throw new Error(`Workspace root is not a directory: ${rootPath}`)
    }

    const resolvedTarget = directoryPath
      ? path.isAbsolute(directoryPath)
        ? path.resolve(directoryPath)
        : path.resolve(realRoot, directoryPath)
      : realRoot
    if (!isPathInside(path, realRoot, resolvedTarget)) {
      throw workspaceBoundaryError(directoryPath)
    }

    const realTarget = await fs.realpath(resolvedTarget)
    if (!isPathInside(path, realRoot, realTarget)) {
      throw workspaceBoundaryError(directoryPath)
    }
    const targetStats = await fs.stat(realTarget)
    if (!targetStats.isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${directoryPath}`)
    }

    const directoryEntries = await fs.readdir(realTarget, {
      withFileTypes: true,
    })
    const entries: WorkspaceEntry[] = []
    for (const directoryEntry of directoryEntries) {
      if (WORKSPACE_EXCLUDED_NAMES.has(directoryEntry.name)) continue
      const absolutePath = path.join(realTarget, directoryEntry.name)
      try {
        const realChild = await fs.realpath(absolutePath)
        if (!isPathInside(path, realRoot, realChild)) continue
        const childStats = await fs.stat(realChild)
        const type = childStats.isDirectory()
          ? 'folder'
          : childStats.isFile()
            ? 'file'
            : null
        if (type === null) continue
        entries.push({
          name: directoryEntry.name,
          type,
          relativePath: path.relative(realRoot, absolutePath),
          absolutePath,
        })
      } catch {
        // Broken/inaccessible children do not make the whole tree unusable.
      }
    }

    entries.sort((left, right) => {
      if (left.type !== right.type) return left.type === 'folder' ? -1 : 1
      return left.name.localeCompare(right.name)
    })

    return {
      rootPath: realRoot,
      directoryPath: path.relative(realRoot, realTarget),
      entries,
    }
  }

  /** Read one existing, canonical UTF-8 text file within a workspace. */
  async readWorkspaceFile(
    rootPath: string,
    filePath: string,
  ): Promise<WorkspaceFileDocument> {
    const fs = loadFsModule().promises
    const path = loadPathModule()
    const validated = await validateWorkspaceFile(rootPath, filePath)
    assertWorkspaceFileSize(validated.stats.size)

    const bytes = await fs.readFile(validated.realTarget)
    assertWorkspaceFileSize(bytes.byteLength)
    const content = decodeWorkspaceText(bytes)

    // Bind the returned token to the bytes just read. If another process
    // changed the file during the read, the caller must retry instead of
    // editing content under a version that describes different bytes.
    const finalStats = await fs.stat(validated.realTarget)
    if (!finalStats.isFile()) {
      throw new Error(`Workspace path is not a file: ${filePath}`)
    }
    if (!versionsMatch(toWorkspaceFileVersion(validated.stats), toWorkspaceFileVersion(finalStats))) {
      throw new WorkspaceFileVersionConflictError()
    }

    return {
      rootPath: validated.realRoot,
      relativePath: path.relative(validated.realRoot, validated.realTarget),
      absolutePath: validated.realTarget,
      content,
      version: toWorkspaceFileVersion(finalStats),
    }
  }

  /**
   * Save one existing workspace text file under an optimistic version lock.
   * The opened handle is checked again before its first write; creation is
   * impossible because `r+` requires the target to already exist.
   */
  async writeWorkspaceFile(
    rootPath: string,
    filePath: string,
    content: string,
    expectedVersion: WorkspaceFileVersion,
  ): Promise<WorkspaceFileDocument> {
    if (
      !Number.isFinite(expectedVersion.mtimeMs) ||
      !Number.isFinite(expectedVersion.size) ||
      expectedVersion.mtimeMs < 0 ||
      expectedVersion.size < 0
    ) {
      throw new Error('Workspace file version is invalid')
    }
    const bytes = encodeWorkspaceText(content)
    const validated = await validateWorkspaceFile(rootPath, filePath)
    const fs = loadFsModule().promises
    const handle = await fs.open(validated.realTarget, 'r+')
    try {
      const openedStats = await handle.stat()
      if (!openedStats.isFile()) {
        throw new Error(`Workspace path is not a file: ${filePath}`)
      }
      if (!versionsMatch(expectedVersion, toWorkspaceFileVersion(openedStats))) {
        throw new WorkspaceFileVersionConflictError()
      }
      await handle.writeFile(bytes)
      await handle.truncate(bytes.byteLength)
    } finally {
      await handle.close()
    }

    // Revalidate root, lexical path, real target, type, size and UTF-8 after
    // the write. The returned content/version therefore becomes the editor's
    // next authoritative original snapshot.
    return await this.readWorkspaceFile(rootPath, filePath)
  }

  isPtySupported(): boolean {
    const platform = this.getPlatform()
    return platform === 'darwin' || platform === 'linux'
  }

  buildPtyCommand(request: PtyCommandRequest): PtyCommand {
    const rows = sanitizeDimension(request.rows, 24)
    const cols = sanitizeDimension(request.cols, 80)
    const platform = this.getPlatform()
    const sttyPreamble = `stty rows ${rows} cols ${cols} 2>/dev/null`
    const ptyPreamble =
      `tty > "$TASKCHUTE_AI_TTY_PATH" 2>/dev/null; ${sttyPreamble}`
    const ptySupervisor =
      'trap "trap - HUP TERM; kill -9 0" HUP TERM; ' +
      '"$0" "$@" <&0 & child=$!; wait "$child"'
    const brokerWatchdog =
      'if [ "${TASKCHUTE_BROKER_WATCH_FD:-}" = "3" ]; then ' +
      '(IFS= read -r _ <&3; kill -9 0 2>/dev/null) & fi; '
    // See TERMINAL_EXIT_SENTINEL for why the wrapper looks like this.
    const wrap = (scriptInvocation: string): string =>
      `${brokerWatchdog}cat 2>/dev/null | { ${scriptInvocation}; st=$?; ` +
      `printf '${TERMINAL_EXIT_SENTINEL}%s\\n' "$st" >&2; kill -9 0 2>/dev/null; }`

    if (platform === 'darwin') {
      // BSD script(1): `script -q -F <file> <command> [args...]` (-F flushes
      // the transcript per write, so a SIGTERM stop cannot truncate it).
      // The /bin/sh trampoline sets the PTY size, supervises the real binary,
      // and kills the whole PTY group if script closes the master side. Every
      // user-influenced value stays OUT of the shell
      // text: the transcript is "$0" and binary+args travel as "$@"
      // positionals, so no quoting or injection concerns arise.
      return {
        command: '/bin/sh',
        args: [
          '-c',
          wrap(
            `TASKCHUTE_AI_TTY_PATH="$0.tty" /usr/bin/script -q -F "$0" ` +
              `/bin/sh -c '${ptyPreamble}; ${ptySupervisor}' "$@"`,
          ),
          request.transcriptPath,
          request.binaryPath,
          ...request.args,
        ],
      }
    }

    if (platform === 'linux') {
      // util-linux script(1): `script -qefc <command> <file>` (-e propagates
      // the child's exit code, -f flushes per write). -c takes one shell
      // string, so the binary and every argument are single-quote escaped.
      const execCommand = [request.binaryPath, ...request.args]
        .map(shellQuote)
        .join(' ')
      return {
        command: '/bin/sh',
        args: [
          '-c',
          wrap(
            `TASKCHUTE_AI_TTY_PATH="$0.tty" /usr/bin/script -qefc ` +
              `${shellQuote(`${ptyPreamble}; ${ptySupervisor.replace('"$0" "$@"', execCommand)}`)} "$0"`,
          ),
          request.transcriptPath,
          // Unused outer-shell positionals: the broker validates the real
          // executable/argv before spawn without attempting to re-parse the
          // nested quoted util-linux script program.
          request.binaryPath,
          ...request.args,
        ],
      }
    }

    throw new TerminalUnsupportedError(platform)
  }

  resizePty(transcriptPath: string, cols: number, rows: number): boolean {
    const normalizedCols = normalizeResizeDimension(cols)
    const normalizedRows = normalizeResizeDimension(rows)
    if (normalizedCols === null || normalizedRows === null) return false

    const platform = this.getPlatform()
    const ttyFlag = platform === 'darwin' ? '-f' : platform === 'linux' ? '-F' : null
    if (ttyFlag === null) return false

    try {
      const ttyPath = loadFsModule()
        .readFileSync(getTtySidecarPath(transcriptPath), 'utf8')
        .trim()
      if (!isTtyDevicePath(ttyPath)) return false
      const childProcess = loadChildProcessModule()
      if (childProcess.execFileSync === undefined) return false
      childProcess.execFileSync(
        '/bin/stty',
        [
          ttyFlag,
          ttyPath,
          'rows',
          String(normalizedRows),
          'cols',
          String(normalizedCols),
        ],
        { encoding: 'utf8' },
      )
      return true
    } catch {
      // The sidecar is created from inside `script`, so an early resize is
      // expected to miss it. TerminalDispatcher retries the latest request.
      return false
    }
  }

  makeTempFilePath(prefix: string): string {
    const tempDir = loadOsModule().tmpdir().replace(/[\\/]+$/, '')
    this.tempFileSequence += 1
    const unique = `${Date.now().toString(36)}-${this.tempFileSequence}-${Math.random()
      .toString(36)
      .slice(2, 8)}`
    return `${tempDir}/${sanitizeTempPrefix(prefix)}-${unique}.log`
  }

  async readAndDeleteFile(path: string): Promise<string> {
    const fs = loadFsModule().promises
    try {
      const size = (await fs.stat(path)).size
      if (size <= MAX_TRANSCRIPT_READ_BYTES) {
        return await fs.readFile(path, 'utf8')
      }
      return await readTranscriptTail(path, size)
    } finally {
      for (const cleanupPath of [path, getTtySidecarPath(path)]) {
        try {
          await fs.unlink(cleanupPath)
        } catch {
          // Best-effort cleanup: a missing/locked temp file is not fatal.
        }
      }
    }
  }

  primeLoginShellPath(): Promise<void> {
    if (this.getPlatform() === 'win32') {
      this.loginShellPathPrimed ??= Promise.resolve()
      return this.loginShellPathPrimed
    }
    // Defer the capture to a microtask so the promise field is assigned
    // before any inner execCapture -> getBaseEnv call runs; the second call
    // then reuses the pending promise instead of spawning another shell.
    this.loginShellPathPrimed ??= Promise.resolve().then(() => this.captureLoginShellPath())
    return this.loginShellPathPrimed
  }

  refreshLoginShellPath(): Promise<void> {
    if (this.getPlatform() === 'win32') return this.primeLoginShellPath()
    if (this.loginShellPathRefresh !== null) return this.loginShellPathRefresh
    const operation = Promise.resolve()
      .then(() => this.captureLoginShellPath())
      .finally(() => {
        if (this.loginShellPathRefresh === operation) {
          this.loginShellPathRefresh = null
        }
      })
    this.loginShellPathRefresh = operation
    // A refresh also satisfies future one-time priming callers, but unlike
    // the old permanent promise it does not prevent the next explicit refresh.
    this.loginShellPathPrimed ??= operation
    return operation
  }

  private async captureLoginShellPath(): Promise<void> {
    const command = `echo "${LOGIN_SHELL_PATH_MARKER}$PATH"`
    for (const flag of [
      POSIX_INTERACTIVE_LOGIN_SHELL_FLAG,
      POSIX_LOGIN_SHELL_FLAG,
    ]) {
      try {
        const result = await this.execCapture(
          this.getShellPath(),
          [flag, command],
          LOGIN_SHELL_PATH_TIMEOUT_MS,
        )
        if (result.code !== 0 || result.timedOut) continue
        const captured = extractMarkedPathLine(result.stdout)
        if (captured !== undefined) {
          this.loginShellPath = captured
          return
        }
      } catch {
        // Try the less demanding login-only invocation next.
      }
    }
    // Capture failures are non-fatal: getBaseEnv keeps the process PATH.
  }
}
