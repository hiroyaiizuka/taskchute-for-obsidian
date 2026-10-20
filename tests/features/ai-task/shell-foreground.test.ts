/**
 * LEV-376: what runs in the foreground of a shell session — read from one
 * `ps` call over the sessions' ttys — and the monitor that asks while shell
 * sessions are alive.
 */
import {
  PS_COLUMNS,
  parseForegroundSnapshot,
  parsePsRows,
  programNameFromArgs,
} from '@/features/ai-task/services/terminal-title/foregroundSnapshot'
import { createShellForegroundProbe } from '@/features/ai-task/services/terminal-title/ShellForegroundProbe'
import {
  SHELL_FOREGROUND_POLL_MS,
  SHELL_FOREGROUND_PROMPT_POLL_MS,
  ShellForegroundMonitor,
} from '@/features/ai-task/services/terminal-title/ShellForegroundMonitor'
import type { ShellForegroundSample } from '@/features/ai-task/services/terminal-title/foregroundSnapshot'
import type { ShellForegroundProbe } from '@/features/ai-task/services/terminal-title/ShellForegroundProbe'

// pid ppid pgid tpgid stat tty args — captured on macOS from a TaskChute
// shell session: the supervisor sh leads the session, zsh is its child in a
// group of its own, and Claude Code (npm install) runs as zsh's job.
const SUPERVISOR = '29428 29427 29428 TPGID Ss   ttys017  /bin/sh -c tty > "$TASKCHUTE_AI_TTY_PATH"; exec "$@"'
const ZSH = '29431 29428 29431 TPGID S    ttys017  /bin/zsh -i -l'
const at = (tpgid: number, ...lines: string[]) =>
  parsePsRows(lines.map((line) => line.replace('TPGID', String(tpgid))).join('\n'))

describe('parseForegroundSnapshot', () => {
  test('the shell at its prompt: nothing runs', () => {
    expect(parseForegroundSnapshot(at(29431, SUPERVISOR, ZSH))).toEqual({ program: null })
  })

  test("a job the shell started is the program, named from its command line", () => {
    const rows = at(
      39066,
      SUPERVISOR,
      ZSH,
      '39066 29431 39066 39066 S+ ttys017 /Users/me/.local/share/mise/installs/npm-anthropic-ai-claude-code/2.1.303/bin/claude -- weekly review',
      '39395 39066 39066 39066 S+ ttys017 node /Users/me/.npm/_npx/e84/node_modules/.bin/freee-mcp',
    )
    expect(parseForegroundSnapshot(rows)).toEqual({ program: { pid: 39066, name: 'Claude Code' } })
  })

  test('a shell script in the foreground is a program, not the prompt', () => {
    const rows = at(500, SUPERVISOR, ZSH, '500 29431 500 500 S+ ttys017 bash ./build.sh --release')
    expect(parseForegroundSnapshot(rows)).toEqual({ program: { pid: 500, name: 'build.sh' } })
  })

  test('without job control the program shares the home group and is still told apart', () => {
    // fish-style bootstrap: `exec /bin/sh -c` runs the agent in the session leader's group.
    const rows = at(
      29428,
      SUPERVISOR,
      '600 29428 29428 29428 S+ ttys017 node /usr/local/lib/node_modules/@openai/codex/bin/codex.js',
      '601 600 29428 29428 S+ ttys017 /usr/local/lib/node_modules/@openai/codex/vendor/codex',
    )
    expect(parseForegroundSnapshot(rows)).toEqual({ program: { pid: 600, name: 'Codex' } })
  })

  test('a group whose leader already exited speaks through its oldest member', () => {
    const rows = at(700, SUPERVISOR, ZSH, '705 29431 700 700 S+ ttys017 sleep 5', '709 29431 700 700 S+ ttys017 tail -f log')
    expect(parseForegroundSnapshot(rows)).toEqual({ program: { pid: 705, name: 'sleep' } })
  })

  test('no session leader, no foreground group, or nobody in it: cannot tell', () => {
    expect(parseForegroundSnapshot([])).toBeNull()
    expect(parseForegroundSnapshot(at(29431, ZSH.replace('S ', 'S+')))).toBeNull()
    expect(parseForegroundSnapshot(at(999, SUPERVISOR, ZSH))).toBeNull()
    expect(parseForegroundSnapshot(at(-1, SUPERVISOR, ZSH))).toBeNull()
  })
})

