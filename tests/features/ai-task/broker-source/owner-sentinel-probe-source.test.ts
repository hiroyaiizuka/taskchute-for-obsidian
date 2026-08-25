import { execFileSync } from 'child_process'
import { closeSync, mkdtempSync, openSync, realpathSync, symlinkSync, writeFileSync } from 'fs'
import * as fs from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createContext, runInContext } from 'vm'

import { OWNER_SENTINEL_PROBE_SOURCE } from '../../../../src/features/ai-task/services/broker-source/OwnerSentinelProbeSource'
import { TERMINAL_BROKER_SOURCE } from '../../../../src/features/ai-task/services/TerminalSessionBrokerSource'
import { TERMINAL_SESSION_GUARD_SOURCE } from '../../../../src/features/ai-task/services/TerminalSessionGuardSource'
import { TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE } from '../../../../src/features/ai-task/services/TerminalSessionOwnerWatchdogSource'

/**
 * The one place the three programs branch on the host OS.
 *
 * Two kinds of test live here, and the split is the point:
 *
 * - Branch tests run against a fabricated `process`, `fs` and `cp`, so the
 *   Linux `/proc` branch is exercised from a macOS checkout and the macOS
 *   `lsof` branch from a Linux runner. Neither was reachable before.
 * - One conformance test per platform runs the real branch against the live
 *   kernel, using this very test process as the subject. It is the only OS-level
 *   claim being made — "a descriptor this process holds can be named" — and it
 *   needs no spawn, no signal and no waiting.
 */
type Reading = { path: string } | string

type Identity = {
  sentinelFd: number | null
  sentinelPath: string | null
}

type Probe = {
  canonicalSentinelPath: (value: string) => string
  probeSentinelState: (pid: number, identity: Identity | null) => string
  readSentinelFdPath: (pid: number, fd: number) => Reading
  resolveUnprovenSentinel: (
    identity: (Identity & { commandHint?: string | null }) | null,
    entry: { command?: unknown } | null,
  ) => string
  sentinelStateFrom: (identity: Identity | null, reading: Reading) => string
}

const errorWith = (fields: Record<string, unknown>): Error =>
  Object.assign(new Error('probe failed'), fields)

const probeFor = (
  platform: string,
  overrides: { fs?: Record<string, unknown>; cp?: Record<string, unknown> } = {},
): Probe => {
  const context = createContext({
    Number,
    String,
    process: { platform, env: {} },
    fs: { realpathSync: (value: string) => value, ...overrides.fs },
    cp: { ...overrides.cp },
  })
  runInContext(OWNER_SENTINEL_PROBE_SOURCE, context)
  return context as unknown as Probe
}

const hostProbe = (): Probe => {
  const context = createContext({ Number, String, process, fs, cp: { execFileSync } })
  runInContext(OWNER_SENTINEL_PROBE_SOURCE, context)
  return context as unknown as Probe
}

const identityOf = (path: string): Identity => ({
  sentinelFd: 9,
  sentinelPath: path,
})

const PROGRAMS = [
  ['broker', TERMINAL_BROKER_SOURCE],
  ['session guard', TERMINAL_SESSION_GUARD_SOURCE],
  ['owner watchdog', TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE],
] as const

describe('sentinel probe fragment composition', () => {
  test.each(PROGRAMS)(
    'the shipped %s program embeds the fragment verbatim',
    (_name, source) => {
      expect(source).toContain(OWNER_SENTINEL_PROBE_SOURCE)
    },
  )

  test.each(PROGRAMS)('%s keeps no private copy of the probe', (_name, source) => {
    const outsideFragment = source.replace(OWNER_SENTINEL_PROBE_SOURCE, '')

    expect(outsideFragment).not.toMatch(
      /function\s+(?:canonicalSentinelPath|sentinelState)\b/u,
    )
    // The /proc path and the lsof argv are the branch itself. A second one
    // anywhere is a copy that will not be fixed when this one is.
    expect(outsideFragment).not.toContain("'/proc/'")
    expect(outsideFragment).not.toContain('/usr/sbin/lsof')
  })

  // Every program that authenticates a process by its descriptor has to have
  // somewhere to go when the descriptor cannot be read. A program that splices
  // the probe but never reaches the fallback is the bug this fragment exists to
  // remove, and it is invisible from the fragment's own tests.
  test.each(PROGRAMS)('%s resolves an unreadable descriptor', (_name, source) => {
    const outsideFragment = source.replace(OWNER_SENTINEL_PROBE_SOURCE, '')

    expect(outsideFragment).toContain('resolveUnprovenSentinel(')
    expect(outsideFragment).toContain('probeSentinelState(')
  })
})

