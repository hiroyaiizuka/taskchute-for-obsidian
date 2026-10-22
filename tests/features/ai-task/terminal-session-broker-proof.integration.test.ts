import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createHmac } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer, type AddressInfo, type Server } from 'net'

import { BROKER_PROOF_PREFIX } from '@/features/ai-task/services/BrokerProof'
import {
  getTerminalBrokerDescriptorPath,
  TerminalSessionBrokerClient,
} from '@/features/ai-task/services/TerminalSessionBroker'
import { describePosix } from '@tests/support/platform'
import { deferred, withTimeout } from './brokerTestUtils'

/**
 * LEV-391: whoever answers on the descriptor's port must prove it holds the
 * token before the plugin sends the token or anything else.
 */

const STALE_TOKEN = 'e'.repeat(64)

interface Impostor {
  server: Server
  port: number
  /** Every byte the plugin sent it, across all connections. */
  received: () => string
}

/**
 * A process on the broker's old port that does not hold the token.
 * 'wrong-proof' answers the challenge with a made-up key; 'legacy' behaves like
 * a broker from before LEV-391 and hangs up on any frame without the token.
 */
async function startImpostor(kind: 'wrong-proof' | 'legacy'): Promise<Impostor> {
  let received = ''
  const server = createServer((socket) => {
    socket.on('error', () => undefined)
    let buffer = ''
    socket.on('data', (chunk) => {
      received += chunk.toString()
      buffer += chunk.toString()
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const message = JSON.parse(buffer.slice(0, newline)) as {
          op?: string
          nonce?: string
          token?: string
        }
        buffer = buffer.slice(newline + 1)
        if (kind === 'legacy' && message.token !== STALE_TOKEN) {
          socket.destroy()
          return
        }
        if (kind === 'wrong-proof' && message.op === 'prove') {
          const proof = createHmac('sha256', 'f'.repeat(64))
            .update(`${BROKER_PROOF_PREFIX}${String(message.nonce)}`)
            .digest('hex')
          socket.write(`${JSON.stringify({ type: 'proof', proof })}\n`)
        }
        newline = buffer.indexOf('\n')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    port: (server.address() as AddressInfo).port,
    received: () => received,
  }
}

function writeStaleDescriptor(
  identity: string,
  version: 1 | 2,
  port: number,
): string {
  const descriptorPath = getTerminalBrokerDescriptorPath(identity)
  writeFileSync(
    descriptorPath,
    JSON.stringify({
      version,
      port,
      token: STALE_TOKEN,
      // Alive, but not a broker: it must be neither trusted nor signalled.
      pid: process.pid,
    }),
    { mode: 0o600 },
  )
  return descriptorPath
}

async function startSessionThroughStaleDescriptor(
  identity: string,
  descriptorPath: string,
  unique: string,
): Promise<void> {
  const ready = deferred<void>()
  const client = new TerminalSessionBrokerClient({
    identity,
    startupTimeoutMs: 5_000,
    connectTimeoutMs: 500,
  })
  try {
    client.start(
      `session-${unique}`,
      {
        command: '/bin/sh',
        args: ['-c', 'printf "SECRET_PROMPT_READY\\n"; while :; do sleep 1; done'],
        env: { ...process.env, TASKCHUTE_TEST_SECRET: 'do-not-leak' },
        stdinMode: 'pipe',
      },
      join(tmpdir(), `taskchute-broker-${unique}.log`),
      undefined,
      {
        onData: (data) => {
          if (data.includes('SECRET_PROMPT_READY')) ready.resolve()
        },
        onExit: (outcome) =>
          ready.reject(new Error(`Unexpected exit: ${outcome.status}`)),
        onUnavailable: () =>
          ready.reject(new Error('The replacement broker was unavailable')),
      },
    )
    await withTimeout(ready.promise)
    // The session runs on a fresh broker that wrote its own descriptor.
    const fresh = JSON.parse(readFileSync(descriptorPath, 'utf8')) as {
      version: number
      token: string
    }
    expect(fresh.version).toBe(2)
    expect(fresh.token).not.toBe(STALE_TOKEN)
  } finally {
    await client.shutdown().catch(() => undefined)
  }
}

function expectNothingButChallenges(received: string): void {
  expect(received).not.toContain(STALE_TOKEN)
  expect(received).not.toContain('do-not-leak')
  expect(received).not.toContain('SECRET_PROMPT')
  const frames = received.split('\n').filter((line) => line.length > 0)
  for (const frame of frames) {
    expect(Object.keys(JSON.parse(frame) as object).sort()).toEqual(['nonce', 'op'])
    expect((JSON.parse(frame) as { op: string }).op).toBe('prove')
  }
}

describePosix('TerminalSessionBrokerClient proves the broker (LEV-391)', () => {
  test('an impostor on the old port gets no token or frame, and a fresh broker takes over', async () => {
    const unique = `proof-impostor-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const impostor = await startImpostor('wrong-proof')
    const descriptorPath = writeStaleDescriptor(identity, 2, impostor.port)
    try {
      await startSessionThroughStaleDescriptor(identity, descriptorPath, unique)
      expect(impostor.received()).toContain('"op":"prove"')
      expectNothingButChallenges(impostor.received())
    } finally {
      await new Promise((resolve) => impostor.server.close(resolve))
      if (existsSync(descriptorPath)) rmSync(descriptorPath, { force: true })
    }
  })

  test('a broker from before the proof is never sent anything, and a fresh broker takes over', async () => {
    const unique = `proof-legacy-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const legacy = await startImpostor('legacy')
    const descriptorPath = writeStaleDescriptor(identity, 1, legacy.port)
    try {
      await startSessionThroughStaleDescriptor(identity, descriptorPath, unique)
      // A legacy broker cannot prove itself, so it is not even dialled.
      expect(legacy.received()).toBe('')
    } finally {
      await new Promise((resolve) => legacy.server.close(resolve))
      if (existsSync(descriptorPath)) rmSync(descriptorPath, { force: true })
    }
  })
})
