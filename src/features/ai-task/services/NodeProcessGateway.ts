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

export interface SpawnProcessRequest {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string | undefined>
}

export interface SpawnedProcessHandle {
  pid?: number
  onStdout(callback: (text: string) => void): void
  onStderr(callback: (text: string) => void): void
  onExit(callback: (code: number | null, signal: string | null) => void): void
  kill(signal: NodeKillSignal): void
}

export interface ExecCaptureResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

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
}

// --- Minimal structural types for the child_process module -----------------

interface NodeReadableLike {
  on(event: 'data', listener: (chunk: unknown) => void): void
  setEncoding(encoding: string): void
}

interface NodeWritableLike {
  end(): void
}

interface NodeChildProcessLike {
  pid?: number
  stdout: NodeReadableLike | null
  stderr: NodeReadableLike | null
  stdin: NodeWritableLike | null
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
    },
  ): NodeChildProcessLike
}

function loadChildProcessModule(): ChildProcessModuleLike {
  // eslint-disable-next-line import/no-nodejs-modules
  return require('child_process') as ChildProcessModuleLike
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
    try {
      // detached:true makes the child a process-group leader (POSIX) so
      // kill() below can signal the WHOLE group: if the CLI ignores SIGTERM
      // and spawned its own tool subprocesses, the SIGKILL escalation still
      // reaps the grandchildren instead of leaving orphans behind.
      child = loadChildProcessModule().spawn(request.command, request.args, {
        cwd: request.cwd,
        env: request.env,
        detached: true,
        windowsHide: true,
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
      try {
        child.stdin?.end()
      } catch {
        // stdin may already be closed; nothing to clean up
      }
    }

    const failedChild = child === null

    return {
      pid: child?.pid,
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
