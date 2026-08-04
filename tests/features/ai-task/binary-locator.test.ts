import {
  AiBinaryNotFoundError,
  BinaryLocator,
  POSIX_BINARY_PATH_MARKER,
  PROBE_TIMEOUT_MS,
  WHICH_TIMEOUT_MS,
} from '../../../src/features/ai-task/services/BinaryLocator'
import type {
  AiCliLaunchSpec,
  AiBinaryPathOverrides,
  BinaryLocatorGateway,
} from '../../../src/features/ai-task/services/BinaryLocator'
import type { ExecCaptureResult } from '../../../src/features/ai-task/services/NodeProcessGateway'
import {
  POSIX_INTERACTIVE_LOGIN_SHELL_FLAG,
  POSIX_LOGIN_SHELL_FLAG,
} from '../../../src/features/ai-task/services/NodeProcessGateway'

type ExecCaptureMock = jest.Mock<Promise<ExecCaptureResult>, [string, string[], number]>

function success(stdout: string): ExecCaptureResult {
  return { code: 0, stdout, stderr: '', timedOut: false }
}

function posixSuccess(path: string, noise = ''): ExecCaptureResult {
  return success(`${noise}${POSIX_BINARY_PATH_MARKER}${path}\n`)
}

function posixLookup(host: 'claude' | 'codex'): string {
  return (
    `resolved="$(command -v ${host} 2>/dev/null)" && ` +
    `printf '${POSIX_BINARY_PATH_MARKER}%s\\n' "$resolved"`
  )
}

function failure(code: number | null = 1): ExecCaptureResult {
  return { code, stdout: '', stderr: '', timedOut: false }
}

async function resolveExecutable(
  locator: BinaryLocator,
  host: 'claude' | 'codex',
): Promise<string> {
  return (await locator.resolve(host)).executable
}

async function resolveSpec(
  locator: BinaryLocator,
  host: 'claude' | 'codex',
): Promise<AiCliLaunchSpec> {
  return await locator.resolve(host)
}

function createLocator(options: {
  execCapture: ExecCaptureMock
  overrides?: AiBinaryPathOverrides
  home?: string | undefined
  env?: Record<string, string | undefined>
  platform?: string
  isFile?: jest.Mock<Promise<boolean>, [string]>
  primeLoginShellPath?: jest.Mock<Promise<void>, []>
}): BinaryLocator {
  const gateway: BinaryLocatorGateway = {
    execCapture: options.execCapture,
    getShellPath: () => '/bin/zsh',
    getBaseEnv: () =>
      options.env ?? { HOME: options.home ?? '/Users/tester', NO_COLOR: '1' },
    getPlatform: () => options.platform ?? 'darwin',
    isFile: options.isFile ?? jest.fn(() => Promise.resolve(false)),
    primeLoginShellPath: options.primeLoginShellPath ?? jest.fn(() => Promise.resolve()),
  }
  return new BinaryLocator(gateway, () => options.overrides ?? {})
}

