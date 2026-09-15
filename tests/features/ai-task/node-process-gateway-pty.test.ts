import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  CONPTY_PROBE_TIMEOUT_MS,
  MAX_TRANSCRIPT_READ_BYTES,
  NodeProcessGateway,
  TERMINAL_EXIT_SENTINEL,
  TRANSCRIPT_TRUNCATED_MARKER,
  TerminalUnsupportedError,
  type SpawnProcessRequest,
  type SpawnedProcessHandle,
} from '../../../src/features/ai-task/services/NodeProcessGateway'
import { encodeConPtyInputFrame } from '../../../src/features/ai-task/services/windows/ConPtyControlFrames'
import {
  CONPTY_HOST_POWERSHELL_ARGS,
  CONPTY_PROBE_INPUT,
  CONPTY_PROBE_OK_MARKER,
} from '../../../src/features/ai-task/services/windows/ConPtyHostSource'

/** POSIX single-quote escaping, mirrored here from first principles */
function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const REAL_PLATFORM = process.platform

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  })
}

afterEach(() => {
  setPlatform(REAL_PLATFORM)
})

describe('NodeProcessGateway.buildPtyCommand', () => {
  const BASE_REQUEST = {
    binaryPath: '/bin/claude',
    args: ['--dangerously-skip-permissions', 'do it'],
    rows: 24,
    cols: 80,
    transcriptPath: '/tmp/transcript.txt',
  }

  // The wrapper shape is load-bearing (verified on-device):
  //  - `cat |` interposes a REAL pipe because macOS `script` hard-fails on
  //    Node's socketpair stdin ("tcgetattr: Operation not supported on socket")
  //  - the sentinel + `kill -9 0` reap the pipeline on natural exit (cat never
  //    sees EOF) while carrying the child's real exit code out over stderr
  //  - -F / -f flush the transcript so SIGTERM stops cannot truncate it
  //  - the CLI is a supervised background child so a HUP trap is not deferred
  //    behind a hostile foreground process that ignores HUP/TERM
  //  - fd 3 closes in the kernel if the external broker crashes, so the
  //    wrapper can reap its own group without signalling a reusable PID
  const BROKER_WATCHDOG =
    'if [ "${TASKCHUTE_BROKER_WATCH_FD:-}" = "3" ]; then ' +
    '(IFS= read -r _ <&3; kill -9 0 2>/dev/null) & fi; '
  const DARWIN_WRAPPER =
    `${BROKER_WATCHDOG}cat 2>/dev/null | { TASKCHUTE_AI_TTY_PATH="$0.tty" ` +
    '/usr/bin/script -q -F "$0" /bin/sh -c ' +
    `'tty > "$TASKCHUTE_AI_TTY_PATH" 2>/dev/null; stty rows 24 cols 80 2>/dev/null; ` +
    `trap "trap - HUP TERM; kill -9 0" HUP TERM; ` +
    `"$0" "$@" <&0 & child=$!; wait "$child"' "$@"; st=$?; ` +
    `printf '${TERMINAL_EXIT_SENTINEL}%s\\n' "$st" >&2; kill -9 0 2>/dev/null; }`

  test('darwin: wraps the binary in the cat | script -q -F pipeline with an stty preamble', () => {
    setPlatform('darwin')
    const gateway = new NodeProcessGateway()

    const command = gateway.buildPtyCommand(BASE_REQUEST)

    expect(command).toEqual({
      command: '/bin/sh',
      args: [
        '-c',
        DARWIN_WRAPPER,
        '/tmp/transcript.txt',
        '/bin/claude',
        '--dangerously-skip-permissions',
        'do it',
      ],
    })
  })

  test('darwin: argv entries are passed positionally, never interpolated into shell text', () => {
    setPlatform('darwin')
    const gateway = new NodeProcessGateway()

    const command = gateway.buildPtyCommand({
      ...BASE_REQUEST,
      args: ["it's; rm -rf /", '$(danger)'],
    })

    // The dangerous strings appear only as standalone argv entries after the
    // wrapper string; the wrapper itself stays the fixed template.
    expect(command.args[1]).toBe(DARWIN_WRAPPER)
    expect(command.args.slice(2)).toEqual([
      '/tmp/transcript.txt',
      '/bin/claude',
      "it's; rm -rf /",
      '$(danger)',
    ])
  })

  test('linux: embeds a shell-quoted script -qefc command with the transcript as a positional', () => {
    setPlatform('linux')
    const gateway = new NodeProcessGateway()

    const command = gateway.buildPtyCommand(BASE_REQUEST)

    expect(command.command).toBe('/bin/sh')
    expect(command.args[0]).toBe('-c')
    expect(command.args[2]).toBe('/tmp/transcript.txt')
    expect(command.args.slice(3)).toEqual([
      '/bin/claude',
      '--dangerously-skip-permissions',
      'do it',
    ])
    const wrapper = command.args[1]
    expect(wrapper).toContain(BROKER_WATCHDOG)
    expect(wrapper).toContain('cat 2>/dev/null | {')
    expect(wrapper).toContain('TASKCHUTE_AI_TTY_PATH="$0.tty"')
    expect(wrapper).toContain(`printf '${TERMINAL_EXIT_SENTINEL}%s\\n' "$st" >&2`)
    expect(wrapper).toContain('kill -9 0 2>/dev/null')
    expect(wrapper).toContain(
      `/usr/bin/script -qefc ${posixQuote(
        "tty > \"$TASKCHUTE_AI_TTY_PATH\" 2>/dev/null; stty rows 24 cols 80 2>/dev/null; trap \"trap - HUP TERM; kill -9 0\" HUP TERM; '/bin/claude' '--dangerously-skip-permissions' 'do it' <&0 & child=$!; wait \"$child\"",
      )} "$0"`,
    )
  })

  test('linux: single quotes inside argv entries are escaped safely', () => {
    setPlatform('linux')
    const gateway = new NodeProcessGateway()

    const command = gateway.buildPtyCommand({
      ...BASE_REQUEST,
      args: ["it's; rm -rf /"],
    })

    expect(command.args[1]).toContain(
      posixQuote(
        "tty > \"$TASKCHUTE_AI_TTY_PATH\" 2>/dev/null; stty rows 24 cols 80 2>/dev/null; trap \"trap - HUP TERM; kill -9 0\" HUP TERM; '/bin/claude' 'it'\\''s; rm -rf /' <&0 & child=$!; wait \"$child\"",
      ),
    )
  })

  test('sanitizes non-integer terminal dimensions', () => {
    setPlatform('darwin')
    const gateway = new NodeProcessGateway()

    const floored = gateway.buildPtyCommand({ ...BASE_REQUEST, rows: 30.9, cols: 120.2 })
    expect(floored.args[1]).toContain('stty rows 30 cols 120')

    const fallback = gateway.buildPtyCommand({ ...BASE_REQUEST, rows: Number.NaN, cols: -5 })
    expect(fallback.args[1]).toContain('stty rows 24 cols 80')
  })

  test('win32: runs the ConPTY host with the session in its environment, never in PowerShell text', () => {
    const gateway = new NodeProcessGateway(undefined, 'win32')

    const command = gateway.buildPtyCommand({
      ...BASE_REQUEST,
      binaryPath: 'C:\\Program Files\\Claude\\claude.exe',
      args: ['--flag', 'say "hi"; $(danger)'],
    })

    expect(command.command).toMatch(
      /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/,
    )
    expect(command.args).toEqual([...CONPTY_HOST_POWERSHELL_ARGS])
    expect(command.env).toMatchObject({
      TASKCHUTE_CONPTY_MODE: 'session',
      TASKCHUTE_CONPTY_COMMAND_LINE:
        '"C:\\Program Files\\Claude\\claude.exe" "--flag" "say \\"hi\\"; $(danger)"',
      TASKCHUTE_CONPTY_COLS: '80',
      TASKCHUTE_CONPTY_ROWS: '24',
      TASKCHUTE_CONPTY_TRANSCRIPT: '/tmp/transcript.txt',
    })
    expect(command.env?.TASKCHUTE_CONPTY_HOST).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(command.args.join(' ')).not.toContain('claude.exe')
    expect(command.args.join(' ')).not.toContain('danger')
  })

  test('win32: sanitizes the grid the host starts the pseudo console with', () => {
    const gateway = new NodeProcessGateway(undefined, 'win32')

    const command = gateway.buildPtyCommand({ ...BASE_REQUEST, rows: 30.9, cols: -5 })

    expect(command.env?.TASKCHUTE_CONPTY_ROWS).toBe('30')
    expect(command.env?.TASKCHUTE_CONPTY_COLS).toBe('80')
  })

  test('win32: refuses to hand a batch file to CreateProcess', () => {
    const gateway = new NodeProcessGateway(undefined, 'win32')

    expect(() =>
      gateway.buildPtyCommand({ ...BASE_REQUEST, binaryPath: 'C:\\npm\\claude.CMD' }),
    ).toThrow('batch file')
  })

  test('throws a typed TerminalUnsupportedError on a platform without a wrapper', () => {
    const gateway = new NodeProcessGateway(undefined, 'freebsd')

    expect(() => gateway.buildPtyCommand(BASE_REQUEST)).toThrow(TerminalUnsupportedError)
  })
})

