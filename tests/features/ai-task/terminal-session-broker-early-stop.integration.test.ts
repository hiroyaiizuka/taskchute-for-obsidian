import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getTerminalBrokerDescriptorPath,
  TerminalSessionBrokerClient,
} from '@/features/ai-task/services/TerminalSessionBroker'
import type { SpawnProcessRequest } from '@/features/ai-task/services/NodeProcessGateway'
import { describePosix } from '@tests/support/platform'
import { deferred, isAlive, ownerPidFiles, waitUntil, withTimeout } from './brokerTestUtils'

/**
 * LEV-380: a terminal whose guard is gone before it stopped the terminal.
 *
 * Every terminal's shell starts a background subshell that waits on fd 3, a
 * pipe the broker holds per session, and kills the shell's process group when
 * the pipe closes. A terminal force-stopped right after it was created could
 * lose its guard first: the broker kills a guard that has not finished a force
 * stop within 250ms, such as one still starting up. If the broker had not yet
 * seen the shell's processes either, nothing stopped them. The
 * subshell waited on a pipe the broker never closed, and since it held that
 * pipe, the broker never saw the guard's streams close — the terminal never
 * ended.
 *
 * The broker here runs a ps (TASKCHUTE_BROKER_TEST_PS) that leaves the
 * terminal's own processes out, as when it looked before they existed, and
 * the guard is killed directly.
 */
describePosix('TerminalSessionBroker when a guard is gone before its terminal (LEV-380)', () => {
  jest.setTimeout(240_000)

  /** The shape every real terminal has: an fd-3 watcher, then the work. */
  function watchedShell(marker: string): SpawnProcessRequest {
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

  const processesNamed = (marker: string): number =>
    execFileSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter((line) => line.includes(marker)).length

  test("the terminal's processes go with it, and the broker sees it end", async () => {
    const unique = `lev380-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const marker = `LEV380_${Math.random().toString(36).slice(2)}`
    const dir = mkdtempSync(join(tmpdir(), 'taskchute-test-ps-'))
    const transcriptPath = join(tmpdir(), `taskchute-session-guard-lost-${unique}.log`)
    const ps = join(dir, 'ps')
    writeFileSync(ps, `#!/bin/sh\n/bin/ps "$@" | grep -v -- '${marker}'\n`, { mode: 0o755 })
    const client = new TerminalSessionBrokerClient({
      identity,
      getEnv: () => ({ ...process.env, TASKCHUTE_BROKER_TEST_PS: ps }),
    })
    let brokerPid: number | undefined
    try {
      const attached = deferred<number>()
      const ready = deferred<void>()
      const exited = deferred<void>()
      let unavailable = false
      let output = ''
      client.start(
        'session-guard-lost',
        watchedShell(marker),
        transcriptPath,
        undefined,
        {
          onAttached: (pid) => {
            if (pid !== undefined) attached.resolve(pid)
          },
          onData: (data) => {
            output += data
            if (output.includes(marker)) ready.resolve()
          },
          onExit: () => exited.resolve(),
          onUnavailable: () => {
            unavailable = true
          },
        },
      )
      const guardPid = await withTimeout(attached.promise, 60_000)
      // The watcher is forked before the marker is printed.
      await withTimeout(ready.promise, 60_000)
      brokerPid = (JSON.parse(readFileSync(descriptorPath, 'utf8')) as { pid: number }).pid
      expect(processesNamed(marker)).toBeGreaterThanOrEqual(2)

      process.kill(guardPid, 'SIGKILL')

      await waitUntil(
        () => processesNamed(marker) === 0,
        "no process of the guard's terminal is left running",
        30_000,
      )
      await withTimeout(exited.promise, 30_000, 'the broker reporting the terminal ended')
      expect(unavailable).toBe(false)
      // The broker removes a session's owner record only when it finishes it.
      await waitUntil(
        () => ownerPidFiles(descriptorPath).length === 0,
        'the broker finished the session',
        30_000,
      )
      expect(isAlive(brokerPid)).toBe(true)
    } finally {
      await client.shutdown().catch(() => undefined)
      try {
        execFileSync('/usr/bin/pkill', ['-9', '-f', marker])
      } catch {
        // Best effort: normally none are left, as the test asserts.
      }
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
      rmSync(transcriptPath, { force: true })
    }
  })
})
