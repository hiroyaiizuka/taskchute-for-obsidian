import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  NodeProcessGateway,
  TERMINAL_EXIT_SENTINEL,
  TerminalUnsupportedError,
} from '../../../src/features/ai-task/services/NodeProcessGateway'

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
  const DARWIN_WRAPPER =
    'cat 2>/dev/null | { /usr/bin/script -q -F "$0" /bin/sh -c ' +
    `'stty rows 24 cols 80 2>/dev/null; exec "$0" "$@"' "$@"; st=$?; ` +
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
    const wrapper = command.args[1]
    expect(wrapper).toContain('cat 2>/dev/null | {')
    expect(wrapper).toContain(`printf '${TERMINAL_EXIT_SENTINEL}%s\\n' "$st" >&2`)
    expect(wrapper).toContain('kill -9 0 2>/dev/null')
    expect(wrapper).toContain(
      `/usr/bin/script -qefc ${posixQuote(
        "stty rows 24 cols 80 2>/dev/null; exec '/bin/claude' '--dangerously-skip-permissions' 'do it'",
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
      posixQuote("stty rows 24 cols 80 2>/dev/null; exec '/bin/claude' 'it'\\''s; rm -rf /'"),
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

  test('win32: throws a typed TerminalUnsupportedError', () => {
    setPlatform('win32')
    const gateway = new NodeProcessGateway()

    expect(() => gateway.buildPtyCommand(BASE_REQUEST)).toThrow(TerminalUnsupportedError)
  })
})

describe('NodeProcessGateway.isPtySupported', () => {
  test('is true on darwin and linux', () => {
    const gateway = new NodeProcessGateway()
    setPlatform('darwin')
    expect(gateway.isPtySupported()).toBe(true)
    setPlatform('linux')
    expect(gateway.isPtySupported()).toBe(true)
  })

  test('is false on win32', () => {
    const gateway = new NodeProcessGateway()
    setPlatform('win32')
    expect(gateway.isPtySupported()).toBe(false)
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

    const content = await gateway.readAndDeleteFile(target)

    expect(content).toBe('transcript body 日本語')
    expect(fs.existsSync(target)).toBe(false)
  })

  test('readAndDeleteFile rejects for a missing file', async () => {
    const gateway = new NodeProcessGateway()
    const missing = path.join(os.tmpdir(), 'taskchute-missing-transcript-for-test.txt')

    await expect(gateway.readAndDeleteFile(missing)).rejects.toBeDefined()
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
