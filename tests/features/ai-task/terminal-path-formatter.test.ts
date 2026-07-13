import {
  WORKSPACE_PATH_DRAG_MIME,
  formatWorkspacePathForTerminal,
} from '../../../src/features/ai-task/services/TerminalPathFormatter'

describe('formatWorkspacePathForTerminal', () => {
  test('exports a feature-specific drag MIME type', () => {
    expect(WORKSPACE_PATH_DRAG_MIME).toBe('application/x-taskchute-workspace-path')
  })

  test('single-quotes a path and appends one insertion space', () => {
    expect(formatWorkspacePathForTerminal('/tmp/My Project/read me.md')).toBe(
      "'/tmp/My Project/read me.md' ",
    )
  })

  test('escapes an embedded single quote without exposing shell metacharacters', () => {
    expect(formatWorkspacePathForTerminal("/tmp/it's;$(touch pwned).md")).toBe(
      "'/tmp/it'\"'\"'s;$(touch pwned).md' ",
    )
  })

  test('rejects NUL instead of writing a truncated path to the terminal', () => {
    expect(() => formatWorkspacePathForTerminal('/tmp/safe\0hidden')).toThrow(
      'control',
    )
  })

  test.each([
    ['ETX', '\u0003'],
    ['tab', '\t'],
    ['line feed', '\n'],
    ['carriage return', '\r'],
    ['escape', '\u001b'],
    ['delete', '\u007f'],
  ])('rejects %s before the TTY can interpret it', (_label, control) => {
    expect(() =>
      formatWorkspacePathForTerminal(`/tmp/before${control}after`),
    ).toThrow('control')
  })
})
