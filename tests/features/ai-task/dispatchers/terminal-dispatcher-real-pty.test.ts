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
import * as path from 'path'
import { NodeProcessGateway } from '../../../../src/features/ai-task/services/NodeProcessGateway'
import { TerminalDispatcher } from '../../../../src/features/ai-task/services/dispatchers/TerminalDispatcher'
import type {
  TerminalRunHandle,
} from '../../../../src/features/ai-task/services/dispatchers/TerminalDispatcher'
import type { AiRunExitOutcome } from '../../../../src/features/ai-task/services/dispatchers/Dispatcher'
import { FIXTURES_DIR, prepareFixture } from './dispatcherTestUtils'

const FAKE_INTERACTIVE = path.join(FIXTURES_DIR, 'fake-interactive.js')

const describeDarwin = process.platform === 'darwin' ? describe : describe.skip

interface PtyRun {
  handle: TerminalRunHandle
  transcriptPath: string
  gateway: NodeProcessGateway
  data: () => string
  waitForData(needle: string, timeoutMs?: number): Promise<void>
  waitForExit(): Promise<AiRunExitOutcome>
}

function startRealPtyRun(): PtyRun {
  const gateway = new NodeProcessGateway()
  const dispatcher = new TerminalDispatcher(gateway)
  const transcriptPath = gateway.makeTempFilePath('real-pty-test')
  let data = ''
  let exitOutcome: AiRunExitOutcome | null = null
  const exitWaiters: Array<(outcome: AiRunExitOutcome) => void> = []

  const handle = dispatcher.start(
    {
      binaryPath: FAKE_INTERACTIVE,
      prompt: '',
      rows: 24,
      cols: 80,
      transcriptPath,
    },
    {
      onData: (bytes) => {
        data += bytes
      },
      onExit: (outcome) => {
        exitOutcome = outcome
        for (const waiter of exitWaiters.splice(0)) waiter(outcome)
      },
    },
  )

  return {
    handle,
    transcriptPath,
    gateway,
    data: () => data,
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
    waitForExit: () => {
      if (exitOutcome) return Promise.resolve(exitOutcome)
      return new Promise<AiRunExitOutcome>((resolve) => {
        exitWaiters.push(resolve)
      })
    },
  }
}

describeDarwin('TerminalDispatcher through the real PTY wrapper (darwin)', () => {
  let restorePath: () => void

  beforeAll(() => {
    restorePath = prepareFixture(FAKE_INTERACTIVE)
  })

  afterAll(() => {
    restorePath()
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
})
