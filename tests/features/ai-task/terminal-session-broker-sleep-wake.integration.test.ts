import { execFileSync, spawn, type ChildProcess } from 'child_process'
import {
  existsSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { createConnection, createServer, type AddressInfo, type Server, type Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getTerminalBrokerDescriptorPath,
  TerminalSessionBrokerClient,
  type TerminalBrokerClientOptions,
  type TerminalBrokerSessionCallbacks,
} from '@/features/ai-task/services/TerminalSessionBroker'
import type { SpawnProcessRequest } from '@/features/ai-task/services/NodeProcessGateway'
import { describePosix } from '@tests/support/platform'
import {
  deferred,
  isAlive,
  ownerPidFiles,
  sleep,
  waitUntil,
  withTimeout,
} from './brokerTestUtils'

/**
 * LEV-377: after the Mac slept, a terminal session's termination could stay
 * "unconfirmed" forever. While it did, the client refused every new terminal
 * ("Terminal broker is recovering from an unconfirmed session failure") and
 * silently dropped every keystroke, and only a renderer reload cleared it.
 *
 * The first half drives the client against in-process fake brokers that
 * never confirm anything, which is the only way to hold a session in that
 * state deterministically. The second half reproduces it against the real
 * broker with SIGKILL and SIGSTOP. Recovery is per session and per broker:
 * no broker-wide shutdown is ever sent, the give-up window runs on a clock
 * that stops during sleep, and a lost connection is reported once.
 */

const TOKEN = 'a'.repeat(64)

interface FakeBroker {
  server: Server
  port: number
  ops: string[]
  /** Drop every connected client, as a broker restart would. */
  dropClients(): void
}

/**
 * A broker that acknowledges spawns but never answers termination, and
 * answers attach only when asked to.
 */
async function startFakeBroker(
  options: { answerAttach?: boolean; answerTerminate?: 'missing' } = {},
): Promise<FakeBroker> {
  const ops: string[] = []
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const message = JSON.parse(buffer.slice(0, newline)) as {
          op: string
          sessionId?: string
        }
        buffer = buffer.slice(newline + 1)
        ops.push(`${message.op}:${message.sessionId ?? ''}`)
        if (message.op === 'terminate-unavailable' && options.answerTerminate === 'missing') {
          socket.write(`${JSON.stringify({ type: 'missing', sessionId: message.sessionId })}\n`)
        }
        if (message.op === 'spawn' || (message.op === 'attach' && options.answerAttach)) {
          socket.write(`${JSON.stringify({
            type: 'attached',
            sessionId: message.sessionId,
            status: 'running',
            replay: '',
            pid: 999_999,
          })}\n`)
        }
        newline = buffer.indexOf('\n')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const close = server.close.bind(server)
  server.close = (callback?: (error?: Error) => void) => {
    for (const socket of sockets) socket.destroy()
    return close(callback)
  }
  return {
    server,
    port: (server.address() as AddressInfo).port,
    ops,
    dropClients: () => {
      for (const socket of sockets) socket.destroy()
    },
  }
}

function writeDescriptor(identity: string, port: number, pid: number): string {
  const descriptorPath = getTerminalBrokerDescriptorPath(identity)
  writeFileSync(
    descriptorPath,
    JSON.stringify({ version: 1, port, token: TOKEN, pid }),
    { mode: 0o600 },
  )
  return descriptorPath
}

/** Client tuned so an unanswered attach becomes an unconfirmed termination fast. */
function fastClient(
  identity: string,
  overrides: Partial<TerminalBrokerClientOptions> = {},
): TerminalSessionBrokerClient {
  return new TerminalSessionBrokerClient({
    identity,
    sessionAckTimeoutMs: 100,
    unavailableTerminationTimeoutMs: 50,
    shutdownTimeoutMs: 50,
    unavailableRecoveryBaseMs: 20,
    unavailableRecoveryMaxMs: 40,
    ...overrides,
  })
}

function recordingCallbacks() {
  const connectionLost = deferred<void>()
  const unavailable = deferred<void>()
  const inputDropped = deferred<void>()
  const counts = { connectionLost: 0, unavailable: 0, inputDropped: 0, exit: 0 }
  const callbacks: TerminalBrokerSessionCallbacks = {
    onData: () => undefined,
    onExit: () => {
      counts.exit += 1
    },
    onUnavailable: () => {
      counts.unavailable += 1
      unavailable.resolve()
    },
    onConnectionLost: () => {
      counts.connectionLost += 1
      connectionLost.resolve()
    },
    onInputDropped: () => {
      counts.inputDropped += 1
      inputDropped.resolve()
    },
  }
  return { callbacks, counts, connectionLost, unavailable, inputDropped }
}

const SHELL_REQUEST: SpawnProcessRequest = {
  command: '/bin/sh',
  args: ['-c', 'while :; do sleep 1; done'],
  stdinMode: 'pipe',
}

describePosix('TerminalSessionBroker after an unconfirmed session (LEV-377)', () => {
  jest.setTimeout(30_000)

  test('a session stuck in confirmation no longer blocks a new terminal', async () => {
    const fake = await startFakeBroker()
    const identity = `lev377-unblocked-${process.pid}-${Date.now()}-${Math.random()}`
    const descriptorPath = writeDescriptor(identity, fake.port, process.pid)
    const client = fastClient(identity)
    try {
      const stuck = recordingCallbacks()
      client.attach('session-stuck', stuck.callbacks)
      await withTimeout(stuck.connectionLost.promise)

      const fresh = deferred<number | undefined>()
      let freshExit: unknown
      client.start('session-fresh', SHELL_REQUEST, '/tmp/fresh.log', undefined, {
        onData: () => undefined,
        onAttached: (pid) => fresh.resolve(pid),
        onExit: (outcome) => {
          freshExit = outcome
          fresh.resolve(undefined)
        },
      })

      expect(await withTimeout(fresh.promise)).toBe(999_999)
      expect(freshExit).toBeUndefined()
      expect(fake.ops).toContain('spawn:session-fresh')
      // The stuck session is still being confirmed, not quietly dropped.
      expect(stuck.counts.unavailable).toBe(0)
    } finally {
      client.detach()
      if (existsSync(descriptorPath)) unlinkSync(descriptorPath)
      await new Promise((resolve) => fake.server.close(resolve))
    }
  })

  test('input for a session being confirmed is reported, not swallowed', async () => {
    const fake = await startFakeBroker()
    const identity = `lev377-input-${process.pid}-${Date.now()}-${Math.random()}`
    const descriptorPath = writeDescriptor(identity, fake.port, process.pid)
    const client = fastClient(identity)
    try {
      const stuck = recordingCallbacks()
      client.attach('session-input', stuck.callbacks)
      await withTimeout(stuck.connectionLost.promise)

      client.write('session-input', 'ls\r')
      await withTimeout(stuck.inputDropped.promise)

      expect(stuck.counts.inputDropped).toBe(1)
      expect(fake.ops).not.toContain('input:session-input')
    } finally {
      client.detach()
      if (existsSync(descriptorPath)) unlinkSync(descriptorPath)
      await new Promise((resolve) => fake.server.close(resolve))
    }
  })

  test('confirmation is given up after the bounded window and reported once', async () => {
    const fake = await startFakeBroker()
    const identity = `lev377-giveup-${process.pid}-${Date.now()}-${Math.random()}`
    const descriptorPath = writeDescriptor(identity, fake.port, process.pid)
    const client = fastClient(identity, { unavailableConfirmationGiveUpMs: 400 })
    try {
      const stuck = recordingCallbacks()
      const started = Date.now()
      client.attach('session-giveup', stuck.callbacks)

      await withTimeout(stuck.unavailable.promise, 5_000)
      const elapsed = Date.now() - started

      expect(stuck.counts.connectionLost).toBe(1)
      expect(elapsed).toBeGreaterThanOrEqual(400)
      // The broker never confirmed anything: only the window ended it.
      expect(fake.ops.filter((op) => op === 'terminate-unavailable:session-giveup').length)
        .toBeGreaterThan(1)
      await sleep(300)
      expect(stuck.counts.unavailable).toBe(1)
      expect(stuck.counts.exit).toBe(0)
    } finally {
      client.detach()
      if (existsSync(descriptorPath)) unlinkSync(descriptorPath)
      await new Promise((resolve) => fake.server.close(resolve))
    }
  })

  test('a dead broker without a descriptor confirms a session whose pid never arrived', async () => {
    // Stand-in for the broker process: something the test can kill.
    const brokerStandIn: ChildProcess = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    )
    const standInPid = brokerStandIn.pid as number
    const standInExited = new Promise<void>((resolve) => brokerStandIn.once('exit', () => resolve()))
    const fake = await startFakeBroker()
    const identity = `lev377-dead-${process.pid}-${Date.now()}-${Math.random()}`
    const descriptorPath = writeDescriptor(identity, fake.port, standInPid)
    // The give-up window is far away: only the confirmation can settle it.
    const client = fastClient(identity, { unavailableConfirmationGiveUpMs: 60_000 })
    try {
      const orphan = recordingCallbacks()
      client.attach('session-orphan', orphan.callbacks)
      await withTimeout(orphan.connectionLost.promise)

      brokerStandIn.kill('SIGKILL')
      await standInExited
      unlinkSync(descriptorPath)
      await new Promise((resolve) => fake.server.close(resolve))

      await withTimeout(orphan.unavailable.promise, 5_000)
      expect(orphan.counts.unavailable).toBe(1)
    } finally {
      client.detach()
      if (isAlive(standInPid)) brokerStandIn.kill('SIGKILL')
      if (existsSync(descriptorPath)) unlinkSync(descriptorPath)
    }
  })

  // Item 3: the window runs on a clock that stops during sleep, and needs real
  // attempts. A wall clock that jumped a whole night must not write the
  // session off on the first attempt after wake.
  test('a wall-clock jump (sleep) does not end the confirmation window; monotonic time and attempts do', async () => {
    const fake = await startFakeBroker()
    const identity = `lev377-clock-${process.pid}-${Date.now()}-${Math.random()}`
    const descriptorPath = writeDescriptor(identity, fake.port, process.pid)
    let monotonic = 0
    let wall = Date.now()
    const client = fastClient(identity, {
      unavailableConfirmationGiveUpMs: 1_000,
      unavailableConfirmationMinAttempts: 3,
      monotonicNow: () => monotonic,
      now: () => wall,
    })
    try {
      const stuck = recordingCallbacks()
      client.attach('session-clock', stuck.callbacks)
      await withTimeout(stuck.connectionLost.promise)

      // A night passes on the wall clock only.
      wall += 8 * 60 * 60 * 1000
      await waitUntil(
        () => fake.ops.filter((op) => op === 'terminate-unavailable:session-clock').length >= 5,
        'several recovery attempts ran',
      )
      expect(stuck.counts.unavailable).toBe(0)

      // Only the monotonic clock passing the window ends it.
      monotonic += 1_000
      await withTimeout(stuck.unavailable.promise, 5_000)
      expect(stuck.counts.unavailable).toBe(1)
    } finally {
      client.detach()
      if (existsSync(descriptorPath)) unlinkSync(descriptorPath)
      await new Promise((resolve) => fake.server.close(resolve))
    }
  })

  // Items 4 and 5: sessions of different brokers are tracked separately — each
  // termination goes to the session's own broker, and only that broker's
  // death confirms a session whose pid never arrived.
  test('pending sessions of two brokers are terminated and confirmed per owning broker', async () => {
    const standIn: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    const standInPid = standIn.pid as number
    const standInExited = new Promise<void>((resolve) => standIn.once('exit', () => resolve()))
    const first = await startFakeBroker()
    const second = await startFakeBroker()
    const identity = `lev377-two-brokers-${process.pid}-${Date.now()}-${Math.random()}`
    // The first broker stays alive (this test process) the whole time.
    const descriptorPath = writeDescriptor(identity, first.port, process.pid)
    const client = fastClient(identity, { unavailableConfirmationGiveUpMs: 60_000 })
    try {
      const onFirst = recordingCallbacks()
      client.attach('session-on-first', onFirst.callbacks)
      await withTimeout(onFirst.connectionLost.promise)

      // The transport to the first broker goes away and the descriptor now
      // names another broker; the next session lands there.
      first.dropClients()
      await sleep(20)
      writeDescriptor(identity, second.port, standInPid)
      const onSecond = recordingCallbacks()
      client.attach('session-on-second', onSecond.callbacks)
      await withTimeout(onSecond.connectionLost.promise)
      await waitUntil(
        () => second.ops.includes('terminate-unavailable:session-on-second'),
        'the second broker was asked about its own session',
      )

      expect(first.ops).toContain('terminate-unavailable:session-on-first')
      expect(first.ops).not.toContain('terminate-unavailable:session-on-second')
      expect(second.ops).not.toContain('terminate-unavailable:session-on-first')

      // The second broker dies and its descriptor is replaced: that confirms
      // its own session, and says nothing about the first broker's.
      standIn.kill('SIGKILL')
      await standInExited
      writeDescriptor(identity, first.port, process.pid)
      await new Promise((resolve) => second.server.close(resolve))

      await withTimeout(onSecond.unavailable.promise, 5_000)
      await sleep(300)
      expect(onSecond.counts.unavailable).toBe(1)
      expect(onFirst.counts.unavailable).toBe(0)
    } finally {
      client.detach()
      if (isAlive(standInPid)) standIn.kill('SIGKILL')
      if (existsSync(descriptorPath)) unlinkSync(descriptorPath)
      await new Promise((resolve) => first.server.close(resolve))
      await new Promise((resolve) => second.server.close(() => resolve(undefined)))
    }
  })

  // Item 7: a reconnect blip is not a dropped-input notice; input lost in an
  // outage that does not recover is reported once.
  test('input lost in a reconnect blip is silent; the same loss is reported once if the session is written off', async () => {
    const attaching = await startFakeBroker({ answerAttach: true })
    const identity = `lev377-input-blip-${process.pid}-${Date.now()}-${Math.random()}`
    const descriptorPath = writeDescriptor(identity, attaching.port, process.pid)
    const client = fastClient(identity, { unavailableConfirmationGiveUpMs: 60_000 })
    try {
      const session = recordingCallbacks()
      const attached = deferred<void>()
      client.attach('session-blip', { ...session.callbacks, onAttached: () => attached.resolve() })
      await withTimeout(attached.promise)

      // Blip: the connection drops and the descriptor is briefly gone.
      unlinkSync(descriptorPath)
      attaching.dropClients()
      await sleep(20)
      client.write('session-blip', 'lost-in-blip\r')
      await sleep(30)
      expect(session.counts.inputDropped).toBe(0)

      // The descriptor never comes back: the reconnect gives up.
      await withTimeout(session.connectionLost.promise, 5_000)
      await withTimeout(session.inputDropped.promise, 5_000)
      client.write('session-blip', 'again\r')
      await sleep(50)
      expect(session.counts.inputDropped).toBe(1)
    } finally {
      client.detach()
      if (existsSync(descriptorPath)) unlinkSync(descriptorPath)
      await new Promise((resolve) => attaching.server.close(resolve))
    }
  })

  // Second review, item 4: input lost during a reconnect that then succeeds
  // never arrived either — say so once when the session reattaches.
  test('input lost while reconnecting is reported once when the reattach succeeds', async () => {
    const fake = await startFakeBroker({ answerAttach: true })
    const identity = `lev377-reattach-${process.pid}-${Date.now()}-${Math.random()}`
    const descriptorPath = writeDescriptor(identity, fake.port, process.pid)
    const client = fastClient(identity)
    try {
      const session = recordingCallbacks()
      let attachedCount = 0
      const firstAttach = deferred<void>()
      const reattached = deferred<void>()
      client.attach('session-reattach', {
        ...session.callbacks,
        onAttached: () => {
          attachedCount += 1
          if (attachedCount === 1) firstAttach.resolve()
          else reattached.resolve()
        },
      })
      await withTimeout(firstAttach.promise)

      // The connection drops and the descriptor is gone for a moment.
      unlinkSync(descriptorPath)
      fake.dropClients()
      await sleep(20)
      client.write('session-reattach', 'typed-while-down\r')
      writeDescriptor(identity, fake.port, process.pid)

      await withTimeout(reattached.promise, 5_000)
      await withTimeout(session.inputDropped.promise, 5_000)
      expect(session.counts.inputDropped).toBe(1)
      expect(session.counts.connectionLost).toBe(0)
      expect(fake.ops).not.toContain('input:session-reattach')

      // Reset: the next outage that loses input is reported again.
      unlinkSync(descriptorPath)
      fake.dropClients()
      await sleep(20)
      client.write('session-reattach', 'typed-while-down-again\r')
      writeDescriptor(identity, fake.port, process.pid)
      await waitUntil(() => session.counts.inputDropped === 2, 'the second outage is reported too', 5_000)
    } finally {
      client.detach()
      if (existsSync(descriptorPath)) unlinkSync(descriptorPath)
      await new Promise((resolve) => fake.server.close(resolve))
    }
  })

  // Second review, item 3: a session written off while no broker was known
  // is addressed to the broker known at recovery time, not skipped forever.
  test('a pending session without an owning broker is resolved against the broker known at recovery time', async () => {
    const fake = await startFakeBroker({ answerTerminate: 'missing' })
    const identity = `lev377-null-descriptor-${process.pid}-${Date.now()}-${Math.random()}`
    const descriptorPath = writeDescriptor(identity, fake.port, process.pid)
    const client = fastClient(identity)
    try {
      const orphan = recordingCallbacks()
      // White-box: no public path reliably produces this state any more, so
      // enter it directly — the recovery must still reach a broker.
      ;(client as unknown as {
        terminateUnavailableSessions(
          descriptor: null,
          sessions: Array<[string, TerminalBrokerSessionCallbacks]>,
        ): void
      }).terminateUnavailableSessions(null, [['session-no-broker', orphan.callbacks]])

      await withTimeout(orphan.unavailable.promise, 5_000)
      expect(fake.ops).toContain('terminate-unavailable:session-no-broker')
      expect(orphan.counts.unavailable).toBe(1)
    } finally {
      client.detach()
      if (existsSync(descriptorPath)) unlinkSync(descriptorPath)
      await new Promise((resolve) => fake.server.close(resolve))
    }
  })
})