describe('programNameFromArgs', () => {
  test('known agents, whichever way they were installed', () => {
    expect(programNameFromArgs('claude')).toBe('Claude Code')
    expect(programNameFromArgs('/Users/me/.local/share/claude/versions/2.1.114')).toBeUndefined()
    expect(programNameFromArgs('node /opt/lib/node_modules/@anthropic-ai/claude-code/cli.js')).toBe('Claude Code')
    expect(programNameFromArgs('node /usr/local/bin/codex resume abc')).toBe('Codex')
    expect(programNameFromArgs('/Users/me/Library/Application Support/Claude/claude-code/2.1.295/claude.app/Contents/MacOS/claude --verbose')).toBe('Claude Code')
    expect(programNameFromArgs('cursor-agent -p')).toBe('Cursor')
  })

  test('never a bare launcher, flag or version number', () => {
    expect(programNameFromArgs('node')).toBeUndefined()
    expect(programNameFromArgs('python3 -m http.server')).toBe('http.server')
    expect(programNameFromArgs('2.1.114 --resume x')).toBe('x')
    expect(programNameFromArgs('vim notes.md')).toBe('vim')
    expect(programNameFromArgs('-zsh')).toBeUndefined()
  })
})

describe('createShellForegroundProbe', () => {
  function setup(stdout: string, code: number | null = 0) {
    const ttys: Record<string, string> = { '/tmp/a.log': '/dev/ttys017', '/tmp/b.log': '/dev/ttys018' }
    const readTtyPath = jest.fn<Promise<string | null>, [string]>(async (path) => ttys[path] ?? null)
    const execCapture = jest.fn(async () => ({ code, stdout, stderr: '', timedOut: false }))
    const probe = createShellForegroundProbe({ readTtyPath, execCapture })
    return { probe, readTtyPath, execCapture }
  }

  const BOTH = [
    '10 9 10 11 Ss ttys017 /bin/sh -c x',
    '11 10 11 11 S+ ttys017 /bin/zsh -i -l',
    '20 19 20 30 Ss ttys018 /bin/sh -c x',
    '21 20 21 30 S ttys018 /bin/zsh -i -l',
    '30 21 30 30 S+ ttys018 codex',
  ].join('\n')

  test('one ps call answers every session, split by tty; ttys are read once', async () => {
    const { probe, readTtyPath, execCapture } = setup(BOTH)
    const answers = await probe(['/tmp/a.log', '/tmp/b.log', '/tmp/missing.log'])
    expect(answers.get('/tmp/a.log')).toEqual({ program: null })
    expect(answers.get('/tmp/b.log')).toEqual({ program: { pid: 30, name: 'Codex' } })
    expect(answers.get('/tmp/missing.log')).toBeNull()
    expect(execCapture).toHaveBeenCalledTimes(1)
    expect(execCapture).toHaveBeenCalledWith('/bin/ps', ['-t', 'ttys017,ttys018', '-o', PS_COLUMNS], expect.any(Number))

    await probe(['/tmp/a.log', '/tmp/b.log'])
    expect(readTtyPath).toHaveBeenCalledTimes(3)
  })

  test('a failed ps answers "cannot tell" for everyone and re-reads the ttys next time', async () => {
    const { probe, readTtyPath } = setup('', 1)
    const answers = await probe(['/tmp/a.log'])
    expect(answers.get('/tmp/a.log')).toBeNull()
    await probe(['/tmp/a.log'])
    expect(readTtyPath).toHaveBeenCalledTimes(2)
  })

  test('no sidecar yet: no ps at all', async () => {
    const { probe, execCapture } = setup(BOTH)
    expect((await probe(['/tmp/missing.log'])).get('/tmp/missing.log')).toBeNull()
    expect(execCapture).not.toHaveBeenCalled()
  })
})

