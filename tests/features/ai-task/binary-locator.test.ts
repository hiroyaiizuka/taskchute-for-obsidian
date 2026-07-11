import {
  AiBinaryNotFoundError,
  BinaryLocator,
  PROBE_TIMEOUT_MS,
  WHICH_TIMEOUT_MS,
} from '../../../src/features/ai-task/services/BinaryLocator'
import type {
  AiBinaryPathOverrides,
  BinaryLocatorGateway,
} from '../../../src/features/ai-task/services/BinaryLocator'
import type { ExecCaptureResult } from '../../../src/features/ai-task/services/NodeProcessGateway'

type ExecCaptureMock = jest.Mock<Promise<ExecCaptureResult>, [string, string[], number]>

function success(stdout: string): ExecCaptureResult {
  return { code: 0, stdout, stderr: '', timedOut: false }
}

function failure(code: number | null = 1): ExecCaptureResult {
  return { code, stdout: '', stderr: '', timedOut: false }
}

function createLocator(options: {
  execCapture: ExecCaptureMock
  overrides?: AiBinaryPathOverrides
  home?: string | undefined
}): BinaryLocator {
  const gateway: BinaryLocatorGateway = {
    execCapture: options.execCapture,
    getShellPath: () => '/bin/zsh',
    getBaseEnv: () => ({ HOME: options.home ?? '/Users/tester', NO_COLOR: '1' }),
  }
  return new BinaryLocator(gateway, () => options.overrides ?? {})
}

describe('BinaryLocator', () => {
  test('settings override wins without touching the gateway', async () => {
    const execCapture: ExecCaptureMock = jest.fn()
    const locator = createLocator({
      execCapture,
      overrides: { aiTaskClaudePath: '  /custom/claude  ' },
    })

    await expect(locator.resolve('claude')).resolves.toBe('/custom/claude')
    expect(execCapture).not.toHaveBeenCalled()
  })

  test('codex override uses aiTaskCodexPath', async () => {
    const execCapture: ExecCaptureMock = jest.fn()
    const locator = createLocator({
      execCapture,
      overrides: { aiTaskClaudePath: '/custom/claude', aiTaskCodexPath: '/custom/codex' },
    })

    await expect(locator.resolve('codex')).resolves.toBe('/custom/codex')
    expect(execCapture).not.toHaveBeenCalled()
  })

  test('a blank override falls through to which-detection', async () => {
    const execCapture: ExecCaptureMock = jest
      .fn()
      .mockResolvedValue(success('/opt/homebrew/bin/claude\n'))
    const locator = createLocator({ execCapture, overrides: { aiTaskClaudePath: '   ' } })

    await expect(locator.resolve('claude')).resolves.toBe('/opt/homebrew/bin/claude')
  })

  test('detects the binary via `which` in a login shell', async () => {
    const execCapture: ExecCaptureMock = jest
      .fn()
      .mockResolvedValue(success('/Users/tester/.local/bin/claude\n'))
    const locator = createLocator({ execCapture })

    await expect(locator.resolve('claude')).resolves.toBe('/Users/tester/.local/bin/claude')
    expect(execCapture).toHaveBeenCalledWith('/bin/zsh', ['-lc', 'which claude'], WHICH_TIMEOUT_MS)
  })

  test('uses `which codex` for the codex host', async () => {
    const execCapture: ExecCaptureMock = jest
      .fn()
      .mockResolvedValue(success('/usr/local/bin/codex\n'))
    const locator = createLocator({ execCapture })

    await expect(locator.resolve('codex')).resolves.toBe('/usr/local/bin/codex')
    expect(execCapture).toHaveBeenCalledWith('/bin/zsh', ['-lc', 'which codex'], WHICH_TIMEOUT_MS)
  })

  test('caches a which-detected path per host', async () => {
    const execCapture: ExecCaptureMock = jest
      .fn()
      .mockResolvedValue(success('/opt/homebrew/bin/claude\n'))
    const locator = createLocator({ execCapture })

    await locator.resolve('claude')
    await locator.resolve('claude')

    expect(execCapture).toHaveBeenCalledTimes(1)
  })

  test('invalidateCache forces re-detection', async () => {
    const execCapture: ExecCaptureMock = jest
      .fn()
      .mockResolvedValue(success('/opt/homebrew/bin/claude\n'))
    const locator = createLocator({ execCapture })

    await locator.resolve('claude')
    locator.invalidateCache()
    await locator.resolve('claude')

    expect(execCapture).toHaveBeenCalledTimes(2)
  })

  test('falls back to known-path probes when which fails', async () => {
    const execCapture: ExecCaptureMock = jest.fn((command, args) => {
      if (command === '/bin/test' && args[1] === '/opt/homebrew/bin/claude') {
        return Promise.resolve(success(''))
      }
      return Promise.resolve(failure())
    })
    const locator = createLocator({ execCapture })

    await expect(locator.resolve('claude')).resolves.toBe('/opt/homebrew/bin/claude')
    expect(execCapture).toHaveBeenNthCalledWith(1, '/bin/zsh', ['-lc', 'which claude'], WHICH_TIMEOUT_MS)
    expect(execCapture).toHaveBeenNthCalledWith(
      2,
      '/bin/test',
      ['-x', '/Users/tester/.local/bin/claude'],
      PROBE_TIMEOUT_MS,
    )
    expect(execCapture).toHaveBeenNthCalledWith(
      3,
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
    execCapture.mockResolvedValue(success('/opt/homebrew/bin/claude\n'))
    await expect(locator.resolve('claude')).resolves.toBe('/opt/homebrew/bin/claude')
  })

  test('treats execCapture rejections as detection misses', async () => {
    const execCapture: ExecCaptureMock = jest.fn().mockRejectedValue(new Error('spawn failed'))
    const locator = createLocator({ execCapture })

    await expect(locator.resolve('claude')).rejects.toBeInstanceOf(AiBinaryNotFoundError)
  })

  test('ignores which output that is not an absolute path', async () => {
    const execCapture: ExecCaptureMock = jest.fn((command) => {
      if (command === '/bin/zsh') {
        return Promise.resolve(success('claude not found\n'))
      }
      return Promise.resolve(failure())
    })
    const locator = createLocator({ execCapture })

    await expect(locator.resolve('claude')).rejects.toBeInstanceOf(AiBinaryNotFoundError)
  })
})