describe('readSentinelFdPath on linux', () => {
  test('names the descriptor from /proc', () => {
    const readlinkSync = jest.fn().mockReturnValue('/tmp/owner.jsonl')

    expect(probeFor('linux', { fs: { readlinkSync } }).readSentinelFdPath(42, 9)).toEqual(
      { path: '/tmp/owner.jsonl' },
    )
    expect(readlinkSync).toHaveBeenCalledWith('/proc/42/fd/9')
  })

  test('reads ENOENT as the kernel answering that the descriptor is gone', () => {
    const readlinkSync = () => {
      throw errorWith({ code: 'ENOENT' })
    }

    expect(probeFor('linux', { fs: { readlinkSync } }).readSentinelFdPath(42, 9)).toBe(
      'missing',
    )
  })

  // The failure this whole refactor was chasing: a /proc that will not answer
  // is not a descriptor that is gone.
  test.each([['EACCES'], ['EPERM'], [undefined]])(
    'reads %s as the probe being unavailable',
    (code) => {
      const readlinkSync = () => {
        throw errorWith({ code })
      }

      expect(
        probeFor('linux', { fs: { readlinkSync } }).readSentinelFdPath(42, 9),
      ).toBe('unreadable')
    },
  )
})

describe('readSentinelFdPath on darwin', () => {
  const lsofReturning = (output: string): jest.Mock => jest.fn().mockReturnValue(output)

  test('names the descriptor from the lsof name field', () => {
    const execFile = lsofReturning('p4242\nf9\nn/tmp/owner.jsonl\n')

    expect(
      probeFor('darwin', { cp: { execFileSync: execFile } }).readSentinelFdPath(42, 9),
    ).toEqual({ path: '/tmp/owner.jsonl' })
    expect(execFile).toHaveBeenCalledWith(
      '/usr/sbin/lsof',
      ['-a', '-p', '42', '-d', '9', '-Fn'],
      expect.objectContaining({ encoding: 'utf8' }),
    )
  })

  test('reads output without a name field as no such descriptor', () => {
    expect(
      probeFor('darwin', {
        cp: { execFileSync: lsofReturning('p4242\nf9\n') },
      }).readSentinelFdPath(42, 9),
    ).toBe('missing')
  })

  test('reads exit status 1 as lsof answering that nothing matched', () => {
    const execFileSync = () => {
      throw errorWith({ status: 1 })
    }

    expect(
      probeFor('darwin', { cp: { execFileSync } }).readSentinelFdPath(42, 9),
    ).toBe('missing')
  })

  test('reads a missing lsof as the probe being unavailable, not as an answer', () => {
    const execFileSync = () => {
      throw errorWith({ code: 'ENOENT' })
    }

    expect(
      probeFor('darwin', { cp: { execFileSync } }).readSentinelFdPath(42, 9),
    ).toBe('unreadable')
  })
})

describe('readSentinelFdPath under the test override', () => {
  test('reports the probe unavailable on any platform', () => {
    const context = createContext({
      Number,
      String,
      process: {
        platform: 'linux',
        env: { TASKCHUTE_OWNER_SENTINEL_TEST_UNREADABLE: '1' },
      },
      fs: { readlinkSync: () => '/tmp/owner.jsonl' },
      cp: {},
    })
    runInContext(OWNER_SENTINEL_PROBE_SOURCE, context)

    expect((context as unknown as Probe).readSentinelFdPath(42, 9)).toBe(
      'unreadable',
    )
  })
})

describe('readSentinelFdPath elsewhere', () => {
  test.each([['win32'], ['freebsd']])('has no probe on %s', (platform) => {
    expect(probeFor(platform).readSentinelFdPath(42, 9)).toBe('unsupported')
  })
})

describe('sentinelStateFrom', () => {
  const probe = probeFor('linux')

  test.each([
    ['the same path', { path: '/tmp/owner.jsonl' }, 'match'],
    ['another session\'s path', { path: '/tmp/other.jsonl' }, 'mismatch'],
    ['no such descriptor', 'missing', 'mismatch'],
    ['an unavailable probe', 'unreadable', 'unreadable'],
    ['a platform without a probe', 'unsupported', 'unknown'],
  ])('reads %s as %s', (_name, reading, expected) => {
    expect(
      probe.sentinelStateFrom(identityOf('/tmp/owner.jsonl'), reading as Reading),
    ).toBe(expected)
  })

  test('a deleted descriptor still names the file it was opened on', () => {
    // Linux appends " (deleted)" once the path is unlinked, which happens as
    // soon as another actor cleans the session up underneath the watchdog.
    expect(
      probe.sentinelStateFrom(identityOf('/tmp/owner.jsonl'), {
        path: '/tmp/owner.jsonl (deleted)',
      }),
    ).toBe('match')
  })

  test.each([
    ['no descriptor was recorded', { sentinelFd: null, sentinelPath: '/tmp/owner.jsonl' }],
    ['no path was recorded', { sentinelFd: 9, sentinelPath: null }],
    ['there is no identity at all', null],
  ])('cannot judge when %s', (_name, identity) => {
    expect(
      probe.sentinelStateFrom(identity as Identity | null, { path: '/tmp/owner.jsonl' }),
    ).toBe('unknown')
  })

  test('resolves both sides before comparing them', () => {
    // /tmp is a symlink to /private/tmp on macOS: the recorded path and the
    // one the kernel reports are then the same file under two names.
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sentinel-')))
    const linked = join(directory, 'link')
    const file = join(directory, 'owner.jsonl')
    writeFileSync(file, '')
    symlinkSync(directory, linked)
    const real = hostProbe()

    expect(
      real.sentinelStateFrom(identityOf(file), { path: join(linked, 'owner.jsonl') }),
    ).toBe('match')
  })
})

