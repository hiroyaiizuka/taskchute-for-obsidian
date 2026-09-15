/** The host needs Windows, so these pin its contracts instead of running it. */
import { gunzipSync } from 'zlib'
import { TERMINAL_EXIT_SENTINEL } from '../../../../src/features/ai-task/services/NodeProcessGateway'
import {
  CONPTY_FRAME_INPUT,
  CONPTY_FRAME_RESIZE,
} from '../../../../src/features/ai-task/services/windows/ConPtyControlFrames'
import {
  buildConPtyHostEnv,
  CONPTY_CONSTRAINED_LANGUAGE_EXIT_CODE,
  CONPTY_HOST_CSHARP,
  CONPTY_HOST_ENV_PREFIX,
  CONPTY_HOST_EXIT_SENTINEL,
  CONPTY_HOST_FAILURE_EXIT_CODE,
  CONPTY_HOST_LOADER,
  CONPTY_HOST_POWERSHELL_ARGS,
  CONPTY_HOST_SOURCE_ENV,
  CONPTY_PROBE_INPUT,
  CONPTY_PROBE_OK_MARKER,
  getEncodedConPtyHostSource,
  getWindowsPowerShellPath,
  parseWindowsBuildNumber,
} from '../../../../src/features/ai-task/services/windows/ConPtyHostSource'

const WINDOWS_ENV_VALUE_LIMIT = 32_767

describe('ConPTY host PowerShell invocation', () => {
  test('is a fixed loader with no double quotes for Node to re-escape', () => {
    expect(CONPTY_HOST_LOADER).not.toContain('"')
    expect(CONPTY_HOST_LOADER).not.toContain('\\')
    expect(CONPTY_HOST_POWERSHELL_ARGS).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      CONPTY_HOST_LOADER,
    ])
  })

  test('refuses Constrained Language Mode before compiling anything', () => {
    const languageCheck = CONPTY_HOST_LOADER.indexOf('FullLanguage')
    expect(languageCheck).toBeGreaterThanOrEqual(0)
    expect(languageCheck).toBeLessThan(CONPTY_HOST_LOADER.indexOf('Add-Type'))
    expect(CONPTY_HOST_LOADER).toContain(`exit ${CONPTY_CONSTRAINED_LANGUAGE_EXIT_CODE}`)
  })

  test('reads the source from the environment and exits with the host result', () => {
    expect(CONPTY_HOST_LOADER).toContain(`$env:${CONPTY_HOST_SOURCE_ENV}`)
    expect(CONPTY_HOST_LOADER).toContain('[Environment]::Exit([TaskChute.ConPtyHost]::Run())')
  })

  test('uses the absolute Windows PowerShell path', () => {
    expect(getWindowsPowerShellPath({ SystemRoot: 'D:\\WINDOWS\\' })).toBe(
      'D:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
    expect(getWindowsPowerShellPath({})).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
  })
})

describe('ConPTY host environment', () => {
  test('carries the session parameters under the prefix the host clears', () => {
    const env = buildConPtyHostEnv({
      commandLine: '"C:\\claude.exe" "--" "hi"',
      cols: 120,
      rows: 40,
      transcriptPath: 'C:\\Temp/taskchute-run.log',
    })

    expect(env).toEqual({
      [CONPTY_HOST_SOURCE_ENV]: getEncodedConPtyHostSource(),
      TASKCHUTE_CONPTY_MODE: 'session',
      TASKCHUTE_CONPTY_COMMAND_LINE: '"C:\\claude.exe" "--" "hi"',
      TASKCHUTE_CONPTY_COLS: '120',
      TASKCHUTE_CONPTY_ROWS: '40',
      TASKCHUTE_CONPTY_TRANSCRIPT: 'C:\\Temp/taskchute-run.log',
    })
    for (const key of Object.keys(env)) {
      expect(key.startsWith(CONPTY_HOST_ENV_PREFIX)).toBe(true)
    }
    expect(CONPTY_HOST_CSHARP).toContain('ClearHostEnvironment();')
  })

  test('probe mode carries no session', () => {
    expect(buildConPtyHostEnv({ probe: true })).toEqual({
      [CONPTY_HOST_SOURCE_ENV]: getEncodedConPtyHostSource(),
      TASKCHUTE_CONPTY_MODE: 'probe',
    })
  })

  test('the compressed source round-trips and fits one environment variable', () => {
    const encoded = getEncodedConPtyHostSource()

    expect(gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8')).toBe(
      CONPTY_HOST_CSHARP,
    )
    // Keep headroom under the per-variable limit.
    expect(encoded.length).toBeLessThan(WINDOWS_ENV_VALUE_LIMIT / 2)
  })
})

describe('ConPTY host C# source', () => {
  test('shares the exit sentinel with TerminalDispatcher', () => {
    expect(CONPTY_HOST_EXIT_SENTINEL).toBe(TERMINAL_EXIT_SENTINEL)
    expect(CONPTY_HOST_CSHARP).toContain(
      `private const string ExitSentinel = "${TERMINAL_EXIT_SENTINEL}";`,
    )
  })

  test('embeds the protocol constants the TypeScript side encodes', () => {
    expect(CONPTY_HOST_CSHARP).toContain(`private const int FrameInput = ${CONPTY_FRAME_INPUT};`)
    expect(CONPTY_HOST_CSHARP).toContain(`private const int FrameResize = ${CONPTY_FRAME_RESIZE};`)
    expect(CONPTY_HOST_CSHARP).toContain(`private const string ProbeInput = "${CONPTY_PROBE_INPUT}";`)
    expect(CONPTY_HOST_CSHARP).toContain(`private const string ProbeOk = "${CONPTY_PROBE_OK_MARKER}";`)
    expect(CONPTY_HOST_CSHARP).toContain(
      `private const int HostFailureExitCode = ${CONPTY_HOST_FAILURE_EXIT_CODE};`,
    )
  })

  test('keeps the CLI off the host handles and inside a kill-on-close job', () => {
    expect(CONPTY_HOST_CSHARP).toContain('startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;')
    expect(CONPTY_HOST_CSHARP).toMatch(/CreateProcessW\(null, mutableCommandLine, IntPtr\.Zero, IntPtr\.Zero, false,/)
    expect(CONPTY_HOST_CSHARP).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE')
    expect(CONPTY_HOST_CSHARP).toContain('CREATE_SUSPENDED')
  })

  test('uses no syntax newer than the C# 5 compiler behind Add-Type', () => {
    const code = CONPTY_HOST_CSHARP.replace(/\/\/.*$/gmu, '')
    expect(code).not.toMatch(/\$"/u) // string interpolation
    expect(code).not.toMatch(/\?\./u) // null-conditional
    expect(code).not.toMatch(/\bnameof\s*\(/u)
    expect(code).not.toMatch(/\bout\s+var\b/u)
    expect(code).not.toMatch(/\)\s*=>/u) // expression-bodied members and lambdas
    expect(code).not.toMatch(/\?\?=/u)
    expect(code).not.toContain('${')
  })
})

describe('parseWindowsBuildNumber', () => {
  test('reads the build from os.release()', () => {
    expect(parseWindowsBuildNumber('10.0.22631')).toBe(22631)
    expect(parseWindowsBuildNumber('10.0.17763 ')).toBe(17763)
  })

  test('returns null for anything else', () => {
    expect(parseWindowsBuildNumber('')).toBeNull()
    expect(parseWindowsBuildNumber('Windows 11')).toBeNull()
  })
})
