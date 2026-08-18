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

/** Legacy package-backed shape accepted by AiTaskManager test doubles. */
export interface AiBinaryLaunchSpec {
  binaryPath: string
  argsPrefix: string[]
}

export type AiCliLaunchSource =
  | 'manual-override'
  | 'path'
  | 'login-shell'
  | 'known-location'
  | 'package-payload'

export type AiCliPackageManager =
  | 'native'
  | 'npm'
  | 'pnpm'
  | 'homebrew'
  | 'mise'
  | 'asdf'
  | 'nvm'
  | 'volta'
  | 'scoop'
  | 'winget'
  | 'apt'
  | 'dnf'
  | 'apk'
  | 'unknown'

/**
 * A validated, diagnostics-friendly launch plan. Production resolution
 * always returns this shape. The executable path is deliberately lexical:
 * stable shims/symlinks must not be realpath-resolved to a version directory.
 */
export interface AiCliLaunchSpec {
  executable: string
  argvPrefix: readonly string[]
  envPatch: Readonly<Record<string, string | undefined>>
  source: AiCliLaunchSource
  packageManager: AiCliPackageManager
  resolvedAt: number
  pathFingerprint: string
  requiredFiles: readonly string[]
  /**
   * Fixed allowlisted command name used by a fresh POSIX login shell for the
   * final terminal lookup. It is never derived from task/prompt text.
   */
  terminalCommand?: AiTaskHost
}

/** Legacy shapes remain accepted at the manager boundary during migration. */
export type AiBinaryResolution =
  | string
  | AiBinaryLaunchSpec
  | AiCliLaunchSpec

export interface AiBinaryResolveOptions {
  forceRefresh?: boolean
}

