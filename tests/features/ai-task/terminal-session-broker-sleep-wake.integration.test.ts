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
import { orphanStorePath } from '@/features/ai-task/services/BrokerOrphanStore'
import { describePosix } from '@tests/support/platform'
import {
  answerBrokerProof,
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
    answerBrokerProof(socket, TOKEN)
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
    JSON.stringify({ version: 2, port, token: TOKEN, pid }),
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
      readyShell(marker),
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

  /** Block until the process is stopped (ps state T), so nothing it does can race a write. */
  function waitUntilStoppedSync(pid: number): void {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
      if (state.startsWith('T')) return
    }
    throw new Error(`process ${String(pid)} did not stop`)
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

      const blocked = startSession(client, 'session-while-stopped', 'STALE_A_READY', unique)
      await withTimeout(blocked.connectionLost, 30_000)

      // Old behavior: refused synchronously ("recovering from an unconfirmed
      // session failure"). It is now sent and judged on its own.
      let refusedAtOnce = false
      const another = startSession(client, 'session-also-while-stopped', 'STALE_B_READY', unique)
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

  test('a client restoring a session from a frozen broker stops it once the broker resumes (LEV-391)', async () => {
    const unique = `lev391-restore-frozen-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const lease = {
      rendererLeaseToken: 'lev391-restore-lease',
      rendererLeaseOwnerId: 'lev391-restore-owner',
      rendererLeaseGeneration: 1,
    }
    const before = new TerminalSessionBrokerClient({ identity, ...lease })
    const pids: Array<number | undefined> = []
    let brokerPid: number | undefined
    let after: TerminalSessionBrokerClient | null = null
    try {
      const session = startSession(before, 'session-restored', 'RESTORED_READY', unique)
      const sessionPid = await withTimeout(session.attached)
      pids.push(sessionPid)
      await withTimeout(session.ready)
      brokerPid = brokerPidOf(descriptorPath)
      pids.push(brokerPid)

      // The renderer reloads; the session keeps running in the broker. Then
      // the broker freezes before the new renderer restores it.
      before.detach()
      process.kill(brokerPid, 'SIGSTOP')

      after = new TerminalSessionBrokerClient({
        identity,
        ...lease,
        connectTimeoutMs: 300,
        sessionAckTimeoutMs: 1_000,
        unavailableTerminationTimeoutMs: 200,
        unavailableRecoveryBaseMs: 50,
        unavailableRecoveryMaxMs: 100,
        unavailableConfirmationGiveUpMs: 1_500,
        unavailableConfirmationMinAttempts: 3,
        orphanCleanupIntervalMs: 200,
      })
      const unavailable = deferred<void>()
      after.attach('session-restored', {
        onData: () => undefined,
        onExit: () => unavailable.resolve(),
        onUnavailable: () => unavailable.resolve(),
      })
      // The new client never verified this broker, so it could send nothing,
      // and it gives up within the window.
      await withTimeout(unavailable.promise, 30_000)

      process.kill(brokerPid, 'SIGCONT')

      // Its termination is still delivered once the broker can prove itself.
      await waitUntil(
        () => !isAlive(sessionPid),
        'the restored session is stopped after the broker resumes',
        60_000,
      )
    } finally {
      if (brokerPid !== undefined) {
        try {
          process.kill(brokerPid, 'SIGCONT')
        } catch {
          // Already gone.
        }
      }
      await after?.shutdown().catch(() => undefined)
      await before.shutdown().catch(() => undefined)
      cleanup(descriptorPath, pids)
    }
  })

  test('a termination given up in one renderer is finished by the next, under its own lease, once the broker resumes (LEV-391)', async () => {
    const unique = `lev391-orphan-reload-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const owner = 'lev391-orphan-owner'
    const lease = (generation: number) => ({
      rendererLeaseToken: `lev391-orphan-lease-${String(generation)}`,
      rendererLeaseOwnerId: owner,
      rendererLeaseGeneration: generation,
    })
    const frozenWindow = {
      connectTimeoutMs: 300,
      sessionAckTimeoutMs: 1_000,
      unavailableTerminationTimeoutMs: 200,
      deferredShutdownTimeoutMs: 300,
      unavailableRecoveryBaseMs: 50,
      unavailableRecoveryMaxMs: 100,
      unavailableConfirmationGiveUpMs: 1_500,
      unavailableConfirmationMinAttempts: 3,
      rendererLeaseActivationRetryWindowMs: 500,
    }
    // Renderer 1 spawns the session, then the window reloads.
    const first = new TerminalSessionBrokerClient({ identity, ...lease(1) })
    const pids: Array<number | undefined> = []
    let brokerPid: number | undefined
    let second: TerminalSessionBrokerClient | null = null
    let third: TerminalSessionBrokerClient | null = null
    try {
      const session = startSession(first, 'session-orphaned', 'ORPHANED_READY', unique)
      const sessionPid = await withTimeout(session.attached)
      pids.push(sessionPid)
      await withTimeout(session.ready)
      brokerPid = brokerPidOf(descriptorPath)
      pids.push(brokerPid)
      first.detach()
      process.kill(brokerPid, 'SIGSTOP')

      // Renderer 2 restores it from the frozen broker and gives up; its
      // retries never get to run before it is replaced in turn.
      second = new TerminalSessionBrokerClient({
        identity,
        ...lease(2),
        ...frozenWindow,
        orphanCleanupIntervalMs: 60 * 60 * 1_000,
      })
      const unavailable = deferred<void>()
      second.attach('session-orphaned', {
        onData: () => undefined,
        onExit: () => unavailable.resolve(),
        onUnavailable: () => unavailable.resolve(),
      })
      await withTimeout(unavailable.promise, 30_000)
      expect(existsSync(orphanStorePath(descriptorPath))).toBe(true)
      second.detach()

      // Renderer 3 picks the pending termination up from disk. Its own lease
      // activation runs out while the broker is still frozen.
      third = new TerminalSessionBrokerClient({
        identity,
        ...lease(3),
        ...frozenWindow,
        orphanCleanupIntervalMs: 200,
      })
      await expect(
        third.setRendererLeaseToken(lease(3).rendererLeaseToken, owner, 3),
      ).rejects.toThrow()

      // The broker resumes still holding renderer 1's lease.
      process.kill(brokerPid, 'SIGCONT')

      await waitUntil(
        () => !isAlive(sessionPid),
        'the orphaned session is stopped after the broker resumes',
        60_000,
      )
      await waitUntil(
        () => !existsSync(orphanStorePath(descriptorPath)),
        'the pending termination is forgotten once the broker answers',
        30_000,
      )
    } finally {
      if (brokerPid !== undefined) {
        try {
          process.kill(brokerPid, 'SIGCONT')
        } catch {
          // Already gone.
        }
      }
      await third?.shutdown().catch(() => undefined)
      await second?.shutdown().catch(() => undefined)
      await first.shutdown().catch(() => undefined)
      rmSync(orphanStorePath(descriptorPath), { force: true })
      cleanup(descriptorPath, pids)
    }
  })

  test('a session an older client gives up on late is stopped by the client holding the current lease (LEV-391)', async () => {
    const unique = `lev391-late-orphan-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const owner = 'lev391-late-owner'
    const lease = (generation: number) => ({
      rendererLeaseToken: `lev391-late-lease-${String(generation)}`,
      rendererLeaseOwnerId: owner,
      rendererLeaseGeneration: generation,
    })
    const frozenWindow = {
      connectTimeoutMs: 300,
      sessionAckTimeoutMs: 1_000,
      unavailableTerminationTimeoutMs: 200,
      deferredShutdownTimeoutMs: 300,
      unavailableRecoveryBaseMs: 50,
      unavailableRecoveryMaxMs: 100,
      unavailableConfirmationGiveUpMs: 1_500,
      unavailableConfirmationMinAttempts: 3,
    }
    // The client an old terminal handle keeps after two hot reloads, and the
    // one the latest reload made. Both live in this window.
    const older = new TerminalSessionBrokerClient({
      identity,
      ...lease(1),
      ...frozenWindow,
      orphanCleanupIntervalMs: 200,
    })
    let current: TerminalSessionBrokerClient | null = null
    const pids: Array<number | undefined> = []
    let brokerPid: number | undefined
    try {
      const session = startSession(older, 'session-late', 'LATE_READY', unique)
      const sessionPid = await withTimeout(session.attached)
      pids.push(sessionPid)
      await withTimeout(session.ready)
      brokerPid = brokerPidOf(descriptorPath)
      pids.push(brokerPid)

      // The latest client read the (empty) store when it was made, and holds
      // the current lease: the older one's lease is stale from now on.
      current = new TerminalSessionBrokerClient({
        identity,
        ...lease(3),
        ...frozenWindow,
        orphanCleanupIntervalMs: 200,
      })
      await current.setRendererLeaseToken(lease(3).rendererLeaseToken, owner, 3)

      // Later, the broker freezes and the older client loses its connection
      // and gives the session up.
      process.kill(brokerPid, 'SIGSTOP')
      ;(older as unknown as { socket: { destroy(): void } | null }).socket?.destroy()
      await withTimeout(session.unavailable, 30_000)

      process.kill(brokerPid, 'SIGCONT')

      // The older client's lease is refused; the current client takes it on.
      await waitUntil(
        () => !isAlive(sessionPid),
        'the late orphan is stopped after the broker resumes',
        60_000,
      )
      // Once the current client has confirmed it, the older client stops
      // retrying too: its refused attempts would keep resetting the broker's
      // idle timer.
      const pendingIn = (client: TerminalSessionBrokerClient): number =>
        (client as unknown as { orphanedSessions: Map<string, unknown> }).orphanedSessions.size
      await waitUntil(
        () => pendingIn(older) === 0 && pendingIn(current!) === 0,
        'neither client retries the confirmed termination',
        30_000,
      )
    } finally {
      if (brokerPid !== undefined) {
        try {
          process.kill(brokerPid, 'SIGCONT')
        } catch {
          // Already gone.
        }
      }
      await current?.shutdown().catch(() => undefined)
      await older.shutdown().catch(() => undefined)
      rmSync(orphanStorePath(descriptorPath), { force: true })
      cleanup(descriptorPath, pids)
    }
  })

  test('a pending termination retried after the window closes keeps the exit grace (LEV-391)', async () => {
    const unique = `lev391-exit-grace-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const lease = {
      rendererLeaseToken: 'lev391-exit-lease',
      rendererLeaseOwnerId: 'lev391-exit-owner',
      rendererLeaseGeneration: 1,
    }
    const first = new TerminalSessionBrokerClient({ identity, ...lease })
    let closing: TerminalSessionBrokerClient | null = null
    const pids: Array<number | undefined> = []
    let brokerPid: number | undefined
    try {
      // A healthy session and one that will be orphaned.
      const healthy = startSession(first, 'session-healthy-exit', 'HEALTHY_EXIT_READY', unique)
      const healthyPid = await withTimeout(healthy.attached)
      pids.push(healthyPid)
      await withTimeout(healthy.ready)
      const orphan = startSession(first, 'session-orphan-exit', 'ORPHAN_EXIT_READY', unique)
      pids.push(await withTimeout(orphan.attached))
      await withTimeout(orphan.ready)
      brokerPid = brokerPidOf(descriptorPath)
      pids.push(brokerPid)
      first.detach()
      process.kill(brokerPid, 'SIGSTOP')

      // The next window restores only the orphan, from the frozen broker, and
      // gives it up.
      closing = new TerminalSessionBrokerClient({
        identity,
        ...lease,
        connectTimeoutMs: 300,
        sessionAckTimeoutMs: 1_000,
        unavailableTerminationTimeoutMs: 200,
        deferredShutdownTimeoutMs: 2_000,
        unavailableRecoveryBaseMs: 50,
        unavailableRecoveryMaxMs: 100,
        unavailableConfirmationGiveUpMs: 1_500,
        unavailableConfirmationMinAttempts: 3,
        orphanCleanupIntervalMs: 1_000,
      })
      const unavailable = deferred<void>()
      closing.attach('session-orphan-exit', {
        onData: () => undefined,
        onExit: () => unavailable.resolve(),
        onUnavailable: () => unavailable.resolve(),
      })
      await withTimeout(unavailable.promise, 30_000)

      // The broker resumes and the window closes: exit grace, then detach.
      // The orphan retry keeps running after the detach.
      process.kill(brokerPid, 'SIGCONT')
      await closing.scheduleShutdownAfterGrace(
        5_000,
        lease.rendererLeaseToken,
        lease.rendererLeaseOwnerId,
        lease.rendererLeaseGeneration,
      )
      closing.detach()

      // Its activation must not cancel the grace: the broker stops, and the
      // healthy session with it.
      await waitUntil(
        () => !isAlive(brokerPid) && !isAlive(healthyPid),
        'the broker shuts down at the end of the exit grace',
        60_000,
      )
    } finally {
      if (brokerPid !== undefined) {
        try {
          process.kill(brokerPid, 'SIGCONT')
        } catch {
          // Already gone.
        }
      }
      await closing?.shutdown().catch(() => undefined)
      await first.shutdown().catch(() => undefined)
      rmSync(orphanStorePath(descriptorPath), { force: true })
      cleanup(descriptorPath, pids)
    }
  })

  test('an exit grace asked of a frozen broker still stops it once it resumes after the window is gone (LEV-391)', async () => {
    const unique = `lev391-frozen-exit-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const lease = {
      rendererLeaseToken: 'lev391-frozen-exit-lease',
      rendererLeaseOwnerId: 'lev391-frozen-exit-owner',
      rendererLeaseGeneration: 1,
    }
    const client = new TerminalSessionBrokerClient({
      identity,
      ...lease,
      deferredShutdownTimeoutMs: 300,
      exitGraceMs: 2_000,
    })
    const pids: Array<number | undefined> = []
    let brokerPid: number | undefined
    try {
      const healthy = startSession(client, 'session-frozen-exit', 'FROZEN_EXIT_READY', unique)
      const healthyPid = await withTimeout(healthy.attached)
      pids.push(healthyPid)
      await withTimeout(healthy.ready)
      brokerPid = brokerPidOf(descriptorPath)
      pids.push(brokerPid)

      // The broker is frozen through the window's exit: the control
      // connection cannot get the exit grace past the proof, and the window
      // detaches right after asking. The broker arms the grace itself when it
      // sees the window's data connection gone (LEV-397).
      process.kill(brokerPid, 'SIGSTOP')
      await expect(
        client.scheduleShutdownAfterGrace(
          2_000,
          lease.rendererLeaseToken,
          lease.rendererLeaseOwnerId,
          lease.rendererLeaseGeneration,
        ),
      ).rejects.toThrow()
      client.detach()

      process.kill(brokerPid, 'SIGCONT')

      // Not the 30-minute idle timeout: the exit grace, then shutdown.
      await waitUntil(
        () => !isAlive(brokerPid) && !isAlive(healthyPid),
        'the resumed broker shuts down at the end of the exit grace',
        30_000,
      )
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

  /** A window whose broker it spawned waits `exitGraceMs` for it to return. */
  function lev397Client(unique: string, generation = 1, extra: Partial<TerminalBrokerClientOptions> = {}) {
    const identity = `broker-${unique}`
    const lease = {
      rendererLeaseToken: `lev397-lease-${String(generation)}`,
      rendererLeaseOwnerId: 'lev397-owner',
      rendererLeaseGeneration: generation,
    }
    const client = new TerminalSessionBrokerClient({
      identity,
      ...lease,
      connectTimeoutMs: 300,
      deferredShutdownTimeoutMs: 300,
      exitGraceMs: 1_000,
      ...extra,
    })
    return { client, lease, descriptorPath: getTerminalBrokerDescriptorPath(identity) }
  }

  test('a window that closes with writes queued to a frozen broker still gets its exit grace (LEV-397)', async () => {
    const unique = `lev397-backlog-${process.pid}-${Date.now()}-${Math.random()}`
    const { client, lease, descriptorPath } = lev397Client(unique)
    const pids: Array<number | undefined> = []
    let brokerPid: number | undefined
    try {
      const session = startSession(client, 'session-backlog', 'BACKLOG_READY', unique)
      const sessionPid = await withTimeout(session.attached)
      pids.push(sessionPid)
      await withTimeout(session.ready)
      brokerPid = brokerPidOf(descriptorPath)
      pids.push(brokerPid)

      // Frozen, the broker reads nothing, so typing fills the socket until
      // writes queue in this process.
      process.kill(brokerPid, 'SIGSTOP')
      const socket = (client as unknown as { socket: { writableLength: number } | null }).socket
      const chunk = 'x'.repeat(128 * 1024)
      for (let i = 0; i < 128 && (socket?.writableLength ?? 0) < 1024 * 1024; i += 1) {
        client.write('session-backlog', chunk)
        await sleep(5)
      }
      expect(socket?.writableLength ?? 0).toBeGreaterThan(0)

      // The window closes: its exit grace cannot get past the proof, and the
      // queued writes are dropped with the connection.
      await expect(
        client.scheduleShutdownAfterGrace(
          1_000,
          lease.rendererLeaseToken,
          lease.rendererLeaseOwnerId,
          lease.rendererLeaseGeneration,
        ),
      ).rejects.toThrow()
      client.detach()
      process.kill(brokerPid, 'SIGCONT')

      // Not the 30-minute idle timeout: the grace, then shutdown.
      await waitUntil(
        () => !isAlive(brokerPid) && !isAlive(sessionPid),
        'the resumed broker shuts down at the end of the exit grace',
        30_000,
      )
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

  test('a quit canceled while the broker was frozen does not stop it once it resumes (LEV-397)', async () => {
    const unique = `lev397-cancel-${process.pid}-${Date.now()}-${Math.random()}`
    const { client, lease, descriptorPath } = lev397Client(unique)
    const pids: Array<number | undefined> = []
    let brokerPid: number | undefined
    try {
      const session = startSession(client, 'session-cancel', 'CANCEL_READY', unique)
      const sessionPid = await withTimeout(session.attached)
      pids.push(sessionPid)
      await withTimeout(session.ready)
      brokerPid = brokerPidOf(descriptorPath)
      pids.push(brokerPid)

      // Quit is asked and then canceled while the broker is frozen. Neither
      // request gets past the proof.
      process.kill(brokerPid, 'SIGSTOP')
      const identity = [lease.rendererLeaseToken, lease.rendererLeaseOwnerId, lease.rendererLeaseGeneration] as const
      await expect(client.scheduleShutdownAfterGrace(1_000, ...identity)).rejects.toThrow()
      await expect(client.cancelDeferredShutdown(...identity)).rejects.toThrow()
      process.kill(brokerPid, 'SIGCONT')

      // The window stays. Nothing it queued may arm the grace after the
      // cancel: the broker and the session outlive it.
      await sleep(3_000)
      expect(isAlive(brokerPid)).toBe(true)
      expect(isAlive(sessionPid)).toBe(true)
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

  test('a window that loses its connection and reattaches keeps its sessions (LEV-397)', async () => {
    const unique = `lev397-reconnect-${process.pid}-${Date.now()}-${Math.random()}`
    const { client, descriptorPath } = lev397Client(unique)
    const pids: Array<number | undefined> = []
    let brokerPid: number | undefined
    try {
      const session = startSession(client, 'session-reconnect', 'RECONNECT_READY', unique)
      const sessionPid = await withTimeout(session.attached)
      pids.push(sessionPid)
      await withTimeout(session.ready)
      brokerPid = brokerPidOf(descriptorPath)
      pids.push(brokerPid)

      // The connection drops while the window lives. The broker arms the
      // grace; the window's reconnect attaches and cancels it.
      ;(client as unknown as { socket: { destroy(): void } | null }).socket?.destroy()
      await sleep(3_000)
      expect(isAlive(brokerPid)).toBe(true)
      expect(isAlive(sessionPid)).toBe(true)
    } finally {
      await client.shutdown().catch(() => undefined)
      cleanup(descriptorPath, pids)
    }
  })

  test('a connection from a replaced window closing does not arm the exit grace (LEV-397)', async () => {
    const unique = `lev397-stale-${process.pid}-${Date.now()}-${Math.random()}`
    const { client: older, descriptorPath } = lev397Client(unique, 1)
    const { client: current, lease } = lev397Client(unique, 2)
    const pids: Array<number | undefined> = []
    let brokerPid: number | undefined
    try {
      const session = startSession(older, 'session-stale', 'STALE_READY', unique)
      const sessionPid = await withTimeout(session.attached)
      pids.push(sessionPid)
      await withTimeout(session.ready)
      brokerPid = brokerPidOf(descriptorPath)
      pids.push(brokerPid)

      // A new window takes the lease but has not attached yet when the old
      // window's connection goes.
      await current.setRendererLeaseToken(lease.rendererLeaseToken, lease.rendererLeaseOwnerId, lease.rendererLeaseGeneration)
      older.detach()

      await sleep(3_000)
      expect(isAlive(brokerPid)).toBe(true)
      expect(isAlive(sessionPid)).toBe(true)
    } finally {
      await current.shutdown().catch(() => undefined)
      await older.shutdown().catch(() => undefined)
      cleanup(descriptorPath, pids)
    }
  })

  test('a client that rotates its lease in place still gets the exit grace when its window closes (LEV-397)', async () => {
    const unique = `lev397-rotate-${process.pid}-${Date.now()}-${Math.random()}`
    const { client, descriptorPath } = lev397Client(unique, 1)
    const pids: Array<number | undefined> = []
    let brokerPid: number | undefined
    try {
      const session = startSession(client, 'session-rotate', 'ROTATE_READY', unique)
      const sessionPid = await withTimeout(session.attached)
      pids.push(sessionPid)
      await withTimeout(session.ready)
      brokerPid = brokerPidOf(descriptorPath)
      pids.push(brokerPid)

      // A hot reload adopts this client and rotates its lease; the data
      // connection stays as it is.
      const rotated = { token: 'lev397-lease-rotated', ownerId: 'lev397-owner', generation: 2 }
      await client.setRendererLeaseToken(rotated.token, rotated.ownerId, rotated.generation)
      await sleep(200)

      // Then the window closes while the broker is frozen.
      process.kill(brokerPid, 'SIGSTOP')
      await expect(
        client.scheduleShutdownAfterGrace(1_000, rotated.token, rotated.ownerId, rotated.generation),
      ).rejects.toThrow()
      client.detach()
      process.kill(brokerPid, 'SIGCONT')

      await waitUntil(
        () => !isAlive(brokerPid) && !isAlive(sessionPid),
        'the resumed broker shuts down at the end of the exit grace',
        30_000,
      )
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

  test('the current window closing before a replaced one still arms the exit grace (LEV-397)', async () => {
    const unique = `lev397-order-${process.pid}-${Date.now()}-${Math.random()}`
    const { client: older, descriptorPath } = lev397Client(unique, 1)
    const { client: current, lease } = lev397Client(unique, 2)
    const pids: Array<number | undefined> = []
    let brokerPid: number | undefined
    try {
      const session = startSession(older, 'session-order', 'ORDER_READY', unique)
      const sessionPid = await withTimeout(session.attached)
      pids.push(sessionPid)
      await withTimeout(session.ready)
      brokerPid = brokerPidOf(descriptorPath)
      pids.push(brokerPid)

      // The new window takes the lease and attaches; the old window's
      // connection is still attached too.
      await current.setRendererLeaseToken(lease.rendererLeaseToken, lease.rendererLeaseOwnerId, lease.rendererLeaseGeneration)
      const reattached = deferred<void>()
      current.attach('session-order', {
        onAttached: () => reattached.resolve(),
        onData: () => undefined,
        onExit: () => undefined,
      })
      await withTimeout(reattached.promise)

      // The new window closes first, without its exit grace arriving, then
      // the old one.
      current.detach()
      await sleep(200)
      older.detach()

      await waitUntil(
        () => !isAlive(brokerPid) && !isAlive(sessionPid),
        'the broker shuts down at the end of the exit grace',
        30_000,
      )
    } finally {
      await current.shutdown().catch(() => undefined)
      await older.shutdown().catch(() => undefined)
      cleanup(descriptorPath, pids)
    }
  })

  test('a window that closes before the broker answers its lease activation still gets the exit grace (LEV-397)', async () => {
    const unique = `lev397-unanswered-${process.pid}-${Date.now()}-${Math.random()}`
    const { client, descriptorPath } = lev397Client(unique, 1, { rendererLeaseActivationRetryWindowMs: 400 })
    const pids: Array<number | undefined> = []
    let brokerPid: number | undefined
    try {
      const session = startSession(client, 'session-unanswered', 'UNANSWERED_READY', unique)
      const sessionPid = await withTimeout(session.attached)
      pids.push(sessionPid)
      await withTimeout(session.ready)
      brokerPid = brokerPidOf(descriptorPath)
      pids.push(brokerPid)

      // A hot reload rotates the lease, and the broker is frozen just before
      // the activation is written, so it cannot answer. The window then
      // closes: neither the activation nor the exit grace is acknowledged.
      // Only the activation frame waits for the freeze; a control
      // connection's proof exchange goes through first.
      const frozen = deferred<void>()
      const freezeOnActivation = <T extends { write(data: string): boolean }>(socket: T): T => {
        const write = socket.write.bind(socket)
        socket.write = (data: string) => {
          if (data.includes('"op":"activate-renderer-lease"') && brokerPid !== undefined) {
            process.kill(brokerPid, 'SIGSTOP')
            waitUntilStoppedSync(brokerPid)
            const written = write(data)
            frozen.resolve()
            return written
          }
          return write(data)
        }
        return socket
      }
      const dataSocket = (client as unknown as { socket: { write(data: string): boolean } | null }).socket
      if (dataSocket) freezeOnActivation(dataSocket)
      // The client loads net when it connects; wrap the sockets it makes.
      const netModule = jest.requireActual<{ createConnection: (...args: unknown[]) => Socket }>('net')
      const createConnection = netModule.createConnection
      netModule.createConnection = (...args: unknown[]) => freezeOnActivation(createConnection(...args))
      const rotated = { token: 'lev397-lease-unanswered', ownerId: 'lev397-owner', generation: 2 }
      let activation: Promise<void>
      try {
        activation = client.setRendererLeaseToken(rotated.token, rotated.ownerId, rotated.generation)
        await withTimeout(frozen.promise)
      } finally {
        netModule.createConnection = createConnection
      }
      await expect(
        client.scheduleShutdownAfterGrace(1_000, rotated.token, rotated.ownerId, rotated.generation),
      ).rejects.toThrow()
      client.detach()
      await expect(activation).rejects.toThrow()
      process.kill(brokerPid, 'SIGCONT')

      await waitUntil(
        () => !isAlive(brokerPid) && !isAlive(sessionPid),
        'the resumed broker shuts down at the end of the exit grace',
        30_000,
      )
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

  test('overlapping lease activations keep the data connection (LEV-397)', async () => {
    const unique = `lev397-overlap-${process.pid}-${Date.now()}-${Math.random()}`
    const { client, descriptorPath } = lev397Client(unique, 1)
    const pids: Array<number | undefined> = []
    try {
      const session = startSession(client, 'session-overlap', 'OVERLAP_READY', unique)
      const sessionPid = await withTimeout(session.attached)
      pids.push(sessionPid)
      await withTimeout(session.ready)
      pids.push(brokerPidOf(descriptorPath))

      const socketOf = () => (client as unknown as { socket: { destroyed: boolean } | null }).socket
      const before = socketOf()
      await Promise.all([
        client.setRendererLeaseToken('lev397-lease-overlap-2', 'lev397-owner', 2),
        client.setRendererLeaseToken('lev397-lease-overlap-3', 'lev397-owner', 3),
      ])
      await sleep(500)

      // The broker took both, in order, on the same connection.
      expect(socketOf()).toBe(before)
      expect(before?.destroyed).toBe(false)
      client.write('session-overlap', 'after-overlap\n')
      await waitUntil(() => session.output().includes('ECHO:after-overlap'), 'the terminal still takes input', 10_000)
    } finally {
      await client.shutdown().catch(() => undefined)
      cleanup(descriptorPath, pids)
    }
  })
})
