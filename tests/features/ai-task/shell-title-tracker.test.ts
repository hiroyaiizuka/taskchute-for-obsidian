/**
 * LEV-376: the name a shell session's tab shows — the program running in it
 * (its title, else its name), and nothing once the shell is back at its
 * prompt — plus the name of every run's tab.
 */
import {
  SHELL_FOREGROUND_FAILURE_LIMIT,
  ShellTitleTracker,
  resolveShellTerminalLabel,
} from '@/features/ai-task/services/terminal-title/ShellTitleTracker'
import { runTabLabel } from '@/features/ai-task/ui/runTabLabel'
import type { AiRunRecord } from '@/features/ai-task/types'

const ESC = '\u001b'
const BEL = '\u0007'
const title = (text: string) => `${ESC}]0;${text}${BEL}`
const CLAUDE = { pid: 100, name: 'Claude Code' }
const VIM = { pid: 200, name: 'vim' }

function shellRecord(overrides: Partial<AiRunRecord> = {}): AiRunRecord {
  return {
    id: 'shell-1',
    taskPath: '',
    taskName: 'ターミナル',
    host: 'shell',
    status: 'running',
    mode: 'terminal',
    startedAt: 0,
    events: [],
    ...overrides,
  }
}

describe('resolveShellTerminalLabel', () => {
  test('a running program: its title, else its name, else nothing', () => {
    expect(resolveShellTerminalLabel({ title: 'ID63 書き直し', foreground: CLAUDE, detecting: true })).toBe('ID63 書き直し')
    expect(resolveShellTerminalLabel({ title: undefined, foreground: { pid: 1, name: 'Codex' }, detecting: true })).toBe('Codex')
    expect(resolveShellTerminalLabel({ title: undefined, foreground: { pid: 1, name: undefined }, detecting: true })).toBeUndefined()
  })

  test('at the prompt, or not answered yet: no name', () => {
    expect(resolveShellTerminalLabel({ title: '~/notes', foreground: null, detecting: true })).toBeUndefined()
    expect(resolveShellTerminalLabel({ title: 'x', foreground: undefined, detecting: true })).toBeUndefined()
  })

  test('without foreground detection the latest title is kept', () => {
    expect(resolveShellTerminalLabel({ title: 'kept', foreground: undefined, detecting: false })).toBe('kept')
  })
})