describe('BinaryLocator', () => {
  test('settings override wins without touching the gateway', async () => {
    const execCapture: ExecCaptureMock = jest.fn(() => Promise.resolve(success('')))
    const locator = createLocator({
      execCapture,
      overrides: { aiTaskClaudePath: '  /custom/claude  ' },
      isFile: jest.fn(() => Promise.resolve(true)),
    })

    await expect(resolveExecutable(locator, 'claude')).resolves.toBe('/custom/claude')
    expect(execCapture).toHaveBeenCalledWith(
      '/bin/test',
      ['-x', '/custom/claude'],
      PROBE_TIMEOUT_MS,
    )
  })

  test('codex override uses aiTaskCodexPath', async () => {
    const execCapture: ExecCaptureMock = jest.fn(() => Promise.resolve(success('')))
    const locator = createLocator({
      execCapture,
      overrides: { aiTaskClaudePath: '/custom/claude', aiTaskCodexPath: '/custom/codex' },
      isFile: jest.fn(() => Promise.resolve(true)),
    })

    await expect(resolveExecutable(locator, 'codex')).resolves.toBe('/custom/codex')
  })

  test('a Windows override synced to POSIX is ignored in favor of local auto-detection', async () => {
    const execCapture: ExecCaptureMock = jest
      .fn()
      .mockResolvedValue(posixSuccess('/opt/homebrew/bin/claude'))
    const locator = createLocator({
      execCapture,
      overrides: { aiTaskClaudePath: 'C:\\Users\\other-device\\claude.exe' },
    })

    await expect(resolveExecutable(locator, 'claude')).resolves.toBe('/opt/homebrew/bin/claude')
  })

  test('a blank override falls through to which-detection', async () => {
    const execCapture: ExecCaptureMock = jest
      .fn()
      .mockResolvedValue(posixSuccess('/opt/homebrew/bin/claude'))
    const locator = createLocator({ execCapture, overrides: { aiTaskClaudePath: '   ' } })

    await expect(resolveExecutable(locator, 'claude')).resolves.toBe('/opt/homebrew/bin/claude')
  })

  test('a stale POSIX override falls through to local auto-detection', async () => {
    const execCapture: ExecCaptureMock = jest
      .fn()
      .mockResolvedValue(posixSuccess('/opt/homebrew/bin/claude'))
    const locator = createLocator({
      execCapture,
      overrides: { aiTaskClaudePath: '/deleted/claude' },
      isFile: jest.fn(() => Promise.resolve(false)),
    })

    await expect(resolveExecutable(locator, 'claude')).resolves.toBe('/opt/homebrew/bin/claude')
  })

  test('detects the binary via command lookup in an interactive login shell', async () => {
    const execCapture: ExecCaptureMock = jest
      .fn()
      .mockResolvedValue(posixSuccess('/Users/tester/.local/bin/claude'))
    const locator = createLocator({ execCapture })

    await expect(resolveExecutable(locator, 'claude')).resolves.toBe(
      '/Users/tester/.local/bin/claude',
    )
    expect(execCapture).toHaveBeenCalledWith(
      '/bin/zsh',
      [POSIX_INTERACTIVE_LOGIN_SHELL_FLAG, posixLookup('claude')],
      WHICH_TIMEOUT_MS,
    )
  })

  test('looks up the codex host in the shell', async () => {
    const execCapture: ExecCaptureMock = jest
      .fn()
      .mockResolvedValue(posixSuccess('/usr/local/bin/codex'))
    const locator = createLocator({ execCapture })

    await expect(resolveExecutable(locator, 'codex')).resolves.toBe('/usr/local/bin/codex')
    expect(execCapture).toHaveBeenCalledWith(
      '/bin/zsh',
      [POSIX_INTERACTIVE_LOGIN_SHELL_FLAG, posixLookup('codex')],
      WHICH_TIMEOUT_MS,
    )
  })

  test('caches a shell-detected path per host', async () => {
    const execCapture: ExecCaptureMock = jest
      .fn()
      .mockResolvedValue(posixSuccess('/opt/homebrew/bin/claude'))
    const locator = createLocator({ execCapture })

    await locator.resolve('claude')
    await locator.resolve('claude')

    // The second resolve validates the cached executable before reusing it.
    expect(execCapture).toHaveBeenCalledTimes(2)
  })

  test('invalidateCache forces re-detection', async () => {
    const execCapture: ExecCaptureMock = jest
      .fn()
      .mockResolvedValue(posixSuccess('/opt/homebrew/bin/claude'))
    const locator = createLocator({ execCapture })

    await locator.resolve('claude')
    locator.invalidateCache()
    await locator.resolve('claude')

    expect(execCapture).toHaveBeenCalledTimes(2)
  })

  test('falls back to known-path probes when shell lookup fails', async () => {
    const execCapture: ExecCaptureMock = jest.fn((command, args) => {
      if (command === '/bin/test' && args[1] === '/opt/homebrew/bin/claude') {
        return Promise.resolve(success(''))
      }
      return Promise.resolve(failure())
    })
    const locator = createLocator({ execCapture })

    await expect(resolveExecutable(locator, 'claude')).resolves.toBe('/opt/homebrew/bin/claude')
    expect(execCapture).toHaveBeenNthCalledWith(
      1,
      '/bin/zsh',
      [POSIX_INTERACTIVE_LOGIN_SHELL_FLAG, posixLookup('claude')],
      WHICH_TIMEOUT_MS,
    )
    expect(execCapture).toHaveBeenNthCalledWith(
      2,
      '/bin/zsh',
      [POSIX_LOGIN_SHELL_FLAG, posixLookup('claude')],
      WHICH_TIMEOUT_MS,
    )
    expect(execCapture).toHaveBeenNthCalledWith(
      3,
      '/bin/test',
      ['-x', '/Users/tester/.local/bin/claude'],
      PROBE_TIMEOUT_MS,
    )
    expect(execCapture).toHaveBeenNthCalledWith(
      4,
      '/bin/test',
      ['-x', '/opt/homebrew/bin/claude'],
      PROBE_TIMEOUT_MS,
    )
  })

  test('skips the home probe when HOME is not set', async () => {
    const execCapture: ExecCaptureMock = jest.fn().mockResolvedValue(failure())
    const locator = createLocator({ execCapture, home: undefined })
    const gatewayWithoutHome: BinaryLocatorGateway = {
      execCapture,
      getShellPath: () => '/bin/zsh',
      getBaseEnv: () => ({ NO_COLOR: '1' }),
      getPlatform: () => 'darwin',
      isFile: () => Promise.resolve(false),
      primeLoginShellPath: () => Promise.resolve(),
    }
    const locatorWithoutHome = new BinaryLocator(gatewayWithoutHome, () => ({}))
    void locator

    await expect(locatorWithoutHome.resolve('claude')).rejects.toBeInstanceOf(AiBinaryNotFoundError)
    const probedPaths = execCapture.mock.calls
      .filter(([command]) => command === '/bin/test')
      .map(([, args]) => args[1])
    expect(probedPaths).toEqual(['/opt/homebrew/bin/claude', '/usr/local/bin/claude'])
  })

  test('throws AiBinaryNotFoundError when nothing resolves', async () => {
    const execCapture: ExecCaptureMock = jest.fn().mockResolvedValue(failure())
    const locator = createLocator({ execCapture })

    const rejection = locator.resolve('codex')
    await expect(rejection).rejects.toBeInstanceOf(AiBinaryNotFoundError)
    await rejection.catch((error: unknown) => {
      expect(error).toBeInstanceOf(AiBinaryNotFoundError)
      expect((error as AiBinaryNotFoundError).host).toBe('codex')
    })
  })

  test('does not cache failures', async () => {
    const execCapture: ExecCaptureMock = jest.fn().mockResolvedValue(failure())
    const locator = createLocator({ execCapture })

    await expect(locator.resolve('claude')).rejects.toBeInstanceOf(AiBinaryNotFoundError)
    execCapture.mockResolvedValue(posixSuccess('/opt/homebrew/bin/claude'))
    await expect(resolveExecutable(locator, 'claude')).resolves.toBe('/opt/homebrew/bin/claude')
  })

  test('treats execCapture rejections as detection misses', async () => {
    const execCapture: ExecCaptureMock = jest.fn().mockRejectedValue(new Error('spawn failed'))
    const locator = createLocator({ execCapture })

    await expect(locator.resolve('claude')).rejects.toBeInstanceOf(AiBinaryNotFoundError)
  })

  test('trusts only the marked binary result among interactive-shell noise', async () => {
    const execCapture: ExecCaptureMock = jest
      .fn()
      .mockResolvedValue(
        posixSuccess(
          '/opt/homebrew/bin/claude',
          'nvm: loading environment\n/noisy/absolute/path\nUsing node v20.11.0\n',
        ),
      )
    const locator = createLocator({ execCapture })

    await expect(resolveExecutable(locator, 'claude')).resolves.toBe('/opt/homebrew/bin/claude')
    expect(execCapture).toHaveBeenCalledWith(
      '/bin/zsh',
      [POSIX_INTERACTIVE_LOGIN_SHELL_FLAG, posixLookup('claude')],
      WHICH_TIMEOUT_MS,
    )
  })

  test('finds a mise-managed CLI from the primed PATH without sourcing rc files again', async () => {
    const miseClaude =
      '/Users/tester/.local/share/mise/installs/npm-anthropic-ai-claude-code/2.1.205/bin/claude'
    const execCapture: ExecCaptureMock = jest.fn((command, args) => {
      if (command === '/bin/test' && args[0] === '-x' && args[1] === miseClaude) {
        return Promise.resolve(success(''))
      }
      return Promise.resolve(failure())
    })
    const locator = createLocator({
      execCapture,
      env: {
        HOME: '/Users/tester',
        PATH: `${miseClaude.slice(0, -'/claude'.length)}:/usr/bin:/bin`,
      },
    })

    await expect(resolveExecutable(locator, 'claude')).resolves.toBe(miseClaude)
    expect(execCapture).toHaveBeenCalledWith(
      '/bin/test',
      ['-x', miseClaude],
      PROBE_TIMEOUT_MS,
    )
    expect(execCapture.mock.calls.some(([command]) => command === '/bin/zsh')).toBe(false)
  })

  test('falls back to a login-only shell when interactive flags are unsupported', async () => {
    const execCapture: ExecCaptureMock = jest.fn((_command, args) => {
      if (args[0] === POSIX_INTERACTIVE_LOGIN_SHELL_FLAG) {
        return Promise.resolve(failure(2))
      }
      if (args[0] === POSIX_LOGIN_SHELL_FLAG) {
        return Promise.resolve(posixSuccess('/usr/local/bin/codex'))
      }
      return Promise.resolve(failure())
    })
    const locator = createLocator({ execCapture })

    await expect(resolveExecutable(locator, 'codex')).resolves.toBe('/usr/local/bin/codex')
    expect(execCapture).toHaveBeenNthCalledWith(
      1,
      '/bin/zsh',
      [POSIX_INTERACTIVE_LOGIN_SHELL_FLAG, posixLookup('codex')],
      WHICH_TIMEOUT_MS,
    )
    expect(execCapture).toHaveBeenNthCalledWith(
      2,
      '/bin/zsh',
      [POSIX_LOGIN_SHELL_FLAG, posixLookup('codex')],
      WHICH_TIMEOUT_MS,
    )
  })

  test('primes the login-shell PATH before detection', async () => {
    const callOrder: string[] = []
    const primeLoginShellPath = jest.fn(() => {
      callOrder.push('prime')
      return Promise.resolve()
    })
    const execCapture: ExecCaptureMock = jest.fn(() => {
      callOrder.push('exec')
      return Promise.resolve(posixSuccess('/opt/homebrew/bin/claude'))
    })
    const locator = createLocator({ execCapture, primeLoginShellPath })

    await locator.resolve('claude')

    expect(primeLoginShellPath).toHaveBeenCalledTimes(1)
    expect(callOrder[0]).toBe('prime')
  })

  test('primes the login-shell PATH even when a settings override is set', async () => {
    const primeLoginShellPath = jest.fn(() => Promise.resolve())
    const execCapture: ExecCaptureMock = jest.fn(() => Promise.resolve(success('')))
    const locator = createLocator({
      execCapture,
      overrides: { aiTaskClaudePath: '/custom/claude' },
      primeLoginShellPath,
      isFile: jest.fn(() => Promise.resolve(true)),
    })

    await expect(resolveExecutable(locator, 'claude')).resolves.toBe('/custom/claude')
    expect(primeLoginShellPath).toHaveBeenCalledTimes(1)
  })

  test('a priming failure does not break resolution', async () => {
    const primeLoginShellPath = jest.fn(() => Promise.reject(new Error('shell exploded')))
    const execCapture: ExecCaptureMock = jest
      .fn()
      .mockResolvedValue(posixSuccess('/opt/homebrew/bin/claude'))
    const locator = createLocator({ execCapture, primeLoginShellPath })

    await expect(resolveExecutable(locator, 'claude')).resolves.toBe('/opt/homebrew/bin/claude')
  })

  test('ignores shell output that has no marked absolute binary path', async () => {
    const execCapture: ExecCaptureMock = jest.fn((command) => {
      if (command === '/bin/zsh') {
        return Promise.resolve(success('claude not found\n'))
      }
      return Promise.resolve(failure())
    })
    const locator = createLocator({ execCapture })

    await expect(locator.resolve('claude')).rejects.toBeInstanceOf(AiBinaryNotFoundError)
  })

  test('win32 detects a native Claude executable with where.exe and never invokes a POSIX shell', async () => {
    const execCapture: ExecCaptureMock = jest.fn((command, args) => {
      if (command === 'where.exe' && args[0] === 'claude') {
        return Promise.resolve(success('C:\\Users\\tester\\.local\\bin\\claude.exe\r\n'))
      }
      return Promise.resolve(failure())
    })
    const locator = createLocator({
      execCapture,
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\tester', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
    })

    await expect(resolveExecutable(locator, 'claude')).resolves.toBe(
      'C:\\Users\\tester\\.local\\bin\\claude.exe',
    )
    expect(execCapture).toHaveBeenCalledWith('where.exe', ['claude'], WHICH_TIMEOUT_MS)
    expect(execCapture.mock.calls.some(([command]) => command === '/bin/zsh')).toBe(false)
    expect(execCapture.mock.calls.some(([command]) => command === '/bin/test')).toBe(false)
  })

  test('win32 ignores a synced POSIX override and uses the local executable', async () => {
    const execCapture: ExecCaptureMock = jest.fn((command, args) => {
      if (command === 'where.exe' && args[0] === 'claude') {
        return Promise.resolve(success('C:\\Tools\\claude.exe\r\n'))
      }
      return Promise.resolve(failure())
    })
    const locator = createLocator({
      execCapture,
      platform: 'win32',
      overrides: { aiTaskClaudePath: '/opt/homebrew/bin/claude' },
      env: {},
    })

    await expect(resolveExecutable(locator, 'claude')).resolves.toBe('C:\\Tools\\claude.exe')
  })

  test('win32 ignores a stale local override and uses where.exe auto-detection', async () => {
    const execCapture: ExecCaptureMock = jest.fn((command, args) => {
      if (command === 'where.exe' && args[0] === 'claude') {
        return Promise.resolve(success('C:\\Tools\\claude.exe\r\n'))
      }
      return Promise.resolve(failure())
    })
    const isFile = jest.fn(() => Promise.resolve(false))
    const locator = createLocator({
      execCapture,
      isFile,
      platform: 'win32',
      overrides: { aiTaskClaudePath: 'C:\\Old\\claude.exe' },
      env: {},
    })

    await expect(resolveExecutable(locator, 'claude')).resolves.toBe('C:\\Tools\\claude.exe')
    expect(isFile).toHaveBeenCalledWith('C:\\Old\\claude.exe')
  })

  test('win32 normalizes the Claude npm cmd shim to node.exe plus cli-wrapper.cjs', async () => {
    const cliEntry =
      'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli-wrapper.cjs'
    const nodePath = 'C:\\Program Files\\nodejs\\node.exe'
    const isFile = jest.fn((candidate: string) => Promise.resolve(candidate === cliEntry))
    const execCapture: ExecCaptureMock = jest.fn((command, args) => {
      if (command === 'where.exe' && args[0] === 'claude') {
        return Promise.resolve(success('C:\\Users\\tester\\AppData\\Roaming\\npm\\claude.cmd\r\n'))
      }
      if (command === 'where.exe' && args[0] === 'node.exe') {
        return Promise.resolve(success(`${nodePath}\r\n`))
      }
      return Promise.resolve(failure())
    })
    const locator = createLocator({ execCapture, isFile, platform: 'win32', env: {} })

    await expect(resolveSpec(locator, 'claude')).resolves.toEqual(
      expect.objectContaining({
        executable: nodePath,
        argvPrefix: [cliEntry],
      }),
    )
  })

  test('win32 resolves a Codex npm cmd shim to its packaged native executable', async () => {
    const codexExe =
      'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe'
    const isFile = jest.fn((candidate: string) => Promise.resolve(candidate === codexExe))
    const execCapture: ExecCaptureMock = jest.fn((command, args) => {
      if (command === 'where.exe' && args[0] === 'codex') {
        return Promise.resolve(
          success(
            'C:\\Users\\tester\\AppData\\Roaming\\npm\\codex\r\n' +
              'C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd\r\n',
          ),
        )
      }
      return Promise.resolve(failure())
    })
    const locator = createLocator({
      execCapture,
      isFile,
      platform: 'win32',
      env: { PROCESSOR_ARCHITECTURE: 'AMD64' },
    })

    await expect(resolveExecutable(locator, 'codex')).resolves.toBe(codexExe)
  })

  test('win32 arm64 prefers the matching packaged Codex native executable', async () => {
    const codexExe =
      'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-arm64\\vendor\\aarch64-pc-windows-msvc\\bin\\codex.exe'
    const isFile = jest.fn((candidate: string) => Promise.resolve(candidate === codexExe))
    const execCapture: ExecCaptureMock = jest.fn((command, args) => {
      if (command === 'where.exe' && args[0] === 'codex') {
        return Promise.resolve(
          success('C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd\r\n'),
        )
      }
      return Promise.resolve(failure())
    })
    const locator = createLocator({
      execCapture,
      isFile,
      platform: 'win32',
      env: { PROCESSOR_ARCHITECTURE: 'ARM64' },
    })

    await expect(resolveExecutable(locator, 'codex')).resolves.toBe(codexExe)
  })

  test('win32 falls back to node.exe plus the Codex npm JavaScript entrypoint', async () => {
    const codexEntry =
      'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'
    const nodePath = 'C:\\Program Files\\nodejs\\node.exe'
    const isFile = jest.fn((candidate: string) => Promise.resolve(candidate === codexEntry))
    const execCapture: ExecCaptureMock = jest.fn((command, args) => {
      if (command === 'where.exe' && args[0] === 'codex') {
        return Promise.resolve(success('C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd\r\n'))
      }
      if (command === 'where.exe' && args[0] === 'node.exe') {
        return Promise.resolve(success(`${nodePath}\r\n`))
      }
      return Promise.resolve(failure())
    })
    const locator = createLocator({ execCapture, isFile, platform: 'win32', env: {} })

    await expect(resolveSpec(locator, 'codex')).resolves.toEqual(
      expect.objectContaining({
        executable: nodePath,
        argvPrefix: [codexEntry],
      }),
    )
  })

  test('win32 probes the native Claude installer path when where.exe misses', async () => {
    const nativePath = 'C:\\Users\\tester\\AppData\\Local\\Claude\\claude.exe'
    const isFile = jest.fn((candidate: string) => Promise.resolve(candidate === nativePath))
    const execCapture: ExecCaptureMock = jest.fn().mockResolvedValue(failure())
    const locator = createLocator({
      execCapture,
      isFile,
      platform: 'win32',
      env: {
        USERPROFILE: 'C:\\Users\\tester',
        LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      },
    })

    await expect(resolveExecutable(locator, 'claude')).resolves.toBe(nativePath)
    expect(isFile).toHaveBeenCalledWith(nativePath)
  })

  test('win32 probes a Volta native shim when Explorer PATH is stale', async () => {
    const voltaPath = 'C:\\Users\\tester\\.volta\\bin\\claude.exe'
    const isFile = jest.fn((candidate: string) => Promise.resolve(candidate === voltaPath))
    const execCapture: ExecCaptureMock = jest.fn().mockResolvedValue(failure())
    const locator = createLocator({
      execCapture,
      isFile,
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\tester' },
    })

    await expect(resolveExecutable(locator, 'claude')).resolves.toBe(voltaPath)
  })

  test('win32 never probes a relative path when user environment roots are missing', async () => {
    const isFile = jest.fn(() => Promise.resolve(false))
    const execCapture: ExecCaptureMock = jest.fn().mockResolvedValue(failure())
    const locator = createLocator({
      execCapture,
      isFile,
      platform: 'win32',
      env: {},
    })

    await expect(locator.resolve('claude')).rejects.toBeInstanceOf(AiBinaryNotFoundError)
    for (const [candidate] of isFile.mock.calls) {
      expect(candidate).toMatch(/^(?:[A-Za-z]:[\\/]|\\\\)/u)
    }
  })
})
