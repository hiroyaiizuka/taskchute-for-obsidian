import { createHmac } from 'crypto'
import { readdirSync } from 'fs'
import type { Socket } from 'net'
import { basename, dirname, join } from 'path'

import { BROKER_PROOF_PREFIX } from '@/features/ai-task/services/BrokerProof'

/**
 * Helpers the two broker integration suites both need.
 *
 * They were duplicated per file, with divergent timeouts (8s in one, 15s in the
 * other) for the same kind of wait. Every use is either a poll loop or a wait on
 * a real process, and neither becomes more correct by giving up sooner, so they
 * share one number here.
 */
export const BROKER_TEST_TIMEOUT_MS = 20_000

/** Interval for the poll loops below. */
const POLL_INTERVAL_MS = 25

export function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs = BROKER_TEST_TIMEOUT_MS,
  label = 'Broker integration test',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${String(timeoutMs)}ms`)),
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

/**
 * Poll until `predicate` holds. `describe` is folded into the timeout message,
 * because "condition timed out" tells whoever reads the CI log nothing about
 * which condition, and these all fail on a loaded runner eventually.
 */
export async function waitUntil(
  predicate: () => boolean,
  describeCondition: string,
  timeoutMs = BROKER_TEST_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(
    `Timed out after ${String(timeoutMs)}ms waiting until ${describeCondition}`,
  )
}

/** Whether a pid is still signalable by this process. */
export function isAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Poll until every pid is gone, naming the survivors when it times out. */
export async function waitUntilAllGone(
  pids: readonly number[],
  timeoutMs = BROKER_TEST_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let surviving = pids.filter(isAlive)
  while (Date.now() < deadline && surviving.length > 0) {
    await sleep(POLL_INTERVAL_MS)
    surviving = pids.filter(isAlive)
  }
  if (surviving.length > 0) {
    throw new Error(
      `Timed out after ${String(timeoutMs)}ms; still alive: ${surviving.join(', ')}`,
    )
  }
}

export function ownerPidFiles(descriptorPath: string): string[] {
  const directory = dirname(descriptorPath)
  const prefix = `${basename(descriptorPath)}.owner-`
  return readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.jsonl'))
    .map((name) => join(directory, name))
}

/**
 * Make a fake broker answer the client's proof challenge (LEV-391), the way the
 * real broker does, and hide the challenge from the fake's own frame parser.
 * Call it first thing in the fake's connection listener.
 */
export function answerBrokerProof(socket: Socket, token: string): void {
  const emit = socket.emit.bind(socket) as (event: string, ...args: unknown[]) => boolean
  let pending = ''
  let answered = false
  socket.emit = ((event: string, ...args: unknown[]): boolean => {
    if (event !== 'data' || answered) return emit(event, ...args)
    pending += String(args[0])
    const newline = pending.indexOf('\n')
    if (newline < 0) return true
    answered = true
    const line = pending.slice(0, newline)
    const rest = pending.slice(newline + 1)
    pending = ''
    let challenge: { op?: unknown; nonce?: unknown } = {}
    try {
      challenge = JSON.parse(line) as { op?: unknown; nonce?: unknown }
    } catch {
      // Not a challenge: hand it to the fake untouched below.
    }
    if (challenge.op !== 'prove' || typeof challenge.nonce !== 'string') {
      return emit('data', Buffer.from(`${line}\n${rest}`))
    }
    const proof = createHmac('sha256', token)
      .update(`${BROKER_PROOF_PREFIX}${challenge.nonce}`)
      .digest('hex')
    socket.write(`${JSON.stringify({ type: 'proof', proof })}\n`)
    if (rest.length > 0) emit('data', Buffer.from(rest))
    return true
  }) as typeof socket.emit
}
