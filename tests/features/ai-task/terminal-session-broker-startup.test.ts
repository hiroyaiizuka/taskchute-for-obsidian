import { EventEmitter } from 'events'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { AiRunExitOutcome } from '@/features/ai-task/services/dispatchers/Dispatcher'
import {
  TerminalSessionBrokerClient,
  type TerminalBrokerClientOptions,
} from '@/features/ai-task/services/TerminalSessionBroker'

jest.mock('child_process', () => ({
  ...jest.requireActual<typeof import('child_process')>('child_process'),
  spawn: jest.fn(),
}))

import { spawn } from 'child_process'

/**
 * Starting the broker never reaches a socket in these cases: either no Node.js
 * exists, or every Node.js tried fails before writing a descriptor. That is
 * the path a Dock-launched Obsidian took before any AI task had captured the
 * login shell's PATH — `spawn('node')` failed with ENOENT, and the client kept
 * polling five seconds for a broker that could never start, then reported only
 * "Terminal broker did not start" behind a red tab.
 */
const spawnMock = spawn as unknown as jest.Mock

type ChildBehaviour = { error: string } | { exit: number }

function fakeChild(behaviour: ChildBehaviour): EventEmitter & { unref(): void } {
  const child = Object.assign(new EventEmitter(), { unref: () => undefined })
  setTimeout(() => {
    if ('error' in behaviour) {
      child.emit('error', Object.assign(new Error(`spawn ${behaviour.error}`), {
        code: behaviour.error,
      }))
    } else {
      child.emit('exit', behaviour.exit, null)
    }
  }, 5)
  return child
}

function startOnce(
  options: Omit<TerminalBrokerClientOptions, 'identity'>,
): Promise<{ outcome: AiRunExitOutcome; elapsedMs: number }> {
  const client = new TerminalSessionBrokerClient({
    identity: `broker-startup-${process.pid}-${Date.now()}-${Math.random()}`,
    ...options,
  })
  const started = Date.now()
  return new Promise((resolve) => {
    client.start(
      'session-startup',
      { command: '/bin/sh', args: [], stdinMode: 'pipe' },
      '/tmp/transcript.log',
      undefined,
      {
        onData: () => undefined,
        onExit: (outcome) => resolve({ outcome, elapsedMs: Date.now() - started }),
      },
    )
  })
}

beforeEach(() => {
  spawnMock.mockReset()
})

describe('TerminalSessionBrokerClient broker startup', () => {
  test('fails at once with node-not-found when no Node.js exists', async () => {
    const { outcome, elapsedMs } = await startOnce({ locateNode: () => [] })

    expect(outcome).toMatchObject({
      status: 'failed',
      exitCode: null,
      terminalFailure: 'node-not-found',
    })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(elapsedMs).toBeLessThan(1000)
  })

  test('waits for the login-shell PATH before deciding Node.js is missing', async () => {
    const locateNode = jest
      .fn<string[], [Record<string, string | undefined>]>()
      .mockReturnValueOnce([])
      .mockReturnValue(['/login/bin/node'])
    const prepareEnv = jest.fn(async () => undefined)
    spawnMock.mockImplementation(() => fakeChild({ error: 'ENOENT' }))

    await startOnce({ locateNode, prepareEnv })

    expect(prepareEnv).toHaveBeenCalledTimes(1)
    expect(spawnMock).toHaveBeenCalledWith(
      '/login/bin/node',
      ['-e', expect.any(String)],
      expect.objectContaining({ detached: true }),
    )
  })

  test('never waits on a login shell that does not answer', async () => {
    const { outcome, elapsedMs } = await startOnce({
      locateNode: () => [],
      prepareEnv: () => new Promise<void>(() => undefined),
      prepareEnvTimeoutMs: 50,
    })

    expect(outcome.terminalFailure).toBe('node-not-found')
    expect(elapsedMs).toBeLessThan(1000)
  })

  test('a Node.js that cannot be spawned moves on at once instead of waiting out startup', async () => {
    spawnMock.mockImplementation(() => fakeChild({ error: 'ENOENT' }))

    const { outcome, elapsedMs } = await startOnce({
      locateNode: () => ['/gone/a/node', '/gone/b/node'],
      startupTimeoutMs: 5_000,
    })

    expect(spawnMock.mock.calls.map((call) => call[0])).toEqual([
      '/gone/a/node',
      '/gone/b/node',
    ])
    expect(outcome.terminalFailure).toBe('node-not-found')
    expect(elapsedMs).toBeLessThan(2_000)
  })

  test('a Node.js that exits during startup is skipped, and the error names it', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeChild({ exit: 1 }))
      .mockImplementationOnce(() => fakeChild({ error: 'EACCES' }))

    const { outcome } = await startOnce({
      locateNode: () => ['/broken/shim/node', '/no-permission/node'],
    })

    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(outcome.terminalFailure).toBe('broker-start-failed')
    expect(outcome.errorMessage).toContain('/broken/shim/node: exited with code 1')
    expect(outcome.errorMessage).toContain('/no-permission/node')
  })

  test('the default search spawns an absolute node found on the PATH', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'taskchute-node-locate-'))
    const nodePath = join(directory, 'node')
    writeFileSync(nodePath, '#!/bin/sh\n')
    chmodSync(nodePath, 0o755)
    spawnMock.mockImplementation(() => fakeChild({ error: 'ENOENT' }))
    try {
      await startOnce({ getEnv: () => ({ PATH: `/nonexistent:${directory}` }) })

      expect(spawnMock.mock.calls[0]?.[0]).toBe(nodePath)
      for (const call of spawnMock.mock.calls) {
        expect(call[0]).not.toBe('node')
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
