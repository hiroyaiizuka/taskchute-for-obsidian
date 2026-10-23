import { TerminalSessionBrokerClient } from '@/features/ai-task/services/TerminalSessionBroker'

/**
 * LEV-397: with a data connection, a lease activation goes on it, and the
 * broker answers activations in the order they were written. An answer that
 * arrives after its activation timed out must not complete a newer one:
 * setRendererLeaseToken would report a lease active before the broker took
 * it, and a shutdown request sent next on a control connection would be
 * dropped as stale.
 */

interface Internals {
  socket: { destroyed: boolean; write(data: string): boolean } | null
  descriptor: { version: number; port: number; token: string; pid: number } | null
  activateLeaseOnDataTransport(
    target: unknown,
    identity: { token: string; ownerId: string; generation: number },
    timeoutMs: number,
  ): Promise<boolean>
  handleMessage(message: { type: string }): void
}

function clientWithDataConnection() {
  const client = new TerminalSessionBrokerClient({
    identity: `broker-lease-activation-${process.pid}-${Date.now()}-${Math.random()}`,
  })
  const internals = client as unknown as Internals
  const written: string[] = []
  const descriptor = { version: 2, port: 1, token: 'f'.repeat(64), pid: process.pid }
  internals.descriptor = descriptor
  internals.socket = {
    destroyed: false,
    write: (data: string) => {
      written.push(data)
      return true
    },
  }
  return { internals, descriptor, written }
}

const lease = (generation: number) => ({
  token: `lease-${String(generation)}`,
  ownerId: 'owner',
  generation,
})

async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false
  void promise.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 10))
  return done
}

describe('lease activation on the data connection', () => {
  test('a late answer to a timed-out activation does not complete a newer one', async () => {
    const { internals, descriptor, written } = clientWithDataConnection()

    await expect(
      internals.activateLeaseOnDataTransport(descriptor, lease(2), 20),
    ).rejects.toThrow(/timed out/)
    const newer = internals.activateLeaseOnDataTransport(descriptor, lease(3), 5_000)
    expect(written).toHaveLength(2)

    // The broker answers generation 2 late: generation 3 is still waiting.
    internals.handleMessage({ type: 'renderer-lease-activated' })
    expect(await settled(newer)).toBe(false)

    // Its own answer completes it.
    internals.handleMessage({ type: 'renderer-lease-activated' })
    await expect(newer).resolves.toBe(true)
  })

  test('answers owed on an earlier connection are dropped with it', async () => {
    const { internals, descriptor } = clientWithDataConnection()

    await expect(
      internals.activateLeaseOnDataTransport(descriptor, lease(2), 20),
    ).rejects.toThrow(/timed out/)
    // The connection is replaced; its unanswered activation goes with it.
    internals.socket = { destroyed: false, write: () => true }
    const next = internals.activateLeaseOnDataTransport(descriptor, lease(3), 5_000)

    internals.handleMessage({ type: 'renderer-lease-activated' })
    await expect(next).resolves.toBe(true)
  })
})