describe('ShellTitleTracker', () => {
  function setup() {
    let now = 1000
    const tracker = new ShellTitleTracker(() => now)
    return { tracker, tick: (ms: number) => (now += ms), now: () => now }
  }

  test('Claude Code in a + terminal: its name, then its conversation, then "Terminal" again', () => {
    const { tracker, tick, now } = setup()
    const record = shellRecord()

    // The title arrives before the first answer: stored, the tab waits.
    expect(tracker.handleOutput(record, title('✳ Claude Code'), true)).toEqual({ changed: true, pollSoon: true })
    expect(record.terminalTitle).toBe('Claude Code')
    expect(record.terminalLabel).toBeUndefined()

    tick(250)
    expect(tracker.handleSample(record, { program: CLAUDE }, now())).toBe(true)
    expect(record.terminalLabel).toBe('Claude Code')

    // While it runs, a new title relabels the tab at once.
    tick(100)
    expect(tracker.handleOutput(record, `out ${title('⠂ ID63 書き直し')}`, true)).toEqual({ changed: true, pollSoon: true })
    expect(record.terminalLabel).toBe('ID63 書き直し')

    // /exit: back at the prompt, the title goes with the program.
    tick(2000)
    expect(tracker.handleSample(record, { program: null }, now())).toBe(true)
    expect(record.terminalLabel).toBeUndefined()
    expect(record.terminalTitle).toBeUndefined()
  })

  test('spinner frames that clean to the same title neither relabel nor ask again', () => {
    const { tracker, now } = setup()
    const record = shellRecord()
    tracker.handleSample(record, { program: CLAUDE }, now())
    tracker.handleOutput(record, title('⠂ ID63 書き直し'), true)
    expect(tracker.handleOutput(record, title('⠐ ID63 書き直し'), true)).toEqual({ changed: false, pollSoon: false })
    expect(tracker.handleOutput(record, title('✳ ID63 書き直し'), true)).toEqual({ changed: false, pollSoon: false })
  })

  test("another program in the foreground drops the last one's title", () => {
    const { tracker, tick, now } = setup()
    const record = shellRecord()
    tracker.handleSample(record, { program: CLAUDE }, now())
    tick(10)
    tracker.handleOutput(record, title('ID63 書き直し'), true)
    // Claude quit and vim started between two answers.
    tick(2000)
    tracker.handleSample(record, { program: VIM }, now())
    expect(record.terminalTitle).toBeUndefined()
    expect(record.terminalLabel).toBe('vim')
  })

  test('a title set at the prompt is claimed by the program the next answer sees', () => {
    const { tracker, tick, now } = setup()
    const record = shellRecord()
    tracker.handleSample(record, { program: null }, now())
    tick(10)
    tracker.handleOutput(record, title('E2E title'), true)
    expect(record.terminalLabel).toBeUndefined()
    tick(250)
    tracker.handleSample(record, { program: { pid: 300, name: 'sleep' } }, now())
    expect(record.terminalLabel).toBe('E2E title')
    tick(2000)
    tracker.handleSample(record, { program: { pid: 300, name: 'sleep' } }, now())
    expect(record.terminalLabel).toBe('E2E title')
  })

  test('a title that arrived while ps ran is kept for the next answer to judge', () => {
    const { tracker, tick, now } = setup()
    const record = shellRecord()
    tracker.handleSample(record, { program: null }, now())
    const probeStartedAt = now()
    tick(5)
    tracker.handleOutput(record, title('next program'), true)
    tracker.handleSample(record, { program: null }, probeStartedAt)
    expect(record.terminalTitle).toBe('next program')
    tracker.handleSample(record, { program: VIM }, now())
    expect(record.terminalLabel).toBe('next program')
  })

  test("titles the shell sets for itself at the prompt never reach the tab", () => {
    const { tracker, tick, now } = setup()
    const record = shellRecord()
    tracker.handleSample(record, { program: null }, now())
    tick(10)
    tracker.handleOutput(record, title('~/orca'), true)
    expect(record.terminalLabel).toBeUndefined()
    tick(2000)
    tracker.handleSample(record, { program: null }, now())
    expect(record.terminalTitle).toBeUndefined()
  })

  test("a title newer than when the answer was last true is kept (Windows' sidecar)", () => {
    const { tracker, tick, now } = setup()
    const record = shellRecord()
    tracker.handleSample(record, { program: null }, now())
    tick(1000)
    tracker.handleOutput(record, title('E2E title'), true)
    tick(200)
    // The sidecar still says "at the prompt": it was written before cmd started.
    tracker.handleSample(record, { program: null, observedAt: now() - 1500 }, now())
    expect(record.terminalTitle).toBe('E2E title')
    tick(2000)
    tracker.handleSample(record, { program: { pid: 300, name: 'cmd' }, observedAt: now() - 1500 }, now())
    expect(record.terminalLabel).toBe('E2E title')
  })

  test('back to back: a title that came after the next program started is its own', () => {
    const { tracker, tick, now } = setup()
    const record = shellRecord()
    tracker.handleSample(record, { program: { pid: 300, name: 'git' } }, now())
    // git exits; npm starts and names itself before an answer shows npm.
    tick(500)
    const npmStartedAt = now()
    tick(100)
    tracker.handleOutput(record, title('npm run build'), true)
    tick(2000)
    tracker.handleSample(record, { program: { pid: 400, name: 'npm', startedAt: npmStartedAt } }, now())
    expect(record.terminalTitle).toBe('npm run build')
    tick(2000)
    tracker.handleSample(record, { program: { pid: 400, name: 'npm', startedAt: npmStartedAt } }, now())
    expect(record.terminalLabel).toBe('npm run build')
  })

  test('a title from before the next program started still goes with the one before', () => {
    const { tracker, tick, now } = setup()
    const record = shellRecord()
    tracker.handleSample(record, { program: CLAUDE }, now())
    tick(10)
    tracker.handleOutput(record, title('ID63 書き直し'), true)
    tick(500)
    const vimStartedAt = now()
    tick(1500)
    tracker.handleSample(record, { program: { ...VIM, startedAt: vimStartedAt } }, now())
    expect(record.terminalTitle).toBeUndefined()
    expect(record.terminalLabel).toBe('vim')
  })

  test("the shell's own path as a title is no title (PowerShell on Windows)", () => {
    const { tracker, tick, now } = setup()
    const record = shellRecord()
    const pwsh = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'
    tracker.handleOutput(record, title('C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.9.0_x64\\pwsh.exe'), true, pwsh)
    tracker.handleSample(record, { program: { pid: 300, name: 'ping' } }, now())
    tick(10)
    tracker.handleOutput(record, title('C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.9.0_x64\\pwsh.exe'), true, pwsh)
    expect(record.terminalTitle).toBeUndefined()
    expect(record.terminalLabel).toBe('ping')
    // A title that merely mentions the shell is a program's.
    tracker.handleOutput(record, title('pwsh.exe tips'), true, pwsh)
    expect(record.terminalLabel).toBe('pwsh.exe tips')
  })

  test('a program with no title and no meaningful name leaves "Terminal"', () => {
    const { tracker, now } = setup()
    const record = shellRecord()
    tracker.handleSample(record, { program: { pid: 1, name: undefined } }, now())
    expect(record.terminalLabel).toBeUndefined()
  })

  test('when the foreground cannot be told, titles reach the tab after a few failures', () => {
    const { tracker, tick, now } = setup()
    const record = shellRecord()
    expect(tracker.handleOutput(record, title('vim notes.md'), true).pollSoon).toBe(true)
    expect(record.terminalLabel).toBeUndefined()
    for (let attempt = 1; attempt < SHELL_FOREGROUND_FAILURE_LIMIT; attempt += 1) {
      tracker.handleSample(record, null, now())
      expect(record.terminalLabel).toBeUndefined()
    }
    tracker.handleSample(record, null, now())
    expect(record.terminalLabel).toBe('vim notes.md')
    // Detection given up: new titles are shown as they come (a new title still asks once more).
    expect(tracker.handleOutput(record, title('other'), true)).toEqual({ changed: true, pollSoon: true })
    expect(record.terminalLabel).toBe('other')
    // An answer again: back to detecting.
    tick(10)
    tracker.handleSample(record, { program: null }, now())
    expect(record.terminalLabel).toBeUndefined()
  })

  test('without a probe the latest title is the name', () => {
    const { tracker } = setup()
    const record = shellRecord()
    tracker.handleOutput(record, title('vim notes.md'), false)
    expect(record.terminalLabel).toBe('vim notes.md')
  })

  test('a restored name stays until the first answer, which judges it', () => {
    const { tracker, now } = setup()
    const record = shellRecord({ terminalTitle: 'ID63 書き直し', terminalLabel: 'ID63 書き直し' })
    expect(tracker.handleOutput(record, 'plain replay', true).changed).toBe(false)
    expect(record.terminalLabel).toBe('ID63 書き直し')
    tracker.handleSample(record, { program: CLAUDE }, now())
    expect(record.terminalLabel).toBe('ID63 書き直し')
  })
})

describe('runTabLabel', () => {
  const fallback = { terminal: 'ターミナル', untitled: '無題の実行' }

  test("an AI task's tab carries its task name, terminal or headless", () => {
    expect(runTabLabel({ host: 'claude', taskName: 'AI デイリーレビュー' }, fallback)).toBe('AI デイリーレビュー')
    expect(runTabLabel({ host: 'codex', taskName: '  ' }, fallback)).toBe('無題の実行')
  })

  test("a shell's tab: what runs in it, else the session's own name", () => {
    expect(runTabLabel({ host: 'shell', taskName: 'ターミナル', terminalLabel: 'Codex' }, fallback)).toBe('Codex')
    expect(runTabLabel({ host: 'shell', taskName: 'ターミナル' }, fallback)).toBe('ターミナル')
    expect(runTabLabel({ host: 'shell', taskName: '👑 引っ越しの準備' }, fallback)).toBe('👑 引っ越しの準備')
    expect(runTabLabel({ host: 'shell', taskName: '' }, fallback)).toBe('ターミナル')
  })
})
