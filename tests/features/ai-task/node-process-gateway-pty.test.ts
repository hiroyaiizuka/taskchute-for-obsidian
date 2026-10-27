import * as childProcess from 'child_process'
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
} from '@/features/ai-task/services/NodeProcessGateway'
import { encodeConPtyInputFrame } from '@/features/ai-task/services/windows/ConPtyControlFrames'
import {
  CONPTY_HOST_POWERSHELL_ARGS,
  CONPTY_PROBE_INPUT,
  CONPTY_PROBE_OK_MARKER,
} from '@/features/ai-task/services/windows/ConPtyHostSource'

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
    `exec 7<&0; "$0" "$@" <&7 7<&- & child=$!; exec 7<&-; wait "$child"' "$@"; st=$?; ` +
    `printf '${TERMINAL_EXIT_SENTINEL}%s\\n' "$st" >&2; kill -9 0 2>/dev/null; }`

  // Run first inside util-linux `script` (see the LEV-388 tests below).
  const LINUX_RESTORE_SHELL =
    'if [ -n "${TASKCHUTE_ORIGINAL_SHELL:-}" ]; then SHELL=$TASKCHUTE_ORIGINAL_SHELL; ' +
    'export SHELL; else unset SHELL; fi; unset TASKCHUTE_ORIGINAL_SHELL; '

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
    // dd, not cat: a cat that copies with splice(2) stalls script (see buildPtyCommand).
    expect(wrapper).toContain(`${BROKER_WATCHDOG}dd bs=65536 2>/dev/null | {`)
    expect(wrapper).not.toContain('cat ')
    expect(wrapper).toContain('TASKCHUTE_AI_TTY_PATH="$0.tty"')
    expect(wrapper).toContain(`printf '${TERMINAL_EXIT_SENTINEL}%s\\n' "$st" >&2`)
    expect(wrapper).toContain('kill -9 0 2>/dev/null')
    expect(wrapper).toContain(
      `/usr/bin/script -qefc ${posixQuote(
        `${LINUX_RESTORE_SHELL}tty > "$TASKCHUTE_AI_TTY_PATH" 2>/dev/null; stty rows 24 cols 80 2>/dev/null; trap "trap - HUP TERM; kill -9 0" HUP TERM; exec 7<&0; '/bin/claude' '--dangerously-skip-permissions' 'do it' <&7 7<&- & child=$!; exec 7<&-; wait "$child"`,
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
        `${LINUX_RESTORE_SHELL}tty > "$TASKCHUTE_AI_TTY_PATH" 2>/dev/null; stty rows 24 cols 80 2>/dev/null; trap "trap - HUP TERM; kill -9 0" HUP TERM; exec 7<&0; '/bin/claude' 'it'\\''s; rm -rf /' <&7 7<&- & child=$!; exec 7<&-; wait "$child"`,
      ),
    )
  })

  // LEV-388: util-linux `script -c` runs its command through `$SHELL -c`.
  // The command is quoted for POSIX sh, which fish reads differently (\' and
  // \\ are escapes inside fish single quotes), so `script` is started with
  // SHELL=/bin/sh and the user's own shell is put back for the CLI.
  test('linux: script runs its command with /bin/sh, never the user shell', () => {
    setPlatform('linux')
    const wrapper = new NodeProcessGateway().buildPtyCommand(BASE_REQUEST).args[1]

    expect(wrapper).toContain(
      'TASKCHUTE_ORIGINAL_SHELL=${SHELL-}; export TASKCHUTE_ORIGINAL_SHELL; ' +
        'TASKCHUTE_AI_TTY_PATH="$0.tty" SHELL=/bin/sh /usr/bin/script -qefc ',
    )
  })

  const posixTest = process.platform === 'win32' ? test.skip : test

  /** The command util-linux `script -qefc` is given, unquoted. */
  function linuxScriptCommand(wrapper: string): string {
    const match = /\/usr\/bin\/script -qefc ('(?:[^']|'\\'')*') "\$0"/u.exec(wrapper)
    if (!match) throw new Error('No script -qefc command in the wrapper')
    return match[1].slice(1, -1).replace(/'\\''/gu, "'")
  }

  posixTest("linux: the CLI gets the user's SHELL back and its arguments intact", () => {
    setPlatform('linux')
    const report =
      'process.stdout.write(JSON.stringify({ shell: process.env.SHELL ?? null, ' +
      'saved: process.env.TASKCHUTE_ORIGINAL_SHELL ?? null, args: process.argv.slice(1) }))'
    const tricky = "it\\'s $(echo pwned) \\\\ 'quoted'"
    const command = linuxScriptCommand(
      new NodeProcessGateway().buildPtyCommand({
        ...BASE_REQUEST,
        binaryPath: process.execPath,
        args: ['-e', report, tricky],
      }).args[1],
    )
    // What util-linux `script` does with the command: `$SHELL -c <command>`.
    const runAsScriptWould = (originalShell: string): unknown =>
      JSON.parse(
        childProcess.execFileSync('/bin/sh', ['-c', command], {
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            SHELL: '/bin/sh',
            TASKCHUTE_ORIGINAL_SHELL: originalShell,
            TASKCHUTE_AI_TTY_PATH: '/dev/null',
          },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 10_000,
        }),
      )

    expect(runAsScriptWould('/usr/local/bin/fish')).toEqual({
      shell: '/usr/local/bin/fish',
      saved: null,
      args: [tricky],
    })
    // No SHELL to begin with: the CLI gets none, as `script` would have left it.
    expect(runAsScriptWould('')).toEqual({ shell: null, saved: null, args: [tricky] })
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

  test('win32: a shell-backed run names the PowerShell that takes over after the CLI', () => {
    const gateway = new NodeProcessGateway(undefined, 'win32')
    jest.spyOn(gateway, 'getWindowsInteractiveShellPath').mockReturnValue('C:\\Program Files\\PowerShell\\7\\pwsh.exe')

    const command = gateway.buildPtyCommand({ ...BASE_REQUEST, thenShell: true })
    const plain = gateway.buildPtyCommand({ ...BASE_REQUEST })

    expect(command.env?.TASKCHUTE_CONPTY_THEN_SHELL).toBe('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" "-NoLogo"')
    expect(plain.env).not.toHaveProperty('TASKCHUTE_CONPTY_THEN_SHELL')
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

    try {
      expect(first).not.toBe(second)
      for (const candidate of [first, second]) {
        expect(path.dirname(candidate)).toBe(os.tmpdir().replace(/[\\/]+$/, ''))
        expect(path.basename(candidate)).toMatch(/^ai-run-1-/)
        expect(path.basename(candidate)).not.toContain('/')
      }
    } finally {
      fs.rmSync(first, { force: true })
      fs.rmSync(second, { force: true })
    }
  })

  // LEV-388: `script` creates a missing transcript with the umask (often
  // 0644), and the OS temp directory is shared on Linux. The file is made
  // here, owner-only, so the transcript is never readable by other users.
  test('makeTempFilePath creates the transcript empty and owner-only', () => {
    const gateway = new NodeProcessGateway()
    const target = gateway.makeTempFilePath('gateway-owner-only')
    try {
      const stats = fs.lstatSync(target)
      expect(stats.isFile()).toBe(true)
      expect(stats.size).toBe(0)
      if (process.platform !== 'win32') {
        expect(stats.mode & 0o777).toBe(0o600)
      }
    } finally {
      fs.rmSync(target, { force: true })
    }
  })

  test('makeTempFilePath never hands out a name that already exists', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    jest.spyOn(Math, 'random').mockReturnValue(0.5)
    const taken = new NodeProcessGateway().makeTempFilePath('gateway-name-taken')
    let fresh: string | undefined
    try {
      fs.writeFileSync(taken, 'planted', 'utf8')

      // A second gateway starts from the same sequence, so its first pick is `taken`.
      fresh = new NodeProcessGateway().makeTempFilePath('gateway-name-taken')

      expect(fresh).not.toBe(taken)
      expect(fs.readFileSync(taken, 'utf8')).toBe('planted')
    } finally {
      jest.restoreAllMocks()
      fs.rmSync(taken, { force: true })
      if (fresh !== undefined) fs.rmSync(fresh, { force: true })
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

  // LEV-387: a transcript path also comes back from the terminal broker, a
  // separate process; a forged one must not make the plugin read or delete
  // any other file.
  test('readAndDeleteFile leaves a file that is not one of its temp files', async () => {
    const gateway = new NodeProcessGateway()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskchute-foreign-'))
    const outside = path.join(dir, 'notes.md')
    const lookalike = path.join(os.tmpdir(), `precious-${process.pid}.log`)
    try {
      for (const target of [outside, lookalike]) {
        fs.writeFileSync(target, 'keep me', 'utf8')
        fs.writeFileSync(`${target}.tty`, '/dev/ttys001\n', 'utf8')

        await expect(gateway.readAndDeleteFile(target)).rejects.toThrow('temp file')

        expect(fs.readFileSync(target, 'utf8')).toBe('keep me')
        expect(fs.existsSync(`${target}.tty`)).toBe(true)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.rmSync(lookalike, { force: true })
      fs.rmSync(`${lookalike}.tty`, { force: true })
    }
  })

  test('readAndDeleteFile never follows a link planted under a temp-file name', async () => {
    const gateway = new NodeProcessGateway()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskchute-link-target-'))
    const target = path.join(dir, 'secret.txt')
    const link = gateway.makeTempFilePath('gateway-planted-link')
    try {
      fs.writeFileSync(target, 'keep me secret', 'utf8')
      // Swapped for a link after the gateway created it.
      fs.rmSync(link, { force: true })
      fs.symlinkSync(target, link)

      await expect(gateway.readAndDeleteFile(link)).rejects.toThrow('regular file')

      expect(fs.readFileSync(target, 'utf8')).toBe('keep me secret')
    } finally {
      fs.rmSync(link, { force: true })
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('readPtyTtyPath reads the sidecar of its own temp files only', async () => {
    const gateway = new NodeProcessGateway()
    const own = gateway.makeTempFilePath('gateway-tty-sidecar')
    const foreign = path.join(os.tmpdir(), `foreign-${process.pid}.log`)
    try {
      fs.writeFileSync(`${own}.tty`, '/dev/ttys001\n', 'utf8')
      fs.writeFileSync(`${foreign}.tty`, '/dev/ttys002\n', 'utf8')

      await expect(gateway.readPtyTtyPath(own)).resolves.toBe('/dev/ttys001')
      await expect(gateway.readPtyTtyPath(foreign)).resolves.toBeNull()
    } finally {
      fs.rmSync(own, { force: true })
      fs.rmSync(`${own}.tty`, { force: true })
      fs.rmSync(`${foreign}.tty`, { force: true })
    }
  })

  test('readAndDeleteFile removes the tty sidecar even when the transcript is missing', async () => {
    const gateway = new NodeProcessGateway()
    const missing = gateway.makeTempFilePath('gateway-missing-with-sidecar')
    fs.rmSync(missing, { force: true })
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
