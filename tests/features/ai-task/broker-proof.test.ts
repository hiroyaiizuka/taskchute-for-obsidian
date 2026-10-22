import * as nodeCrypto from 'crypto'

import {
  challengeBroker,
  computeBrokerProof,
  isValidBrokerProof,
  UntrustedBrokerError,
} from '@/features/ai-task/services/BrokerProof'

const TOKEN = 'a'.repeat(64)
const NONCE = 'b'.repeat(64)

/** randomBytes is pinned so the test knows the nonce the client will send. */
const crypto = {
  createHmac: nodeCrypto.createHmac,
  randomBytes: () => ({ toString: () => NONCE }),
}

class FakeSocket {
  written: string[] = []
  private readonly listeners = new Map<string, Array<(arg?: unknown) => void>>()

  write(data: string): boolean {
    this.written.push(data)
    return true
  }

  on(event: string, listener: (arg?: never) => void): void {
    const list = this.listeners.get(event) ?? []
    list.push(listener as (arg?: unknown) => void)
    this.listeners.set(event, list)
  }

  emit(event: string, arg?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(arg)
  }
}

function setup() {
  const socket = new FakeSocket()
  const events: string[] = []
  const errors: Error[] = []
  challengeBroker(socket, TOKEN, crypto, {
    verified: () => events.push('verified'),
    data: (chunk) => events.push(`data:${chunk}`),
    rejected: (error) => errors.push(error),
  })
  return { socket, events, errors }
}

const proofLine = (token = TOKEN): string =>
  `${JSON.stringify({ type: 'proof', proof: computeBrokerProof(crypto, token, NONCE) })}\n`

describe('BrokerProof', () => {
  test('the challenge carries only a nonce, never the token', () => {
    const { socket } = setup()
    socket.emit('connect')
    expect(socket.written).toEqual([`${JSON.stringify({ op: 'prove', nonce: NONCE })}\n`])
    expect(socket.written.join('')).not.toContain(TOKEN)
  })

  test('a correct proof verifies, and frames after it in the same chunk pass through', () => {
    const { socket, events, errors } = setup()
    socket.emit('connect')
    socket.emit('data', `${proofLine()}{"type":"data"}\n`)
    expect(events).toEqual(['verified', 'data:{"type":"data"}\n'])
    expect(errors).toEqual([])
  })

  test('a proof split across chunks still verifies', () => {
    const { socket, events } = setup()
    const line = proofLine()
    socket.emit('data', line.slice(0, 20))
    expect(events).toEqual([])
    socket.emit('data', line.slice(20))
    expect(events).toEqual(['verified'])
  })

  test.each([
    ['made with another key', proofLine('c'.repeat(64))],
    ['not a proof frame', `${JSON.stringify({ type: 'attached', sessionId: 'x' })}\n`],
    ['not JSON', 'hello\n'],
    ['uppercase hex', `${JSON.stringify({ type: 'proof', proof: computeBrokerProof(crypto, TOKEN, NONCE).toUpperCase() })}\n`],
  ])('an answer %s is rejected and nothing is passed on', (_name, line) => {
    const { socket, events, errors } = setup()
    socket.emit('data', `${line}{"type":"data"}\n`)
    socket.emit('data', '{"type":"data"}\n')
    expect(events).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(UntrustedBrokerError)
  })

  test('an endless line before any proof is rejected', () => {
    const { socket, errors } = setup()
    socket.emit('data', 'x'.repeat(2048))
    expect(errors).toHaveLength(1)
  })

  test('the proof is bound to the nonce', () => {
    const line = proofLine()
    expect(isValidBrokerProof(crypto, TOKEN, NONCE, line.trim())).toBe(true)
    expect(isValidBrokerProof(crypto, TOKEN, 'd'.repeat(64), line.trim())).toBe(false)
  })
})
