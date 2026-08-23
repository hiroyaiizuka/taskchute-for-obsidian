import * as fs from 'fs'
import * as path from 'path'
import {
  NodeProcessGateway,
  POSIX_INTERACTIVE_LOGIN_SHELL_FLAG,
  POSIX_LOGIN_SHELL_FLAG,
  buildWindowsTaskkillArgs,
} from '../../../src/features/ai-task/services/NodeProcessGateway'

const ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'NO_COLOR',
  'SHELL',
  'PATH',
  'COMSPEC',
  'SystemRoot',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'NVM_SYMLINK',
  'FNM_MULTISHELL_PATH',
  'FNM_DIR',
  'npm_config_prefix',
  'ChocolateyInstall',
] as const

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

    test('augments a stale Windows GUI PATH with common CLI manager directories', () => {
      process.env.PATH = 'C:\\Windows\\System32;C:\\Users\\tester\\.VOLTA\\bin'
      process.env.USERPROFILE = 'C:\\Users\\tester'
      process.env.LOCALAPPDATA = 'C:\\Users\\tester\\AppData\\Local'
      process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming'
      process.env.FNM_MULTISHELL_PATH = 'C:\\Users\\tester\\AppData\\Local\\fnm_multishells\\42'
      process.env.ChocolateyInstall = 'C:\\ProgramData\\chocolatey'

      const env = new NodeProcessGateway(undefined, 'win32').getBaseEnv()
      const entries = (env.PATH ?? '').split(';')

      expect(entries).toEqual(expect.arrayContaining([
        'C:\\Users\\tester\\.local\\bin',
        'C:\\Users\\tester\\.volta\\bin',
        'C:\\Users\\tester\\scoop\\shims',
        'C:\\Users\\tester\\AppData\\Local\\pnpm',
        'C:\\Users\\tester\\AppData\\Roaming\\npm',
        'C:\\Users\\tester\\AppData\\Local\\fnm_multishells\\42',
        'C:\\ProgramData\\chocolatey\\bin',
        'C:\\Windows\\System32',
      ]))
      expect(entries.filter((entry) => entry.toLowerCase() === 'c:\\users\\tester\\.volta\\bin'))
        .toHaveLength(1)
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

      // Interactive-shell entries come first, as mise/nvm activation from
      // .zshrc would set them in a real GUI-launched Obsidian session.
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

    test('falls back to login-only flags when the shell rejects interactive mode', async () => {
      const gateway = new NodeProcessGateway()
      const execCapture = jest.spyOn(gateway, 'execCapture')
      execCapture
        .mockResolvedValueOnce({ code: 2, stdout: '', stderr: 'unsupported', timedOut: false })
        .mockResolvedValueOnce({
          code: 0,
          stdout: 'shell noise\n__TASKCHUTE_AI_PATH__/fallback/bin:/usr/bin\nlogout noise\n',
          stderr: '',
          timedOut: false,
        })

      await gateway.primeLoginShellPath()

      expect(execCapture.mock.calls[0]?.[1]?.[0]).toBe(POSIX_INTERACTIVE_LOGIN_SHELL_FLAG)
      expect(execCapture.mock.calls[1]?.[1]?.[0]).toBe(POSIX_LOGIN_SHELL_FLAG)
      expect(gateway.getBaseEnv().PATH?.split(':')[0]).toBe('/fallback/bin')
    })

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

    test('refreshLoginShellPath captures a changed PATH after initial priming', async () => {
      const gateway = new NodeProcessGateway()
      const execCapture = jest.spyOn(gateway, 'execCapture')
      execCapture
        .mockResolvedValueOnce({
          code: 0,
          stdout: '__TASKCHUTE_AI_PATH__/versions/1/bin:/usr/bin\n',
          stderr: '',
          timedOut: false,
        })
        .mockResolvedValueOnce({
          code: 0,
          stdout: '__TASKCHUTE_AI_PATH__/versions/2/bin:/usr/bin\n',
          stderr: '',
          timedOut: false,
        })

      await gateway.primeLoginShellPath()
      expect(gateway.getBaseEnv().PATH?.split(':')[0]).toBe('/versions/1/bin')
      await gateway.refreshLoginShellPath()
      expect(gateway.getBaseEnv().PATH?.split(':')[0]).toBe('/versions/2/bin')
    })

    test('coalesces concurrent PATH refreshes and preserves the last good PATH on failure', async () => {
      const gateway = new NodeProcessGateway()
      const execCapture = jest.spyOn(gateway, 'execCapture')
      execCapture.mockResolvedValueOnce({
        code: 0,
        stdout: '__TASKCHUTE_AI_PATH__/stable/bin:/usr/bin\n',
        stderr: '',
        timedOut: false,
      })
      await gateway.primeLoginShellPath()

      let release: (() => void) | undefined
      execCapture.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({ code: 1, stdout: '', stderr: 'temporary', timedOut: false })
          }),
      )
      // The login-only fallback also fails after the shared first attempt.
      execCapture.mockResolvedValueOnce({
        code: 1,
        stdout: '',
        stderr: 'temporary',
        timedOut: false,
      })
      const first = gateway.refreshLoginShellPath()
      const second = gateway.refreshLoginShellPath()
      expect(second).toBe(first)
      await Promise.resolve()
      release?.()
      await first

      expect(gateway.getBaseEnv().PATH?.split(':')[0]).toBe('/stable/bin')
    })

    test('is a no-op on win32 instead of trying to launch /bin/sh', async () => {
      const gateway = new NodeProcessGateway(undefined, 'win32')
      const execCapture = jest.spyOn(gateway, 'execCapture')

      await gateway.primeLoginShellPath()

      expect(execCapture).not.toHaveBeenCalled()
    })
  })

  describe('getShellPath', () => {
    test('returns SHELL when set', () => {
      process.env.SHELL = '/opt/homebrew/bin/fish'
      expect(new NodeProcessGateway().getShellPath()).toBe('/opt/homebrew/bin/fish')
    })

    test('falls back to the POSIX-guaranteed /bin/sh when SHELL is missing', () => {
      delete process.env.SHELL
      expect(new NodeProcessGateway().getShellPath()).toBe('/bin/sh')
    })

    test('falls back to the POSIX-guaranteed /bin/sh when SHELL is blank', () => {
      process.env.SHELL = '   '
      expect(new NodeProcessGateway().getShellPath()).toBe('/bin/sh')
    })

    test('uses COMSPEC on win32 and never returns a POSIX shell', () => {
      process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe'
      expect(new NodeProcessGateway(undefined, 'win32').getShellPath()).toBe(
        'C:\\Windows\\System32\\cmd.exe',
      )
    })

    test('uses the SystemRoot cmd.exe fallback on win32 when COMSPEC is missing', () => {
      delete process.env.COMSPEC
      process.env.SystemRoot = 'D:\\Windows'
      expect(new NodeProcessGateway(undefined, 'win32').getShellPath()).toBe(
        'D:\\Windows\\System32\\cmd.exe',
      )
    })
  })

  describe('runtime helpers', () => {
    test('reports an injected platform for deterministic Windows resolution', () => {
      expect(new NodeProcessGateway(undefined, 'win32').getPlatform()).toBe('win32')
    })

    test('isFile distinguishes files from directories and missing paths', async () => {
      const gateway = new NodeProcessGateway()
      await expect(gateway.isFile(__filename)).resolves.toBe(true)
      await expect(gateway.isFile(__dirname)).resolves.toBe(false)
      await expect(gateway.isFile(path.join(__dirname, 'missing-file'))).resolves.toBe(false)
    })

    test('builds non-forced and forced Windows process-tree stop arguments', () => {
      expect(buildWindowsTaskkillArgs(4321, false)).toEqual(['/PID', '4321', '/T'])
      expect(buildWindowsTaskkillArgs(4321, true)).toEqual([
        '/PID',
        '4321',
        '/T',
        '/F',
      ])
      expect(buildWindowsTaskkillArgs(0, true)).toEqual([])
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
    test('synchronously reaps an active renderer-owned POSIX process group on renderer exit', async () => {
      const gateway = new NodeProcessGateway()
      const handle = gateway.spawnProcess({
        command: process.execPath,
        args: ['-e', 'setInterval(function () {}, 1000)'],
        env: gateway.getBaseEnv(),
      })
      const childPid = handle.pid
      expect(childPid).toBeGreaterThan(0)
      const exited = new Promise<void>((resolve) =>
        handle.onExit(() => resolve()),
      )

      gateway.reapRendererOwnedProcessesForExit()
      await exited

      expect(() => process.kill(childPid ?? -1, 0)).toThrow()
    }, 15_000)

    test('uses synchronous taskkill for an active renderer-owned Windows tree', async () => {
      const terminateWindowsTree = jest.fn(() => false)
      const terminateWindowsTreeSync = jest.fn(() => true)
      const readProcessBirthToken = jest.fn(() => 'original-start-time')
      const gateway = new NodeProcessGateway(
        undefined,
        'win32',
        terminateWindowsTree,
        readProcessBirthToken,
        terminateWindowsTreeSync,
      )
      const handle = gateway.spawnProcess({
        command: process.execPath,
        args: ['-e', 'setInterval(function () {}, 1000)'],
        env: gateway.getBaseEnv(),
      })
      expect(handle.pid).toBeGreaterThan(0)

      gateway.reapRendererOwnedProcessesForExit()
      expect(terminateWindowsTreeSync).toHaveBeenCalledWith(handle.pid)

      // The injected synchronous terminator only records the request. Clean
      // up the real test child through the ordinary fallback path.
      const exited = new Promise<void>((resolve) =>
        handle.onExit(() => resolve()),
      )
      handle.kill('SIGKILL')
      await exited
    }, 15_000)

    test('does not taskkill a Windows PID reused after the renderer-exit snapshot', async () => {
      const terminateWindowsTree = jest.fn(() => false)
      const terminateWindowsTreeSync = jest.fn(() => true)
      const readProcessBirthToken = jest
        .fn<string | null, []>()
        .mockReturnValueOnce('original-start-time')
        .mockReturnValue('replacement-start-time')
      const gateway = new NodeProcessGateway(
        undefined,
        'win32',
        terminateWindowsTree,
        readProcessBirthToken,
        terminateWindowsTreeSync,
      )
      const handle = gateway.spawnProcess({
        command: process.execPath,
        args: ['-e', 'setInterval(function () {}, 1000)'],
        env: gateway.getBaseEnv(),
      })
      expect(handle.pid).toBeGreaterThan(0)

      // The first token is captured at spawn. The second represents the same
      // numeric PID after the reaper took its Map snapshot but before it
      // reached taskkill.
      gateway.reapRendererOwnedProcessesForExit()

      expect(readProcessBirthToken).toHaveBeenCalledTimes(2)
      expect(terminateWindowsTreeSync).not.toHaveBeenCalled()

      // The reaper correctly skipped the synthetic replacement; clean up the
      // still-real test child through the ordinary handle path.
      const exited = new Promise<void>((resolve) =>
        handle.onExit(() => resolve()),
      )
      handle.kill('SIGKILL')
      await exited
    }, 15_000)

    test('does not taskkill a reused Windows PID after exit but before close', async () => {
      const terminateWindowsTree = jest.fn(() => false)
      const terminateWindowsTreeSync = jest.fn(() => true)
      const gateway = new NodeProcessGateway(
        undefined,
        'win32',
        terminateWindowsTree,
        undefined,
        terminateWindowsTreeSync,
      )
      // The grandchild inherits stdout, keeping the root ChildProcess `close`
      // event pending after its earlier `exit` event. That is the exact PID
      // reuse window where the renderer-exit reaper must no longer track root.
      const script = [
        "const cp = require('child_process')",
        `cp.spawn(${JSON.stringify(process.execPath)}, ['-e', 'setTimeout(() => {}, 1200)'], { stdio: ['ignore', 1, 2], detached: true })`,
        'process.exit(0)',
      ].join('; ')
      const handle = gateway.spawnProcess({
        command: process.execPath,
        args: ['-e', script],
        env: gateway.getBaseEnv(),
      })
      const rootPid = handle.pid
      const closed = new Promise<void>((resolve) =>
        handle.onExit(() => resolve()),
      )

      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        try {
          process.kill(rootPid ?? -1, 0)
          await new Promise((resolve) => setTimeout(resolve, 20))
        } catch {
          break
        }
      }
      expect(() => process.kill(rootPid ?? -1, 0)).toThrow()

      gateway.reapRendererOwnedProcessesForExit()
      // The ordinary run stop/dispose path uses handle.kill rather than the
      // renderer-exit reaper. It must share the same exit-before-close fence.
      handle.kill('SIGKILL')
      expect(terminateWindowsTreeSync).not.toHaveBeenCalled()
      expect(terminateWindowsTree).not.toHaveBeenCalled()
      await closed
    }, 15_000)

    test('reports a structured ENOENT launch error before exit', async () => {
      const gateway = new NodeProcessGateway()
      const handle = gateway.spawnProcess({
        command: '/nonexistent/taskchute-cli-for-test',
        args: [],
        env: gateway.getBaseEnv(),
      })
      const launchErrors: Array<{ code?: string; message: string }> = []
      handle.onLaunchError?.((error) => launchErrors.push(error))
      await new Promise<void>((resolve) => handle.onExit(() => resolve()))

      expect(launchErrors).toHaveLength(1)
      expect(launchErrors[0].code).toBe('ENOENT')
      expect(launchErrors[0].message).toContain('ENOENT')
    })

    test('retries a failed graceful win32 tree stop with force before child.kill', async () => {
      const terminateWindowsTree = jest.fn(() => false)
      const gateway = new NodeProcessGateway(undefined, 'win32', terminateWindowsTree)
      const handle = gateway.spawnProcess({
        command: process.execPath,
        args: ['-e', 'setInterval(function () {}, 1000)'],
        env: gateway.getBaseEnv(),
      })
      expect(handle.pid).toBeGreaterThan(0)

      handle.kill('SIGTERM')
      await new Promise<void>((resolve) => handle.onExit(() => resolve()))

      expect(terminateWindowsTree).toHaveBeenNthCalledWith(
        1,
        handle.pid,
        false,
        expect.any(Function),
      )
      expect(terminateWindowsTree).toHaveBeenNthCalledWith(
        2,
        handle.pid,
        true,
        expect.any(Function),
      )
      handle.kill('SIGKILL')
      expect(terminateWindowsTree).toHaveBeenCalledTimes(2)
    }, 15_000)

    test('falls back to child.kill when taskkill reports an asynchronous launch failure', async () => {
      let reportTaskkillFailure: (() => void) | undefined
      const terminateWindowsTree = jest.fn(
        (_pid: number, force: boolean, onFailure: () => void) => {
          if (!force) {
            reportTaskkillFailure = onFailure
            return true
          }
          return false
        },
      )
      const gateway = new NodeProcessGateway(undefined, 'win32', terminateWindowsTree)
      const handle = gateway.spawnProcess({
        command: process.execPath,
        args: ['-e', 'setInterval(function () {}, 1000)'],
        env: gateway.getBaseEnv(),
      })
      const exited = new Promise<void>((resolve) => handle.onExit(() => resolve()))

      handle.kill('SIGTERM')
      expect(reportTaskkillFailure).toBeDefined()
      reportTaskkillFailure?.()
      await exited

      expect(terminateWindowsTree).toHaveBeenCalledTimes(2)
      expect(terminateWindowsTree).toHaveBeenLastCalledWith(
        handle.pid,
        true,
        expect.any(Function),
      )
    }, 15_000)

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

    test('sweeps snapshotted detached descendants after the wrapper exits', async () => {
      const detachedPid = 987_654
      const snapshotDescendantPids = jest.fn(() => [
        { pid: detachedPid, birthToken: 'detached-birth' },
      ])
      const gateway = new NodeProcessGateway(
        snapshotDescendantPids,
        undefined,
        undefined,
        () => 'detached-birth',
      )
      const handle = gateway.spawnProcess({
        command: process.execPath,
        args: ['-e', "process.stdout.write('READY'); setInterval(() => {}, 1000)"],
        env: gateway.getBaseEnv(),
      })
      const wrapperPid = handle.pid
      expect(wrapperPid).toBeGreaterThan(0)

      await new Promise<void>((resolve) => {
        handle.onStdout((text) => {
          if (text.includes('READY')) resolve()
        })
      })

      const originalKill = process.kill.bind(process)
      const killSpy = jest.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === detachedPid) return true
        return originalKill(pid, signal)
      })
      try {
        handle.kill('SIGTERM')
        await new Promise<void>((resolve) => {
          handle.onExit(() => resolve())
        })

        // TerminalDispatcher invokes this second sweep from wrapper onExit.
        handle.kill('SIGKILL')

        expect(snapshotDescendantPids).toHaveBeenCalledWith(wrapperPid)
        expect(killSpy).toHaveBeenCalledWith(detachedPid, 'SIGTERM')
        expect(killSpy).toHaveBeenCalledWith(detachedPid, 'SIGKILL')
        expect(killSpy).not.toHaveBeenCalledWith(-(wrapperPid ?? 0), 'SIGKILL')
      } finally {
        killSpy.mockRestore()
        if (typeof wrapperPid === 'number') {
          try {
            originalKill(-wrapperPid, 'SIGKILL')
          } catch {
            // The wrapper was already reaped by the test.
          }
        }
      }
    }, 15_000)

    test('does not SIGKILL a descendant PID reused after graceful stop', async () => {
      const reusedPid = 987_653
      const snapshotDescendantPids = jest.fn(() => [
        { pid: reusedPid, birthToken: 'original-birth' },
      ])
      const readBirthToken = jest
        .fn<string | null, [number]>()
        .mockReturnValueOnce('original-birth')
        .mockReturnValue('replacement-birth')
      const gateway = new NodeProcessGateway(
        snapshotDescendantPids,
        undefined,
        undefined,
        readBirthToken,
      )
      const handle = gateway.spawnProcess({
        command: process.execPath,
        args: ['-e', "process.stdout.write('READY'); setInterval(() => {}, 1000)"],
        env: gateway.getBaseEnv(),
      })
      const wrapperPid = handle.pid
      expect(wrapperPid).toBeGreaterThan(0)

      await new Promise<void>((resolve) => {
        handle.onStdout((text) => {
          if (text.includes('READY')) resolve()
        })
      })

      const originalKill = process.kill.bind(process)
      const killSpy = jest.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === reusedPid) return true
        return originalKill(pid, signal)
      })
      try {
        handle.kill('SIGTERM')
        await new Promise<void>((resolve) => {
          handle.onExit(() => resolve())
        })

        // Dispatcher escalation after the wrapper close must revalidate the
        // remembered process birth identity before using its numeric PID.
        handle.kill('SIGKILL')

        expect(killSpy).toHaveBeenCalledWith(reusedPid, 'SIGTERM')
        expect(killSpy).not.toHaveBeenCalledWith(reusedPid, 'SIGKILL')
        expect(readBirthToken).toHaveBeenCalledTimes(2)
      } finally {
        killSpy.mockRestore()
        if (typeof wrapperPid === 'number') {
          try {
            originalKill(-wrapperPid, 'SIGKILL')
          } catch {
            // The wrapper was already reaped by the test.
          }
        }
      }
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
