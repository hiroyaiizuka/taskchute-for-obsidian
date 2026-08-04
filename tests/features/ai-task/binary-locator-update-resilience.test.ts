import {
  BinaryLocator,
  type AiCliLaunchSpec,
  type BinaryLocatorGateway,
} from '../../../src/features/ai-task/services/BinaryLocator'
import type { ExecCaptureResult } from '../../../src/features/ai-task/services/NodeProcessGateway'

function result(code: number, stdout = ''): ExecCaptureResult {
  return { code, stdout, stderr: '', timedOut: false }
}

function expectSpec(value: unknown): AiCliLaunchSpec {
  expect(value).toEqual(
    expect.objectContaining({
      executable: expect.any(String),
      argvPrefix: expect.any(Array),
      source: expect.any(String),
      resolvedAt: expect.any(Number),
      pathFingerprint: expect.any(String),
      requiredFiles: expect.any(Array),
    }),
  )
  return value as AiCliLaunchSpec
}

describe('BinaryLocator update resilience', () => {
  test.each([
    ['Homebrew', '/opt/homebrew/bin', 'homebrew'],
    ['npm global', '/usr/local/bin', 'unknown'],
    ['nvm', '/home/user/.nvm/versions/node/v22/bin', 'nvm'],
    ['Volta', '/home/user/.volta/bin', 'volta'],
    ['apt/dnf/apk native PATH', '/usr/bin', 'native'],
    ['WSL local installer', '/home/user/.local/bin', 'native'],
  ] as const)(
    'resolves %s installations through the same PATH algorithm',
    async (_label, directory, packageManager) => {
      const candidate = `${directory}/codex`
      const gateway: BinaryLocatorGateway = {
        refreshLoginShellPath: async () => undefined,
        primeLoginShellPath: async () => undefined,
        getBaseEnv: () => ({ HOME: '/home/user', PATH: `${directory}:/usr/bin` }),
        getPlatform: () => 'linux',
        getShellPath: () => '/bin/bash',
        isFile: async (path) => path === candidate,
        execCapture: jest.fn(async (command, args) =>
          command === '/bin/test' && args[1] === candidate
            ? result(0)
            : result(1),
        ),
      }

      const spec = expectSpec(
        await new BinaryLocator(gateway, () => ({})).resolve('codex'),
      )
      expect(spec.executable).toBe(candidate)
      expect(spec.packageManager).toBe(packageManager)
      expect(spec.terminalCommand).toBe('codex')
    },
  )

  test('prefers a mise stable shim over its current version directory', async () => {
    const versioned = '/home/user/.local/share/mise/installs/codex/1/bin/codex'
    const shim = '/home/user/.local/share/mise/shims/codex'
    const executable = new Set([versioned, shim])
    const gateway: BinaryLocatorGateway = {
      refreshLoginShellPath: async () => undefined,
      primeLoginShellPath: async () => undefined,
      getBaseEnv: () => ({
        HOME: '/home/user',
        PATH: '/home/user/.local/share/mise/installs/codex/1/bin:/usr/bin',
      }),
      getPlatform: () => 'linux',
      getShellPath: () => '/bin/zsh',
      isFile: async (candidate) => executable.has(candidate),
      execCapture: jest.fn(async (command, args) =>
        command === '/bin/test' && executable.has(args[1] ?? '')
          ? result(0)
          : result(1),
      ),
    }

    const spec = expectSpec(
      await new BinaryLocator(gateway, () => ({})).resolve('codex'),
    )
    expect(spec.executable).toBe(shim)
    expect(spec.packageManager).toBe('mise')
  })

  test('classifies a WinGet WindowsApps executable without invoking a shell', async () => {
    const executable =
      'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\\claude.exe'
    const execCapture = jest.fn(async (command: string, args: string[]) =>
      command === 'where.exe' && args[0] === 'claude'
        ? result(0, `${executable}\r\n`)
        : result(1),
    )
    const gateway: BinaryLocatorGateway = {
      refreshLoginShellPath: async () => undefined,
      primeLoginShellPath: async () => undefined,
      getBaseEnv: () => ({ PATH: 'C:\\Windows\\System32' }),
      getPlatform: () => 'win32',
      getShellPath: () => 'C:\\Windows\\System32\\cmd.exe',
      isFile: async () => true,
      execCapture,
    }

    const spec = expectSpec(
      await new BinaryLocator(gateway, () => ({})).resolve('claude'),
    )
    expect(spec.executable).toBe(executable)
    expect(spec.packageManager).toBe('winget')
    expect(execCapture.mock.calls.some(([command]) => command.includes('/bin/'))).toBe(
      false,
    )
  })

  test('refreshes PATH and moves from a deleted version to the new version without restart', async () => {
    const v1 = '/tools/claude/1/bin/claude'
    const v2 = '/tools/claude/2/bin/claude'
    let path = '/tools/claude/1/bin:/usr/bin'
    const executable = new Set([v1])
    const refreshLoginShellPath = jest.fn(async () => undefined)
    const gateway: BinaryLocatorGateway = {
      refreshLoginShellPath,
      primeLoginShellPath: async () => undefined,
      getBaseEnv: () => ({ HOME: '/home/user', PATH: path }),
      getPlatform: () => 'linux',
      getShellPath: () => '/bin/zsh',
      isFile: async (candidate) => executable.has(candidate),
      execCapture: jest.fn(async (command, args) => {
        if (command === '/bin/test') {
          return result(executable.has(args[1] ?? '') ? 0 : 1)
        }
        return result(1)
      }),
    }
    const locator = new BinaryLocator(gateway, () => ({}))

    expect(expectSpec(await locator.resolve('claude')).executable).toBe(v1)

    executable.delete(v1)
    executable.add(v2)
    path = '/tools/claude/2/bin:/usr/bin'

    expect(expectSpec(await locator.resolve('claude')).executable).toBe(v2)
    expect(refreshLoginShellPath).toHaveBeenCalledTimes(2)
  })

  test('keeps a stable shim path when its target changes and the old target still exists', async () => {
    const shim = '/home/user/.asdf/shims/codex'
    let targetVersion = '1'
    const gateway: BinaryLocatorGateway = {
      refreshLoginShellPath: async () => undefined,
      primeLoginShellPath: async () => undefined,
      getBaseEnv: () => ({
        HOME: '/home/user',
        PATH: '/home/user/.asdf/shims:/usr/bin',
        ASDF_DATA_DIR: '/home/user/.asdf',
      }),
      getPlatform: () => 'linux',
      getShellPath: () => '/bin/zsh',
      isFile: async (candidate) => candidate === shim,
      execCapture: jest.fn(async (command, args) => {
        if (command === '/bin/test' && args[1] === shim) return result(0)
        return result(1)
      }),
    }
    const locator = new BinaryLocator(gateway, () => ({}))

    const first = expectSpec(await locator.resolve('codex'))
    targetVersion = '2'
    const second = expectSpec(await locator.resolve('codex'))

    expect(targetVersion).toBe('2')
    expect(first.executable).toBe(shim)
    expect(second.executable).toBe(shim)
    expect(second.packageManager).toBe('asdf')
  })

  test('coalesces concurrent resolution for the same host', async () => {
    let releaseRefresh: (() => void) | undefined
    const refreshLoginShellPath = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseRefresh = resolve
        }),
    )
    const gateway: BinaryLocatorGateway = {
      refreshLoginShellPath,
      primeLoginShellPath: async () => undefined,
      getBaseEnv: () => ({ PATH: '/usr/local/bin:/usr/bin' }),
      getPlatform: () => 'darwin',
      getShellPath: () => '/bin/zsh',
      isFile: async () => true,
      execCapture: jest.fn(async (command, args) =>
        command === '/bin/test' && args[1] === '/usr/local/bin/claude'
          ? result(0)
          : result(1),
      ),
    }
    const locator = new BinaryLocator(gateway, () => ({}))

    const first = locator.resolve('claude')
    const second = locator.resolve('claude')
    await Promise.resolve()
    expect(refreshLoginShellPath).toHaveBeenCalledTimes(1)
    releaseRefresh?.()

    await expect(first).resolves.toEqual(await second)
  })

  test('a failed PATH refresh preserves a still-valid cached facade', async () => {
    const stable = '/opt/homebrew/bin/claude'
    const refreshLoginShellPath = jest
      .fn<Promise<void>, []>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('shell unavailable'))
    const gateway: BinaryLocatorGateway = {
      refreshLoginShellPath,
      primeLoginShellPath: async () => undefined,
      getBaseEnv: () => ({ PATH: '/opt/homebrew/bin:/usr/bin' }),
      getPlatform: () => 'darwin',
      getShellPath: () => '/bin/zsh',
      isFile: async (candidate) => candidate === stable,
      execCapture: jest.fn(async (command, args) =>
        command === '/bin/test' && args[1] === stable ? result(0) : result(1),
      ),
    }
    const locator = new BinaryLocator(gateway, () => ({}))

    expect(expectSpec(await locator.resolve('claude')).executable).toBe(stable)
    await expect(locator.resolve('claude')).resolves.toEqual(
      expect.objectContaining({ executable: stable }),
    )
  })
})
