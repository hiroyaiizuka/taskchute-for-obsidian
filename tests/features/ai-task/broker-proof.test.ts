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
  private readonly listeners = new Map<string, Array<(chunk: string) => void>>()

  write(data: string): boolean {
    this.written.push(data)
    return true
  }

  on(event: string, listener: (chunk: string) => void): void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
  }

  emit(event: string, chunk = ''): void {
    for (const listener of this.listeners.get(event) ?? []) listener(chunk)
  }
}

/** Timers the test fires by hand. */
class FakeTimers {
  private next = 0
  readonly pending = new Map<number, () => void>()
  setTimeout = (callback: () => void): number => {
    this.next += 1
    this.pending.set(this.next, callback)
    return this.next
  }
  clearTimeout = (id: number): void => {
    this.pending.delete(id)
  }
  fire(): void {
    const callbacks = Array.from(this.pending.values())
    this.pending.clear()
    for (const callback of callbacks) callback()
  }
}

function setup() {
  const socket = new FakeSocket()
  const timers = new FakeTimers()
  const events: string[] = []
  const errors: Error[] = []
  challengeBroker(socket, TOKEN, crypto, {
    deadlineMs: 700,
    timers,
    verified: () => events.push('verified'),
    data: (chunk) => events.push(`data:${chunk}`),
    rejected: (error) => errors.push(error),
  })
  return { socket, timers, events, errors }
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

  test('an oversized proof is rejected even when its newline arrives with it', () => {
    const { socket, events, errors } = setup()
    const padded = `{"type":"proof",${' '.repeat(2048)}"proof":"${computeBrokerProof(crypto, TOKEN, NONCE)}"}\n`
    socket.emit('data', padded)
    expect(events).toEqual([])
    expect(errors[0]).toBeInstanceOf(UntrustedBrokerError)
  })

  test('a peer trickling bytes cannot outlast the deadline', () => {
    const { socket, timers, events, errors } = setup()
    socket.emit('connect')
    socket.emit('data', '{')
    socket.emit('data', '"')
    timers.fire()
    socket.emit('data', proofLine())
    expect(events).toEqual([])
    expect(errors).toHaveLength(1)
    // Not answering in time is not proof of an impostor: our broker may only be stalled.
    expect(errors[0]).not.toBeInstanceOf(UntrustedBrokerError)
  })

  test('the deadline is cleared once the proof checks out, or the socket closes', () => {
    const verified = setup()
    verified.socket.emit('data', proofLine())
    expect(verified.timers.pending.size).toBe(0)
    const closed = setup()
    closed.socket.emit('close')
    expect(closed.timers.pending.size).toBe(0)
  })

  test('the proof is bound to the nonce', () => {
    const line = proofLine()
    expect(isValidBrokerProof(crypto, TOKEN, NONCE, line.trim())).toBe(true)
    expect(isValidBrokerProof(crypto, TOKEN, 'd'.repeat(64), line.trim())).toBe(false)
  })
})
