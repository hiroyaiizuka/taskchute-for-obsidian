/**
 * AI Task - CLI binary locator
 *
 * Resolution is platform aware. POSIX primes the interactive login-shell
 * PATH (so GUI-launched apps inherit mise/nvm/nodenv) and probes executables
 * without launching them. Windows never invokes a POSIX shell: it checks
 * `where.exe`, native installers, and the actual npm package payload behind
 * `.cmd` shims. Package JavaScript is launched through node.exe with
 * shell:false so prompts remain argv data, never cmd.exe text.
 */

import type { AiTaskHost } from '../types'
import {
  POSIX_INTERACTIVE_LOGIN_SHELL_FLAG,
  POSIX_LOGIN_SHELL_FLAG,
  type ExecCaptureResult,
  type ProcessGateway,
} from './NodeProcessGateway'

export const WHICH_TIMEOUT_MS = 10_000
export const PROBE_TIMEOUT_MS = 2_000
export const POSIX_BINARY_PATH_MARKER = '__TASKCHUTE_AI_BIN__'

const PROBE_COMMAND = '/bin/test'
const KNOWN_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']
const WINDOWS_PLATFORM = 'win32'

export interface AiBinaryPathOverrides {
  aiTaskClaudePath?: string
  aiTaskCodexPath?: string
}

/** A package-backed CLI needs prefix argv before the host-specific args. */
export interface AiBinaryLaunchSpec {
  binaryPath: string
  argsPrefix: string[]
}

/** Native/POSIX CLIs stay strings for backward compatibility with manager fakes. */
export type AiBinaryResolution = string | AiBinaryLaunchSpec

export interface BinaryLocatorGateway extends Pick<
  ProcessGateway,
  'execCapture' | 'getShellPath' | 'getBaseEnv' | 'primeLoginShellPath'
> {
  getPlatform(): string
  isFile(path: string): Promise<boolean>
}

export class AiBinaryNotFoundError extends Error {
  readonly host: AiTaskHost

  constructor(host: AiTaskHost) {
    super(`Could not locate the ${host} CLI binary`)
    this.name = 'AiBinaryNotFoundError'
    this.host = host
  }
}

function getEnvValue(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const direct = env[name]
  if (direct !== undefined) return direct
  const normalized = name.toLowerCase()
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === normalized)
  return key === undefined ? undefined : env[key]
}

function windowsJoin(root: string | undefined, ...parts: string[]): string {
  if (root === undefined || root.length === 0) return ''
  return [root, ...parts]
    .map((part, index) =>
      index === 0
        ? part.replace(/[\\/]+$/u, '')
        : part.replace(/^[\\/]+|[\\/]+$/gu, ''),
    )
    .join('\\')
}

function windowsDirname(path: string): string {
  const lastSeparator = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return lastSeparator > 0 ? path.slice(0, lastSeparator) : ''
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith('\\\\')
}

function parseWindowsWhereOutput(result: ExecCaptureResult): string[] {
  if (result.code !== 0 || result.timedOut) return []
  const seen = new Set<string>()
  const paths: string[] = []
  for (const line of result.stdout.split(/\r?\n/u)) {
    const candidate = line.trim()
    if (!isWindowsAbsolutePath(candidate)) continue
    const key = candidate.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    paths.push(candidate)
  }
  return paths.sort((left, right) => {
    const leftExe = /\.exe$/iu.test(left)
    const rightExe = /\.exe$/iu.test(right)
    return leftExe === rightExe ? 0 : leftExe ? -1 : 1
  })
}

function dedupeWindowsPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  return paths.filter((path) => {
    if (path.length === 0) return false
    const key = path.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export class BinaryLocator {
  private readonly cache = new Map<AiTaskHost, AiBinaryResolution>()
  private windowsNodePath: string | null | undefined

  constructor(
    private readonly gateway: BinaryLocatorGateway,
    private readonly getOverrides: () => AiBinaryPathOverrides,
  ) {}

  async resolve(host: AiTaskHost): Promise<AiBinaryResolution> {
    // On POSIX this warms the user's real login-shell PATH. The gateway makes
    // the call a no-op on Windows, where `/bin/sh -lc` must never be attempted.
    try {
      await this.gateway.primeLoginShellPath()
    } catch {
      // Children fall back to the process PATH; detection can still work.
    }

    const platform = this.gateway.getPlatform()
    const override = this.readOverride(host)
    if (override !== undefined) {
      if (platform !== WINDOWS_PLATFORM) {
        if (!isWindowsAbsolutePath(override) && (await this.isExistingFile(override))) {
          return override
        }
      } else {
        if (await this.isExistingFile(override)) {
          const normalizedOverride = await this.normalizeWindowsCandidate(host, override)
          if (normalizedOverride !== undefined) return normalizedOverride
        }
      }
      // A stale path (or one synced from another OS) must not disable this
      // machine's auto-detection. The setting is only an advanced fallback.
    }

    const cached = this.cache.get(host)
    if (cached !== undefined) return cached

    const detected =
      platform === WINDOWS_PLATFORM
        ? await this.detectWindows(host)
        : (await this.detectViaPath(host)) ??
          (await this.detectViaShell(host)) ??
          (await this.probeKnownPaths(host))
    if (detected === undefined) {
      throw new AiBinaryNotFoundError(host)
    }
    this.cache.set(host, detected)
    return detected
  }

  invalidateCache(): void {
    this.cache.clear()
    this.windowsNodePath = undefined
  }

  private readOverride(host: AiTaskHost): string | undefined {
    const overrides = this.getOverrides()
    const value = host === 'claude' ? overrides.aiTaskClaudePath : overrides.aiTaskCodexPath
    const trimmed = value?.trim()
    return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
  }

  private async detectViaShell(host: AiTaskHost): Promise<string | undefined> {
    const command =
      `resolved="$(command -v ${host} 2>/dev/null)" && ` +
      `printf '${POSIX_BINARY_PATH_MARKER}%s\\n' "$resolved"`
    for (const flag of [
      POSIX_INTERACTIVE_LOGIN_SHELL_FLAG,
      POSIX_LOGIN_SHELL_FLAG,
    ]) {
      try {
        const result = await this.gateway.execCapture(
          this.gateway.getShellPath(),
          [flag, command],
          WHICH_TIMEOUT_MS,
        )
        if (result.code !== 0 || result.timedOut) continue
        // Interactive rc files often print prompts/version-manager banners,
        // including absolute paths. Only our marked lookup result is trusted.
        const markedLine = result.stdout
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line.startsWith(POSIX_BINARY_PATH_MARKER))
        const detected = markedLine?.slice(POSIX_BINARY_PATH_MARKER.length).trim()
        if (detected?.startsWith('/')) return detected
      } catch {
        // Retry with the login-only form, then fall through to path probes.
      }
    }
    return undefined
  }

  /**
   * `primeLoginShellPath()` has already merged the interactive shell PATH
   * into the child environment. Probe those entries directly instead of
   * sourcing user rc files a second time. This is what finds mise/nvm CLIs
   * from an OS-launched Obsidian process whose original PATH is minimal.
   */
  private async detectViaPath(host: AiTaskHost): Promise<string | undefined> {
    const pathValue = this.gateway.getBaseEnv()['PATH']
    if (pathValue === undefined || pathValue.length === 0) return undefined
    const seen = new Set<string>()
    const candidates: string[] = []
    for (const rawDirectory of pathValue.split(':')) {
      const directory = rawDirectory.trim().replace(/\/+$/u, '')
      if (!directory.startsWith('/') || seen.has(directory)) continue
      seen.add(directory)
      candidates.push(`${directory}/${host}`)
    }
    return await this.probeExecutablePaths(candidates)
  }

  private candidatePaths(host: AiTaskHost): string[] {
    const home = this.gateway.getBaseEnv()['HOME']?.trim()
    const dirs =
      home !== undefined && home.length > 0
        ? [`${home}/.local/bin`, ...KNOWN_BIN_DIRS]
        : [...KNOWN_BIN_DIRS]
    return dirs.map((dir) => `${dir}/${host}`)
  }

  private async probeKnownPaths(host: AiTaskHost): Promise<string | undefined> {
    return await this.probeExecutablePaths(this.candidatePaths(host))
  }

  private async probeExecutablePaths(
    candidates: readonly string[],
  ): Promise<string | undefined> {
    for (const candidate of candidates) {
      try {
        const result = await this.gateway.execCapture(
          PROBE_COMMAND,
          ['-x', candidate],
          PROBE_TIMEOUT_MS,
        )
        if (result.code === 0) return candidate
      } catch {
        // Probe errors mean "not here"; keep trying the next candidate.
      }
    }
    return undefined
  }

  private async detectWindows(host: AiTaskHost): Promise<AiBinaryResolution | undefined> {
    try {
      const result = await this.gateway.execCapture(
        'where.exe',
        [host],
        WHICH_TIMEOUT_MS,
      )
      for (const candidate of parseWindowsWhereOutput(result)) {
        const normalized = await this.normalizeWindowsCandidate(host, candidate)
        if (normalized !== undefined) return normalized
      }
    } catch {
      // Explorer-launched Obsidian can have a stale PATH; known paths follow.
    }
    return await this.probeKnownWindowsPaths(host)
  }

  private async normalizeWindowsCandidate(
    host: AiTaskHost,
    candidate: string,
  ): Promise<AiBinaryResolution | undefined> {
    if (!isWindowsAbsolutePath(candidate)) return undefined
    if (/\.exe$/iu.test(candidate)) return candidate
    if (/\.(?:cjs|js)$/iu.test(candidate)) {
      return await this.wrapWindowsNodeEntrypoint(candidate)
    }
    if (/\.(?:cmd|bat)$/iu.test(candidate)) {
      const shimDirectory = windowsDirname(candidate)
      return host === 'claude'
        ? await this.resolveClaudePackageFromDirectory(shimDirectory)
        : await this.resolveCodexPackageFromDirectory(shimDirectory)
    }
    if (/\.ps1$/iu.test(candidate)) return undefined
    // npm also installs extensionless POSIX shims on Windows. CreateProcess
    // cannot safely execute those as a CLI, so only known native/Node-backed
    // forms are accepted.
    return undefined
  }

  private async probeKnownWindowsPaths(
    host: AiTaskHost,
  ): Promise<AiBinaryResolution | undefined> {
    const env = this.gateway.getBaseEnv()
    const userProfile = getEnvValue(env, 'USERPROFILE')?.trim()
    const localAppData = getEnvValue(env, 'LOCALAPPDATA')?.trim()
    const appData = getEnvValue(env, 'APPDATA')?.trim()
    const programFiles = getEnvValue(env, 'ProgramFiles')?.trim() ?? 'C:\\Program Files'
    const programFilesX86 =
      getEnvValue(env, 'ProgramFiles(x86)')?.trim() ?? 'C:\\Program Files (x86)'

    if (host === 'claude') {
      const native = await this.firstExistingWindowsPath([
        windowsJoin(userProfile, '.claude', 'local', 'claude.exe'),
        windowsJoin(localAppData, 'Claude', 'claude.exe'),
        windowsJoin(programFiles, 'Claude', 'claude.exe'),
        windowsJoin(programFilesX86, 'Claude', 'claude.exe'),
        windowsJoin(userProfile, '.local', 'bin', 'claude.exe'),
        windowsJoin(userProfile, '.volta', 'bin', 'claude.exe'),
        windowsJoin(userProfile, 'scoop', 'shims', 'claude.exe'),
        windowsJoin(localAppData, 'pnpm', 'claude.exe'),
      ])
      if (native !== undefined) return native
    }

    const npmDirectories = dedupeWindowsPaths([
      windowsJoin(appData, 'npm'),
      windowsJoin(userProfile, 'AppData', 'Roaming', 'npm'),
      getEnvValue(env, 'npm_config_prefix')?.trim() ?? '',
      windowsJoin(programFiles, 'nodejs', 'node_global'),
      windowsJoin(programFilesX86, 'nodejs', 'node_global'),
      windowsJoin(userProfile, '.volta', 'tools', 'image', 'packages', host, 'lib'),
      ...this.pnpmGlobalDirectories(localAppData, appData),
    ])
    for (const directory of npmDirectories) {
      const packaged =
        host === 'claude'
          ? await this.resolveClaudePackageFromDirectory(directory)
          : await this.resolveCodexPackageFromDirectory(directory)
      if (packaged !== undefined) return packaged
    }
    return undefined
  }

  private async resolveClaudePackageFromDirectory(
    npmDirectory: string,
  ): Promise<AiBinaryLaunchSpec | undefined> {
    if (npmDirectory.length === 0) return undefined
    const entrypoint = await this.firstExistingWindowsPath([
      windowsJoin(
        npmDirectory,
        'node_modules',
        '@anthropic-ai',
        'claude-code',
        'cli-wrapper.cjs',
      ),
      windowsJoin(
        npmDirectory,
        'node_modules',
        '@anthropic-ai',
        'claude-code',
        'cli.js',
      ),
    ])
    return entrypoint === undefined
      ? undefined
      : await this.wrapWindowsNodeEntrypoint(entrypoint)
  }

  private async resolveCodexPackageFromDirectory(
    npmDirectory: string,
  ): Promise<AiBinaryResolution | undefined> {
    if (npmDirectory.length === 0) return undefined
    const native = await this.firstExistingWindowsPath(
      this.codexNativeCandidates(npmDirectory),
    )
    if (native !== undefined) return native
    const nodeEntrypoint = await this.firstExistingWindowsPath([
      windowsJoin(
        npmDirectory,
        'node_modules',
        '@openai',
        'codex',
        'bin',
        'codex.js',
      ),
    ])
    return nodeEntrypoint === undefined
      ? undefined
      : await this.wrapWindowsNodeEntrypoint(nodeEntrypoint)
  }

  private codexNativeCandidates(npmDirectory: string): string[] {
    const env = this.gateway.getBaseEnv()
    const architecture = (
      getEnvValue(env, 'PROCESSOR_ARCHITEW6432') ??
      getEnvValue(env, 'PROCESSOR_ARCHITECTURE') ??
      ''
    ).toLowerCase()
    const targets = [
      { packageName: 'codex-win32-x64', target: 'x86_64-pc-windows-msvc' },
      { packageName: 'codex-win32-arm64', target: 'aarch64-pc-windows-msvc' },
    ]
    if (architecture.includes('arm64')) targets.reverse()

    const packageRoot = windowsJoin(npmDirectory, 'node_modules', '@openai', 'codex')
    const candidates: string[] = []
    for (const target of targets) {
      const roots = [
        packageRoot,
        windowsJoin(
          npmDirectory,
          'node_modules',
          '@openai',
          target.packageName,
        ),
        windowsJoin(
          packageRoot,
          'node_modules',
          '@openai',
          target.packageName,
        ),
      ]
      for (const root of roots) {
        candidates.push(
          windowsJoin(root, 'vendor', target.target, 'bin', 'codex.exe'),
          windowsJoin(root, 'vendor', target.target, 'codex', 'codex.exe'),
        )
      }
    }
    return dedupeWindowsPaths(candidates)
  }

  private async wrapWindowsNodeEntrypoint(
    entrypoint: string,
  ): Promise<AiBinaryLaunchSpec | undefined> {
    const nodePath = await this.resolveWindowsNodePath()
    return nodePath === undefined
      ? undefined
      : { binaryPath: nodePath, argsPrefix: [entrypoint] }
  }

  private async resolveWindowsNodePath(): Promise<string | undefined> {
    if (this.windowsNodePath !== undefined) return this.windowsNodePath ?? undefined
    try {
      const result = await this.gateway.execCapture(
        'where.exe',
        ['node.exe'],
        WHICH_TIMEOUT_MS,
      )
      const detected = parseWindowsWhereOutput(result).find((path) => /\.exe$/iu.test(path))
      if (detected !== undefined) {
        this.windowsNodePath = detected
        return detected
      }
    } catch {
      // Known paths below cover stale GUI PATH values.
    }

    const env = this.gateway.getBaseEnv()
    const nodePath = await this.firstExistingWindowsPath([
      windowsJoin(getEnvValue(env, 'NVM_SYMLINK')?.trim(), 'node.exe'),
      windowsJoin(getEnvValue(env, 'ProgramFiles')?.trim() ?? 'C:\\Program Files', 'nodejs', 'node.exe'),
      windowsJoin(getEnvValue(env, 'LOCALAPPDATA')?.trim(), 'Programs', 'nodejs', 'node.exe'),
      windowsJoin(getEnvValue(env, 'USERPROFILE')?.trim(), '.volta', 'bin', 'node.exe'),
      windowsJoin(getEnvValue(env, 'USERPROFILE')?.trim(), 'scoop', 'apps', 'nodejs', 'current', 'node.exe'),
    ])
    this.windowsNodePath = nodePath ?? null
    return nodePath
  }

  private async firstExistingWindowsPath(
    candidates: readonly string[],
  ): Promise<string | undefined> {
    for (const candidate of dedupeWindowsPaths(candidates)) {
      try {
        if (await this.gateway.isFile(candidate)) return candidate
      } catch {
        // Inaccessible candidates are ordinary misses.
      }
    }
    return undefined
  }

  private async isExistingFile(candidate: string): Promise<boolean> {
    try {
      return await this.gateway.isFile(candidate)
    } catch {
      return false
    }
  }

  private pnpmGlobalDirectories(
    localAppData: string | undefined,
    appData: string | undefined,
  ): string[] {
    const directories: string[] = []
    // pnpm's global-dir generation is numeric and normally 5 today. Probe a
    // small bounded range so upgrades and older installations still resolve
    // through their linked node_modules directory without executing a .cmd
    // shim (which would reparse prompt text through cmd.exe).
    for (let generation = 1; generation <= 10; generation += 1) {
      directories.push(
        windowsJoin(localAppData, 'pnpm', 'global', String(generation)),
        windowsJoin(appData, 'pnpm', 'global', String(generation)),
      )
    }
    return directories
  }
}