describe('NodeProcessGateway.getPtyTransport', () => {
  test('is script on POSIX and conpty on Windows', () => {
    expect(new NodeProcessGateway(undefined, 'darwin').getPtyTransport()).toBe('script')
    expect(new NodeProcessGateway(undefined, 'linux').getPtyTransport()).toBe('script')
    expect(new NodeProcessGateway(undefined, 'win32').getPtyTransport()).toBe('conpty')
  })
})

describe('NodeProcessGateway.isPtySupported', () => {
  test('is true on darwin and linux without a probe', async () => {
    const gateway = new NodeProcessGateway()
    setPlatform('darwin')
    expect(gateway.isPtySupported()).toBe(true)
    setPlatform('linux')
    expect(gateway.isPtySupported()).toBe(true)
    const spawn = jest.spyOn(gateway, 'spawnProcess')
    await gateway.ensurePtyCapability()
    expect(spawn).not.toHaveBeenCalled()
  })

  test('is false on unrecognized platforms', () => {
    expect(new NodeProcessGateway(undefined, 'freebsd').isPtySupported()).toBe(false)
  })
})

describe('NodeProcessGateway ConPTY probe (win32)', () => {
  interface FakeProbeProcess {
    handle: SpawnedProcessHandle
    controlWrites: Uint8Array[]
    emitStdout(text: string): void
    emitStderr(text: string): void
    exit(code: number | null): void
  }

  function fakeProbeProcess(): FakeProbeProcess {
    const stdout: Array<(text: string) => void> = []
    const stderr: Array<(text: string) => void> = []
    const exits: Array<(code: number | null, signal: string | null) => void> = []
    const controlWrites: Uint8Array[] = []
    return {
      controlWrites,
      handle: {
        pid: 777,
        onStdout: (callback) => stdout.push(callback),
        onStderr: (callback) => stderr.push(callback),
        onExit: (callback) => exits.push(callback),
        kill: jest.fn(),
        writeControl: (data) => controlWrites.push(data),
      },
      emitStdout: (text) => stdout.forEach((callback) => callback(text)),
      emitStderr: (text) => stderr.forEach((callback) => callback(text)),
      exit: (code) => exits.forEach((callback) => callback(code, null)),
    }
  }

  function probeGateway(build: number | null): {
    gateway: NodeProcessGateway
    spawn: jest.SpyInstance
    host: FakeProbeProcess
  } {
    const gateway = new NodeProcessGateway(undefined, 'win32')
    jest.spyOn(gateway, 'getWindowsBuildNumber').mockReturnValue(build)
    jest.spyOn(gateway, 'getBaseEnv').mockReturnValue({ SystemRoot: 'C:\\Windows' })
    const host = fakeProbeProcess()
    const spawn = jest.spyOn(gateway, 'spawnProcess').mockReturnValue(host.handle)
    return { gateway, spawn, host }
  }

  afterEach(() => {
    jest.useRealTimers()
  })

  test('stays unsupported before the probe has run', () => {
    const { gateway, spawn } = probeGateway(22631)

    expect(gateway.isPtySupported()).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  test('becomes supported when the host relays the probe through a pseudo console', async () => {
    const { gateway, spawn, host } = probeGateway(22631)

    const settled = gateway.ensurePtyCapability()
    host.emitStdout(`${CONPTY_PROBE_OK_MARKER}\n`)
    host.exit(0)
    await settled

    expect(gateway.isPtySupported()).toBe(true)
    expect(gateway.getPtyUnavailableReason()).toBeUndefined()
    expect(spawn).toHaveBeenCalledTimes(1)
    const request = spawn.mock.calls[0][0] as SpawnProcessRequest
    expect(request.command).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
    expect(request.args).toEqual([...CONPTY_HOST_POWERSHELL_ARGS])
    expect(request.controlPipe).toBe(true)
    expect(request.stdinMode).toBeUndefined()
    expect(request.env?.TASKCHUTE_CONPTY_MODE).toBe('probe')
    expect(host.controlWrites).toEqual([encodeConPtyInputFrame(CONPTY_PROBE_INPUT)])
  })

  test('probes once and reuses the verdict', async () => {
    const { gateway, spawn, host } = probeGateway(22631)

    const first = gateway.ensurePtyCapability()
    const second = gateway.ensurePtyCapability()
    host.emitStdout(CONPTY_PROBE_OK_MARKER)
    host.exit(0)
    await Promise.all([first, second])
    await gateway.ensurePtyCapability()

    expect(spawn).toHaveBeenCalledTimes(1)
  })

  test('stays unsupported with the host error when the probe fails', async () => {
    const { gateway, host } = probeGateway(22631)

    const settled = gateway.ensurePtyCapability()
    host.emitStderr('TaskChute ConPTY host: the control pipe was not inherited\r\n__TASKCHUTE_AI_EXIT__70\n')
    host.exit(70)
    await settled

    expect(gateway.isPtySupported()).toBe(false)
    expect(gateway.getPtyUnavailableReason()).toBe(
      'the ConPTY probe exited with code 70: TaskChute ConPTY host: the control pipe was not inherited',
    )
  })

  test('a zero exit without the OK marker is not success', async () => {
    const { gateway, host } = probeGateway(22631)

    const settled = gateway.ensurePtyCapability()
    host.emitStdout('TASKCHUTE_CONPTY_PROBE_OUTPUT\n')
    host.exit(0)
    await settled

    expect(gateway.isPtySupported()).toBe(false)
  })

  test('skips the host entirely on a build without ConPTY', async () => {
    const { gateway, spawn } = probeGateway(17134)

    await gateway.ensurePtyCapability()

    expect(spawn).not.toHaveBeenCalled()
    expect(gateway.isPtySupported()).toBe(false)
    expect(gateway.getPtyUnavailableReason()).toContain('17134')
  })

  test('gives up and kills the host when the probe hangs', async () => {
    jest.useFakeTimers()
    const { gateway, host } = probeGateway(22631)

    const settled = gateway.ensurePtyCapability()
    jest.advanceTimersByTime(CONPTY_PROBE_TIMEOUT_MS)
    await settled

    expect(host.handle.kill).toHaveBeenCalledWith('SIGKILL')
    expect(gateway.isPtySupported()).toBe(false)
    expect(gateway.getPtyUnavailableReason()).toContain('timed out')
  })

  test('reads the build number from the OS release only on Windows', () => {
    expect(new NodeProcessGateway(undefined, 'darwin').getWindowsBuildNumber()).toBeNull()
  })
})

describe('NodeProcessGateway temp file helpers', () => {
  test('makeTempFilePath returns unique paths inside the OS tmpdir with the sanitized prefix', () => {
    const gateway = new NodeProcessGateway()

    const first = gateway.makeTempFilePath('ai run/1')
    const second = gateway.makeTempFilePath('ai run/1')

    expect(first).not.toBe(second)
    for (const candidate of [first, second]) {
      expect(path.dirname(candidate)).toBe(os.tmpdir().replace(/[\\/]+$/, ''))
      expect(path.basename(candidate)).toMatch(/^ai-run-1-/)
      expect(path.basename(candidate)).not.toContain('/')
    }
  })

  test('readAndDeleteFile returns the content and removes the file', async () => {
    const gateway = new NodeProcessGateway()
    const target = gateway.makeTempFilePath('gateway-read-delete-test')
    fs.writeFileSync(target, 'transcript body 日本語', 'utf8')
    fs.writeFileSync(`${target}.tty`, '/dev/ttys001\n', 'utf8')

    const content = await gateway.readAndDeleteFile(target)

    expect(content).toBe('transcript body 日本語')
    expect(fs.existsSync(target)).toBe(false)
    expect(fs.existsSync(`${target}.tty`)).toBe(false)
  })

  test('readAndDeleteFile reads only the tail of an oversized transcript and still deletes it', async () => {
    const gateway = new NodeProcessGateway()
    const target = gateway.makeTempFilePath('gateway-oversized-transcript')
    const tailText = 'tail marker 日本語\n'
    const tailBytes = Buffer.byteLength(tailText, 'utf8')
    const filler = 'x'.repeat(MAX_TRANSCRIPT_READ_BYTES - 1 - tailBytes)
    // Total size is MAX + 2 bytes: the tail read starts on the FINAL
    // continuation byte of the leading 3-byte '日', exercising the UTF-8
    // boundary trim (the torn character is dropped, not replaced).
    fs.writeFileSync(target, `日${filler}${tailText}`, 'utf8')
    fs.writeFileSync(`${target}.tty`, '/dev/ttys001\n', 'utf8')

    const content = await gateway.readAndDeleteFile(target)

    expect(content).toBe(`${TRANSCRIPT_TRUNCATED_MARKER}\n${filler}${tailText}`)
    expect(content).not.toContain('�')
    expect(content.length).toBeLessThanOrEqual(
      MAX_TRANSCRIPT_READ_BYTES + TRANSCRIPT_TRUNCATED_MARKER.length + 1,
    )
    expect(fs.existsSync(target)).toBe(false)
    expect(fs.existsSync(`${target}.tty`)).toBe(false)
  }, 15_000)

  test('readAndDeleteFile leaves transcripts at or below the read cap unmarked', async () => {
    const gateway = new NodeProcessGateway()
    const target = gateway.makeTempFilePath('gateway-cap-sized-transcript')
    const content = 'y'.repeat(MAX_TRANSCRIPT_READ_BYTES)
    fs.writeFileSync(target, content, 'utf8')

    await expect(gateway.readAndDeleteFile(target)).resolves.toBe(content)
    expect(fs.existsSync(target)).toBe(false)
  }, 15_000)

  test('readAndDeleteFile rejects for a missing file', async () => {
    const gateway = new NodeProcessGateway()
    const missing = path.join(os.tmpdir(), 'taskchute-missing-transcript-for-test.txt')

    await expect(gateway.readAndDeleteFile(missing)).rejects.toBeDefined()
  })

  test('readAndDeleteFile removes the tty sidecar even when the transcript is missing', async () => {
    const gateway = new NodeProcessGateway()
    const missing = gateway.makeTempFilePath('gateway-missing-with-sidecar')
    fs.writeFileSync(`${missing}.tty`, '/dev/ttys001\n', 'utf8')

    await expect(gateway.readAndDeleteFile(missing)).rejects.toBeDefined()

    expect(fs.existsSync(`${missing}.tty`)).toBe(false)
  })
})

describe('NodeProcessGateway stdin modes', () => {
  test('default spawn exposes no stdin writer (stdin stays ignored)', async () => {
    const gateway = new NodeProcessGateway()
    const handle = gateway.spawnProcess({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: gateway.getBaseEnv(),
    })

    expect(handle.writeStdin).toBeUndefined()
    await new Promise<void>((resolve) => {
      handle.onExit(() => resolve())
    })
  }, 15_000)

  test("stdinMode 'pipe' provides a writer whose data reaches the child", async () => {
    const gateway = new NodeProcessGateway()
    const childScript = [
      "process.stdin.setEncoding('utf8')",
      "let buf = ''",
      "process.stdin.on('data', (d) => {",
      '  buf += d',
      "  if (buf.includes('\\n')) {",
      "    process.stdout.write('got:' + buf.trim())",
      '    process.exit(0)',
      '  }',
      '})',
    ].join('\n')
    const handle = gateway.spawnProcess({
      command: process.execPath,
      args: ['-e', childScript],
      env: gateway.getBaseEnv(),
      stdinMode: 'pipe',
    })

    let stdout = ''
    handle.onStdout((text) => {
      stdout += text
    })
    expect(typeof handle.writeStdin).toBe('function')
    handle.writeStdin?.('ping\n')

    const exit = await new Promise<{ code: number | null }>((resolve) => {
      handle.onExit((code) => resolve({ code }))
    })

    expect(exit.code).toBe(0)
    expect(stdout).toBe('got:ping')
  }, 15_000)

  test('default spawn exposes no control writer', async () => {
    const gateway = new NodeProcessGateway()
    const handle = gateway.spawnProcess({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: gateway.getBaseEnv(),
    })

    expect(handle.writeControl).toBeUndefined()
    await new Promise<void>((resolve) => {
      handle.onExit(() => resolve())
    })
  }, 15_000)

  test('controlPipe provides a writer whose bytes reach the child on descriptor 3', async () => {
    const gateway = new NodeProcessGateway()
    const childScript = [
      "const net = require('net')",
      'const control = new net.Socket({ fd: 3, readable: true, writable: false })',
      'let buf = Buffer.alloc(0)',
      "control.on('data', (d) => {",
      '  buf = Buffer.concat([buf, d])',
      '  if (buf.length >= 4) {',
      "    process.stdout.write('got:' + buf.toString('hex'))",
      '    process.exit(0)',
      '  }',
      '})',
    ].join('\n')
    const handle = gateway.spawnProcess({
      command: process.execPath,
      args: ['-e', childScript],
      env: gateway.getBaseEnv(),
      controlPipe: true,
    })

    let stdout = ''
    handle.onStdout((text) => {
      stdout += text
    })
    expect(typeof handle.writeControl).toBe('function')
    handle.writeControl?.(Uint8Array.from([0x00, 0x01, 0xfe, 0xff]))

    const exit = await new Promise<{ code: number | null }>((resolve) => {
      handle.onExit((code) => resolve({ code }))
    })

    expect(exit.code).toBe(0)
    expect(stdout).toBe('got:0001feff')
    expect(() => handle.writeControl?.(Uint8Array.from([1]))).not.toThrow()
  }, 15_000)

  test('writeStdin after exit is a safe no-op', async () => {
    const gateway = new NodeProcessGateway()
    const handle = gateway.spawnProcess({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: gateway.getBaseEnv(),
      stdinMode: 'pipe',
    })

    await new Promise<void>((resolve) => {
      handle.onExit(() => resolve())
    })

    expect(() => handle.writeStdin?.('late data\n')).not.toThrow()
  }, 15_000)
})
