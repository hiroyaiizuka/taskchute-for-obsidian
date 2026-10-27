/**
 * Where the terminal broker's Node.js runtime is looked for.
 *
 * The broker runs as `node -e <program>`. Obsidian launched from the Dock or
 * Finder inherits launchd's PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), which holds
 * no `node` at all on a stock Mac. Spawning the bare name then fails with
 * ENOENT, and the client used to poll five seconds for a broker that could
 * never start — every + terminal and split went red without a word until some
 * AI task happened to capture the login shell's PATH.
 *
 * So the broker gets an absolute path instead: the first `node` on the PATH
 * the client already has (process PATH plus the login-shell PATH once it has
 * been captured), then the places Node installers and version managers put
 * one (ToolInstallLocations, shared with BinaryLocator and honouring the same
 * environment overrides). Real binaries come before shims, because a
 * version-manager shim fails when no version is selected for the broker's
 * working directory.
 *
 * Pure: the file system arrives as a probe, so the search order is testable on
 * any host. Windows looks for node.exe on its PATH and in the Node.js
 * installer's folder; finding none there means terminals run without the
 * broker (see the ai-task index).
 */

import {
  asdfShimDirectories,
  fnmDefaultBinDirectories,
  KNOWN_BIN_DIRS,
  miseShimDirectories,
  nodenvShimDirectories,
  nvmVersionRoots,
  voltaBinDirectories,
} from './ToolInstallLocations'

export interface NodeExecutableProbe {
  /** Whether `path` is a regular file this user can execute. */
  isExecutableFile(path: string): boolean
  /** Entry names of a directory, or [] when it cannot be read. */
  listDirectory(path: string): string[]
}

type Env = Readonly<Record<string, string | undefined>>

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/u

function nodeIn(directory: string): string {
  return `${directory.replace(/\/+$/u, '')}/node`
}

function parseVersion(name: string): number[] | null {
  const match = name.match(VERSION_PATTERN)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function compareVersionsDescending(left: number[], right: number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** nvm keeps one directory per version; newer installs are tried first. */
function nvmCandidates(env: Env, probe: NodeExecutableProbe): string[] {
  return nvmVersionRoots(env).flatMap((root) =>
    probe
      .listDirectory(root)
      .map((name) => ({ name, version: parseVersion(name) }))
      .filter((entry): entry is { name: string; version: number[] } => entry.version !== null)
      .sort((left, right) => compareVersionsDescending(left.version, right.version))
      .map((entry) => nodeIn(`${root}/${entry.name}/bin`)),
  )
}

/** The first executable `node` on a colon-separated PATH, if any. */
export function findNodeOnPath(
  pathValue: string | undefined,
  probe: NodeExecutableProbe,
): string | undefined {
  for (const directory of (pathValue ?? '').split(':')) {
    // An empty or relative entry means "the current directory", which for a
    // GUI app is wherever it was launched from — never a place to run from.
    if (!directory.startsWith('/')) continue
    const candidate = nodeIn(directory)
    if (probe.isExecutableFile(candidate)) return candidate
  }
  return undefined
}

/** Executable `node` binaries outside the PATH, most dependable first. */
export function findNodeInKnownLocations(env: Env, probe: NodeExecutableProbe): string[] {
  const candidates = [
    ...[...KNOWN_BIN_DIRS, '/usr/bin'].map(nodeIn),
    ...voltaBinDirectories(env).map(nodeIn),
    ...nvmCandidates(env, probe),
    ...fnmDefaultBinDirectories(env).map(nodeIn),
    ...miseShimDirectories(env).map(nodeIn),
    ...nodenvShimDirectories(env).map(nodeIn),
    ...asdfShimDirectories(env).map(nodeIn),
  ]
  return candidates.filter((candidate) => probe.isExecutableFile(candidate))
}

/** Windows variable names ignore case; a copied env object does not. */
function windowsEnv(env: Env, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

/** `C:\dir` or `\\server\share`: never a relative entry. */
function isAbsoluteWindowsDirectory(directory: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(directory) || directory.startsWith('\\\\')
}

function nodeExeIn(directory: string): string {
  return `${directory.replace(/[\\/]+$/u, '')}\\node.exe`
}

/**
 * Windows: node.exe on the semicolon-separated PATH, then the folders the
 * Node.js installer (Program Files\nodejs) and nvm-windows (NVM_SYMLINK)
 * use, which a PATH edited after Obsidian started does not show yet.
 */
export function findWindowsNodeExecutables(env: Env, probe: NodeExecutableProbe): string[] {
  const directories = (windowsEnv(env, 'PATH') ?? '')
    .split(';')
    .map((entry) => entry.trim().replace(/^"(.*)"$/u, '$1'))
    .filter(isAbsoluteWindowsDirectory)
  for (const name of ['PROGRAMFILES', 'NVM_SYMLINK']) {
    const value = windowsEnv(env, name)
    if (value === undefined || !isAbsoluteWindowsDirectory(value)) continue
    directories.push(name === 'PROGRAMFILES' ? `${value.replace(/[\\/]+$/u, '')}\\nodejs` : value)
  }
  const found: string[] = []
  for (const candidate of directories.map(nodeExeIn)) {
    const known = found.some((entry) => entry.toLowerCase() === candidate.toLowerCase())
    if (!known && probe.isExecutableFile(candidate)) found.push(candidate)
  }
  return found
}

/**
 * Every Node.js the broker may be started with, in the order to try them.
 * Empty means no Node.js could be found.
 */
export function listNodeExecutableCandidates(
  platform: string,
  env: Env,
  probe: NodeExecutableProbe,
): string[] {
  if (platform === 'win32') return findWindowsNodeExecutables(env, probe)
  const ordered = [findNodeOnPath(env['PATH'], probe), ...findNodeInKnownLocations(env, probe)]
  const unique: string[] = []
  for (const candidate of ordered) {
    if (candidate !== undefined && !unique.includes(candidate)) unique.push(candidate)
  }
  return unique
}