describePosix('real broker interrupted by SIGKILL / SIGSTOP (LEV-377)', () => {
  // The broker, its guards and its watchdog confirm every owned process with
  // synchronous ps/lsof before they let go; on a busy Mac (~1,700 processes,
  // a 3.7MB ps snapshot) a teardown alone takes tens of seconds. The waits
  // below are generous so the suite measures behavior, not machine load.
  jest.setTimeout(300_000)

  function readyShell(marker: string): SpawnProcessRequest {
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
    request: SpawnProcessRequest = readyShell(marker),
  ) {
    const attached = deferred<number>()
    const ready = deferred<void>()
    const exited = deferred<unknown>()
    const unavailable = deferred<void>()
    const connectionLost = deferred<void>()
    let output = ''
    let pid: number | undefined
    client.start(
      sessionId,
      request,
      join(tmpdir(), `taskchute-${sessionId}-${unique}.log`),
      undefined,
      {
        onAttached: (attachedPid) => {
          if (attachedPid !== undefined) {
            pid = attachedPid
            attached.resolve(attachedPid)
          }
        },
        onData: (data) => {
          output += data
          if (output.includes(marker)) ready.resolve()
        },
        onExit: (outcome) => exited.resolve(outcome),
        onUnavailable: () => unavailable.resolve(),
        onConnectionLost: () => connectionLost.resolve(),
      },
    )
    return {
      attached: attached.promise,
      ready: ready.promise,
      exited: exited.promise,
      unavailable: unavailable.promise,
      connectionLost: connectionLost.promise,
      output: () => output,
      pid: () => pid,
    }
  }

  function brokerPidOf(descriptorPath: string): number {
    return (JSON.parse(readFileSync(descriptorPath, 'utf8')) as { pid: number }).pid
  }

  function cleanup(descriptorPath: string, pids: Array<number | undefined>): void {
    for (const pid of pids) {
      if (pid === undefined) continue
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, 'SIGCONT')
          process.kill(target, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
    try {
      unlinkSync(descriptorPath)
    } catch {
      // The broker normally removes its own descriptor.
    }
    for (const path of ownerPidFiles(descriptorPath)) rmSync(path, { force: true })
  }

  test('after a broker SIGKILL a new terminal starts and takes input without a reload', async () => {
    const unique = `lev377-sigkill-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const client = new TerminalSessionBrokerClient({
      identity,
      unavailableRecoveryBaseMs: 20,
      unavailableRecoveryMaxMs: 40,
    })
    const pids: Array<number | undefined> = []
    try {
      const first = startSession(client, 'session-before-kill', 'FIRST_READY', unique)
      pids.push(await withTimeout(first.attached))
      await withTimeout(first.ready)
      const firstBroker = brokerPidOf(descriptorPath)
      pids.push(firstBroker)

      process.kill(firstBroker, 'SIGKILL')
      await withTimeout(first.unavailable, 90_000)

      const second = startSession(client, 'session-after-kill', 'SECOND_READY', unique)
      pids.push(await withTimeout(second.attached))
      await withTimeout(second.ready)
      const secondBroker = brokerPidOf(descriptorPath)
      pids.push(secondBroker)
      expect(secondBroker).not.toBe(firstBroker)

      client.write('session-after-kill', 'after-kill\n')
      await waitUntil(
        () => second.output().includes('ECHO:after-kill'),
        'the new terminal echoes input',
      )
    } finally {
      await client.shutdown().catch(() => undefined)
      cleanup(descriptorPath, pids)
    }
  })

  // Item 2, broker side: a renderer that gave up on a frozen broker has the
  // spawn and its termination queued on different connections, and the
  // resumed broker may read the termination first. The 'missing' it answers
  // then has to stay true: a later spawn of that id is refused.
  test('the broker refuses a spawn whose termination it already answered as missing', async () => {
    const unique = `lev377-tombstone-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const lease = { token: `lease-${process.pid}`, ownerId: 'taskchute-plus-ai-terminal', generation: 7 }
    const client = new TerminalSessionBrokerClient({
      identity,
      rendererLeaseToken: lease.token,
      rendererLeaseOwnerId: lease.ownerId,
      rendererLeaseGeneration: lease.generation,
    })
    const pids: Array<number | undefined> = []
    try {
      const anchor = startSession(client, 'session-anchor', 'ANCHOR_READY', unique)
      pids.push(await withTimeout(anchor.attached))
      await withTimeout(anchor.ready)
      const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as {
        port: number
        token: string
        pid: number
      }
      pids.push(descriptor.pid)
      const frame = (body: Record<string, unknown>) =>
        `${JSON.stringify({
          token: descriptor.token,
          rendererLeaseToken: lease.token,
          rendererLeaseOwnerId: lease.ownerId,
          rendererLeaseGeneration: lease.generation,
          ...body,
        })}\n`
      const exchange = (payload: string, expectType: string) =>
        withTimeout(
          new Promise<Record<string, unknown>>((resolve, reject) => {
            const socket = createConnection({ host: '127.0.0.1', port: descriptor.port }, () =>
              socket.write(payload),
            )
            let buffer = ''
            socket.on('data', (chunk) => {
              buffer += chunk.toString()
              for (const line of buffer.split('\n')) {
                if (!line) continue
                const message = JSON.parse(line) as Record<string, unknown>
                if (message.type === expectType) {
                  socket.destroy()
                  resolve(message)
                }
              }
            })
            socket.on('error', reject)
          }),
          30_000,
        )

      expect(
        await exchange(frame({ op: 'terminate-unavailable', sessionId: 'session-ghost' }), 'missing'),
      ).toMatchObject({ sessionId: 'session-ghost' })

      const refused = await exchange(
        frame({
          op: 'spawn',
          sessionId: 'session-ghost',
          spawn: { command: '/bin/sh', args: ['-c', 'printf GHOST_RAN; sleep 30'], stdinMode: 'pipe' },
          transcriptPath: join(tmpdir(), `taskchute-ghost-${unique}.log`),
        }),
        'error',
      )
      expect(refused).toMatchObject({
        sessionId: 'session-ghost',
        message: 'Terminal session was already terminated',
      })
      // The anchor session is untouched.
      client.write('session-anchor', 'still-here\n')
      await waitUntil(
        () => anchor.output().includes('ECHO:still-here'),
        'the anchor session still echoes',
        30_000,
      )
    } finally {
      await client.shutdown().catch(() => undefined)
      cleanup(descriptorPath, pids)
    }
  })

  // Second review, item 7: a renderer that gave up on a frozen broker and then
  // reloaded leaves its termination queued under a lease that is no longer
  // current. It must still stop the session that renderer spawned (otherwise
  // a spawn read before the lease rotated runs with nobody to stop it), and
  // must still not reach a session spawned under the new lease.
  test('after a lease rotation the old renderer can still terminate its own spawn, and nothing else', async () => {
    const unique = `lev377-lease-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const owner = 'taskchute-plus-ai-terminal'
    const oldLease = { token: `old-${process.pid}`, ownerId: owner, generation: 10 }
    const newLease = { token: `new-${process.pid}`, ownerId: owner, generation: 11 }
    const oldRenderer = new TerminalSessionBrokerClient({
      identity,
      rendererLeaseToken: oldLease.token,
      rendererLeaseOwnerId: oldLease.ownerId,
      rendererLeaseGeneration: oldLease.generation,
    })
    const newRenderer = new TerminalSessionBrokerClient({
      identity,
      rendererLeaseToken: newLease.token,
      rendererLeaseOwnerId: newLease.ownerId,
      rendererLeaseGeneration: newLease.generation,
    })
    const pids: Array<number | undefined> = []
    try {
      const oldSpawn = startSession(oldRenderer, 'session-old-spawn', 'OLD_SPAWN_READY', unique)
      const oldPid = await withTimeout(oldSpawn.attached)
      pids.push(oldPid)
      await withTimeout(oldSpawn.ready)
      const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as {
        port: number
        token: string
        pid: number
      }
      pids.push(descriptor.pid)

      // The reload: the new renderer's lease becomes the current one.
      const newSpawn = startSession(newRenderer, 'session-new-spawn', 'NEW_SPAWN_READY', unique)
      pids.push(await withTimeout(newSpawn.attached))
      await withTimeout(newSpawn.ready)

      const frame = (lease: typeof oldLease, body: Record<string, unknown>) =>
        `${JSON.stringify({
          token: descriptor.token,
          rendererLeaseToken: lease.token,
          rendererLeaseOwnerId: lease.ownerId,
          rendererLeaseGeneration: lease.generation,
          ...body,
        })}\n`
      // Resolves with the first frame of `type`, or 'closed' if the broker
      // drops the connection without answering.
      const exchange = (payload: string, type: string) =>
        withTimeout(
          new Promise<Record<string, unknown> | 'closed'>((resolve, reject) => {
            const socket = createConnection({ host: '127.0.0.1', port: descriptor.port }, () =>
              socket.write(payload),
            )
            let buffer = ''
            socket.on('data', (chunk) => {
              buffer += chunk.toString()
              for (const line of buffer.split('\n')) {
                if (!line) continue
                const message = JSON.parse(line) as Record<string, unknown>
                if (message.type === type) {
                  socket.destroy()
                  resolve(message)
                }
              }
            })
            socket.on('close', () => resolve('closed'))
            socket.on('error', reject)
          }),
          60_000,
        )

      // Not its session: the stale lease is turned away, the session lives.
      expect(
        await exchange(
          frame(oldLease, { op: 'terminate-unavailable', sessionId: 'session-new-spawn' }),
          'terminated-unavailable',
        ),
      ).toBe('closed')
      newRenderer.write('session-new-spawn', 'still-alive\n')
      await waitUntil(
        () => newSpawn.output().includes('ECHO:still-alive'),
        "the new renderer's session is untouched",
        30_000,
      )

      // Its own spawn: honoured despite the stale lease.
      expect(
        await exchange(
          frame(oldLease, { op: 'terminate-unavailable', sessionId: 'session-old-spawn' }),
          'terminated-unavailable',
        ),
      ).toMatchObject({ sessionId: 'session-old-spawn' })
      await waitUntil(() => !isAlive(oldPid), "the old renderer's spawn is gone", 60_000)

      // An id it never got to spawn: remembered, so a stale spawn of it is refused.
      expect(
        await exchange(
          frame(oldLease, { op: 'terminate-unavailable', sessionId: 'session-old-unspawned' }),
          'missing',
        ),
      ).toMatchObject({ sessionId: 'session-old-unspawned' })
      expect(
        await exchange(
          frame(newLease, {
            op: 'spawn',
            sessionId: 'session-old-unspawned',
            spawn: { command: '/bin/sh', args: ['-c', 'sleep 30'], stdinMode: 'pipe' },
            transcriptPath: join(tmpdir(), `taskchute-unspawned-${unique}.log`),
          }),
          'error',
        ),
      ).toMatchObject({ message: 'Terminal session was already terminated' })
    } finally {
      oldRenderer.detach()
      await newRenderer.shutdown().catch(() => undefined)
      cleanup(descriptorPath, pids)
    }
  })

  // Items 1 and 2: while the broker is frozen, new terminals fail on their
  // own and are given up within the window, but nothing broker-wide is ever
  // queued — so when it resumes, the healthy terminal opened before the
  // freeze keeps running, the written-off sessions do not survive (not even
  // a stale spawn read after its termination), and new terminals work.
  test('a SIGSTOPped broker: new terminals give up within the window, the healthy one survives the resume, and new ones work', async () => {
    const unique = `lev377-sigstop-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const client = new TerminalSessionBrokerClient({
      identity,
      sessionAckTimeoutMs: 2_000,
      unavailableTerminationTimeoutMs: 200,
      shutdownTimeoutMs: 2_000,
      unavailableRecoveryBaseMs: 50,
      unavailableRecoveryMaxMs: 100,
      unavailableConfirmationGiveUpMs: 1_500,
      unavailableConfirmationMinAttempts: 3,
    })
    const pids: Array<number | undefined> = []
    let brokerPid: number | undefined
    try {
      const healthy = startSession(client, 'session-healthy', 'HEALTHY_READY', unique)
      pids.push(await withTimeout(healthy.attached))
      await withTimeout(healthy.ready)
      brokerPid = brokerPidOf(descriptorPath)
      pids.push(brokerPid)

      // The frozen-broker state: its socket still accepts, nothing answers.
      process.kill(brokerPid, 'SIGSTOP')

      // The written-off sessions run a plain loop. readyShell's fd-3 watcher
      // is a background subshell that can outlive a target killed while its
      // tree is still forming (a guard race outside this ticket), which
      // would only make this test wait on the broker's teardown of it.
      const staleShell = (marker: string): SpawnProcessRequest => ({
        command: '/bin/sh',
        args: ['-c', 'while :; do sleep 1; done', marker],
        env: { ...process.env },
        stdinMode: 'pipe',
      })
      const blocked = startSession(
        client,
        'session-while-stopped',
        'STALE_A_READY',
        unique,
        staleShell('STALE_A_READY'),
      )
      await withTimeout(blocked.connectionLost, 30_000)

      // Old behavior: refused synchronously ("recovering from an unconfirmed
      // session failure"). It is now sent and judged on its own.
      let refusedAtOnce = false
      const another = startSession(
        client,
        'session-also-while-stopped',
        'STALE_B_READY',
        unique,
        staleShell('STALE_B_READY'),
      )
      void another.exited.then((outcome) => {
        if (
          typeof outcome === 'object' &&
          outcome !== null &&
          String((outcome as { errorMessage?: string }).errorMessage).includes('recovering')
        ) {
          refusedAtOnce = true
        }
      })
      await sleep(50)
      expect(refusedAtOnce).toBe(false)

      // Bounded: both give up while the broker is still frozen.
      await withTimeout(Promise.all([blocked.unavailable, another.unavailable]), 30_000)

      process.kill(brokerPid, 'SIGCONT')

      // The terminal from before the freeze is untouched and still types.
      client.write('session-healthy', 'after-resume\n')
      await waitUntil(
        () => healthy.output().includes('ECHO:after-resume'),
        'the healthy terminal still echoes after the resume',
        60_000,
      )
      expect(isAlive(brokerPid)).toBe(true)

      // The written-off sessions never run on: whichever order the resumed
      // broker reads their queued spawn and termination in, they end.
      await waitUntil(
        () => {
          const commands = execFileSync('/bin/ps', ['-axo', 'command='], {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
          })
          return !commands.includes('STALE_A_READY') && !commands.includes('STALE_B_READY')
        },
        'no process of a written-off session is left running',
        120_000,
      )
      // The resumed broker confirms each of them with synchronous ps before it
      // finalizes them (seconds each on a busy Mac); a spawn arriving inside
      // that would wait on it. Their owner records go when they finalize.
      await waitUntil(
        () => ownerPidFiles(descriptorPath).length === 1,
        'the resumed broker finalized the written-off sessions',
        120_000,
      )

      // A new terminal on the resumed broker works without a reload.
      const fresh = startSession(client, 'session-after-resume', 'FRESH_READY', unique)
      pids.push(await withTimeout(fresh.attached, 60_000))
      await withTimeout(fresh.ready, 60_000)
      expect(brokerPidOf(descriptorPath)).toBe(brokerPid)
      client.write('session-after-resume', 'fresh\n')
      await waitUntil(
        () => fresh.output().includes('ECHO:fresh'),
        'the terminal opened after the resume echoes input',
        60_000,
      )
      expect(healthy.output()).not.toContain('ECHO:fresh')
    } finally {
      if (brokerPid !== undefined) {
        try {
          process.kill(brokerPid, 'SIGCONT')
        } catch {
          // Already gone.
        }
      }
      await client.shutdown().catch(() => undefined)
      cleanup(descriptorPath, pids)
    }
  })
})
