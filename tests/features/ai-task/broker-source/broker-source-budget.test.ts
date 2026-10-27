import { Script } from 'vm'
import { gunzipSync } from 'zlib'

import {
  gzipBase64,
  INFLATE_PROGRAM_SOURCE,
} from '@/features/ai-task/services/broker-source/EmbeddedProgramSource'
import {
  PROGRAM_PIPE_LOADER_SOURCE,
  programPipeLoader,
} from '@/features/ai-task/services/broker-source/ProgramPipeLoaderSource'
import { buildTerminalBrokerSource } from '@/features/ai-task/services/TerminalSessionBrokerSource'
import { TERMINAL_SESSION_GUARD_SOURCE } from '@/features/ai-task/services/TerminalSessionGuardSource'
import { TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE } from '@/features/ai-task/services/TerminalSessionOwnerWatchdogSource'

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
 * Because the guard and watchdog reach the broker compressed, roughly 3KB of
 * growth in either of them costs the broker 1KB.
 *
 * The broker sat ~1KB under this budget (October 2026) until LEV-404 began
 * dropping whole-line comments from all three programs (stripCommentLines):
 * it now sits ~16KB under. Before that, LEV-379, LEV-378 and LEV-400 had to
 * move comments out of the broker template into the "Note A…Z" block beside
 * buildTerminalBrokerSource (and the notes above TerminalBrokerPureSource) to
 * fit; those blocks still keep the templates readable. Anything approaching
 * this budget again should move code, not comments, rather than raise it:
 * comments no longer ship.
 */
const PROGRAM_BUDGET = 120_000

describe('broker program size budget', () => {
  test.each([
    ['broker', buildTerminalBrokerSource()],
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
    expect(buildTerminalBrokerSource()).toContain(gzipBase64(source))
    expect(buildTerminalBrokerSource()).not.toContain(JSON.stringify(source))
  })

  test('the broker defines the inflater before it is called', () => {
    expect(buildTerminalBrokerSource()).toContain(INFLATE_PROGRAM_SOURCE)
    expect(buildTerminalBrokerSource().indexOf(INFLATE_PROGRAM_SOURCE)).toBeLessThan(
      buildTerminalBrokerSource().indexOf('inflateProgram('.concat('"')),
    )
  })
})

/**
 * stripCommentLines treats every line that starts with `//` as a comment. That
 * holds only while no program has a string spanning lines; a backtick or a
 * trailing backslash would let a `//` line be string content.
 */
describe('comment stripping', () => {
  test.each([
    ['broker', buildTerminalBrokerSource()],
    ['session guard', TERMINAL_SESSION_GUARD_SOURCE],
    ['owner watchdog', TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE],
  ])('the %s program has no string that spans lines, and ships no comment line', (_name, source) => {
    expect(source).not.toContain('`')
    expect(source.split('\n').filter((line) => line.endsWith('\\'))).toEqual([])
    expect(source.split('\n').filter((line) => /^\s*\/\//u.test(line))).toEqual([])
  })
})

describe('program syntax', () => {
  test.each([
    ['broker', buildTerminalBrokerSource()],
    ['session guard', TERMINAL_SESSION_GUARD_SOURCE],
    ['owner watchdog', TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE],
  ])('the composed %s program parses', (_name, source) => {
    // These programs are assembled from spliced fragments, so a name declared
    // twice or a fragment landing inside a template literal is a SyntaxError
    // that node reports only at spawn time — with the terminal simply never
    // appearing and nothing written to any log.
    expect(() => new Script(source)).not.toThrow()
  })

  test.each([
    ['broker', buildTerminalBrokerSource()],
    ['session guard', TERMINAL_SESSION_GUARD_SOURCE],
    ['owner watchdog', TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE],
  ])('the %s program also parses as the body the Windows loader runs it in', (_name, source) => {
    expect(() => new Script(`(function (require, module, exports) {${source}\n})`)).not.toThrow()
  })
})

/**
 * Windows caps a whole command line at 32,767 characters, and none of the
 * three programs fits. There the `-e` argument is a short loader and the
 * program arrives through a pipe (ProgramPipeLoaderSource).
 */
describe('Windows command line', () => {
  const WINDOWS_COMMAND_LINE_MAX = 32_767

  test.each([0, 3, 4])('the loader for fd %i is a small fraction of the limit and parses', (fd) => {
    const loader = programPipeLoader(fd)

    expect(loader.length).toBeLessThan(WINDOWS_COMMAND_LINE_MAX / 50)
    expect(loader).toContain(`fd:${fd},`)
    expect(() => new Script(loader)).not.toThrow()
  })

  test('the broker starts the watchdog on fd 3 and the guard on fd 4 through the same loader', () => {
    const broker = buildTerminalBrokerSource()

    expect(broker).toContain(PROGRAM_PIPE_LOADER_SOURCE)
    expect(broker).toContain("programPipeLoader(3) : ownerWatchdogProgram")
    expect(broker).toContain("programPipeLoader(4) : sessionGuardProgram")
    expect(broker.indexOf(PROGRAM_PIPE_LOADER_SOURCE)).toBeLessThan(broker.indexOf('programPipeLoader(3)'))
  })
})
