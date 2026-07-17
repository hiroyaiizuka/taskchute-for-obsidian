import { existsSync } from 'fs'

import {
  getTerminalBrokerDescriptorPath,
  TerminalSessionBrokerClient,
  type TerminalBrokerSessionCallbacks,
} from '../../../src/features/ai-task/services/TerminalSessionBroker'

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
    const originalPid = await withTimeout(firstAttached.promise)
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
})