describe('probeSentinelState', () => {
  const unreadableProbe = probeFor('linux', {
    fs: {
      readlinkSync: () => {
        throw errorWith({ code: 'EACCES' })
      },
    },
  })

  test('reports an unavailable probe as such, rather than as an absent descriptor', () => {
    expect(
      unreadableProbe.probeSentinelState(42, identityOf('/tmp/owner.jsonl')),
    ).toBe('unreadable')
  })

  test('never probes a record that carries no descriptor', () => {
    const readlinkSync = jest.fn()

    expect(
      probeFor('linux', { fs: { readlinkSync } }).probeSentinelState(42, {
        sentinelFd: null,
        sentinelPath: null,
      }),
    ).toBe('unknown')
    expect(readlinkSync).not.toHaveBeenCalled()
  })
})

/**
 * What all three programs do when the descriptor cannot be read.
 *
 * Every one of them used to answer "unproven", which meant the process was
 * neither signalled nor written off: the broker never confirmed its tree was
 * gone, and the watchdog retried forever, while the detached child they exist
 * to reap stayed alive. On Linux that is the normal case, not an exotic one —
 * `readlink /proc/<pid>/fd/<n>` returns EACCES for a sibling's descriptor.
 *
 * Absence of the probe is not evidence of non-ownership. What replaces it is
 * the corroboration the record already carries — and where it carries none,
 * "unknown" stays the answer, because guessing in that direction is what would
 * kill an unrelated process.
 */
describe('resolveUnprovenSentinel', () => {
  const probe = probeFor('linux')
  const withHint = { sentinelFd: 9, sentinelPath: '/tmp/owner.jsonl', commandHint: 'yes' }

  test('keeps a process whose command still matches the record', () => {
    expect(probe.resolveUnprovenSentinel(withHint, { command: '/usr/bin/yes' })).toBe(
      'match',
    )
  })

  test('disowns a pid now running something else', () => {
    // The same number, reused inside the recorded lstart second: the one case
    // the descriptor was there to catch.
    expect(probe.resolveUnprovenSentinel(withHint, { command: '/usr/bin/tail' })).toBe(
      'mismatch',
    )
  })

  /**
   * The invariant a fallback must not break. A record carrying nothing but a
   * PID and a birth second — the ambiguous legacy shape — authorizes neither
   * killing the process nor discarding the record: that pair is exactly what a
   * reused PID also matches. Corroboration is what upgrades it, and where there
   * is none, "unknown" is the answer, and the evidence is left in place for
   * whoever looks next.
   */
  test.each([
    ['no command hint was recorded', { sentinelFd: 9, sentinelPath: '/x' }, { command: 'yes' }],
    ['the process is absent from the snapshot', withHint, null],
    ['ps rendered no command for it', withHint, { command: undefined }],
    ['there is no identity at all', null, { command: 'yes' }],
  ])('refuses to decide when %s', (_name, identity, entry) => {
    expect(
      probe.resolveUnprovenSentinel(
        identity as Identity & { commandHint?: string | null },
        entry as { command?: unknown } | null,
      ),
    ).toBe('unknown')
  })
})

/**
 * The live-kernel half. Everything above proves the branch does what the OS is
 * documented to do; this proves the OS still does it.
 */
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe

describeOnPosix('conformance with the running kernel', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sentinel-host-')))
  const file = join(directory, 'owner-session-host.jsonl')
  let fd = -1

  beforeAll(() => {
    writeFileSync(file, '')
    fd = openSync(file, 'r')
  })

  afterAll(() => {
    if (fd >= 0) closeSync(fd)
  })

  test('a descriptor this process holds is named back', () => {
    const reading = hostProbe().readSentinelFdPath(process.pid, fd)

    expect(typeof reading === 'object' ? reading.path : reading).toBe(file)
  })

  test('the descriptor is recognised as this session, from the record alone', () => {
    expect(
      hostProbe().probeSentinelState(process.pid, {
        sentinelFd: fd,
        sentinelPath: file,
      }),
    ).toBe('match')
  })

  test('a descriptor this process does not hold is reported absent', () => {
    // Well above anything Jest opens, and closed by definition.
    expect(hostProbe().readSentinelFdPath(process.pid, 4000)).toBe('missing')
  })

  test('a pid that does not exist is reported absent', () => {
    expect(hostProbe().readSentinelFdPath(0x7ffffffe, fd)).toBe('missing')
  })
})
