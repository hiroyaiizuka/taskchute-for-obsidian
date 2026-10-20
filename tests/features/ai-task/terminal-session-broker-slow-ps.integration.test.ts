import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getTerminalBrokerDescriptorPath,
  TerminalSessionBrokerClient,
} from '@/features/ai-task/services/TerminalSessionBroker'
import type { SpawnProcessRequest } from '@/features/ai-task/services/NodeProcessGateway'
import { describePosix } from '@tests/support/platform'
import { deferred, isAlive, ownerPidFiles, sleep, waitUntil, withTimeout } from './brokerTestUtils'

/**
 * LEV-379: when a session ends or is force-stopped, the broker confirms its
 * processes with ps (and lsof on a Mac). Those calls used to block the
 * broker's whole event loop. On a busy Mac a ps takes seconds, and right
 * after wake longer, so every other terminal stopped answering and a new one
 * timed out while a single session was being cleaned up.
 *
 * The broker here runs a ps given through TASKCHUTE_BROKER_TEST_PS: one that
 * takes five seconds, or one that always fails. Nothing else is faked.
 */
describePosix('TerminalSessionBroker while ps is slow or failing (LEV-379)', () => {
  jest.setTimeout(240_000)

  function echoShell(marker: string): SpawnProcessRequest {
    return {
      command: '/bin/sh',
      args: [
        '-c',
        'if [ "$TASKCHUTE_BROKER_WATCH_FD" = "3" ]; then ' +
          '(IFS= read -r _ <&3; kill -9 0 2>/dev/null) & ' +
          `fi; printf "${marker}\\n"; while IFS= read -r line; do printf "ECHO:%s\\n" "$line"; done`,
      ],
      env: { ...process.env },
      stdinMode: 'pipe',
    }
  }

  function startSession(
    client: TerminalSessionBrokerClient,
    sessionId: string,
    marker: string,
    unique: string,
  ) {
    const attached = deferred<number>()
    const ready = deferred<void>()
    const exited = deferred<void>()
    const unavailable = deferred<void>()
    let output = ''
    let pid: number | undefined
    client.start(
      sessionId,
      echoShell(marker),
      join(tmpdir(), `taskchute-${sessionId}-${unique}.log`),
      undefined,
      {
        onAttached: (attachedPid) => {
          if (attachedPid === undefined) return
          pid = attachedPid
          attached.resolve(attachedPid)
        },
        onData: (data) => {
          output += data
          if (output.includes(marker)) ready.resolve()
        },
        onExit: () => exited.resolve(),
        onUnavailable: () => unavailable.resolve(),
      },
    )
    return {
      attached: attached.promise,
      ready: ready.promise,
      exited: exited.promise,
      unavailable: unavailable.promise,
      output: () => output,
      pid: () => pid,
    }
  }

  /** How long until `predicate` holds, polling every 10ms, or null after `limitMs`. */
  async function timeUntil(predicate: () => boolean, limitMs: number): Promise<number | null> {
    const started = Date.now()
    while (Date.now() - started < limitMs) {
      if (predicate()) return Date.now() - started
      await sleep(10)
    }
    return null
  }

  /** A broker client whose broker runs `psScript` as its ps. */
  function brokerWithPs(name: string, psScript: string) {
    const unique = `lev379-${name}-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const dir = mkdtempSync(join(tmpdir(), 'taskchute-test-ps-'))
    const ps = join(dir, 'ps')
    writeFileSync(ps, psScript, { mode: 0o755 })
    const client = new TerminalSessionBrokerClient({
      identity,
      getEnv: () => ({ ...process.env, TASKCHUTE_BROKER_TEST_PS: ps }),
    })
    let brokerPid: number | undefined
    return {
      unique,
      client,
      rememberBroker: () => {
        brokerPid = (JSON.parse(readFileSync(descriptorPath, 'utf8')) as { pid: number }).pid
      },
      cleanup: async () => {
        await client.shutdown().catch(() => undefined)
        if (brokerPid !== undefined) {
          try {
            process.kill(brokerPid, 'SIGKILL')
          } catch {
            // Already gone.
          }
        }
        try {
          unlinkSync(descriptorPath)
        } catch {
          // The broker normally removes its own descriptor.
        }
        for (const path of ownerPidFiles(descriptorPath)) rmSync(path, { force: true })
        rmSync(dir, { recursive: true, force: true })
      },
    }
  }

  test('a session being cleaned up does not stop the other terminals, or a new one', async () => {
    const PS_DELAY_SECONDS = 5
    const broker = brokerWithPs('slow', `#!/bin/sh\nsleep ${PS_DELAY_SECONDS}\nexec /bin/ps "$@"\n`)
    const { client, unique } = broker
    try {
      const ending = startSession(client, 'session-ending', 'ENDING_READY', unique)
      await withTimeout(ending.ready, 60_000)
      const other = startSession(client, 'session-other', 'OTHER_READY', unique)
      await withTimeout(other.ready, 60_000)
      broker.rememberBroker()
      // Let the startup ownership samples (already asynchronous) settle.
      await sleep(PS_DELAY_SECONDS * 1000 + 500)

      // Force-stop one session: the broker now confirms its processes.
      client.stop('session-ending', true)
      await sleep(300)

      // The other terminal still answers at once.
      client.write('session-other', 'ping\n')
      const echoMs = await timeUntil(() => other.output().includes('ECHO:ping'), 60_000)
      expect(echoMs).not.toBeNull()
      expect(echoMs).toBeLessThan(2500)

      // A new terminal opens: before, its spawn waited behind the cleanup and
      // the client gave up on it.
      const fresh = startSession(client, 'session-new', 'NEW_READY', unique)
      const first = await Promise.race([
        fresh.attached.then(() => 'attached' as const),
        fresh.unavailable.then(() => 'unavailable' as const),
      ])
      expect(first).toBe('attached')
      await withTimeout(fresh.ready, 30_000)

      // And the stopped session does finish, with its processes gone.
      await withTimeout(ending.exited, 120_000, 'the stopped session reporting its exit')
      await waitUntil(() => !isAlive(ending.pid()), 'the stopped session process is gone', 30_000)
    } finally {
      await broker.cleanup()
    }
  })

  test('with a ps that always fails, a stopped session still finishes', async () => {
    const broker = brokerWithPs('failing', '#!/bin/sh\nexit 1\n')
    const { client, unique } = broker
    try {
      const ending = startSession(client, 'session-ending', 'ENDING_READY', unique)
      await withTimeout(ending.ready, 60_000)
      broker.rememberBroker()

      client.stop('session-ending', true)

      await withTimeout(ending.exited, 60_000, 'the stopped session reporting its exit')
      await waitUntil(() => !isAlive(ending.pid()), 'the stopped session process is gone', 30_000)
    } finally {
      await broker.cleanup()
    }
  })
})
