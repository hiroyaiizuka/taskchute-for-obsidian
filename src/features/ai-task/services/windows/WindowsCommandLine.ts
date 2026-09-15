/**
 * AI Task - Windows command line composition
 *
 * Builds the CreateProcessW command line the ConPTY host launches verbatim,
 * quoting for CommandLineToArgvW. Every token is quoted, matching
 * AiRunLaunchSizeGuard's Windows estimate.
 */

/** Backslashes are doubled only when they precede a double quote. */
export function quoteWindowsArgument(value: string): string {
  assertNoNul(value)
  let quoted = '"'
  let backslashes = 0
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    if (character === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"'
    } else {
      quoted += '\\'.repeat(backslashes) + character
    }
    backslashes = 0
  }
  // A run of backslashes right before the closing quote would escape it.
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

/** argv[0] ends at the next quote and has no escapes, so a quote is rejected. */
export function quoteWindowsProgram(executable: string): string {
  assertNoNul(executable)
  if (executable.length === 0) {
    throw new Error('Windows executable path must not be empty')
  }
  if (executable.includes('"')) {
    throw new Error('Windows executable path must not contain a double quote')
  }
  return `"${executable}"`
}

export function buildWindowsCommandLine(
  executable: string,
  args: readonly string[],
): string {
  return [quoteWindowsProgram(executable), ...args.map(quoteWindowsArgument)].join(' ')
}

function assertNoNul(value: string): void {
  if (value.includes('\0')) {
    throw new Error('Windows command-line tokens must not contain NUL')
  }
}
