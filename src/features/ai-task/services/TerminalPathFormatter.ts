/**
 * Workspace Files drag payload MIME type.
 *
 * A feature-specific type prevents unrelated application/json drags from
 * being interpreted as terminal input. UI integrations may additionally set
 * text/plain for interoperability, but should read this type first.
 */
export const WORKSPACE_PATH_DRAG_MIME =
  'application/x-taskchute-workspace-path'

const POSIX_SINGLE_QUOTE_ESCAPE = `'"'"'`

export interface TerminalPathFormatOptions {
  /** Windows paths are full of backslashes; its terminals run no fish. */
  windows?: boolean
}

/**
 * Format one filesystem path as a single POSIX shell token, followed by the
 * space a user would normally type before the next argument.
 *
 * NUL can neither appear in a POSIX argv entry nor be represented safely by
 * the terminal transport, so it is rejected instead of silently truncating.
 *
 * Off Windows, a backslash is rejected too: fish reads \' and \\ as escapes
 * even inside single quotes, so a crafted file name could end the quoting
 * early and run the rest as a command there (LEV-387). Such names are rare.
 */
export function formatWorkspacePathForTerminal(
  path: string,
  options: TerminalPathFormatOptions = {},
): string {
  for (const character of path) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      throw new Error('Workspace path must not contain control characters')
    }
  }
  if (options.windows !== true && path.includes('\\')) {
    throw new Error('Workspace path must not contain a backslash')
  }
  return `'${path.replace(/'/g, POSIX_SINGLE_QUOTE_ESCAPE)}' `
}
