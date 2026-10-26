import { programNameFromWindowsCommandLine } from '@/features/ai-task/services/terminal-title/foregroundSnapshot'
import {
  WINDOWS_FOREGROUND_STALENESS_MS,
  createWindowsShellForegroundProbe,
  parseWindowsForeground,
} from '@/features/ai-task/services/terminal-title/WindowsShellForegroundProbe'

describe('programNameFromWindowsCommandLine', () => {
  test.each([
    ['"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js', 'Claude Code'],
    ['C:\\WINDOWS\\system32\\cmd.exe /d /s /c ""C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd" "', 'Claude Code'],
    ['"C:\\Users\\me\\.local\\bin\\claude.exe" --resume 1234', 'Claude Code'],
    ['C:\\WINDOWS\\system32\\cmd.exe /d /s /c ""C:\\Program Files\\nodejs\\npm.cmd" run build"', 'npm'],
    ['"C:\\Program Files\\Git\\cmd\\git.exe" log', 'git'],
    ['C:\\WINDOWS\\system32\\PING.EXE -n 9 127.0.0.1', 'PING'],
    // No /s and one quoted path: cmd keeps the quotes.
    ['cmd.exe /c "C:\\Program Files\\Example\\server.exe"', 'server'],
    ['cmd /c "title E2E title&& ping -n 9 127.0.0.1 >nul"', 'title'],
    // A quoted command with arguments is a wrapper, even with a path in it.
    ['cmd.exe /c "git -C C:\\repo log"', 'git'],
    ['cmd.exe /c "C:\\Windows\\System32\\ping.exe -n 9 127.0.0.1"', 'ping'],
  ])('%s → %s', (commandLine, name) => {
    expect(programNameFromWindowsCommandLine(commandLine)).toBe(name)
  })

  test('nothing meaningful left: no name, so the tab says "Terminal"', () => {
    expect(programNameFromWindowsCommandLine('')).toBeUndefined()
    expect(programNameFromWindowsCommandLine('"C:\\Program Files\\nodejs\\node.exe"')).toBeUndefined()
  })
})

describe('parseWindowsForeground', () => {
  test('an empty line: the shell is at its prompt', () => {
    expect(parseWindowsForeground('\n')).toEqual({ program: null })
  })

  test('pid and command line: that program runs', () => {
    expect(parseWindowsForeground('4242\t1700000000000\t"C:\\Program Files\\Git\\cmd\\git.exe" log\n')).toEqual({
      program: { pid: 4242, name: 'git', startedAt: 1700000000000 },
    })
  })

  test('a broken line cannot be told', () => {
    expect(parseWindowsForeground('not-a-pid\t1700000000000\tgit\n')).toBeNull()
    expect(parseWindowsForeground('4242\tgit\n')).toBeNull()
  })
})

describe('createWindowsShellForegroundProbe', () => {
  test('answers per session, and "cannot tell" while the sidecar is missing', async () => {
    const files: Record<string, string> = {
      'a.log': '\n',
      'b.log': '7\t1700000000000\tC:\\WINDOWS\\system32\\PING.EXE\n',
    }
    const probe = createWindowsShellForegroundProbe({
      readForeground: async (path) => files[path] ?? null,
      now: () => 10_000,
    })

    const answers = await probe(['a.log', 'b.log', 'c.log'])

    // The host refreshes the file every second: the answer is as of a moment ago.
    const observedAt = 10_000 - WINDOWS_FOREGROUND_STALENESS_MS
    expect(answers.get('a.log')).toEqual({ program: null, observedAt })
    expect(answers.get('b.log')).toEqual({
      program: { pid: 7, name: 'PING', startedAt: 1700000000000 },
      observedAt,
    })
    expect(answers.get('c.log')).toBeNull()
  })
})
