import { execFileSync, spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE } from '../../../src/features/ai-task/services/TerminalSessionOwnerWatchdogSource'
import {
  BROKER_TEST_TIMEOUT_MS,
  isAlive,
  waitUntil,
  waitUntilAllGone,
} from './brokerTestUtils'

/**
 * The owner watchdog on its own, with no broker and no session guard.
 *
 * Every existing test of this program reaches it through a broker that is then
 * SIGKILLed, which means the guard is alive and racing it: on a healthy host the
 * guard reaps the tree first and the watchdog's own decision is never the thing
 * under test. That is why a watchdog that had stopped reaping entirely still
 * showed up as four intermittent, platform-specific timeouts somewhere else.
 *
 * Here the watchdog is the only actor. It gets a hand-written owner record, a
 * real detached child holding a real sentinel descriptor, and an EOF on stdin —
 * which is exactly what a broker crash looks like from inside it.
 */
jest.setTimeout(BROKER_TEST_TIMEOUT_MS * 2)

type Session = {
  childPid: number
  descriptorPath: string
  directory: string
  ownerFile: string
  prefix: string
}

const BROKER_PID_STANDIN = 999_999_999

const started: ChildProcess[] = []

const spawnDetached = (script: string): ChildProcess => {
  const child = spawn('/bin/sh', ['-c', script], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  started.push(child)
  return child
}

/**
 * A child that holds the owner record open on fd 9 — the same descriptor the
 * broker's spawn hook installs, and the thing the watchdog authenticates it by.
 */
const startSession = (name: string): Session => {
  const directory = mkdtempSync(join(tmpdir(), `owner-watchdog-${name}-`))
  const prefix = join(directory, 'owner-session')
  const ownerFile = `${prefix}-${name}.jsonl`
  const descriptorPath = join(directory, 'descriptor.json')
  writeFileSync(ownerFile, '', { mode: 0o600 })
  writeFileSync(
    descriptorPath,
    JSON.stringify({ pid: BROKER_PID_STANDIN, token: 'watchdog-test-token' }),
    { mode: 0o600 },
  )
  const startedAtLower = Date.now()
  const child = spawnDetached(
    `exec 9<${JSON.stringify(ownerFile)}; while :; do sleep 10; done`,
  )
  const startedAt = Date.now()
  if (child.pid === undefined) throw new Error('Detached child was not started')
  writeFileSync(
    ownerFile,
    `${JSON.stringify({
      pid: child.pid,
      startedAt,
      startedAtLower,
      active: true,
      kind: 'process',
      parentPid: process.pid,
      processGroup: child.pid,
      commandHint: 'sh',
      sentinelFd: 9,
      sentinelPath: ownerFile,
    })}\n`,
    { mode: 0o600 },
  )
  return { childPid: child.pid, descriptorPath, directory, ownerFile, prefix }
}

/** The pids `ps` reports in `pgid`'s process group. */
const groupMembers = (pgid: number): number[] =>
  execFileSync('/bin/ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s*$/u.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .filter((match) => Number(match[2]) === pgid)
    .map((match) => Number(match[1]))

/** Starts the watchdog and closes its stdin, which is what a crash looks like. */
const crashInto = (
  session: Session,
  env: NodeJS.ProcessEnv = {},
): ChildProcess => {
  const watchdog = spawn(
    process.execPath,
    ['-e', TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE],
    {
      detached: true,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        TASKCHUTE_OWNER_WATCH_PREFIX: session.prefix,
        TASKCHUTE_OWNER_WATCH_DESCRIPTOR: session.descriptorPath,
        TASKCHUTE_OWNER_WATCH_TOKEN: 'watchdog-test-token',
        TASKCHUTE_OWNER_WATCH_BROKER_PID: String(BROKER_PID_STANDIN),
        ...env,
      },
    },
  )
  started.push(watchdog)
  watchdog.stdin?.end()
  return watchdog
}

const exitOf = (watchdog: ChildProcess): Promise<number | null> =>
  new Promise((resolve) => watchdog.once('exit', (code) => resolve(code)))

afterEach(() => {
  for (const child of started) {
    if (child.pid === undefined) continue
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      try {
        process.kill(child.pid, 'SIGKILL')
      } catch {
        // Already reaped, which is what most of these tests assert.
      }
    }
  }
  started.length = 0
})