describe('ShellForegroundMonitor', () => {
  class FakeTimer {
    now = 0
    private nextId = 1
    readonly pending = new Map<number, { at: number; handler: () => void }>()
    setTimeout = (handler: () => void, ms: number): number => {
      const id = this.nextId++
      this.pending.set(id, { at: this.now + ms, handler })
      return id
    }
    clearTimeout = (id: number): void => {
      this.pending.delete(id)
    }
    /** Advance time and fire whatever came due. */
    async advance(ms: number): Promise<void> {
      this.now += ms
      for (const [id, entry] of Array.from(this.pending)) {
        if (entry.at <= this.now) {
          this.pending.delete(id)
          entry.handler()
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  function setup(answer: ShellForegroundSample | null = { program: { pid: 1, name: 'Claude Code' } }) {
    const timer = new FakeTimer()
    const probe = jest.fn<ReturnType<ShellForegroundProbe>, Parameters<ShellForegroundProbe>>(
      async (paths) => new Map(paths.map((path) => [path, answer])),
    )
    const onSample = jest.fn()
    let probeAvailable = true
    const monitor = new ShellForegroundMonitor({
      getProbe: () => (probeAvailable ? probe : undefined),
      timer,
      now: () => timer.now,
      onSample,
    })
    return { timer, probe, onSample, monitor, setProbeAvailable: (v: boolean) => (probeAvailable = v) }
  }

  test('one probe call per tick covers every session; soon after tracking, then every interval', async () => {
    const { timer, probe, onSample, monitor } = setup()
    monitor.track('run-1', '/tmp/a.log')
    monitor.track('run-2', '/tmp/b.log')
    await timer.advance(SHELL_FOREGROUND_PROMPT_POLL_MS)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith(['/tmp/a.log', '/tmp/b.log'])
    expect(onSample).toHaveBeenCalledWith('run-1', { program: { pid: 1, name: 'Claude Code' } }, SHELL_FOREGROUND_PROMPT_POLL_MS)
    expect(onSample).toHaveBeenCalledTimes(2)

    await timer.advance(SHELL_FOREGROUND_POLL_MS)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  test('"cannot tell" is delivered as null, so it is not mistaken for the prompt', async () => {
    const { timer, onSample, monitor } = setup(null)
    monitor.track('run-1', '/tmp/a.log')
    await timer.advance(SHELL_FOREGROUND_PROMPT_POLL_MS)
    expect(onSample).toHaveBeenCalledWith('run-1', null, SHELL_FOREGROUND_PROMPT_POLL_MS)
  })

  test('stops when the last session is untracked, and after dispose', async () => {
    const { timer, probe, monitor } = setup()
    monitor.track('run-1', '/tmp/a.log')
    monitor.untrack('run-1')
    expect(timer.pending.size).toBe(0)
    await timer.advance(SHELL_FOREGROUND_POLL_MS * 3)
    expect(probe).not.toHaveBeenCalled()

    monitor.track('run-2', '/tmp/b.log')
    monitor.dispose()
    expect(timer.pending.size).toBe(0)
    monitor.track('run-3', '/tmp/c.log')
    expect(timer.pending.size).toBe(0)
  })

  test('keeps ticking while the probe is gone, and resumes when it is back', async () => {
    const { timer, probe, monitor, setProbeAvailable } = setup()
    setProbeAvailable(false)
    monitor.track('run-1', '/tmp/a.log')
    await timer.advance(SHELL_FOREGROUND_PROMPT_POLL_MS)
    await timer.advance(SHELL_FOREGROUND_POLL_MS)
    expect(probe).not.toHaveBeenCalled()
    expect(timer.pending.size).toBe(1)
    setProbeAvailable(true)
    await timer.advance(SHELL_FOREGROUND_POLL_MS)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  test('pollSoon brings the next poll forward', async () => {
    const { timer, probe, monitor } = setup()
    monitor.track('run-1', '/tmp/a.log')
    await timer.advance(SHELL_FOREGROUND_PROMPT_POLL_MS)
    monitor.pollSoon()
    await timer.advance(SHELL_FOREGROUND_PROMPT_POLL_MS)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  test('a session untracked while ps ran gets no late answer', async () => {
    const { timer, probe, onSample, monitor } = setup()
    let release: (value: Map<string, ShellForegroundSample | null>) => void = () => undefined
    probe.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    monitor.track('run-1', '/tmp/a.log')
    await timer.advance(SHELL_FOREGROUND_PROMPT_POLL_MS)
    monitor.untrack('run-1')
    release(new Map([['/tmp/a.log', { program: null }]]))
    await timer.advance(0)
    expect(onSample).not.toHaveBeenCalled()
  })
})
