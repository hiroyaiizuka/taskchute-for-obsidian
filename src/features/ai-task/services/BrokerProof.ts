/**
 * Proof that whoever answers on the broker's port is our broker (LEV-391).
 *
 * The descriptor tells the plugin which localhost port to dial. If the broker
 * has died, another user on the same machine can take that port. The plugin
 * must not hand the token, environment, prompts or keystrokes to that impostor.
 *
 * So before sending anything else, the client sends a fresh random nonce. The
 * broker answers with HMAC(token, nonce). Only a holder of the token can answer,
 * and the token itself never crosses the wire before the answer checks out.
 */

export const BROKER_PROOF_PREFIX = 'taskchute-broker-proof:'

const HEX_64 = /^[a-f0-9]{64}$/u
// The proof line is ~90 bytes. Anything longer before it is not our broker.
const MAX_PROOF_LINE_BYTES = 1024

/**
 * The peer answered, and the answer was wrong (or malformed). Unlike a refused
 * or dropped connection, this is conclusive: the descriptor no longer points
 * at our broker.
 */
export class UntrustedBrokerError extends Error {
  constructor(reason: string) {
    super(`Terminal broker is not trusted: ${reason}`)
    this.name = 'UntrustedBrokerError'
  }
}

export interface BrokerProofCrypto {
  createHmac(
    algorithm: string,
    key: string,
  ): { update(value: string): { digest(encoding: 'hex'): string } }
  randomBytes(size: number): { toString(encoding: string): string }
}

export interface BrokerProofSocket {
  write(data: string): boolean
  on(event: 'connect', listener: () => void): void
  on(event: 'data', listener: (chunk: string) => void): void
}

export interface BrokerProofHandlers {
  /** The peer proved it holds the token. Safe to send authenticated frames. */
  verified(): void
  /** Frames that arrive after the proof. Never called before `verified`. */
  data(chunk: string): void
  /** The peer could not prove it holds the token. Send nothing more. */
  rejected(error: UntrustedBrokerError): void
}

export function computeBrokerProof(
  crypto: BrokerProofCrypto,
  token: string,
  nonce: string,
): string {
  return crypto
    .createHmac('sha256', token)
    .update(`${BROKER_PROOF_PREFIX}${nonce}`)
    .digest('hex')
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i)
  }
  return diff === 0
}

export function isValidBrokerProof(
  crypto: BrokerProofCrypto,
  token: string,
  nonce: string,
  line: string,
): boolean {
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    return false
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return false
  }
  const { type, proof } = message as Record<string, unknown>
  if (type !== 'proof' || typeof proof !== 'string' || !HEX_64.test(proof)) {
    return false
  }
  return constantTimeEqual(proof, computeBrokerProof(crypto, token, nonce))
}

/**
 * Challenge the peer as soon as the socket connects, and hold back every
 * caller-visible event until the peer has answered correctly.
 *
 * Callers register their own `close`, `error` and `timeout` handling; a peer
 * that hangs up or stalls before answering is caught there.
 */
export function challengeBroker(
  socket: BrokerProofSocket,
  token: string,
  crypto: BrokerProofCrypto,
  handlers: BrokerProofHandlers,
): void {
  const nonce = crypto.randomBytes(32).toString('hex')
  let state: 'waiting' | 'verified' | 'rejected' = 'waiting'
  let pending = ''
  const reject = (reason: string): void => {
    state = 'rejected'
    pending = ''
    handlers.rejected(new UntrustedBrokerError(reason))
  }
  socket.on('connect', () => {
    socket.write(`${JSON.stringify({ op: 'prove', nonce })}\n`)
  })
  socket.on('data', (chunk) => {
    if (state === 'verified') {
      handlers.data(chunk)
      return
    }
    if (state === 'rejected') return
    pending += chunk
    const newline = pending.indexOf('\n')
    if (newline < 0) {
      if (pending.length > MAX_PROOF_LINE_BYTES) reject('the proof is too long')
      return
    }
    const line = pending.slice(0, newline)
    const rest = pending.slice(newline + 1)
    pending = ''
    if (!isValidBrokerProof(crypto, token, nonce, line)) {
      reject('it could not prove it holds the token')
      return
    }
    state = 'verified'
    handlers.verified()
    if (rest.length > 0) handlers.data(rest)
  })
}