describe('the owner watchdog after a broker crash', () => {
  test('reaps the recorded child and clears the session artifacts', async () => {
    const session = startSession('plain')
    const watchdog = crashInto(session)

    await waitUntilAllGone([session.childPid])
    expect(await exitOf(watchdog)).toBe(0)
    expect(existsSync(session.ownerFile)).toBe(false)
    expect(existsSync(session.descriptorPath)).toBe(false)
    rmSync(session.directory, { recursive: true, force: true })
  })

  /**
   * The CI-only failure the reap path was rebuilt for.
   *
   * Where the sentinel descriptor cannot be read — a /proc that refuses the
   * readlink, an image without lsof — the watchdog used to classify this child
   * as unproven forever: it signalled nothing and declared nothing clean, so it
   * retried until the machine went down while the child stayed alive and its
   * owner record stayed on disk. Both halves of that are asserted here, and the
   * override makes the probe answer the way that host does, so this now runs on
   * any platform rather than being discovered by a runner.
   */
  test('reaps it even where the sentinel descriptor cannot be read', async () => {
    const session = startSession('blind')
    const watchdog = crashInto(session, {
      TASKCHUTE_OWNER_SENTINEL_TEST_UNREADABLE: '1',
    })

    await waitUntilAllGone([session.childPid])
    expect(await exitOf(watchdog)).toBe(0)
    expect(existsSync(session.ownerFile)).toBe(false)
    rmSync(session.directory, { recursive: true, force: true })
  })

  test('reaps the recorded child together with its descendants', async () => {
    const session = startSession('tree')
    // The record names one pid. Everything below it in the same process group
    // has to go with it, which is what the group signal is for. The assertion
    // is on the group rather than on pids captured beforehand: the child spawns
    // a fresh `sleep` every few seconds, and in a container PID numbers are
    // recycled fast enough that a captured one can come back as something else.
    await waitUntil(
      () => groupMembers(session.childPid).length > 1,
      'the recorded child has a descendant in its group',
    )

    const watchdog = crashInto(session)

    await waitUntilAllGone([session.childPid])
    expect(await exitOf(watchdog)).toBe(0)
    expect(groupMembers(session.childPid)).toEqual([])
    rmSync(session.directory, { recursive: true, force: true })
  })

  test('leaves a pid whose birth time contradicts the record alone', async () => {
    const session = startSession('reused')
    // The same PID number, recorded as having been born a day ago: what a
    // watchdog reading a stale record sees after the number is reused.
    const record = JSON.parse(
      readFileSync(session.ownerFile, 'utf8').trim(),
    ) as Record<string, unknown>
    writeFileSync(
      session.ownerFile,
      `${JSON.stringify({
        ...record,
        startedAt: Date.now() - 86_400_000,
        startedAtLower: Date.now() - 86_400_000 - 100,
      })}\n`,
      { mode: 0o600 },
    )
    const watchdog = crashInto(session)

    expect(await exitOf(watchdog)).toBe(0)
    expect(isAlive(session.childPid)).toBe(true)
    rmSync(session.directory, { recursive: true, force: true })
  })

  test('a disarmed watchdog reaps nothing', async () => {
    const session = startSession('disarm')
    const watchdog = spawn(
      process.execPath,
      ['-e', TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE],
      {
        detached: true,
        stdio: ['pipe', 'pipe', 'inherit'],
        env: {
          ...process.env,
          TASKCHUTE_OWNER_WATCH_PREFIX: session.prefix,
          TASKCHUTE_OWNER_WATCH_DESCRIPTOR: session.descriptorPath,
          TASKCHUTE_OWNER_WATCH_TOKEN: 'watchdog-test-token',
          TASKCHUTE_OWNER_WATCH_BROKER_PID: String(BROKER_PID_STANDIN),
        },
      },
    )
    started.push(watchdog)
    watchdog.stdin?.write('DISARM\n')
    watchdog.stdin?.end()

    expect(await exitOf(watchdog)).toBe(0)
    expect(isAlive(session.childPid)).toBe(true)
    expect(existsSync(session.ownerFile)).toBe(true)
    rmSync(session.directory, { recursive: true, force: true })
  })

  test('writes the evidence behind each round when a trace is asked for', async () => {
    const session = startSession('trace')
    const tracePath = join(session.directory, 'trace.jsonl')
    const watchdog = crashInto(session, {
      TASKCHUTE_OWNER_WATCH_TRACE: tracePath,
    })

    await waitUntilAllGone([session.childPid])
    await exitOf(watchdog)
    await waitUntil(() => existsSync(tracePath), 'the trace was written')
    const rounds = readFileSync(tracePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        kill: { pid: number; target: string }[]
        outcome: string
        roots: {
          hint: string | null
          kind: string | null
          pid: number
          reason: string
          state: string
        }[]
      })

    // The question a stalled watchdog has to be able to answer: which pid, in
    // what state, on what evidence.
    expect(rounds[0]?.roots).toContainEqual(
      expect.objectContaining({
        pid: session.childPid,
        state: 'match',
        reason: 'verified',
        // The identity the verdict was reached from, not just the verdict: a
        // record that cannot be corroborated is the difference between a reap
        // and a stall, and it is invisible from the surviving processes.
        kind: 'process',
        hint: 'sh',
      }),
    )
    expect(rounds[0]?.kill).toContainEqual({
      pid: session.childPid,
      target: 'group',
    })
    expect(rounds[rounds.length - 1]?.outcome).toBe('cleanup')
    rmSync(session.directory, { recursive: true, force: true })
  })
})
