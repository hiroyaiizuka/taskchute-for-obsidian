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

/**
 * Format one filesystem path as a single POSIX shell token, followed by the
 * space a user would normally type before the next argument.
 *
 * NUL can neither appear in a POSIX argv entry nor be represented safely by
 * the terminal transport, so it is rejected instead of silently truncating.
 */
export function formatWorkspacePathForTerminal(path: string): string {
  for (const character of path) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      throw new Error('Workspace path must not contain control characters')
    }
  }
  return `'${path.replace(/'/g, POSIX_SINGLE_QUOTE_ESCAPE)}' `
}
