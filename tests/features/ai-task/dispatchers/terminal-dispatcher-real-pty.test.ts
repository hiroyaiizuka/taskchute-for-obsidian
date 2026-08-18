/**
 * Darwin-only integration tests that run the REAL PTY wrapper
 * (NodeProcessGateway.buildPtyCommand -> /bin/sh -> cat | /usr/bin/script)
 * against the fake-interactive fixture. These lock in the on-device facts
 * the terminal feature depends on:
 *  - `script` gets a PTY and both directions relay through the pipeline
 *  - the exit-code sentinel maps clean/failed sessions correctly even
 *    though the wrapper reaps its own group with SIGKILL
 *  - stop() (process-group SIGTERM) ends the session as 'stopped'
 *  - the transcript file records the session (script -F) and is consumable
 *    via readAndDeleteFile
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import { NodeProcessGateway } from '../../../../src/features/ai-task/services/NodeProcessGateway'
import { TerminalDispatcher } from '../../../../src/features/ai-task/services/dispatchers/TerminalDispatcher'
import type {
  TerminalRunHandle,
} from '../../../../src/features/ai-task/services/dispatchers/TerminalDispatcher'
import type { AiRunExitOutcome } from '../../../../src/features/ai-task/services/dispatchers/Dispatcher'
import { FIXTURES_DIR, prepareFixture, resizeOf } from './dispatcherTestUtils'

const FAKE_INTERACTIVE = path.join(FIXTURES_DIR, 'fake-interactive.js')

const describeDarwin = process.platform === 'darwin' ? describe : describe.skip
const activePtyRuns = new Set<TerminalRunHandle>()
const observedFixturePids = new Set<number>()

interface PtyRun {
  handle: TerminalRunHandle
  transcriptPath: string
  gateway: NodeProcessGateway
  data: () => string
  hasExited: () => boolean
  waitForData(needle: string, timeoutMs?: number): Promise<void>
  waitForExit(timeoutMs?: number): Promise<AiRunExitOutcome>
}

function startRealPtyRun(options?: {
  binaryPath?: string
  binaryArgsPrefix?: string[]
  envPatch?: Record<string, string | undefined>
  extraArgs?: string[]
  launchInShell?: boolean
  prompt?: string
  shellPath?: string
  snapshotDescendantPids?: (rootPid: number) => number[]
  terminalCommand?: 'claude' | 'codex'
  terminalFallbackCommand?: 'claude' | 'codex'
}): PtyRun {
  const gateway = new NodeProcessGateway(options?.snapshotDescendantPids)
  if (options?.shellPath !== undefined) {
    jest.spyOn(gateway, 'getShellPath').mockReturnValue(options.shellPath)
  }
  const dispatcher = new TerminalDispatcher(gateway)
  const transcriptPath = gateway.makeTempFilePath('real-pty-test')
  let data = ''
  let exitOutcome: AiRunExitOutcome | null = null
  const exitWaiters: Array<(outcome: AiRunExitOutcome) => void> = []

  const handle = dispatcher.start(
    {
      binaryPath: options?.binaryPath ?? FAKE_INTERACTIVE,
      binaryArgsPrefix: options?.binaryArgsPrefix,
      envPatch: options?.envPatch,
      prompt: options?.prompt ?? '',
      extraArgs: options?.extraArgs,
      launchInShell: options?.launchInShell,
      terminalCommand: options?.terminalCommand,
      terminalFallbackCommand: options?.terminalFallbackCommand,
      rows: 24,
      cols: 80,
      transcriptPath,
    },
    {
      onData: (bytes) => {
        data += bytes
        for (const match of data.matchAll(/(?:INTERACTIVE|DETACHED)_PID:(\d+)/gu)) {
          observedFixturePids.add(Number(match[1]))
        }
      },
      onExit: (outcome) => {
        exitOutcome = outcome
        activePtyRuns.delete(handle)
        for (const waiter of exitWaiters.splice(0)) waiter(outcome)
      },
    },
  )
  activePtyRuns.add(handle)

  return {
    handle,
    transcriptPath,
    gateway,
    data: () => data,
    hasExited: () => exitOutcome !== null,
    waitForData: (needle, timeoutMs = 15_000) =>
      new Promise<void>((resolve, reject) => {
        const startedAt = Date.now()
        const poll = setInterval(() => {
          if (data.includes(needle)) {
            clearInterval(poll)
            resolve()
            return
          }
          if (Date.now() - startedAt > timeoutMs) {
            clearInterval(poll)
            reject(new Error(`Timed out waiting for PTY data "${needle}"; got: ${data}`))
          }
        }, 25)
      }),
    waitForExit: (timeoutMs = 15_000) => {
      if (exitOutcome) return Promise.resolve(exitOutcome)
      return new Promise<AiRunExitOutcome>((resolve, reject) => {
        const waiter = (outcome: AiRunExitOutcome): void => {
          window.clearTimeout(timeout)
          resolve(outcome)
        }
        const timeout = window.setTimeout(() => {
          const index = exitWaiters.indexOf(waiter)
          if (index >= 0) exitWaiters.splice(index, 1)
          reject(new Error('Timed out waiting for PTY wrapper exit'))
        }, timeoutMs)
        exitWaiters.push(waiter)
      })
    },
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const startedAt = Date.now()
    const poll = setInterval(() => {
      if (!isProcessAlive(pid)) {
        clearInterval(poll)
        resolve()
        return
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(poll)
        reject(new Error(`PTY child ${pid} survived wrapper shutdown`))
      }
    }, 25)
  })
}

describeDarwin('TerminalDispatcher through the real PTY wrapper (darwin)', () => {
  let restorePath: () => void

  beforeAll(() => {
    restorePath = prepareFixture(FAKE_INTERACTIVE)
  })

  afterAll(() => {
    restorePath()
  })

  afterEach(async () => {
    const activeHandles = [...activePtyRuns]
    for (const handle of activeHandles) {
      handle.forceKill?.()
      if (typeof handle.pid !== 'number') continue
      try {
        process.kill(-handle.pid, 'SIGKILL')
      } catch {
        // The wrapper group already exited.
      }
    }
    for (const pid of observedFixturePids) {
      if (!isProcessAlive(pid)) continue
      process.kill(pid, 'SIGKILL')
    }
    for (const pid of observedFixturePids) {
      await waitForProcessExit(pid)
    }
    for (const handle of activeHandles) {
      if (typeof handle.pid === 'number') await waitForProcessExit(handle.pid)
    }
    activePtyRuns.clear()
    observedFixturePids.clear()
  })

  test('relays a full roundtrip, propagates exit 0, and records the transcript', async () => {
    const run = startRealPtyRun()

    await run.waitForData('INTERACTIVE_READY')
    run.handle.write('ping\r')
    await run.waitForData('echo:ping')
    run.handle.write('exit\r')
    const outcome = await run.waitForExit()

    expect(outcome.status).toBe('succeeded')
    expect(outcome.exitCode).toBe(0)

    const transcript = await run.gateway.readAndDeleteFile(run.transcriptPath)
    expect(transcript).toContain('INTERACTIVE_READY')
    expect(transcript).toContain('echo:ping')
    expect(fs.existsSync(run.transcriptPath)).toBe(false)
  }, 30_000)

  test('a shell-backed AI CLI returns to the login shell after Ctrl+C', async () => {
    const run = startRealPtyRun({ launchInShell: true })

    await run.waitForData('INTERACTIVE_READY')
    run.handle.write('\x03')
    run.handle.write("printf '__SHELL_%s__\\n' 'RETURNED'\r")
    await run.waitForData('__SHELL_RETURNED__')

    expect(run.hasExited()).toBe(false)
    run.handle.write('exit\r')
    const outcome = await run.waitForExit()
    expect(outcome.status).toBe('succeeded')

    const transcript = await run.gateway.readAndDeleteFile(run.transcriptPath)
    expect(transcript).toContain('INTERACTIVE_READY')
    expect(transcript).toContain('__SHELL_RETURNED__')
  }, 30_000)

  test('a shell-backed AI CLI receives a multibyte prompt larger than MAX_CANON intact', async () => {
    const prompt =
      `AIメモリーupdate: ${'長い日本語プロンプト'.repeat(180)}\n` +
      `quotes ' "$() \`pwd\` ; final-marker-終端`
    const promptBytes = Buffer.byteLength(prompt, 'utf8')
    const promptHash = createHash('sha256').update(prompt, 'utf8').digest('hex')
    expect(promptBytes).toBeGreaterThan(1_024)

    const run = startRealPtyRun({
      launchInShell: true,
      extraArgs: ['--report-prompt'],
      prompt,
    })

    await run.waitForData(`PROMPT_BYTES:${promptBytes}`)
    await run.waitForData(`PROMPT_SHA256:${promptHash}`)
    run.handle.write('\x03')
    run.handle.write("printf '__LONG_PROMPT_SHELL_RETURNED__\\n'\r")
    await run.waitForData('__LONG_PROMPT_SHELL_RETURNED__')

    run.handle.write('exit\r')
    const outcome = await run.waitForExit()
    expect(outcome.status).toBe('succeeded')

    const transcript = await run.gateway.readAndDeleteFile(run.transcriptPath)
    expect(transcript).toContain(`PROMPT_BYTES:${promptBytes}`)
    expect(transcript).toContain(`PROMPT_SHA256:${promptHash}`)
  }, 30_000)

  test('a fresh shell command replaces a stale versioned executable without typing shell source', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskchute-cli-shim-'))
    const codexPath = path.join(binDir, 'codex')
    fs.symlinkSync(FAKE_INTERACTIVE, codexPath)
    try {
      const run = startRealPtyRun({
        binaryPath: '/deleted/versioned/path/codex',
        envPatch: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        },
        launchInShell: true,
        shellPath: '/bin/sh',
        terminalCommand: 'codex',
        terminalFallbackCommand: 'codex',
      })

      await run.waitForData('INTERACTIVE_READY')
      expect(run.data()).not.toContain('if command -v')
      expect(run.data()).not.toContain('No such file or directory')

      run.handle.write('\x03')
      run.handle.write("printf '__FRESH_COMMAND_SHELL_RETURNED__\\n'\r")
      await run.waitForData('__FRESH_COMMAND_SHELL_RETURNED__')
      run.handle.write('exit\r')
      const outcome = await run.waitForExit()
      expect(outcome.status).toBe('succeeded')
      await run.gateway.readAndDeleteFile(run.transcriptPath)
    } finally {
      fs.rmSync(binDir, { force: true, recursive: true })
    }
  }, 30_000)

  test('resize updates the real script PTY dimensions', async () => {
    const run = startRealPtyRun()

    await run.waitForData('INTERACTIVE_READY')
    resizeOf(run.handle)(132, 41)
    run.handle.write('size\r')
    await run.waitForData('SIZE:41x132')

    run.handle.write('exit\r')
    await run.waitForExit()
    await run.gateway.readAndDeleteFile(run.transcriptPath)
    expect(fs.existsSync(`${run.transcriptPath}.tty`)).toBe(false)
  }, 30_000)

  test('propagates a non-zero child exit code through the sentinel', async () => {
    const run = startRealPtyRun()

    await run.waitForData('INTERACTIVE_READY')
    run.handle.write('fail\r')
    const outcome = await run.waitForExit()

    expect(outcome.status).toBe('failed')
    expect(outcome.exitCode).toBe(7)

    await run.gateway.readAndDeleteFile(run.transcriptPath).catch(() => '')
  }, 30_000)

  test('stop() tears the whole pipeline down as stopped', async () => {
    const run = startRealPtyRun()

    await run.waitForData('INTERACTIVE_READY')
    run.handle.stop()
    const outcome = await run.waitForExit()

    expect(outcome.status).toBe('stopped')

    await run.gateway.readAndDeleteFile(run.transcriptPath).catch(() => '')
  }, 30_000)

  test('stop() reaps signal-ignoring PTY and detached-session children', async () => {
    let detachedPid = 0
    const run = startRealPtyRun({
      extraArgs: ['--ignore-signals', '--spawn-detached-child'],
      // Process-tree discovery itself is covered by NodeProcessGateway's
      // injected-seam test. Inject the observed detached PID here because
      // Codex's test sandbox denies /bin/ps, then exercise the REAL wrapper,
      // dispatcher onExit sweep, and OS signals end-to-end.
      snapshotDescendantPids: () => (detachedPid > 0 ? [detachedPid] : []),
    })
    let interactivePid = 0
    try {
      await run.waitForData('DETACHED_PID:')
      interactivePid = Number(run.data().match(/INTERACTIVE_PID:(\d+)/u)?.[1] ?? 0)
      detachedPid = Number(run.data().match(/DETACHED_PID:(\d+)/u)?.[1] ?? 0)
      expect(interactivePid).toBeGreaterThan(0)
      expect(detachedPid).toBeGreaterThan(0)
      expect(isProcessAlive(interactivePid)).toBe(true)
      expect(isProcessAlive(detachedPid)).toBe(true)

      run.handle.stop()
      const outcome = await run.waitForExit()
      expect(outcome.status).toBe('stopped')
      await Promise.all([
        waitForProcessExit(interactivePid),
        waitForProcessExit(detachedPid),
      ])
    } finally {
      run.handle.forceKill?.()
      for (const pid of [interactivePid, detachedPid]) {
        if (pid > 0 && isProcessAlive(pid)) process.kill(pid, 'SIGKILL')
      }
      for (const pid of [interactivePid, detachedPid]) {
        if (pid > 0) await waitForProcessExit(pid)
      }
      await run.gateway.readAndDeleteFile(run.transcriptPath).catch(() => '')
    }
  }, 30_000)
})
