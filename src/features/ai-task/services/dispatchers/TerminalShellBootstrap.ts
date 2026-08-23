export const TERMINAL_ARGV_BOOTSTRAP_MARKER =
  'TASKCHUTE_AI_ARGV_BOOTSTRAP_V1'
export const TERMINAL_ARGV_BOOTSTRAP_ARG_ZERO = 'taskchute-ai'

/**
 * Fixed POSIX bootstrap for shell-backed AI terminals.
 *
 * User-controlled argv is passed after the `-c` program as positional
 * parameters. It must never be concatenated into this program or written as
 * an initial terminal line: macOS canonical TTY input is limited to 1,024
 * bytes and would silently truncate a long/multibyte prompt.
 */
export const POSIX_TERMINAL_BOOTSTRAP = [
  `_taskchute_marker=${TERMINAL_ARGV_BOOTSTRAP_MARKER}`,
  '_taskchute_shell=$1',
  '_taskchute_resolved=$2',
  '_taskchute_command=$3',
  '_taskchute_fallback=$4',
  '_taskchute_prefix_count=$5',
  'shift 5',
  '_taskchute_mode=',
  '_taskchute_candidate=',
  'if [ -n "$_taskchute_command" ]; then',
  '  _taskchute_candidate=$(command -v "$_taskchute_command" 2>/dev/null || :)',
  'fi',
  'if [ -n "$_taskchute_candidate" ] && [ -x "$_taskchute_candidate" ]; then',
  '  _taskchute_executable=$_taskchute_candidate',
  '  _taskchute_mode=command',
  'elif [ -x "$_taskchute_resolved" ]; then',
  '  _taskchute_executable=$_taskchute_resolved',
  '  _taskchute_mode=resolved',
  'else',
  '  _taskchute_candidate=',
  '  if [ -n "$_taskchute_fallback" ]; then',
  '    _taskchute_candidate=$(command -v "$_taskchute_fallback" 2>/dev/null || :)',
  '  fi',
  '  if [ -n "$_taskchute_candidate" ] && [ -x "$_taskchute_candidate" ]; then',
  '    _taskchute_executable=$_taskchute_candidate',
  '    _taskchute_mode=command',
  '  elif [ -e "$_taskchute_resolved" ]; then',
  '    printf "TaskChute AI CLI is not executable: %s\\n" "$_taskchute_resolved" >&2',
  '    exit 126',
  '  else',
  '    printf "TaskChute AI CLI was not found: %s\\n" "${_taskchute_command:-$_taskchute_resolved}" >&2',
  '    exit 127',
  '  fi',
  'fi',
  // The PTY can deliver Ctrl+C to both the CLI and this `-c` shell when job
  // control is unavailable. A caught trap is reset to the default disposition
  // for the external CLI, so the CLI still receives SIGINT while the parent
  // survives long enough to replace itself with the normal interactive shell.
  "trap ':' INT",
  'if [ "$_taskchute_mode" = resolved ]; then',
  '  "$_taskchute_executable" "$@"',
  'else',
  '  shift "$_taskchute_prefix_count"',
  '  "$_taskchute_executable" "$@"',
  'fi',
  'trap - INT',
  // Keep the PTY alive after Claude/Codex exits. The replacement shell reads
  // the same login/interactive startup files and gives the user a normal
  // prompt in the existing terminal session.
  'exec "$_taskchute_shell" -i -l',
].join('\n')

/**
 * fish exposes every token after `-c PROGRAM` through `$argv` (there is no
 * POSIX-style `$0`). Let fish load the user's startup environment, then hand
 * the unchanged argv to the audited POSIX bootstrap.
 */
export const FISH_TERMINAL_BOOTSTRAP = [
  `set -l _taskchute_marker ${TERMINAL_ARGV_BOOTSTRAP_MARKER}`,
  `exec /bin/sh -c "$argv[1]" ${TERMINAL_ARGV_BOOTSTRAP_ARG_ZERO} $argv[2..-1]`,
].join('\n')

const LOGIN_SHELL_ARGS: readonly string[] = ['-i', '-l']
const POSIX_SHELL_NAMES = new Set([
  'ash',
  'bash',
  'dash',
  'ksh',
  'mksh',
  'sh',
  'zsh',
])

export interface TerminalShellLaunch {
  binaryPath: string
  args: string[]
}

function assertNoNul(value: string): void {
  if (value.includes('\0')) {
    throw new Error('Terminal launch tokens must not contain NUL bytes')
  }
}

function shellName(shellPath: string): string {
  const normalized = shellPath.replace(/\\/gu, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
}

/**
 * Build an argv-only login-shell launch.
 *
 * The validated absolute executable may require `binaryArgsPrefix` (for
 * example `node` + a package entrypoint). A fresh login-shell command or the
 * fixed host fallback does not, so the bootstrap drops exactly that prefix
 * only for command-name launches.
 */
export function buildTerminalShellLaunch(
  shellPath: string,
  resolvedPath: string,
  binaryArgsPrefix: readonly string[],
  args: readonly string[],
  terminalCommand?: 'claude' | 'codex',
  fallbackCommand?: 'claude' | 'codex',
): TerminalShellLaunch {
  const dataTokens = [
    shellPath,
    resolvedPath,
    terminalCommand ?? '',
    fallbackCommand ?? '',
    ...binaryArgsPrefix,
    ...args,
  ]
  for (const token of dataTokens) assertNoNul(token)

  const name = shellName(shellPath)
  if (name === 'fish') {
    return {
      binaryPath: shellPath,
      args: [
        ...LOGIN_SHELL_ARGS,
        '-c',
        FISH_TERMINAL_BOOTSTRAP,
        POSIX_TERMINAL_BOOTSTRAP,
        shellPath,
        resolvedPath,
        terminalCommand ?? '',
        fallbackCommand ?? '',
        String(binaryArgsPrefix.length),
        ...binaryArgsPrefix,
        ...args,
      ],
    }
  }

  // Unknown shells may not understand POSIX syntax. Use /bin/sh for the fixed
  // bootstrap while still returning to the user's configured shell after the
  // CLI exits. PATH was already captured from that login shell by the gateway.
  const bootstrapShell = POSIX_SHELL_NAMES.has(name) ? shellPath : '/bin/sh'
  return {
    binaryPath: bootstrapShell,
    args: [
      ...LOGIN_SHELL_ARGS,
      '-c',
      POSIX_TERMINAL_BOOTSTRAP,
      TERMINAL_ARGV_BOOTSTRAP_ARG_ZERO,
      shellPath,
      resolvedPath,
      terminalCommand ?? '',
      fallbackCommand ?? '',
      String(binaryArgsPrefix.length),
      ...binaryArgsPrefix,
      ...args,
    ],
  }
}
