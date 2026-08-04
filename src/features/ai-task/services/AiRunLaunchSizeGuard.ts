/**
 * Cross-platform launch-size guard for AI CLI requests.
 *
 * Windows CreateProcess has a 32,767 UTF-16 command-line limit. POSIX
 * terminal mode transports the same request as real argv through a fixed
 * login-shell bootstrap. We conservatively estimate both representations,
 * reserve room for host-owned flags, and use the larger value. Keeping the
 * accepted envelope below 30,000 makes the preflight portable while still
 * allowing substantially larger prompts than the task UI normally creates.
 */

/** Conservative ceiling below Windows' 32,767 UTF-16 command-line limit. */
export const AI_RUN_MAX_LAUNCH_SIZE = 30_000

/** Room for Claude/Codex flags that their dispatchers add after preflight. */
const HOST_ARGV_RESERVE = 1_024

export interface AiRunLaunchSizeInput {
  binaryPath: string
  binaryArgsPrefix?: readonly string[]
  extraArgs?: readonly string[]
  prompt: string
}

export class AiRunLaunchTooLargeError extends Error {
  readonly estimatedSize: number
  readonly limit: number

  constructor(estimatedSize: number, limit = AI_RUN_MAX_LAUNCH_SIZE) {
    super(
      `AI task launch request is too large (${estimatedSize}; maximum ${limit})`,
    )
    this.name = 'AiRunLaunchTooLargeError'
    this.estimatedSize = estimatedSize
    this.limit = limit
  }
}

function utf8Length(value: string): number {
  let bytes = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x7f) bytes += 1
    else if (codePoint <= 0x7ff) bytes += 2
    else if (codePoint <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}

/** UTF-8 bytes after TerminalDispatcher's POSIX single-quote escaping. */
function posixQuotedLength(value: string): number {
  let bytes = 2 // surrounding single quotes
  for (const character of value) {
    bytes += character === "'" ? 4 : utf8Length(character)
  }
  return bytes
}

/**
 * UTF-16 units after the standard Windows argv quoting algorithm.
 * Quoting every token is conservative even when CreateProcess could pass a
 * simple token verbatim.
 */
function windowsQuotedLength(value: string): number {
  let units = 2 // surrounding double quotes
  let backslashes = 0
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === '\\') {
      backslashes += 1
      continue
    }
    if (character === '"') {
      units += backslashes * 2 + 2
    } else {
      units += backslashes + 1
    }
    backslashes = 0
  }
  // Backslashes immediately before the closing quote must be doubled.
  return units + backslashes * 2
}

function requestTokens(input: AiRunLaunchSizeInput): string[] {
  return [
    input.binaryPath,
    ...(input.binaryArgsPrefix ?? []),
    ...(input.extraArgs ?? []),
    ...(input.prompt.length > 0 ? ['--', input.prompt] : []),
  ]
}

/** Estimate the larger of the POSIX-shell and Windows command-line shapes. */
export function estimateAiRunLaunchSize(input: AiRunLaunchSizeInput): number {
  const tokens = requestTokens(input)
  const separators = Math.max(0, tokens.length - 1)
  const posix =
    tokens.reduce((total, token) => total + posixQuotedLength(token), 0) +
    separators +
    HOST_ARGV_RESERVE
  const windows =
    tokens.reduce((total, token) => total + windowsQuotedLength(token), 0) +
    separators +
    HOST_ARGV_RESERVE
  return Math.max(posix, windows)
}

/** Fail closed during preflight, before TaskChute starts its timer. */
export function assertAiRunLaunchSize(input: AiRunLaunchSizeInput): void {
  const estimatedSize = estimateAiRunLaunchSize(input)
  if (estimatedSize > AI_RUN_MAX_LAUNCH_SIZE) {
    throw new AiRunLaunchTooLargeError(estimatedSize)
  }
}