export interface BinaryLocatorGateway extends Pick<
  ProcessGateway,
  | 'execCapture'
  | 'getShellPath'
  | 'getBaseEnv'
  | 'primeLoginShellPath'
  | 'refreshLoginShellPath'
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
  private readonly cache = new Map<AiTaskHost, AiCliLaunchSpec>()
  private readonly inFlight = new Map<
    AiTaskHost,
    { operation: Promise<AiCliLaunchSpec>; forceRefresh: boolean }
  >()
  private windowsNodePath: string | null | undefined

  constructor(
    private readonly gateway: BinaryLocatorGateway,
    private readonly getOverrides: () => AiBinaryPathOverrides,
  ) {}

  resolve(
    host: AiTaskHost,
    options: AiBinaryResolveOptions = {},
  ): Promise<AiCliLaunchSpec> {
    const current = this.inFlight.get(host)
    if (current !== undefined) {
      if (!options.forceRefresh || current.forceRefresh) {
        return current.operation
      }
      // A recovery refresh must not inherit a stale result from a normal
      // lookup already in flight. Wait for it to settle, then perform one
      // forced pass; subsequent forced callers coalesce with that pass.
      return current.operation
        .catch(() => undefined)
        .then(() => this.resolve(host, { forceRefresh: true }))
    }
    const operation = this.resolveSingle(host, options).finally(() => {
      if (this.inFlight.get(host)?.operation === operation) {
        this.inFlight.delete(host)
      }
    })
    this.inFlight.set(host, {
      operation,
      forceRefresh: options.forceRefresh === true,
    })
    return operation
  }

  private async resolveSingle(
    host: AiTaskHost,
    options: AiBinaryResolveOptions,
  ): Promise<AiCliLaunchSpec> {
    const platform = this.gateway.getPlatform()
    // Refresh for every new launch. GUI apps otherwise keep the PATH captured
    // before a package-manager update for their whole renderer lifetime.
    try {
      if (platform === WINDOWS_PLATFORM) {
        await this.gateway.primeLoginShellPath()
      } else {
        await (
          this.gateway.refreshLoginShellPath?.() ??
          this.gateway.primeLoginShellPath()
        )
      }
    } catch {
      // The gateway keeps the last successful login PATH. Detection can still
      // use it (or the process PATH) when a shell is temporarily unavailable.
    }

    const pathFingerprint = this.makePathFingerprint(platform)
    const override = this.readOverride(host)
    if (override !== undefined) {
      if (platform !== WINDOWS_PLATFORM) {
        if (
          !isWindowsAbsolutePath(override) &&
          (await this.isExecutablePath(override, platform))
        ) {
          return this.makeLaunchSpec(
            host,
            override,
            'manual-override',
            pathFingerprint,
          )
        }
      } else {
        if (await this.isExistingFile(override)) {
          const normalizedOverride = await this.normalizeWindowsCandidate(host, override)
          if (normalizedOverride !== undefined) {
            return this.makeLaunchSpec(
              host,
              normalizedOverride,
              'manual-override',
              pathFingerprint,
            )
          }
        }
      }
      // A stale path (or one synced from another OS) must not disable this
      // machine's auto-detection. The setting is only an advanced fallback.
    }

    const cached = this.cache.get(host)
    if (
      !options.forceRefresh &&
      cached !== undefined &&
      (await this.isCachedSpecValid(cached, pathFingerprint, platform))
    ) {
      return cached
    }
    this.cache.delete(host)

    let detected: AiBinaryResolution | undefined
    let source: AiCliLaunchSource
    if (platform === WINDOWS_PLATFORM) {
      detected = await this.detectWindows(host)
      source = 'package-payload'
    } else {
      detected = await this.detectViaPath(host)
      source = 'path'
      if (detected === undefined) {
        detected = await this.detectViaShell(host)
        source = 'login-shell'
      }
      if (detected === undefined) {
        detected = await this.probeKnownPaths(host)
        source = 'known-location'
      }
    }
    if (detected === undefined) {
      throw new AiBinaryNotFoundError(host)
    }
    const stableDetected =
      platform === WINDOWS_PLATFORM
        ? detected
        : await this.preferStableFacade(host, detected)
    const spec = this.makeLaunchSpec(
      host,
      stableDetected,
      source,
      pathFingerprint,
    )
    this.cache.set(host, spec)
    return spec
  }

  invalidateCache(host?: AiTaskHost): void {
    if (host === undefined) {
      this.cache.clear()
      this.windowsNodePath = undefined
      return
    }
    this.cache.delete(host)
    // node.exe is shared, but validating it on the next Windows resolution
    // is inexpensive and avoids retaining a replaced version-manager image.
    this.windowsNodePath = undefined
  }

  private makePathFingerprint(platform: string): string {
    const env = this.gateway.getBaseEnv()
    const path =
      platform === WINDOWS_PLATFORM
        ? getEnvValue(env, 'PATH') ?? ''
        : env['PATH'] ?? ''
    return `${platform}\0${path}`
  }

  private makeLaunchSpec(
    host: AiTaskHost,
    resolution: AiBinaryResolution,
    source: AiCliLaunchSource,
    pathFingerprint: string,
  ): AiCliLaunchSpec {
    if (this.isLaunchSpec(resolution)) return resolution
    const executable =
      typeof resolution === 'string' ? resolution : resolution.binaryPath
    const argvPrefix =
      typeof resolution === 'string' ? [] : [...resolution.argsPrefix]
    const requiredFiles = [executable, ...argvPrefix.filter((value) =>
      value.startsWith('/') || isWindowsAbsolutePath(value),
    )]
    return Object.freeze({
      executable,
      argvPrefix: Object.freeze(argvPrefix),
      envPatch: Object.freeze({}),
      source,
      packageManager: this.classifyPackageManager(executable, argvPrefix),
      resolvedAt: Date.now(),
      pathFingerprint,
      requiredFiles: Object.freeze(requiredFiles),
      ...(source === 'path' || source === 'login-shell'
        ? { terminalCommand: host }
        : {}),
    })
  }

  private isLaunchSpec(value: AiBinaryResolution): value is AiCliLaunchSpec {
    return typeof value === 'object' && value !== null && 'executable' in value
  }

  private async isCachedSpecValid(
    spec: AiCliLaunchSpec,
    pathFingerprint: string,
    platform: string,
  ): Promise<boolean> {
    if (spec.pathFingerprint !== pathFingerprint) return false
    for (let index = 0; index < spec.requiredFiles.length; index += 1) {
      const candidate = spec.requiredFiles[index]
      const valid =
        index === 0
          ? await this.isExecutablePath(candidate, platform)
          : await this.isExistingFile(candidate)
      if (!valid) return false
    }
    return true
  }

  private async isExecutablePath(
    candidate: string,
    platform: string,
  ): Promise<boolean> {
    if (platform === WINDOWS_PLATFORM) return this.isExistingFile(candidate)
    if (!candidate.startsWith('/') || candidate.includes('\0')) return false
    if (!(await this.isExistingFile(candidate))) return false
    try {
      const result = await this.gateway.execCapture(
        PROBE_COMMAND,
        ['-x', candidate],
        PROBE_TIMEOUT_MS,
      )
      return result.code === 0 && !result.timedOut
    } catch {
      return false
    }
  }

  private async preferStableFacade(
    host: AiTaskHost,
    resolution: AiBinaryResolution,
  ): Promise<AiBinaryResolution> {
    if (typeof resolution !== 'string') return resolution
    const env = this.gateway.getBaseEnv()
    const home = env['HOME']?.replace(/\/+$/u, '')
    const candidates: string[] = []
    if (resolution.includes('/mise/installs/')) {
      const miseData = env['MISE_DATA_DIR']?.replace(/\/+$/u, '')
      if (miseData) candidates.push(`${miseData}/shims/${host}`)
      if (home) candidates.push(`${home}/.local/share/mise/shims/${host}`)
    }
    if (resolution.includes('/.asdf/installs/')) {
      const asdfData = env['ASDF_DATA_DIR']?.replace(/\/+$/u, '')
      if (asdfData) candidates.push(`${asdfData}/shims/${host}`)
      if (home) candidates.push(`${home}/.asdf/shims/${host}`)
    }
    if (resolution.includes('/.volta/tools/')) {
      const voltaHome = env['VOLTA_HOME']?.replace(/\/+$/u, '')
      if (voltaHome) candidates.push(`${voltaHome}/bin/${host}`)
      if (home) candidates.push(`${home}/.volta/bin/${host}`)
    }
    if (resolution.includes('/Cellar/') || resolution.includes('/homebrew/Cellar/')) {
      candidates.push(`/opt/homebrew/bin/${host}`, `/usr/local/bin/${host}`)
    }
    return (await this.probeExecutablePaths(candidates)) ?? resolution
  }

  private classifyPackageManager(
    executable: string,
    argvPrefix: readonly string[],
  ): AiCliPackageManager {
    const joined = [executable, ...argvPrefix].join('\n').toLowerCase()
    if (joined.includes('/mise/') || joined.includes('\\mise\\')) return 'mise'
    if (joined.includes('/.asdf/') || joined.includes('\\.asdf\\')) return 'asdf'
    if (joined.includes('/.nvm/') || joined.includes('\\nvm\\')) return 'nvm'
    if (joined.includes('/.volta/') || joined.includes('\\.volta\\')) return 'volta'
    if (joined.includes('/cellar/') || joined.includes('/homebrew/')) return 'homebrew'
    if (joined.includes('\\scoop\\')) return 'scoop'
    if (joined.includes('\\winget\\') || joined.includes('\\windowsapps\\')) return 'winget'
    if (joined.includes('/pnpm/') || joined.includes('\\pnpm\\')) return 'pnpm'
    if (joined.includes('node_modules') || /[\\/]npm[\\/]/u.test(joined)) return 'npm'
    if (/^\/(?:usr|opt)\/bin\//u.test(executable)) return 'native'
    if (executable.includes('/.local/bin/') || executable.includes('\\.local\\bin\\')) {
      return 'native'
    }
    return 'unknown'
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
    if (typeof this.windowsNodePath === 'string') {
      if (await this.isExistingFile(this.windowsNodePath)) {
        return this.windowsNodePath
      }
      this.windowsNodePath = undefined
    }
    // Negative results are deliberately not retained. A user can install or
    // update Node while Obsidian stays open, and the next task must recover.
    if (this.windowsNodePath === null) this.windowsNodePath = undefined
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
    this.windowsNodePath = nodePath
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
