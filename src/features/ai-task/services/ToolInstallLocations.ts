/**
 * Where Homebrew and the Node.js version managers put executables.
 *
 * Shared by BinaryLocator (stable shims for an AI CLI) and the terminal
 * broker's Node.js lookup, so both honour the same environment overrides —
 * VOLTA_HOME, MISE_DATA_DIR, ASDF_DATA_DIR, NODENV_ROOT, NVM_DIR, FNM_DIR —
 * before the defaults under HOME. Pure: directories only, no file access.
 */

type Env = Readonly<Record<string, string | undefined>>

/** Homebrew on Apple silicon, then Intel Homebrew and other /usr/local installs. */
export const KNOWN_BIN_DIRS: readonly string[] = ['/opt/homebrew/bin', '/usr/local/bin']

function absolute(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\/+$/u, '')
  return trimmed !== undefined && trimmed.startsWith('/') ? trimmed : undefined
}

/** `${override}/${suffix}` then `${HOME}/${homeSuffix}`, skipping unset roots. */
function overrideThenHome(
  env: Env,
  overrideKey: string,
  suffix: string,
  homeSuffixes: readonly string[],
): string[] {
  const directories: string[] = []
  const override = absolute(env[overrideKey])
  if (override) directories.push(suffix ? `${override}/${suffix}` : override)
  const home = absolute(env['HOME'])
  if (home) {
    for (const homeSuffix of homeSuffixes) directories.push(`${home}/${homeSuffix}`)
  }
  return Array.from(new Set(directories))
}

/** Volta's real binaries (not shims). */
export function voltaBinDirectories(env: Env): string[] {
  return overrideThenHome(env, 'VOLTA_HOME', 'bin', ['.volta/bin'])
}

export function miseShimDirectories(env: Env): string[] {
  return overrideThenHome(env, 'MISE_DATA_DIR', 'shims', ['.local/share/mise/shims'])
}

export function asdfShimDirectories(env: Env): string[] {
  return overrideThenHome(env, 'ASDF_DATA_DIR', 'shims', ['.asdf/shims'])
}

export function nodenvShimDirectories(env: Env): string[] {
  return overrideThenHome(env, 'NODENV_ROOT', 'shims', ['.nodenv/shims'])
}

/** Directories that hold one `<version>/bin/node` per nvm-installed Node.js. */
export function nvmVersionRoots(env: Env): string[] {
  return overrideThenHome(env, 'NVM_DIR', 'versions/node', ['.nvm/versions/node'])
}

/** fnm's default-alias bin directory, wherever fnm keeps its data. */
export function fnmDefaultBinDirectories(env: Env): string[] {
  return overrideThenHome(env, 'FNM_DIR', 'aliases/default/bin', [
    '.local/share/fnm/aliases/default/bin',
    'Library/Application Support/fnm/aliases/default/bin',
    '.fnm/aliases/default/bin',
  ])
}
