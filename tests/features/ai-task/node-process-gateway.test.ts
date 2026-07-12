import { NodeProcessGateway } from '../../../src/features/ai-task/services/NodeProcessGateway'

const ENV_KEYS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'NO_COLOR', 'SHELL'] as const

describe('NodeProcessGateway', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
    }
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  describe('getBaseEnv', () => {
    test('removes Claude Code markers and forces NO_COLOR', () => {
      process.env.CLAUDECODE = '1'
      process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
      delete process.env.NO_COLOR

      const gateway = new NodeProcessGateway()
      const env = gateway.getBaseEnv()

      expect(env.CLAUDECODE).toBeUndefined()
      expect('CLAUDECODE' in env).toBe(false)
      expect('CLAUDE_CODE_ENTRYPOINT' in env).toBe(false)
      expect(env.NO_COLOR).toBe('1')
    })

    test('clones instead of mutating the live environment', () => {
      process.env.CLAUDECODE = '1'

      const gateway = new NodeProcessGateway()
      const env = gateway.getBaseEnv()
      env.EXTRA_MARKER = 'set-by-test'

      expect(process.env.CLAUDECODE).toBe('1')
      expect(process.env.EXTRA_MARKER).toBeUndefined()
    })

    test('preserves unrelated variables', () => {
      process.env.SHELL = '/bin/bash'

      const gateway = new NodeProcessGateway()
      expect(gateway.getBaseEnv().SHELL).toBe('/bin/bash')
    })
  })

  describe('getShellPath', () => {
    test('returns SHELL when set', () => {
      process.env.SHELL = '/opt/homebrew/bin/fish'
      expect(new NodeProcessGateway().getShellPath()).toBe('/opt/homebrew/bin/fish')
    })

    test('falls back to /bin/zsh when SHELL is missing', () => {
      delete process.env.SHELL
      expect(new NodeProcessGateway().getShellPath()).toBe('/bin/zsh')
    })

    test('falls back to /bin/zsh when SHELL is blank', () => {
      process.env.SHELL = '   '
      expect(new NodeProcessGateway().getShellPath()).toBe('/bin/zsh')
    })
  })

  describe('execCapture', () => {
    test('captures stdout, stderr, and the exit code', async () => {
      const gateway = new NodeProcessGateway()
      const result = await gateway.execCapture(
        process.execPath,
        ['-e', 'process.stdout.write("out-data"); process.stderr.write("err-data"); process.exit(3)'],
        10_000,
      )

      expect(result.code).toBe(3)
      expect(result.stdout).toBe('out-data')
      expect(result.stderr).toBe('err-data')
      expect(result.timedOut).toBe(false)
    }, 15_000)

    test('kills the process and reports a timeout when it runs too long', async () => {
      const gateway = new NodeProcessGateway()
      const result = await gateway.execCapture(
        process.execPath,
        ['-e', 'setInterval(function () {}, 1000)'],
        300,
      )

      expect(result.timedOut).toBe(true)
      expect(result.code).toBeNull()
    }, 15_000)

    test('resolves with a null code when the command cannot be spawned', async () => {
      const gateway = new NodeProcessGateway()
      const result = await gateway.execCapture('/nonexistent/fake-binary-for-test', [], 5_000)

      expect(result.code).toBeNull()
      expect(result.stderr).toContain('ENOENT')
    }, 15_000)
  })

  describe('spawnProcess', () => {
    test('streams utf8 stdout chunks and reports the exit code', async () => {
      const gateway = new NodeProcessGateway()
      const handle = gateway.spawnProcess({
        command: process.execPath,
        args: ['-e', 'process.stdout.write("chunk-あ"); process.exit(0)'],
        env: gateway.getBaseEnv(),
      })

      expect(typeof handle.pid).toBe('number')

      let stdout = ''
      handle.onStdout((text) => {
        stdout += text
      })
      const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        handle.onExit((code, signal) => resolve({ code, signal }))
      })

      expect(exit.code).toBe(0)
      expect(exit.signal).toBeNull()
      expect(stdout).toBe('chunk-あ')
    }, 15_000)

    test('reassembles a multibyte character split mid-sequence across stdout writes', async () => {
      const gateway = new NodeProcessGateway()
      const childScript = [
        "const buf = Buffer.from('あ', 'utf8')",
        'process.stdout.write(buf.slice(0, 1))',
        'setTimeout(() => { process.stdout.write(buf.slice(1)) }, 50)',
      ].join('; ')
      const handle = gateway.spawnProcess({
        command: process.execPath,
        args: ['-e', childScript],
        env: gateway.getBaseEnv(),
      })

      let stdout = ''
      handle.onStdout((text) => {
        stdout += text
      })
      await new Promise<void>((resolve) => {
        handle.onExit(() => resolve())
      })

      expect(stdout).toBe('あ')
      expect(stdout).not.toContain('�')
    }, 15_000)

    test('reassembles a multibyte character split mid-sequence across stderr writes', async () => {
      const gateway = new NodeProcessGateway()
      const childScript = [
        "const buf = Buffer.from('日本語', 'utf8')",
        'process.stderr.write(buf.slice(0, 4))',
        'setTimeout(() => { process.stderr.write(buf.slice(4)) }, 50)',
      ].join('; ')
      const handle = gateway.spawnProcess({
        command: process.execPath,
        args: ['-e', childScript],
        env: gateway.getBaseEnv(),
      })

      let stderr = ''
      handle.onStderr((text) => {
        stderr += text
      })
      await new Promise<void>((resolve) => {
        handle.onExit(() => resolve())
      })

      expect(stderr).toBe('日本語')
      expect(stderr).not.toContain('�')
    }, 15_000)
  })
})
