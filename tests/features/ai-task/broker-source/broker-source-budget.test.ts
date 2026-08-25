import { gunzipSync } from 'zlib'

import {
  gzipBase64,
  INFLATE_PROGRAM_SOURCE,
} from '../../../../src/features/ai-task/services/broker-source/EmbeddedProgramSource'
import { TERMINAL_BROKER_SOURCE } from '../../../../src/features/ai-task/services/TerminalSessionBrokerSource'
import { TERMINAL_SESSION_GUARD_SOURCE } from '../../../../src/features/ai-task/services/TerminalSessionGuardSource'
import { TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE } from '../../../../src/features/ai-task/services/TerminalSessionOwnerWatchdogSource'

/**
 * Every one of these programs ships as the single `-e` argument of a spawned
 * node, and Linux rejects an execve whose individual argv string exceeds
 * MAX_ARG_STRLEN — 32 * PAGE_SIZE, i.e. 131_072 bytes on every runner and
 * desktop that matters. Past that the broker does not misbehave, it never
 * starts: spawn fails with E2BIG and the terminal is simply unavailable.
 *
 * macOS has no per-argument cap (only a ~1MB total ARG_MAX), so nothing on a
 * developer machine reports this. The broker reached 99.9% of the limit before
 * anyone measured it. That is what this file exists to stop.
 */
const MAX_ARG_STRLEN = 32 * 4096

/**
 * Deliberately below the hard limit. A program that has crept to within a few
 * hundred bytes is already broken for the next person who adds a feature, so
 * the budget has to fail while there is still room to land a fix.
 *
 * ~11KB of cushion. Because the guard and watchdog reach the broker compressed,
 * roughly 3KB of growth in either of them costs the broker 1KB, so this covers
 * a substantial feature in any of the three before anyone has to think about
 * the transport again.
 */
const PROGRAM_BUDGET = 120_000

describe('broker program size budget', () => {
  test.each([
    ['broker', TERMINAL_BROKER_SOURCE],
    ['session guard', TERMINAL_SESSION_GUARD_SOURCE],
    ['owner watchdog', TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE],
  ])('the %s program fits in one Linux execve argument', (_name, source) => {
    expect(Buffer.byteLength(source, 'utf8')).toBeLessThan(PROGRAM_BUDGET)
  })

  test('the budget leaves real headroom under the kernel limit', () => {
    expect(PROGRAM_BUDGET).toBeLessThan(MAX_ARG_STRLEN)
  })
})

describe('compressed program transport', () => {
  test.each([
    ['session guard', TERMINAL_SESSION_GUARD_SOURCE],
    ['owner watchdog', TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE],
  ])('the %s program survives the gzip round trip', (_name, source) => {
    const encoded = gzipBase64(source)

    expect(gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8')).toBe(
      source,
    )
  })

  test('encoding the same program twice yields the same text', () => {
    // The encoded text is embedded in the broker program, so a non-deterministic
    // encoder would make the program's bytes — and this file's budget — drift
    // between runs.
    expect(gzipBase64(TERMINAL_SESSION_GUARD_SOURCE)).toBe(
      gzipBase64(TERMINAL_SESSION_GUARD_SOURCE),
    )
  })

  test.each([
    ['owner watchdog', TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE],
    ['session guard', TERMINAL_SESSION_GUARD_SOURCE],
  ])('the broker carries the %s program compressed, not inline', (_name, source) => {
    expect(TERMINAL_BROKER_SOURCE).toContain(gzipBase64(source))
    expect(TERMINAL_BROKER_SOURCE).not.toContain(JSON.stringify(source))
  })

  test('the broker defines the inflater before it is called', () => {
    expect(TERMINAL_BROKER_SOURCE).toContain(INFLATE_PROGRAM_SOURCE)
    expect(TERMINAL_BROKER_SOURCE.indexOf(INFLATE_PROGRAM_SOURCE)).toBeLessThan(
      TERMINAL_BROKER_SOURCE.indexOf('inflateProgram('.concat('"')),
    )
  })
})
