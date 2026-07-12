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

// Ambient declarations for the Electron renderer runtime (no @types/node in
// the src build). These shadow nothing at runtime; they only inform tsc.
declare function require(moduleId: string): unknown

declare const process: {
  env: Record<string, string | undefined>
  execPath?: string
  platform?: string
  kill?(pid: number, signal?: string): boolean
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

export interface SpawnedProcessHandle {
  pid?: number
  onStdout(callback: (text: string) => void): void
  onStderr(callback: (text: string) => void): void
  onExit(callback: (code: number | null, signal: string | null) => void): void
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
  /** Whether buildPtyCommand can produce a PTY wrapper on this platform */
  isPtySupported(): boolean
  /**
   * Wrap a binary invocation in the OS `script` utility so the child gets a
   * real TTY (interactive TUIs render and accept input). Throws a typed
   * TerminalUnsupportedError where no wrapper exists (win32).
   */
  buildPtyCommand(request: PtyCommandRequest): PtyCommand
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
}

interface OsModuleLike {
  tmpdir(): string
}

interface FsModuleLike {
  promises: {
    readFile(path: string, encoding: string): Promise<string>
    unlink(path: string): Promise<void>
  }
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

/**
 * Sentinel prefixed to the `echo` output so the PATH line can be recovered
 * from noisy login-shell stdout (nvm banners in .zprofile, .zlogout output).
 */
const LOGIN_SHELL_PATH_MARKER = '__TASKCHUTE_AI_PATH__'

export const LOGIN_SHELL_PATH_TIMEOUT_MS = 10_000

const PATH_DELIMITER = ':'

/** Login-shell entries first, then any process entries not already present */
function mergePathLists(loginShellPath: string, processPath: string | undefined): string {
  const merged: string[] = []
  const seen = new Set<string>()
  const append = (entry: string): void => {
    if (entry.length === 0 || seen.has(entry)) return
    seen.add(entry)
    merged.push(entry)
  }
  for (const entry of loginShellPath.split(PATH_DELIMITER)) append(entry)
  for (const entry of (processPath ?? '').split(PATH_DELIMITER)) append(entry)
  return merged.join(PATH_DELIMITER)
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

export class NodeProcessGateway implements ProcessGateway {
  private loginShellPath: string | null = null
  private loginShellPathPrimed: Promise<void> | null = null
  private tempFileSequence = 0

  spawnProcess(request: SpawnProcessRequest): SpawnedProcessHandle {
    const stdoutCallbacks: Array<(text: string) => void> = []
    const stderrCallbacks: Array<(text: string) => void> = []
    const exitCallbacks: Array<(code: number | null, signal: string | null) => void> = []
    let exited = false

    const notifyExit = (code: number | null, signal: string | null): void => {
      if (exited) return
      exited = true
      for (const callback of exitCallbacks) callback(code, signal)
    }

    let child: NodeChildProcessLike | null = null
    let spawnErrorMessage: string | null = null
    const stdinMode: StdinMode = request.stdinMode ?? 'ignore'
    try {
      // detached:true makes the child a process-group leader (POSIX) so
      // kill() below can signal the WHOLE group: if a headless CLI ignores
      // SIGTERM and spawned its own tool subprocesses, the SIGKILL
      // escalation still reaps the grandchildren instead of leaving orphans.
      // PTY (terminal) runs differ: /usr/bin/script gives the CLI its OWN
      // session on the pty, so group signals reach only the wrapper pipeline
      // (cat | sh | script) and the CLI itself dies via the PTY SIGHUP
      // raised when script exits and the master side closes. A CLI that
      // ignores SIGHUP would therefore outlive stop()/dispose() — a known
      // terminal-mode caveat to the G8 no-zombie guarantee.
      // The default stdio[0]='ignore' gives the child /dev/null as stdin so
      // headless CLIs never wait on (or announce reading from) a parent-held
      // stdin pipe, e.g. codex's "Reading additional input from stdin..."
      // message. Terminal sessions opt into stdinMode 'pipe' so keystrokes
      // can be relayed via writeStdin.
      child = loadChildProcessModule().spawn(request.command, request.args, {
        cwd: request.cwd,
        env: request.env,
        detached: true,
        windowsHide: true,
        stdio: [stdinMode, 'pipe', 'pipe'],
      })
    } catch (error) {
      spawnErrorMessage = describeSpawnError(error)
    }

    if (child) {
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
        const message = describeSpawnError(error)
        for (const callback of stderrCallbacks) callback(`${message}\n`)
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
        if (failedChild && spawnErrorMessage !== null) {
          callback(`${spawnErrorMessage}\n`)
        }
      },
      onExit: (callback) => {
        exitCallbacks.push(callback)
        if (failedChild) {
          // Report the synchronous spawn failure asynchronously so callers
          // finish registering their callbacks first.
          activeWindow.setTimeout(() => {
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
        if (typeof pid === 'number' && pid > 0 && typeof process.kill === 'function') {
          try {
            process.kill(-pid, signal)
            return
          } catch {
            // Fall through to the direct child kill below.
          }
        }
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
      const timerId = activeWindow.setTimeout(() => {
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
        activeWindow.clearTimeout(timerId)
        resolve({ code: timedOut ? null : code, stdout, stderr, timedOut })
      })
    })
  }

  getBaseEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env }
    delete env['CLAUDECODE']
    delete env['CLAUDE_CODE_ENTRYPOINT']
    env['NO_COLOR'] = '1'
    if (this.loginShellPath !== null) {
      env['PATH'] = mergePathLists(this.loginShellPath, env['PATH'])
    }
    return env
  }

  getShellPath(): string {
    const shell = process.env['SHELL']
    if (typeof shell === 'string' && shell.trim().length > 0) return shell
    return '/bin/zsh'
  }

  isPtySupported(): boolean {
    const platform = process.platform
    return platform === 'darwin' || platform === 'linux'
  }

  buildPtyCommand(request: PtyCommandRequest): PtyCommand {
    const rows = sanitizeDimension(request.rows, 24)
    const cols = sanitizeDimension(request.cols, 80)
    const platform = process.platform ?? 'unknown'
    const sttyPreamble = `stty rows ${rows} cols ${cols} 2>/dev/null`
    // See TERMINAL_EXIT_SENTINEL for why the wrapper looks like this.
    const wrap = (scriptInvocation: string): string =>
      `cat 2>/dev/null | { ${scriptInvocation}; st=$?; ` +
      `printf '${TERMINAL_EXIT_SENTINEL}%s\\n' "$st" >&2; kill -9 0 2>/dev/null; }`

    if (platform === 'darwin') {
      // BSD script(1): `script -q -F <file> <command> [args...]` (-F flushes
      // the transcript per write, so a SIGTERM stop cannot truncate it).
      // The /bin/sh trampoline sets the PTY size with stty, then execs the
      // real binary. Every user-influenced value stays OUT of the shell
      // text: the transcript is "$0" and binary+args travel as "$@"
      // positionals, so no quoting or injection concerns arise.
      return {
        command: '/bin/sh',
        args: [
          '-c',
          wrap(
            `/usr/bin/script -q -F "$0" /bin/sh -c '${sttyPreamble}; exec "$0" "$@"' "$@"`,
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
            `/usr/bin/script -qefc ${shellQuote(`${sttyPreamble}; exec ${execCommand}`)} "$0"`,
          ),
          request.transcriptPath,
        ],
      }
    }

    throw new TerminalUnsupportedError(platform)
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
      return await fs.readFile(path, 'utf8')
    } finally {
      try {
        await fs.unlink(path)
      } catch {
        // Best-effort cleanup: a missing/locked temp file is not fatal.
      }
    }
  }

  primeLoginShellPath(): Promise<void> {
    // Defer the capture to a microtask so the promise field is assigned
    // before any inner execCapture -> getBaseEnv call runs; the second call
    // then reuses the pending promise instead of spawning another shell.
    this.loginShellPathPrimed ??= Promise.resolve().then(() => this.captureLoginShellPath())
    return this.loginShellPathPrimed
  }

  private async captureLoginShellPath(): Promise<void> {
    try {
      const result = await this.execCapture(
        this.getShellPath(),
        ['-lc', `echo "${LOGIN_SHELL_PATH_MARKER}$PATH"`],
        LOGIN_SHELL_PATH_TIMEOUT_MS,
      )
      if (result.code !== 0 || result.timedOut) return
      const captured = extractMarkedPathLine(result.stdout)
      if (captured !== undefined) {
        this.loginShellPath = captured
      }
    } catch {
      // Capture failures are non-fatal: getBaseEnv keeps the process PATH.
    }
  }
}
