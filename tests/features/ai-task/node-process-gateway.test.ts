import * as fs from 'fs'
import * as path from 'path'
import { NodeProcessGateway } from '../../../src/features/ai-task/services/NodeProcessGateway'

const ENV_KEYS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'NO_COLOR', 'SHELL', 'PATH'] as const

const FAKE_LOGIN_SHELL = path.join(__dirname, 'fixtures/fake-login-shell.sh')

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

  describe('primeLoginShellPath', () => {
    beforeAll(() => {
      fs.chmodSync(FAKE_LOGIN_SHELL, 0o755)
    })

    test('merges the login-shell PATH ahead of the process PATH', async () => {
      process.env.SHELL = FAKE_LOGIN_SHELL
      const originalPath = process.env.PATH ?? ''

      const gateway = new NodeProcessGateway()
      await gateway.primeLoginShellPath()
      const mergedPath = gateway.getBaseEnv().PATH ?? ''
      const mergedEntries = mergedPath.split(':')

      // Login-shell entries come first, exactly as the fake .zprofile set them.
      expect(mergedEntries[0]).toBe('/fake-login-dir/bin')
      expect(mergedEntries[1]).toBe('/fake-login-dir/sbin')
      // Every original process entry is preserved.
      for (const entry of originalPath.split(':').filter((value) => value.length > 0)) {
        expect(mergedEntries).toContain(entry)
      }
      // No duplicates were introduced by the merge.
      expect(new Set(mergedEntries).size).toBe(mergedEntries.length)
      // Noise lines and the sentinel marker never leak into PATH.
      expect(mergedPath).not.toContain('nvm: loading')
      expect(mergedPath).not.toContain('zlogout:')
      expect(mergedPath).not.toContain('TASKCHUTE')
      // The live process environment is untouched.
      expect(process.env.PATH).toBe(originalPath)
    }, 15_000)

    test('getBaseEnv keeps the process PATH until priming completes', () => {
      process.env.SHELL = FAKE_LOGIN_SHELL

      const gateway = new NodeProcessGateway()
      expect(gateway.getBaseEnv().PATH).toBe(process.env.PATH)
    })

    test('falls back to the process PATH when the login shell cannot run', async () => {
      process.env.SHELL = '/nonexistent/fake-shell-for-test'

      const gateway = new NodeProcessGateway()
      await gateway.primeLoginShellPath()

      expect(gateway.getBaseEnv().PATH).toBe(process.env.PATH)
    }, 15_000)

    test('runs the login shell only once per gateway instance', async () => {
      process.env.SHELL = FAKE_LOGIN_SHELL

      const gateway = new NodeProcessGateway()
      const first = gateway.primeLoginShellPath()
      const second = gateway.primeLoginShellPath()

      expect(second).toBe(first)
      await first
      expect(gateway.primeLoginShellPath()).toBe(first)
    }, 15_000)
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

    test('spawns children with stdin ignored so CLIs never wait on input', async () => {
      const gateway = new NodeProcessGateway()
      // With stdio[0]='ignore' the child's fd 0 is /dev/null (a character
      // device); with a parent-held pipe it would be a FIFO and CLIs like
      // codex would print "Reading additional input from stdin..." and wait.
      const childScript = [
        "const fs = require('fs')",
        'const stat = fs.fstatSync(0)',
        'process.stdout.write(JSON.stringify({ fifo: stat.isFIFO(), chardev: stat.isCharacterDevice() }))',
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

      const stdinInfo = JSON.parse(stdout) as { fifo: boolean; chardev: boolean }
      expect(stdinInfo.fifo).toBe(false)
      expect(stdinInfo.chardev).toBe(true)
    }, 15_000)

    test('swallows the asynchronous pipe error when stdin writes race pipeline teardown', async () => {
      const gateway = new NodeProcessGateway()
      // The child never reads stdin, so large writes stay pending inside
      // libuv; SIGKILL then tears the pipeline down mid-flight and each
      // pending write completes with EPIPE — surfaced as an ASYNC 'error'
      // event on the stdin stream, NOT via the try/catch around write().
      // Without an 'error' listener that event escalates to an uncaught
      // exception ("write EPIPE") and fails this test file.
      const handle = gateway.spawnProcess({
        command: process.execPath,
        args: ['-e', "process.stdout.write('READY'); setTimeout(() => {}, 100000)"],
        env: gateway.getBaseEnv(),
        stdinMode: 'pipe',
      })

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('child never became ready')), 10_000)
        handle.onStdout((text) => {
          if (text.includes('READY')) {
            clearTimeout(timer)
            resolve()
          }
        })
      })

      const bigChunk = 'x'.repeat(1024 * 1024)
      handle.writeStdin?.(bigChunk)
      handle.writeStdin?.(bigChunk)
      handle.kill('SIGKILL')
      // A late keystroke lands after death but before the 'close' event
      // flips the handle's exit guard.
      handle.writeStdin?.('late-keystroke')

      await new Promise<void>((resolve) => {
        handle.onExit(() => resolve())
      })
      // Give still-pending async pipe errors time to surface before the
      // test ends; swallowed errors keep this wait silent.
      await new Promise((resolve) => setTimeout(resolve, 500))
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
