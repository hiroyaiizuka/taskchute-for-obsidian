import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { execFileSync, spawn as spawnChild } from 'child_process'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { createConnection, createServer, type AddressInfo } from 'net'

import {
  getTerminalBrokerDescriptorPath,
  TerminalSessionBrokerClient,
  type TerminalBrokerSessionCallbacks,
} from '../../../src/features/ai-task/services/TerminalSessionBroker'
import { NodeProcessGateway } from '../../../src/features/ai-task/services/NodeProcessGateway'
import { buildTerminalShellLaunch } from '../../../src/features/ai-task/services/dispatchers/TerminalShellBootstrap'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = 8_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Broker integration test timed out')),
      timeoutMs,
    )
    void promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Broker integration condition timed out')
}

function ownerPidFiles(descriptorPath: string): string[] {
  const directory = dirname(descriptorPath)
  const prefix = `${basename(descriptorPath)}.owner-`
  return readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.jsonl'))
    .map((name) => join(directory, name))
}

interface RawBrokerDescriptor {
  port: number
  token: string
}

async function sendRawBrokerFrame(
  descriptorPath: string,
  frame: Record<string, unknown>,
  timeoutMs = 1_000,
): Promise<Record<string, unknown> | null> {
  const descriptor = JSON.parse(
    readFileSync(descriptorPath, 'utf8'),
  ) as RawBrokerDescriptor
  return new Promise((resolve, reject) => {
    const socket = createConnection({
      host: '127.0.0.1',
      port: descriptor.port,
    })
    let settled = false
    let connected = false
    let buffer = ''
    const finish = (value: Record<string, unknown> | null): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setEncoding('utf8')
    socket.setTimeout(timeoutMs, () => finish(null))
    socket.on('connect', () => {
      connected = true
      socket.write(
        `${JSON.stringify({ ...frame, token: descriptor.token })}\n`,
      )
    })
    socket.on('data', (chunk) => {
      buffer += String(chunk)
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      try {
        finish(
          JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>,
        )
      } catch (error) {
        if (settled) return
        settled = true
        socket.destroy()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.on('error', (error) => {
      if (connected) {
        finish(null)
        return
      }
      reject(error)
    })
    socket.on('close', () => finish(null))
  })
}

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('TerminalSessionBrokerClient integration', () => {
  jest.setTimeout(20_000)

  test('stale input, resize, and stop handles never create an empty broker', async () => {
    const unique = `stale-handle-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const client = new TerminalSessionBrokerClient({ identity })

    client.write('missing-session', 'late input\n')
    client.resize('missing-session', 120, 40)
    client.stop('missing-session', true)
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(existsSync(descriptorPath)).toBe(false)
    await client.shutdown()
  })

  test('a second renderer client attaches to the same live process and can type', async () => {
    const unique = `${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const sessionId = `session-${process.pid}-${Date.now()}`
    const transcriptPath = `/tmp/taskchute-broker-integration-${unique}.log`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const logs: string[] = []
    const firstAttached = deferred<number | undefined>()
    const firstReady = deferred<void>()
    let firstOutput = ''
    const firstCallbacks: TerminalBrokerSessionCallbacks = {
      onAttached: firstAttached.resolve,
      onData: (data) => {
        firstOutput += data
        if (firstOutput.includes('READY')) firstReady.resolve()
      },
      onExit: (outcome) => firstReady.reject(
        new Error(`Unexpected early exit: ${outcome.status}`),
      ),
    }
    const firstClient = new TerminalSessionBrokerClient({
      identity,
      log: (level, ...args) => logs.push(`${level}:${args.map(String).join(' ')}`),
    })

    firstClient.start(
      sessionId,
      {
        command: '/bin/sh',
        args: [
          '-c',
          'printf "READY\\n"; while IFS= read -r line; do printf "ECHO:%s\\n" "$line"; [ "$line" = exit ] && exit 0; done',
        ],
        env: { ...process.env },
        stdinMode: 'pipe',
      },
      transcriptPath,
      undefined,
      firstCallbacks,
    )
    const originalPid = await withTimeout(firstAttached.promise).catch(
      (error: unknown) => {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; logs=${logs.join(' | ')}`,
        )
      },
    )
    await withTimeout(firstReady.promise)
    expect(originalPid).toEqual(expect.any(Number))
    expect(existsSync(descriptorPath)).toBe(true)

    // Simulate renderer teardown: the client transport disappears, but the
    // broker-owned shell remains alive for the next renderer.
    firstClient.detach()

    const secondAttached = deferred<number | undefined>()
    const replayed = deferred<void>()
    const echoed = deferred<void>()
    const exited = deferred<void>()
    let secondOutput = ''
    const secondClient = new TerminalSessionBrokerClient({
      identity,
      log: (level, ...args) => logs.push(`${level}:${args.map(String).join(' ')}`),
    })
    secondClient.attach(sessionId, {
      onAttached: secondAttached.resolve,
      onData: (data) => {
        secondOutput += data
        if (secondOutput.includes('READY')) replayed.resolve()
        if (secondOutput.includes('ECHO:after-reload')) echoed.resolve()
      },
      onExit: (outcome) => {
        if (outcome.status === 'succeeded') exited.resolve()
        else exited.reject(new Error(`Unexpected exit: ${outcome.status}`))
      },
      onUnavailable: () => replayed.reject(new Error('Broker session was lost')),
    })

    expect(await withTimeout(secondAttached.promise)).toBe(originalPid)
    await withTimeout(replayed.promise)
    secondClient.write(sessionId, 'after-reload\n')
    await withTimeout(echoed.promise)
    secondClient.write(sessionId, 'exit\n')
    await withTimeout(exited.promise)
    await secondClient.shutdown()

    expect(existsSync(descriptorPath)).toBe(false)
    expect(secondOutput).toContain('READY')
    expect(secondOutput).toContain('ECHO:after-reload')
    expect(logs.filter((line) => line.includes('Spawn failed'))).toEqual([])
  })

  test('deferred app-exit shutdown is canceled by a reloading renderer', async () => {
    const unique = `deferred-reload-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const sessionId = `session-${unique}`
    const transcriptPath = `/tmp/taskchute-broker-integration-${unique}.log`
    const firstAttached = deferred<number | undefined>()
    const firstReady = deferred<void>()
    const first = new TerminalSessionBrokerClient({
      identity,
      deferredShutdownTimeoutMs: 2_000,
    })
    first.start(
      sessionId,
      {
        command: '/bin/sh',
        args: [
          '-c',
          'printf "READY\\n"; while IFS= read -r line; do printf "ECHO:%s\\n" "$line"; [ "$line" = exit ] && exit 0; done',
        ],
        env: { ...process.env },
        stdinMode: 'pipe',
      },
      transcriptPath,
      undefined,
      {
        onAttached: firstAttached.resolve,
        onData: (data) => {
          if (data.includes('READY')) firstReady.resolve()
        },
        onExit: (outcome) =>
          firstReady.reject(new Error(`Unexpected early exit: ${outcome.status}`)),
      },
    )
    const originalPid = await withTimeout(firstAttached.promise)
    await withTimeout(firstReady.promise)

    await first.scheduleShutdownAfterGrace(1_000)
    first.detach()

    // Exercise a realistically slow renderer restart rather than attaching
    // in the same tick that armed the deadline.
    await new Promise((resolve) => setTimeout(resolve, 600))
    const secondAttached = deferred<number | undefined>()
    const echoed = deferred<void>()
    const exited = deferred<void>()
    const second = new TerminalSessionBrokerClient({ identity })
    second.attach(sessionId, {
      onAttached: secondAttached.resolve,
      onData: (data) => {
        if (data.includes('ECHO:after-reload')) echoed.resolve()
      },
      onExit: (outcome) => {
        if (outcome.status === 'succeeded') exited.resolve()
        else exited.reject(new Error(`Unexpected exit: ${outcome.status}`))
      },
      onUnavailable: () =>
        secondAttached.reject(new Error('Deferred shutdown was not canceled')),
    })
    expect(await withTimeout(secondAttached.promise)).toBe(originalPid)

    await new Promise((resolve) => setTimeout(resolve, 550))
    expect(() => process.kill(originalPid ?? -1, 0)).not.toThrow()
    second.write(sessionId, 'after-reload\n')
    await withTimeout(echoed.promise)
    second.write(sessionId, 'exit\n')
    await withTimeout(exited.promise)
    await second.shutdown()
  })

  test('canceled workspace quit explicitly disarms shutdown on the retained client', async () => {
    const unique = `deferred-cancel-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const sessionId = `session-${unique}`
    const attached = deferred<number | undefined>()
    const ready = deferred<void>()
    const echoed = deferred<void>()
    const exited = deferred<void>()
    const client = new TerminalSessionBrokerClient({
      identity,
      deferredShutdownTimeoutMs: 2_000,
    })
    client.start(
      sessionId,
      {
        command: '/bin/sh',
        args: [
          '-c',
          'printf "READY\\n"; while IFS= read -r line; do printf "ECHO:%s\\n" "$line"; [ "$line" = exit ] && exit 0; done',
        ],
        env: { ...process.env },
        stdinMode: 'pipe',
      },
      `/tmp/taskchute-broker-integration-${unique}.log`,
      undefined,
      {
        onAttached: attached.resolve,
        onData: (data) => {
          if (data.includes('READY')) ready.resolve()
          if (data.includes('ECHO:after-cancel')) echoed.resolve()
        },
        onExit: (outcome) => {
          if (outcome.status === 'succeeded') exited.resolve()
          else exited.reject(new Error(`Unexpected exit: ${outcome.status}`))
        },
      },
    )
    const childPid = await withTimeout(attached.promise)
    await withTimeout(ready.promise)

    await client.scheduleShutdownAfterGrace(500)
    await new Promise((resolve) => setTimeout(resolve, 150))
    await client.cancelDeferredShutdown()
    await new Promise((resolve) => setTimeout(resolve, 450))

    expect(() => process.kill(childPid ?? -1, 0)).not.toThrow()
    client.write(sessionId, 'after-cancel\n')
    await withTimeout(echoed.promise)
    client.write(sessionId, 'exit\n')
    await withTimeout(exited.promise)
    await client.shutdown()
  })

  test('new retained-renderer activation makes a delayed old pagehide schedule stale without attach', async () => {
    const unique = `deferred-stale-lease-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const sessionId = `session-${unique}`
    const oldLease = 'retained-renderer-old'
    const newLease = 'retained-renderer-new'
    const rendererOwner = 'retained-renderer-owner'
    const firstAttached = deferred<number | undefined>()
    const ready = deferred<void>()
    const client = new TerminalSessionBrokerClient({
      identity,
      rendererLeaseToken: oldLease,
      rendererLeaseOwnerId: rendererOwner,
      rendererLeaseGeneration: 1,
      deferredShutdownTimeoutMs: 2_000,
    })
    client.start(
      sessionId,
      {
        command: '/bin/sh',
        args: ['-c', 'printf "READY\\n"; while :; do sleep 1; done'],
        env: { ...process.env },
        stdinMode: 'pipe',
      },
      `/tmp/taskchute-broker-integration-${unique}.log`,
      undefined,
      {
        onAttached: firstAttached.resolve,
        onData: (data) => {
          if (data.includes('READY')) ready.resolve()
        },
        onExit: () => undefined,
      },
    )
    const childPid = await withTimeout(firstAttached.promise)
    await withTimeout(ready.promise)

    // The same retained manager/client is adopted by a new plugin instance.
    // Activation must claim the new lease even when AI Runs stays closed and
    // the new renderer does not send attach.
    await client.setRendererLeaseToken(newLease, rendererOwner, 2)

    await client.scheduleShutdownAfterGrace(
      200,
      oldLease,
      rendererOwner,
      1,
    )
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(() => process.kill(childPid ?? -1, 0)).not.toThrow()

    client.stop(sessionId, true)
    await waitUntil(() => {
      try {
        process.kill(childPid ?? -1, 0)
        return false
      } catch {
        return true
      }
    })
    await client.shutdown()
  })

  test('same-owner generations reject delayed activation/attach and reconnect the retained client with the newest lease', async () => {
    const unique = `renderer-generation-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const sessionId = `session-${unique}`
    const ownerId = 'retained-owner'
    const initialToken = 'retained-token-1'
    const delayedToken = 'retained-token-2'
    const currentToken = 'retained-token-3'
    const firstAttached = deferred<void>()
    const ready = deferred<void>()
    const reattached = deferred<void>()
    const echoed = deferred<void>()
    const exited = deferred<void>()
    let attachCount = 0
    const client = new TerminalSessionBrokerClient({
      identity,
      rendererLeaseToken: initialToken,
      rendererLeaseOwnerId: ownerId,
      rendererLeaseGeneration: 1,
      deferredShutdownTimeoutMs: 500,
      rendererLeaseActivationRetryWindowMs: 1_500,
    })
    try {
      client.start(
        sessionId,
        {
          command: '/bin/sh',
          args: [
            '-c',
            'printf "READY\\n"; while IFS= read -r line; do printf "ECHO:%s\\n" "$line"; [ "$line" = exit ] && exit 0; done',
          ],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        `/tmp/taskchute-broker-integration-${unique}.log`,
        undefined,
        {
          onAttached: () => {
            attachCount += 1
            if (attachCount === 1) firstAttached.resolve()
            if (attachCount >= 2) reattached.resolve()
          },
          onData: (data) => {
            if (data.includes('READY')) ready.resolve()
            if (data.includes('ECHO:new-generation')) echoed.resolve()
          },
          onExit: (outcome) => {
            if (outcome.status === 'succeeded') exited.resolve()
            else exited.reject(
              new Error(`Unexpected exit: ${outcome.status}`),
            )
          },
          onUnavailable: () =>
            reattached.reject(new Error('Retained session became unavailable')),
        },
      )
      await withTimeout(firstAttached.promise)
      await withTimeout(ready.promise)

      // Prove activation has a bounded retry independent of any attach. The
      // first dedicated control socket is failed deliberately; the second
      // must claim generation 3 before this Promise resolves.
      const internal = client as unknown as {
        requestAuthenticatedDeferredShutdown: (
          ...args: unknown[]
        ) => Promise<void>
        socket: { destroy(): void } | null
      }
      const originalControl =
        internal.requestAuthenticatedDeferredShutdown.bind(client)
      let activationAttempts = 0
      internal.requestAuthenticatedDeferredShutdown = (
        ...args: unknown[]
      ): Promise<void> => {
        const command = args[1] as { op?: unknown } | undefined
        if (
          command?.op === 'activate-renderer-lease' &&
          activationAttempts === 0
        ) {
          activationAttempts += 1
          return Promise.reject(new Error('synthetic first activation loss'))
        }
        if (command?.op === 'activate-renderer-lease') {
          activationAttempts += 1
        }
        return Reflect.apply(originalControl, client, args)
      }
      await client.setRendererLeaseToken(currentToken, ownerId, 3)
      expect(activationAttempts).toBeGreaterThanOrEqual(2)

      // T1 was created earlier but its activate/attach frames arrive only
      // after T2 (generation 3) became active. Neither may roll the broker
      // back to generation 2.
      await expect(
        sendRawBrokerFrame(descriptorPath, {
          op: 'activate-renderer-lease',
          rendererLeaseToken: delayedToken,
          rendererLeaseOwnerId: ownerId,
          rendererLeaseGeneration: 2,
        }),
      ).resolves.toBeNull()
      await expect(
        sendRawBrokerFrame(descriptorPath, {
          op: 'attach',
          sessionId,
          rendererLeaseToken: delayedToken,
          rendererLeaseOwnerId: ownerId,
          rendererLeaseGeneration: 2,
        }),
      ).resolves.toBeNull()

      // Existing TerminalRunHandle closures retain this BrokerClient. Force
      // its socket down: reconnect must attach with generation 3 and remain
      // writable, not reuse the identity captured at initial spawn.
      internal.socket?.destroy()
      await withTimeout(reattached.promise)
      client.write(sessionId, 'new-generation\n')
      await withTimeout(echoed.promise)
      client.write(sessionId, 'exit\n')
      await withTimeout(exited.promise)
      await client.shutdown()
    } finally {
      client.detach()
      if (existsSync(descriptorPath)) {
        await client.shutdown().catch(() => undefined)
      }
    }
  })

  test('stale raw resize and shutdown frames cannot affect the current renderer generation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'taskchute-broker-stale-control-'))
    const sttyLogPath = join(dir, 'stty.log')
    const fakeSttyPath = join(dir, 'fake-stty')
    writeFileSync(
      fakeSttyPath,
      `#!/bin/sh\necho "$@" >> "${sttyLogPath}"\n`,
      { mode: 0o755 },
    )
    process.env.TASKCHUTE_BROKER_STTY = fakeSttyPath
    const unique = `stale-control-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const sessionId = `session-${unique}`
    const transcriptPath = join(dir, 'transcript.log')
    writeFileSync(`${transcriptPath}.tty`, '/dev/ttys001\n')
    const ownerId = 'taskchute-plus-ai-terminal'
    const staleToken = 'stale-control-token'
    const currentToken = 'current-control-token'
    const attached = deferred<number | undefined>()
    const ready = deferred<void>()
    const client = new TerminalSessionBrokerClient({
      identity,
      rendererLeaseToken: staleToken,
      rendererLeaseOwnerId: ownerId,
      rendererLeaseGeneration: 1,
      deferredShutdownTimeoutMs: 1_000,
    })
    try {
      client.start(
        sessionId,
        {
          command: '/bin/sh',
          args: ['-c', 'printf "READY\\n"; while :; do sleep 1; done'],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        transcriptPath,
        undefined,
        {
          onAttached: attached.resolve,
          onData: (data) => {
            if (data.includes('READY')) ready.resolve()
          },
          onExit: () => undefined,
        },
      )
      const childPid = await withTimeout(attached.promise)
      await withTimeout(ready.promise)
      await client.setRendererLeaseToken(currentToken, ownerId, 2)

      await expect(
        sendRawBrokerFrame(descriptorPath, {
          op: 'resize',
          sessionId,
          cols: 177,
          rows: 55,
          rendererLeaseToken: staleToken,
          rendererLeaseOwnerId: ownerId,
          rendererLeaseGeneration: 1,
        }),
      ).resolves.toBeNull()
      await new Promise((resolve) => setTimeout(resolve, 350))
      expect(existsSync(sttyLogPath)).toBe(false)

      await expect(
        sendRawBrokerFrame(descriptorPath, {
          op: 'shutdown',
          rendererLeaseToken: staleToken,
          rendererLeaseOwnerId: ownerId,
          rendererLeaseGeneration: 1,
        }),
      ).resolves.toBeNull()
      await new Promise((resolve) => setTimeout(resolve, 350))
      expect(existsSync(descriptorPath)).toBe(true)
      expect(() => process.kill(childPid ?? -1, 0)).not.toThrow()

      // Prove the broker remains writable under the current generation and
      // that the stale resize was not merely delayed.
      client.resize(sessionId, 99, 24)
      await waitUntil(
        () =>
          existsSync(sttyLogPath) &&
          readFileSync(sttyLogPath, 'utf8').includes('rows 24 cols 99'),
      )
      expect(readFileSync(sttyLogPath, 'utf8')).not.toContain(
        'rows 55 cols 177',
      )
      client.stop(sessionId, true)
      await waitUntil(() => {
        try {
          process.kill(childPid ?? -1, 0)
          return false
        } catch {
          return true
        }
      })
      await client.shutdown()
    } finally {
      delete process.env.TASKCHUTE_BROKER_STTY
      client.detach()
      if (existsSync(descriptorPath)) {
        await client.shutdown().catch(() => undefined)
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a real renderer owner replacement retires the observed old owner', async () => {
    const unique = `renderer-owner-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const sessionId = `session-${unique}`
    const oldOwner = 'renderer-owner-old'
    const oldToken = 'renderer-token-old'
    const newOwner = 'taskchute-plus-ai-terminal'
    const newToken = 'renderer-token-new'
    const ready = deferred<void>()
    const attached = deferred<void>()
    const echoed = deferred<void>()
    const exited = deferred<void>()
    const oldClient = new TerminalSessionBrokerClient({
      identity,
      rendererLeaseToken: oldToken,
      rendererLeaseOwnerId: oldOwner,
      rendererLeaseGeneration: 1,
    })
    const newClient = new TerminalSessionBrokerClient({
      identity,
      rendererLeaseToken: newToken,
      rendererLeaseOwnerId: newOwner,
      rendererLeaseGeneration: 1,
      deferredShutdownTimeoutMs: 500,
    })
    try {
      oldClient.start(
        sessionId,
        {
          command: '/bin/sh',
          args: [
            '-c',
            'printf "READY\\n"; while IFS= read -r line; do printf "ECHO:%s\\n" "$line"; [ "$line" = exit ] && exit 0; done',
          ],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        `/tmp/taskchute-broker-integration-${unique}.log`,
        undefined,
        {
          onData: (data) => {
            if (data.includes('READY')) ready.resolve()
          },
          onExit: () => undefined,
        },
      )
      await withTimeout(ready.promise)

      // Explicit activation is the replacement barrier even if the new UI
      // has not opened AI Runs and therefore has not attached yet.
      await newClient.setRendererLeaseToken(newToken, newOwner, 1)

      await expect(
        sendRawBrokerFrame(descriptorPath, {
          op: 'attach',
          sessionId,
          rendererLeaseToken: oldToken,
          rendererLeaseOwnerId: oldOwner,
          rendererLeaseGeneration: 2,
        }),
      ).resolves.toBeNull()
      await expect(
        sendRawBrokerFrame(descriptorPath, {
          op: 'input',
          sessionId,
          data: 'stale-owner-input\n',
          rendererLeaseToken: oldToken,
          rendererLeaseOwnerId: oldOwner,
          rendererLeaseGeneration: 2,
        }),
      ).resolves.toBeNull()
      await expect(
        sendRawBrokerFrame(descriptorPath, {
          op: 'stop',
          sessionId,
          force: true,
          rendererLeaseToken: oldToken,
          rendererLeaseOwnerId: oldOwner,
          rendererLeaseGeneration: 2,
        }),
      ).resolves.toBeNull()

      newClient.attach(sessionId, {
        onAttached: () => attached.resolve(),
        onData: (data) => {
          if (data.includes('ECHO:new-owner')) echoed.resolve()
        },
        onExit: (outcome) => {
          if (outcome.status === 'succeeded') exited.resolve()
          else exited.reject(new Error(`Unexpected exit: ${outcome.status}`))
        },
        onUnavailable: () =>
          attached.reject(new Error('New renderer could not attach')),
      })
      await withTimeout(attached.promise)
      newClient.write(sessionId, 'new-owner\n')
      await withTimeout(echoed.promise)
      newClient.write(sessionId, 'exit\n')
      await withTimeout(exited.promise)
      oldClient.detach()
      await newClient.shutdown()
    } finally {
      oldClient.detach()
      newClient.detach()
      if (existsSync(descriptorPath)) {
        await newClient.shutdown().catch(() => undefined)
      }
    }
  })

  test('deferred app-exit shutdown reaps broker and child without a reconnect', async () => {
    const unique = `deferred-exit-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const sessionId = `session-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const attached = deferred<number | undefined>()
    const ready = deferred<void>()
    const client = new TerminalSessionBrokerClient({
      identity,
      deferredShutdownTimeoutMs: 2_000,
    })
    client.start(
      sessionId,
      {
        command: '/bin/sh',
        args: ['-c', 'printf "READY\\n"; while :; do sleep 1; done'],
        env: { ...process.env },
        stdinMode: 'pipe',
      },
      `/tmp/taskchute-broker-integration-${unique}.log`,
      undefined,
      {
        onAttached: attached.resolve,
        onData: (data) => {
          if (data.includes('READY')) ready.resolve()
        },
        onExit: () => undefined,
      },
    )
    const childPid = await withTimeout(attached.promise)
    await withTimeout(ready.promise)

    await client.scheduleShutdownAfterGrace(200)
    client.detach()

    await waitUntil(() => !existsSync(descriptorPath), 5_000)
    expect(() => process.kill(childPid ?? -1, 0)).toThrow()
  })

  test('deferred app-exit shutdown is not blocked by the old renderer socket at the deadline', async () => {
    const unique = `deferred-old-client-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const sessionId = `session-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const attached = deferred<number | undefined>()
    const ready = deferred<void>()
    const client = new TerminalSessionBrokerClient({
      identity,
      deferredShutdownTimeoutMs: 2_000,
    })
    client.start(
      sessionId,
      {
        command: '/bin/sh',
        args: ['-c', 'printf "READY\\n"; while :; do sleep 1; done'],
        env: { ...process.env },
        stdinMode: 'pipe',
      },
      `/tmp/taskchute-broker-integration-${unique}.log`,
      undefined,
      {
        onAttached: attached.resolve,
        onData: (data) => {
          if (data.includes('READY')) ready.resolve()
        },
        onExit: () => undefined,
      },
    )
    const childPid = await withTimeout(attached.promise)
    await withTimeout(ready.promise)

    await client.scheduleShutdownAfterGrace(200)
    // Intentionally keep the original renderer transport connected. A true
    // app exit may terminate it just after the external timer fires. Even
    // late traffic from that already-authenticated socket is not proof of a
    // canceled quit and must not renew/cancel the deadline.
    client.resize(sessionId, 100, 30)
    await waitUntil(() => !existsSync(descriptorPath), 5_000)
    expect(() => process.kill(childPid ?? -1, 0)).toThrow()
    client.detach()
  })

  test('shutdown waits until its live child and broker process are gone', async () => {
    const unique = `shutdown-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const sessionId = `session-${process.pid}-${Date.now()}`
    const attached = deferred<number | undefined>()
    const ready = deferred<void>()
    const exited = deferred<void>()
    const logs: string[] = []
    const client = new TerminalSessionBrokerClient({
      identity,
      log: (level, ...args) => logs.push(`${level}:${args.map(String).join(' ')}`),
    })
    client.start(
      sessionId,
      {
        command: '/bin/sh',
        args: ['-c', 'printf "READY\\n"; while :; do sleep 1; done'],
        env: { ...process.env },
        stdinMode: 'pipe',
      },
      `/tmp/taskchute-broker-integration-${unique}.log`,
      undefined,
      {
        onAttached: attached.resolve,
        onData: (data) => {
          if (data.includes('READY')) ready.resolve()
        },
        onExit: () => exited.resolve(),
      },
    )
    const childPid = await withTimeout(attached.promise)
    await withTimeout(ready.promise)
    expect(childPid).toEqual(expect.any(Number))

    await client.shutdown()
    await withTimeout(exited.promise)

    // AiTaskManager's delayed force-kill sweep can still call an old handle
    // after broker shutdown. It must be a no-op, never a request that starts
    // a brand-new empty broker and leaves a stale descriptor behind.
    client.stop(sessionId, true)
    client.write(sessionId, 'late input\n')
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(() => process.kill(childPid ?? -1, 0)).toThrow()
    expect(existsSync(getTerminalBrokerDescriptorPath(identity))).toBe(false)
    expect(logs.filter((line) => line.includes('Timed out'))).toEqual([])
  })

  test('replaces a refused stale descriptor even when its pid was reused by a live process', async () => {
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const stalePort = (probe.address() as AddressInfo).port
    await new Promise((resolve) => probe.close(resolve))
    const unique = `stale-reused-pid-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    writeFileSync(
      descriptorPath,
      JSON.stringify({
        version: 1,
        port: stalePort,
        token: 'd'.repeat(64),
        // This PID is alive but is the Jest process, not the broker.
        pid: process.pid,
      }),
      { mode: 0o600 },
    )
    const attached = deferred<number | undefined>()
    const ready = deferred<void>()
    const client = new TerminalSessionBrokerClient({
      identity,
      startupTimeoutMs: 3_000,
      connectTimeoutMs: 100,
    })
    try {
      client.start(
        `session-${unique}`,
        {
          command: '/bin/sh',
          args: ['-c', 'printf "READY\\n"; while :; do sleep 1; done'],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onAttached: attached.resolve,
          onData: (data) => {
            if (data.includes('READY')) ready.resolve()
          },
          onExit: (outcome) =>
            ready.reject(new Error(`Unexpected early exit: ${outcome.status}`)),
          onUnavailable: () =>
            ready.reject(new Error('Replacement broker was unavailable')),
        },
      )

      const wrapperPid = await withTimeout(attached.promise)
      await withTimeout(ready.promise)
      expect(wrapperPid).toEqual(expect.any(Number))
      expect(wrapperPid).not.toBe(process.pid)
    } finally {
      await client.shutdown().catch(() => undefined)
      if (existsSync(descriptorPath)) rmSync(descriptorPath, { force: true })
    }
  })

  test('shutdown racing the initial broker startup never sends a late spawn', async () => {
    const unique = `shutdown-start-race-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    let attachedPid: number | undefined
    let output = ''
    const client = new TerminalSessionBrokerClient({
      identity,
      startupTimeoutMs: 3_000,
      shutdownTimeoutMs: 3_000,
    })

    client.start(
      `session-${unique}`,
      {
        command: '/bin/sh',
        args: ['-c', 'echo ORPHAN_STARTED; while :; do sleep 1; done'],
        env: { ...process.env },
        stdinMode: 'pipe',
      },
      `/tmp/taskchute-broker-integration-${unique}.log`,
      undefined,
      {
        onAttached: (pid) => {
          attachedPid = pid
        },
        onData: (data) => {
          output += data
        },
        onExit: () => undefined,
      },
    )

    await withTimeout(client.shutdown(), 8_000)
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(existsSync(descriptorPath)).toBe(false)
    expect(attachedPid).toBeUndefined()
    expect(output).not.toContain('ORPHAN_STARTED')
  })

  test('shutdown kills a Node-spawned detached descendant before resolving', async () => {
    const unique = `detached-descendant-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const sessionId = `session-${process.pid}-${Date.now()}`
    const ready = deferred<void>()
    let output = ''
    let detachedPid: number | undefined
    const client = new TerminalSessionBrokerClient({
      identity,
      shutdownTimeoutMs: 4_000,
    })
    const nodeCode =
      "const {spawn}=require('child_process');" +
      "const c=spawn('/bin/sh',['-c','while :; do sleep 1; done']," +
      "{detached:true,stdio:'ignore'});" +
      "console.log('DETACHED_PID:'+c.pid);c.unref();"

    try {
      client.start(
        sessionId,
        {
          command: '/bin/sh',
          args: [
            '-c',
            `node -e ${JSON.stringify(nodeCode)}; echo READY; while :; do sleep 1; done`,
          ],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        `/tmp/taskchute-broker-integration-${unique}.log`,
        undefined,
        {
          onData: (data) => {
            output += data
            const match = /DETACHED_PID:(\d+)/u.exec(output)
            if (match) detachedPid = Number(match[1])
            if (output.includes('READY') && detachedPid !== undefined) {
              ready.resolve()
            }
          },
          onExit: () => undefined,
          onUnavailable: () =>
            ready.reject(new Error('Detached descendant session was unavailable')),
        },
      )

      await withTimeout(ready.promise)
      expect(detachedPid).toEqual(expect.any(Number))
      await withTimeout(client.shutdown(), 8_000)
      expect(() => process.kill(detachedPid ?? -1, 0)).toThrow()
      expect(existsSync(getTerminalBrokerDescriptorPath(identity))).toBe(false)
    } finally {
      if (detachedPid !== undefined) {
        try {
          process.kill(-detachedPid, 'SIGKILL')
        } catch {
          try {
            process.kill(detachedPid, 'SIGKILL')
          } catch {
            // Already reaped by the broker.
          }
        }
      }
      await client.shutdown().catch(() => undefined)
    }
  })

  test('natural root exit reaps a detached child that keeps inherited stdio open', async () => {
    const unique = `natural-exit-detached-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const exited = deferred<void>()
    let output = ''
    let detachedPid: number | undefined
    const client = new TerminalSessionBrokerClient({
      identity,
      shutdownTimeoutMs: 5_000,
    })
    const nodeCode =
      "const {spawn}=require('child_process');" +
      "const child=spawn('/bin/sh',['-c','while :; do sleep 10; done']," +
      "{detached:true,stdio:'inherit'});" +
      "console.log('DETACHED_PID:'+child.pid);child.unref();"

    try {
      client.start(
        `session-${unique}`,
        {
          command: 'node',
          args: ['-e', nodeCode],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onData: (data) => {
            output += data
            const match = /DETACHED_PID:(\d+)/u.exec(output)
            if (match) detachedPid = Number(match[1])
          },
          onExit: () => exited.resolve(),
          onUnavailable: () =>
            exited.reject(new Error('Natural-exit session was unavailable')),
        },
      )

      await withTimeout(exited.promise)
      expect(detachedPid).toEqual(expect.any(Number))
      expect(() => process.kill(detachedPid ?? -1, 0)).toThrow()
      await withTimeout(client.shutdown())
    } finally {
      if (detachedPid !== undefined) {
        try {
          process.kill(-detachedPid, 'SIGKILL')
        } catch {
          // Already reaped by the broker.
        }
      }
      await client.shutdown().catch(() => undefined)
    }
  })

  test('shutdown tracks a detached child created by promisified exec', async () => {
    const unique = `promisified-detached-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const ready = deferred<void>()
    let output = ''
    let detachedPid: number | undefined
    const client = new TerminalSessionBrokerClient({
      identity,
      shutdownTimeoutMs: 5_000,
    })
    const nodeCode =
      "const {promisify}=require('util');" +
      "const cp=require('child_process');" +
      "const pending=promisify(cp.exec)('while :; do sleep 10; done'," +
      "{detached:true});" +
      "console.log('DETACHED_PID:'+pending.child.pid);pending.child.unref();" +
      "setInterval(()=>{},1000);"

    try {
      client.start(
        `session-${unique}`,
        {
          command: 'node',
          args: ['-e', nodeCode],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onData: (data) => {
            output += data
            const match = /DETACHED_PID:(\d+)/u.exec(output)
            if (match) {
              detachedPid = Number(match[1])
              ready.resolve()
            }
          },
          onExit: () => undefined,
          onUnavailable: () =>
            ready.reject(new Error('Promisified detached session was unavailable')),
        },
      )

      await withTimeout(ready.promise)
      await withTimeout(client.shutdown())
      expect(() => process.kill(detachedPid ?? -1, 0)).toThrow()
    } finally {
      if (detachedPid !== undefined) {
        try {
          process.kill(-detachedPid, 'SIGKILL')
        } catch {
          // Already reaped by the broker.
        }
      }
      await client.shutdown().catch(() => undefined)
    }
  })

  test('Python intermediary tracking chains sitecustomize and survives a localized broker environment', async () => {
    if (!existsSync('/usr/bin/python3')) return
    const unique = `python-detached-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const customSiteDir = mkdtempSync(join(tmpdir(), 'taskchute-sitecustomize-'))
    const markerPath = join(customSiteDir, 'existing-sitecustomize-ran')
    writeFileSync(
      join(customSiteDir, 'sitecustomize.py'),
      "import os\nopen(os.environ['TASKCHUTE_TEST_SITE_MARKER'], 'w').write('CHAINED')\n",
      { mode: 0o600 },
    )
    const ready = deferred<void>()
    let output = ''
    let detachedPid: number | undefined
    const client = new TerminalSessionBrokerClient({
      identity,
      shutdownTimeoutMs: 5_000,
      getEnv: () => ({
        ...process.env,
        LC_ALL: 'fr_FR.UTF-8',
        LANG: 'fr_FR.UTF-8',
      }),
    })
    const pythonCode =
      "import subprocess; p = subprocess.Popen(['/bin/sh', '-c', 'while :; do sleep 10; done'], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); print('DETACHED_PID:' + str(p.pid), flush=True)"
    const nodeCode =
      "const {spawn}=require('child_process');" +
      `const child=spawn('/usr/bin/python3',['-c',${JSON.stringify(pythonCode)}],` +
      "{stdio:['ignore','pipe','inherit']});" +
      "child.stdout.pipe(process.stdout);" +
      "child.on('close',()=>console.log('READY'));"

    try {
      client.start(
        `session-${unique}`,
        {
          command: '/bin/sh',
          args: [
            '-c',
            `node -e ${JSON.stringify(nodeCode)}; while :; do sleep 10; done`,
          ],
          env: {
            ...process.env,
            PYTHONPATH: customSiteDir,
            TASKCHUTE_TEST_SITE_MARKER: markerPath,
          },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onData: (data) => {
            output += data
            const match = /DETACHED_PID:(\d+)/u.exec(output)
            if (match) detachedPid = Number(match[1])
            if (output.includes('READY') && detachedPid !== undefined) {
              ready.resolve()
            }
          },
          onExit: () => undefined,
          onUnavailable: () =>
            ready.reject(new Error('Python detached session was unavailable')),
        },
      )

      await withTimeout(ready.promise)
      expect(existsSync(markerPath)).toBe(true)
      await withTimeout(client.shutdown())
      expect(() => process.kill(detachedPid ?? -1, 0)).toThrow()
      const hookPrefix = `${basename(descriptorPath)}.owner-python-`
      expect(
        readdirSync(dirname(descriptorPath)).filter((name) =>
          name.startsWith(hookPrefix)),
      ).toEqual([])
    } finally {
      if (detachedPid !== undefined) {
        try {
          process.kill(-detachedPid, 'SIGKILL')
        } catch {
          // Already reaped by the broker.
        }
      }
      await client.shutdown().catch(() => undefined)
      rmSync(customSiteDir, { force: true, recursive: true })
    }
  })

  test.each([
    ['direct', '/usr/bin/python3 -S'],
    ['ignore environment', '/usr/bin/python3 -E'],
    ['isolated mode', '/usr/bin/python3 -I'],
    ['combined flags', '/usr/bin/python3 -ES'],
    ['env launcher', '/usr/bin/env python3 -B -S'],
    ['env clear', '/usr/bin/env -i /usr/bin/python3'],
    ['env unset Python path', '/usr/bin/env -u PYTHONPATH /usr/bin/python3'],
    ['env replace Python path', '/usr/bin/env PYTHONPATH= /usr/bin/python3'],
    ['shell command prefix', 'command /usr/bin/python3 -S'],
  ])('rejects %s hook-disabling Python flags before they can leak a detached child', async (
    label,
    pythonLaunch,
  ) => {
    if (!existsSync('/usr/bin/python3')) return
    const safeLabel = label.replace(/[^A-Za-z0-9_-]/gu, '-')
    const unique =
      `python-no-site-detached-${safeLabel}-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const failed = deferred<{
      status: string
      errorMessage?: string
    }>()
    let output = ''
    const client = new TerminalSessionBrokerClient({
      identity,
      shutdownTimeoutMs: 6_000,
    })
    const pythonCode =
      "import subprocess; p = subprocess.Popen(['/bin/sh', '-c', 'while :; do sleep 10; done'], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); print('DETACHED_PID:' + str(p.pid), flush=True)"

    try {
      client.start(
        `session-${unique}`,
        {
          command: '/bin/sh',
          args: [
            '-c',
            `${pythonLaunch} -c ${JSON.stringify(pythonCode)}; echo READY; while :; do sleep 10; done`,
          ],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onData: (data) => {
            output += data
          },
          onExit: failed.resolve,
          onUnavailable: () =>
            failed.reject(new Error('Python -S rejection was unavailable')),
        },
      )

      const outcome = await withTimeout(failed.promise)
      expect(outcome.status).toBe('failed')
      expect(outcome.errorMessage).toContain(
        'Python interpreter flags',
      )
      expect(output).not.toContain('DETACHED_PID:')
      expect(output).not.toContain('READY')
    } finally {
      await client.shutdown().catch(() => undefined)
    }
  })

  test.each(['-S', '-E', '-I', '-ES'])(
    'rejects Python %s through the production PTY wrapper shape before spawn',
    async (pythonFlag) => {
    if (!existsSync('/usr/bin/python3')) return
    const unique =
      `python-no-site-production-pty-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const failed = deferred<{ status: string; errorMessage?: string }>()
    const transcriptPath = join(tmpdir(), `taskchute-broker-${unique}.log`)
    const gateway = new NodeProcessGateway()
    const ptyCommand = gateway.buildPtyCommand({
      binaryPath: '/usr/bin/python3',
      args: [pythonFlag, '-c', 'print("SHOULD_NOT_RUN")'],
      rows: 24,
      cols: 80,
      transcriptPath,
    })
    const client = new TerminalSessionBrokerClient({ identity })
    let output = ''
    try {
      client.start(
        `session-${unique}`,
        {
          command: ptyCommand.command,
          args: ptyCommand.args,
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        transcriptPath,
        undefined,
        {
          onData: (data) => {
            output += data
          },
          onExit: failed.resolve,
          onUnavailable: () =>
            failed.reject(new Error('Production PTY rejection was unavailable')),
        },
      )

      const outcome = await withTimeout(failed.promise)
      expect(outcome.status).toBe('failed')
      expect(outcome.errorMessage).toContain('Python interpreter flags')
      expect(output).not.toContain('SHOULD_NOT_RUN')
    } finally {
      await client.shutdown().catch(() => undefined)
      rmSync(transcriptPath, { force: true })
      rmSync(`${transcriptPath}.tty`, { force: true })
    }
    },
  )

  test('rejects hook-disabling Python hidden inside the AI terminal argv bootstrap', async () => {
    if (!existsSync('/usr/bin/python3')) return
    const unique =
      `python-no-site-terminal-bootstrap-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const observed = deferred<
      | { kind: 'rejected'; errorMessage?: string }
      | { kind: 'spawned' }
    >()
    const transcriptPath = join(tmpdir(), `taskchute-broker-${unique}.log`)
    const gateway = new NodeProcessGateway()
    const shellLaunch = buildTerminalShellLaunch(
      '/bin/sh',
      '/usr/bin/python3',
      ['-S'],
      ['-c', 'print("SHOULD_NOT_RUN", flush=True)'],
    )
    const ptyCommand = gateway.buildPtyCommand({
      binaryPath: shellLaunch.binaryPath,
      args: shellLaunch.args,
      rows: 24,
      cols: 80,
      transcriptPath,
    })
    const client = new TerminalSessionBrokerClient({ identity })
    try {
      client.start(
        `session-${unique}`,
        {
          command: ptyCommand.command,
          args: ptyCommand.args,
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        transcriptPath,
        undefined,
        {
          onData: (data) => {
            if (data.includes('SHOULD_NOT_RUN')) {
              observed.resolve({ kind: 'spawned' })
            }
          },
          onExit: (outcome) =>
            observed.resolve({
              kind: 'rejected',
              errorMessage: outcome.errorMessage,
            }),
          onUnavailable: () =>
            observed.reject(new Error('Bootstrap rejection was unavailable')),
        },
      )

      const outcome = await withTimeout(observed.promise)
      expect(outcome.kind).toBe('rejected')
      if (outcome.kind === 'rejected') {
        expect(outcome.errorMessage).toContain('Python interpreter flags')
      }
    } finally {
      client.stop(`session-${unique}`, true)
      await client.shutdown().catch(() => undefined)
      rmSync(transcriptPath, { force: true })
      rmSync(`${transcriptPath}.tty`, { force: true })
    }
  })

  test.each([
    ['clear environment', ['-i']],
    ['unset Node options', ['-u', 'NODE_OPTIONS']],
    ['replace Node options', ['NODE_OPTIONS=']],
  ])(
    'rejects production PTY env launch that would %s',
    async (_label, envArgs) => {
      const unique =
        `owner-env-production-pty-${process.pid}-${Date.now()}-${Math.random()}`
      const identity = `broker-integration-${unique}`
      const failed = deferred<{ status: string; errorMessage?: string }>()
      const transcriptPath = join(tmpdir(), `taskchute-broker-${unique}.log`)
      const gateway = new NodeProcessGateway()
      const ptyCommand = gateway.buildPtyCommand({
        binaryPath: '/usr/bin/env',
        args: [
          ...envArgs,
          process.execPath,
          '-e',
          'console.log("SHOULD_NOT_RUN")',
        ],
        rows: 24,
        cols: 80,
        transcriptPath,
      })
      const client = new TerminalSessionBrokerClient({ identity })
      let output = ''
      try {
        client.start(
          `session-${unique}`,
          {
            command: ptyCommand.command,
            args: ptyCommand.args,
            env: { ...process.env },
            stdinMode: 'pipe',
          },
          transcriptPath,
          undefined,
          {
            onData: (data) => {
              output += data
            },
            onExit: failed.resolve,
            onUnavailable: () =>
              failed.reject(new Error('Environment rejection was unavailable')),
          },
        )

        const outcome = await withTimeout(failed.promise)
        expect(outcome.status).toBe('failed')
        expect(outcome.errorMessage).toContain(
          'Ownership-disabling environment options',
        )
        expect(output).not.toContain('SHOULD_NOT_RUN')
      } finally {
        await client.shutdown().catch(() => undefined)
        rmSync(transcriptPath, { force: true })
        rmSync(`${transcriptPath}.tty`, { force: true })
      }
    },
  )

  test('a malformed owner record fails cleanup in bounded time instead of hanging', async () => {
    const unique =
      `owner-malformed-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const ready = deferred<void>()
    const exited = deferred<{ status: string; errorMessage?: string }>()
    const client = new TerminalSessionBrokerClient({ identity })
    const nodeCode =
      "const fs=require('fs');" +
      "fs.appendFileSync(process.env.TASKCHUTE_BROKER_OWNER_PID_FILE,'{malformed}\\n');" +
      "console.log('READY');process.stdin.once('data',()=>process.exit(0));"
    try {
      client.start(
        `session-${unique}`,
        {
          command: 'node',
          args: ['-e', nodeCode],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onData: (data) => {
            if (data.includes('READY')) ready.resolve()
          },
          onExit: exited.resolve,
          onUnavailable: () =>
            exited.reject(new Error('Malformed owner session was unavailable')),
        },
      )

      await withTimeout(ready.promise)
      client.write(`session-${unique}`, 'exit\n')
      const outcome = await withTimeout(exited.promise, 4_000)
      expect(outcome.status).toBe('failed')
      expect(outcome.errorMessage).toContain(
        'ownership tracking became unavailable',
      )
    } finally {
      await client.shutdown().catch(() => undefined)
    }
  })

  test('a newline-free partial owner record fails closed without signalling its PID', async () => {
    const unique =
      `owner-partial-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const sessionId = `session-${unique}`
    const ready = deferred<void>()
    const exited = deferred<{ status: string; errorMessage?: string }>()
    const client = new TerminalSessionBrokerClient({ identity })
    let detached: ReturnType<typeof spawnChild> | undefined
    try {
      client.start(
        sessionId,
        {
          command: '/bin/sh',
          args: ['-c', 'printf "READY\\n"; IFS= read -r _'],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onData: (data) => {
            if (data.includes('READY')) ready.resolve()
          },
          onExit: exited.resolve,
          onUnavailable: () =>
            exited.reject(new Error('Partial owner session was unavailable')),
        },
      )

      await withTimeout(ready.promise)
      const [ownerPidFile] = ownerPidFiles(descriptorPath)
      expect(ownerPidFile).toBeDefined()
      detached = spawnChild(
        '/bin/sh',
        ['-c', 'while :; do sleep 10; done'],
        { detached: true, stdio: 'ignore' },
      )
      detached.unref()
      const detachedPid = detached.pid
      expect(detachedPid).toEqual(expect.any(Number))
      const startedAt = Date.parse(
        execFileSync(
          '/bin/ps',
          ['-p', String(detachedPid), '-o', 'lstart='],
          {
            encoding: 'utf8',
            env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
          },
        ).trim(),
      )
      expect(Number.isFinite(startedAt)).toBe(true)
      writeFileSync(
        ownerPidFile,
        `{"pid":${detachedPid},"startedAt":${startedAt},"startedAtLower":${startedAt}`,
        { flag: 'a' },
      )

      client.write(sessionId, 'exit\n')
      const outcome = await withTimeout(exited.promise, 4_000)
      expect(outcome.status).toBe('failed')
      expect(outcome.errorMessage).toContain(
        'ownership tracking became unavailable',
      )
      expect(() => process.kill(detachedPid ?? -1, 0)).not.toThrow()
    } finally {
      if (detached?.pid !== undefined) {
        try {
          process.kill(-detached.pid, 'SIGKILL')
        } catch {
          // Already terminated during test cleanup.
        }
      }
      await client.shutdown().catch(() => undefined)
    }
  })

  test.each(['file', 'hooks'])(
    'ownership %s setup failure rejects before spawning and leaves no pid file',
    async (failureMode) => {
      const unique =
        `owner-setup-${failureMode}-${process.pid}-${Date.now()}-${Math.random()}`
      const identity = `broker-integration-${unique}`
      const descriptorPath = getTerminalBrokerDescriptorPath(identity)
      const markerPath = join(tmpdir(), `taskchute-owner-spawned-${unique}`)
      const failed = deferred<{ status: string; errorMessage?: string }>()
      const client = new TerminalSessionBrokerClient({
        identity,
        getEnv: () => ({
          ...process.env,
          TASKCHUTE_BROKER_TEST_OWNER_SETUP_FAILURE: failureMode,
        }),
      })
      try {
        client.start(
          `session-${unique}`,
          {
            command: '/bin/sh',
            args: ['-c', `printf spawned > ${JSON.stringify(markerPath)}`],
            env: { ...process.env },
            stdinMode: 'pipe',
          },
          join(tmpdir(), `taskchute-broker-${unique}.log`),
          undefined,
          {
            onData: () => undefined,
            onExit: failed.resolve,
            onUnavailable: () =>
              failed.reject(new Error('Owner setup rejection was unavailable')),
          },
        )

        const outcome = await withTimeout(failed.promise)
        expect(outcome.status).toBe('failed')
        expect(outcome.errorMessage).toContain(
          failureMode === 'file' ? 'tracking could not' : 'hooks could not',
        )
        expect(existsSync(markerPath)).toBe(false)
        expect(ownerPidFiles(descriptorPath)).toEqual([])
      } finally {
        await client.shutdown().catch(() => undefined)
        rmSync(markerPath, { force: true })
      }
    },
  )

  test('an asynchronous ENOENT spawn fails without crashing the broker', async () => {
    const unique =
      `owner-enoent-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const failed = deferred<{ status: string; errorMessage?: string }>()
    const recovered = deferred<void>()
    const client = new TerminalSessionBrokerClient({ identity })
    try {
      client.start(
        `session-missing-${unique}`,
        {
          command: `/definitely-missing-taskchute-${unique}`,
          args: [],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-missing-${unique}.log`),
        undefined,
        {
          onData: () => undefined,
          onExit: failed.resolve,
          onUnavailable: () =>
            failed.reject(new Error('Missing binary was unavailable')),
        },
      )

      const outcome = await withTimeout(failed.promise)
      expect(outcome.status).toBe('failed')
      expect(ownerPidFiles(descriptorPath)).toEqual([])

      client.start(
        `session-recovered-${unique}`,
        {
          command: '/bin/sh',
          args: ['-c', 'printf "BROKER_RECOVERED\\n"'],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-recovered-${unique}.log`),
        undefined,
        {
          onData: (data) => {
            if (data.includes('BROKER_RECOVERED')) recovered.resolve()
          },
          onExit: () => undefined,
          onUnavailable: () =>
            recovered.reject(new Error('Broker did not recover after ENOENT')),
        },
      )
      await withTimeout(recovered.promise)
    } finally {
      await client.shutdown().catch(() => undefined)
    }
  })

  test('does not reject quoted Python -S text that is not a shell command', async () => {
    const unique = `python-no-site-literal-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const exited = deferred<void>()
    let output = ''
    const client = new TerminalSessionBrokerClient({ identity })
    try {
      client.start(
        `session-${unique}`,
        {
          command: '/bin/sh',
          args: [
            '-c',
            `printf '%s\\n' '; python3 -S' 'READY'`,
          ],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onData: (data) => {
            output += data
          },
          onExit: (outcome) => {
            if (outcome.status === 'succeeded') exited.resolve()
            else exited.reject(new Error(`Unexpected exit: ${outcome.status}`))
          },
          onUnavailable: () =>
            exited.reject(new Error('Literal shell session was unavailable')),
        },
      )

      await withTimeout(exited.promise)
      expect(output).toContain('; python3 -S')
      expect(output).toContain('READY')
    } finally {
      await client.shutdown().catch(() => undefined)
    }
  })

  test('owner-record backlog cannot hide a detached child at the tail', async () => {
    const unique = `owner-backlog-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const ready = deferred<void>()
    let output = ''
    let detachedPid: number | undefined
    const client = new TerminalSessionBrokerClient({
      identity,
      shutdownTimeoutMs: 5_000,
    })
    const nodeCode =
      "const fs=require('fs');const cp=require('child_process');" +
      "const file=process.env.TASKCHUTE_BROKER_OWNER_PID_FILE;" +
      "const record=JSON.stringify({pid:999999,startedAt:1,active:false})+'\\n';" +
      "fs.appendFileSync(file,record.repeat(1800));" +
      "const child=cp.spawn('/bin/sh',['-c','while :; do sleep 10; done']," +
      "{detached:true,stdio:'ignore'});" +
      "console.log('DETACHED_PID:'+child.pid);child.unref();" +
      "setInterval(()=>{},1000);"

    try {
      client.start(
        `session-${unique}`,
        {
          command: 'node',
          args: ['-e', nodeCode],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onData: (data) => {
            output += data
            const match = /DETACHED_PID:(\d+)/u.exec(output)
            if (match) {
              detachedPid = Number(match[1])
              ready.resolve()
            }
          },
          onExit: () => undefined,
          onUnavailable: () =>
            ready.reject(new Error('Owner-backlog session was unavailable')),
        },
      )

      await withTimeout(ready.promise)
      await withTimeout(client.shutdown(), 10_000)
      expect(() => process.kill(detachedPid ?? -1, 0)).toThrow()
    } finally {
      if (detachedPid !== undefined) {
        try {
          process.kill(-detachedPid, 'SIGKILL')
        } catch {
          // Already reaped by the broker.
        }
      }
      await client.shutdown().catch(() => undefined)
    }
  })

  test('the Node ownership hook preserves custom promisify contracts', async () => {
    const unique = `owner-hook-promisify-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const exited = deferred<void>()
    let output = ''
    const client = new TerminalSessionBrokerClient({ identity })
    const nodeCode =
      "const {promisify}=require('util');" +
      "const cp=require('child_process');" +
      "promisify(cp.exec)('printf hook-ok').then(result=>" +
      "console.log('PROMISIFY:'+typeof result+':'+result.stdout));"

    try {
      client.start(
        `session-${unique}`,
        {
          command: '/bin/sh',
          args: ['-c', `node -e ${JSON.stringify(nodeCode)}`],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        `/tmp/taskchute-broker-integration-${unique}.log`,
        undefined,
        {
          onData: (data) => {
            output += data
          },
          onExit: (outcome) => {
            if (outcome.status === 'succeeded') exited.resolve()
            else exited.reject(new Error(
              `Unexpected outcome: ${outcome.status}: ${outcome.errorMessage ?? ''}: ${output}`,
            ))
          },
          onUnavailable: () =>
            exited.reject(new Error('Owner-hook session was unavailable')),
        },
      )

      await withTimeout(exited.promise)
      expect(output).toContain('PROMISIFY:object:hook-ok')
    } finally {
      await client.shutdown().catch(() => undefined)
    }
  })

  test('two renderer clients can shut down the same live broker concurrently', async () => {
    const unique = `concurrent-shutdown-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const sessionId = `session-${process.pid}-${Date.now()}`
    const firstAttached = deferred<number | undefined>()
    const secondAttached = deferred<number | undefined>()
    const ready = deferred<void>()
    const first = new TerminalSessionBrokerClient({ identity })
    const second = new TerminalSessionBrokerClient({ identity })

    first.start(
      sessionId,
      {
        command: '/bin/sh',
        args: ['-c', 'printf "READY\\n"; while :; do sleep 1; done'],
        env: { ...process.env },
        stdinMode: 'pipe',
      },
      `/tmp/taskchute-broker-integration-${unique}.log`,
      undefined,
      {
        onAttached: firstAttached.resolve,
        onData: (data) => {
          if (data.includes('READY')) ready.resolve()
        },
        onExit: () => undefined,
      },
    )
    const childPid = await withTimeout(firstAttached.promise)
    await withTimeout(ready.promise)
    second.attach(sessionId, {
      onAttached: secondAttached.resolve,
      onData: () => undefined,
      onExit: () => undefined,
      onUnavailable: () => secondAttached.reject(
        new Error('Second renderer could not attach'),
      ),
    })
    expect(await withTimeout(secondAttached.promise)).toBe(childPid)

    await withTimeout(Promise.all([first.shutdown(), second.shutdown()]))

    expect(() => process.kill(childPid ?? -1, 0)).toThrow()
    expect(existsSync(getTerminalBrokerDescriptorPath(identity))).toBe(false)
  })
})
