import * as fs from 'fs'
import * as path from 'path'
import type {
  ProcessGateway,
  PtyCommand,
  PtyCommandRequest,
  SpawnProcessRequest,
  SpawnedProcessHandle,
} from '../../../../src/features/ai-task/services/NodeProcessGateway'
import type {
  AiDispatcher,
  AiGraceTimer,
  AiRunExitOutcome,
  AiRunProcessHandle,
  AiRunRequest,
} from '../../../../src/features/ai-task/services/dispatchers/Dispatcher'
import type { AiStreamEvent } from '../../../../src/features/ai-task/types'

export const FIXTURES_DIR = path.join(__dirname, '../fixtures')

/**
 * Make a fixture executable and ensure the `#!/usr/bin/env node` shebang can
 * resolve the node binary that is running jest. Returns a restore function.
 */
export function prepareFixture(fixturePath: string): () => void {
  fs.chmodSync(fixturePath, 0o755)
  const originalPath = process.env.PATH
  const nodeDir = path.dirname(process.execPath)
  if (!(originalPath ?? '').split(path.delimiter).includes(nodeDir)) {
    process.env.PATH = `${nodeDir}${path.delimiter}${originalPath ?? ''}`
  }
  return () => {
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
  }
}

export interface SpyGateway extends ProcessGateway {
  spawnMock: jest.Mock<SpawnedProcessHandle, [SpawnProcessRequest]>
  ptyMock: jest.Mock<PtyCommand, [PtyCommandRequest]>
  resizePtyMock: jest.Mock<boolean, [string, number, number]>
  baseEnv: Record<string, string | undefined>
}

/** A gateway whose spawnProcess records requests and returns an inert handle */
export function createSpyGateway(): SpyGateway {
  const baseEnv: Record<string, string | undefined> = { NO_COLOR: '1', BASE_ENV_MARKER: 'yes' }
  const spawnMock = jest.fn<SpawnedProcessHandle, [SpawnProcessRequest]>(() => ({
    pid: 4242,
    onStdout: () => undefined,
    onStderr: () => undefined,
    onExit: () => undefined,
    kill: () => undefined,
    writeStdin: () => undefined,
  }))
  const ptyMock = jest.fn<PtyCommand, [PtyCommandRequest]>((request) => ({
    command: '/usr/bin/script',
    args: ['-q', request.transcriptPath, request.binaryPath, ...request.args],
  }))
  const resizePtyMock = jest.fn<boolean, [string, number, number]>(() => true)
  return {
    spawnMock,
    ptyMock,
    resizePtyMock,
    baseEnv,
    spawnProcess: (request: SpawnProcessRequest) => spawnMock(request),
    execCapture: () => Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false }),
    getBaseEnv: () => baseEnv,
    getShellPath: () => '/bin/zsh',
    primeLoginShellPath: () => Promise.resolve(),
    isPtySupported: () => true,
    buildPtyCommand: (request: PtyCommandRequest) => ptyMock(request),
    resizePty: (transcriptPath: string, cols: number, rows: number) =>
      resizePtyMock(transcriptPath, cols, rows),
    makeTempFilePath: (prefix: string) => `/tmp/spy-gateway/${prefix}.log`,
    readAndDeleteFile: () => Promise.resolve(''),
  }
}

export interface RecordingGraceTimer extends AiGraceTimer {
  scheduled: Array<{ handle: number; timeoutMs: number }>
  cleared: number[]
}

/** A grace timer that records calls but never fires */
export function createRecordingGraceTimer(): RecordingGraceTimer {
  const scheduled: Array<{ handle: number; timeoutMs: number }> = []
  const cleared: number[] = []
  let nextHandle = 1
  return {
    scheduled,
    cleared,
    setTimeout: (handler: () => void, timeoutMs: number): number => {
      void handler
      const handle = nextHandle
      nextHandle += 1
      scheduled.push({ handle, timeoutMs })
      return handle
    },
    clearTimeout: (handle: number): void => {
      cleared.push(handle)
    },
  }
}

export interface DispatcherRun {
  handle: AiRunProcessHandle
  events: AiStreamEvent[]
  /** Resolves once the given event kind has been observed */
  waitForEvent(kind: AiStreamEvent['kind'], timeoutMs?: number): Promise<AiStreamEvent>
  /** Resolves with the exit outcome */
  waitForExit(): Promise<AiRunExitOutcome>
}

export function startDispatcherRun(dispatcher: AiDispatcher, request: AiRunRequest): DispatcherRun {
  const events: AiStreamEvent[] = []
  const eventWaiters: Array<{ kind: AiStreamEvent['kind']; resolve: (event: AiStreamEvent) => void }> = []
  let exitOutcome: AiRunExitOutcome | null = null
  const exitWaiters: Array<(outcome: AiRunExitOutcome) => void> = []

  const handle = dispatcher.start(request, {
    onEvent: (event) => {
      events.push(event)
      for (let index = eventWaiters.length - 1; index >= 0; index -= 1) {
        if (eventWaiters[index].kind === event.kind) {
          eventWaiters[index].resolve(event)
          eventWaiters.splice(index, 1)
        }
      }
    },
    onExit: (outcome) => {
      exitOutcome = outcome
      for (const waiter of exitWaiters) {
        waiter(outcome)
      }
      exitWaiters.length = 0
    },
  })

  return {
    handle,
    events,
    waitForEvent: (kind, timeoutMs = 10_000) => {
      const existing = events.find((event) => event.kind === kind)
      if (existing) return Promise.resolve(existing)
      return new Promise<AiStreamEvent>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for event kind "${kind}"`)),
          timeoutMs,
        )
        eventWaiters.push({
          kind,
          resolve: (event) => {
            clearTimeout(timer)
            resolve(event)
          },
        })
      })
    },
    waitForExit: () => {
      if (exitOutcome) return Promise.resolve(exitOutcome)
      return new Promise<AiRunExitOutcome>((resolve) => {
        exitWaiters.push(resolve)
      })
    },
  }
}

export async function runDispatcherToCompletion(
  dispatcher: AiDispatcher,
  request: AiRunRequest,
): Promise<{ events: AiStreamEvent[]; outcome: AiRunExitOutcome }> {
  const run = startDispatcherRun(dispatcher, request)
  const outcome = await run.waitForExit()
  return { events: run.events, outcome }
}
