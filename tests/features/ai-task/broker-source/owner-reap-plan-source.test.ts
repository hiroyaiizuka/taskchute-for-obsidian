import { createContext, runInContext } from 'vm'

import { OWNER_REAP_PLAN_SOURCE } from '../../../../src/features/ai-task/services/broker-source/OwnerReapPlanSource'
import { OWNER_SENTINEL_PROBE_SOURCE } from '../../../../src/features/ai-task/services/broker-source/OwnerSentinelProbeSource'
import { POSIX_PROCESS_SNAPSHOT_SOURCE } from '../../../../src/features/ai-task/services/broker-source/PosixProcessSnapshotSource'
import { TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE } from '../../../../src/features/ai-task/services/TerminalSessionOwnerWatchdogSource'
import { LSTART, LSTART_EPOCH_MS } from './psSnapshots'

/**
 * The watchdog's reap reasoning, exercised as the pure function it now is.
 *
 * Until this existed the only way to reach any of it was to start a broker,
 * SIGKILL it, and inspect what the OS had left behind twenty seconds later —
 * four integration tests that spawned real processes, could only run one
 * platform's branch per checkout, and reported "something survived" without
 * saying which piece of evidence the watchdog had been unable to obtain.
 *
 * Here the evidence is the input.
 */
type Identity = {
  lower: number
  upper: number
  kind: string
  guardToken?: string | null
  processGroup?: number | null
  commandHint?: string | null
  sentinelFd?: number | null
  sentinelPath?: string | null
}

type Entry = {
  ppid: number
  pgid: number
  startedAt: number | null
  command: string
}

type Verdict = { state: string; reason: string }

const context = createContext({
  JSON,
  Map,
  Set,
  Date,
  Math,
  Number,
  String,
  // The fallback the planner reaches for lives with the probe it interprets,
  // because the broker and the guard need it too. It is spliced beside this
  // fragment in the shipped program, so it is spliced beside it here.
  process: { platform: 'linux' },
  fs: { realpathSync: (value: string) => value },
  cp: {},
})
runInContext(POSIX_PROCESS_SNAPSHOT_SOURCE, context)
runInContext(OWNER_SENTINEL_PROBE_SOURCE, context)
runInContext(OWNER_REAP_PLAN_SOURCE, context)

const plan = context as unknown as {
  applyOwnerFileText: (
    active: Map<number, Identity>,
    text: string,
    ownerFile: string,
  ) => boolean
  classifyOwnedPid: (input: Record<string, unknown>) => Verdict
  classifyOwnedPids: (input: Record<string, unknown>) => {
    states: Map<number, Verdict>
    needSentinel: number[]
  }
  planReapRoots: (
    states: Map<number, Verdict>,
    active: Map<number, Identity>,
  ) => { roots: Map<number, Identity>; unknown: boolean; sessionGuardAlive: boolean }
  planReapSignals: (
    states: Map<number, Verdict>,
    expanded: Map<number, Identity | null>,
    context: {
      snapshot: Map<number, Entry> | null
      selfPid: number
      brokerPid: number
    },
  ) => { kill: { pid: number; target: string }[]; unknown: boolean }
  planReapOutcome: (summary: {
    matching: number
    unknown: boolean
    sessionGuardAlive: boolean
    trustworthy: boolean
  }) => string
  reapRetryDelayMs: (elapsedMs: number) => number
  resolveUnprovenSentinel: (
    identity: Identity | null,
    entry: Entry | null,
  ) => string
  signalTargetFor: (
    pid: number,
    entry: Entry | null,
    selfPid: number,
    brokerPid: number,
  ) => string
}

const OWNER_FILE = '/tmp/taskchute/owner-session-abc.jsonl'
const GUARD_TOKEN = 'a'.repeat(48)

const entryOf = (overrides: Partial<Entry> = {}): Entry => ({
  ppid: 1,
  pgid: 4242,
  startedAt: LSTART_EPOCH_MS,
  command: '/usr/bin/yes',
  ...overrides,
})

const identityOf = (overrides: Partial<Identity> = {}): Identity => ({
  lower: LSTART_EPOCH_MS,
  upper: LSTART_EPOCH_MS + 40,
  kind: 'process',
  guardToken: null,
  processGroup: 4242,
  commandHint: 'yes',
  sentinelFd: 9,
  sentinelPath: OWNER_FILE,
  ...overrides,
})

const classify = (overrides: Record<string, unknown> = {}): Verdict =>
  plan.classifyOwnedPid({
    platform: 'linux',
    identity: identityOf(),
    liveness: 'alive',
    entry: entryOf(),
    snapshotAvailable: true,
    windowsStartedAt: null,
    sentinel: 'match',
    ...overrides,
  })

describe('reap plan fragment composition', () => {
  test('the shipped watchdog program embeds the fragment verbatim', () => {
    expect(TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE).toContain(
      OWNER_REAP_PLAN_SOURCE,
    )
  })

  test('the fragment reaches no host facility, so it can be reasoned about alone', () => {
    // Comments stripped first: they discuss processes, ps and /proc in prose,
    // and the claim being made here is about the code.
    const code = OWNER_REAP_PLAN_SOURCE.replace(/^\s*\/\/.*$/gmu, '')

    expect(code).not.toMatch(/\b(?:require|__dirname|globalThis)\b/u)
    expect(code).not.toMatch(/\b(?:process|cp|fs|net)\s*\./u)
  })

  // `toContain` alone would still pass if the watchdog grew a second, private
  // copy beside the shared one, which is how the ownership checks drifted into
  // three subtly different versions before.
  test('the watchdog keeps no private copy of the reasoning', () => {
    const outsideFragment = TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE.replace(
      OWNER_REAP_PLAN_SOURCE,
      '',
    )

    expect(outsideFragment).not.toMatch(
      /function\s+(?:ownershipState|applyRecord|applyPartialRecord)\b/u,
    )
  })
})

describe('applyOwnerFileText', () => {
  test('keeps the last state of every recorded pid', () => {
    const active = new Map<number, Identity>()

    const valid = plan.applyOwnerFileText(
      active,
      [
        JSON.stringify({ pid: 11, startedAt: 1000, kind: 'process' }),
        JSON.stringify({ pid: 12, startedAt: 2000, kind: 'process' }),
        JSON.stringify({ pid: 11, startedAt: 1000, active: false }),
        '',
      ].join('\n'),
      OWNER_FILE,
    )

    expect(valid).toBe(true)
    expect(Array.from(active.keys())).toEqual([12])
  })

  test('a close record for a different birth never retires the live pid', () => {
    // PID reuse: the same number, recorded again after the first exited.
    const active = new Map<number, Identity>()

    plan.applyOwnerFileText(
      active,
      [
        JSON.stringify({ pid: 11, startedAt: 2000, kind: 'process' }),
        JSON.stringify({ pid: 11, startedAt: 1000, active: false }),
        '',
      ].join('\n'),
      OWNER_FILE,
    )

    expect(active.get(11)?.upper).toBe(2000)
  })

  test('a torn trailing record is honoured but never trusted', () => {
    const active = new Map<number, Identity>()

    // An append cut mid-line by the crash the watchdog is reacting to.
    const valid = plan.applyOwnerFileText(
      active,
      '{"pid":13,"startedAt":1000,"startedAtLower":9',
      OWNER_FILE,
    )

    expect(valid).toBe(false)
    expect(active.get(13)?.kind).toBe('unknown')
  })

  test('a sentinel path naming another session is dropped', () => {
    const active = new Map<number, Identity>()

    plan.applyOwnerFileText(
      active,
      `${JSON.stringify({
        pid: 14,
        startedAt: 1000,
        kind: 'process',
        sentinelFd: 9,
        sentinelPath: '/tmp/taskchute/owner-session-other.jsonl',
      })}\n`,
      OWNER_FILE,
    )

    expect(active.get(14)?.sentinelPath).toBeNull()
  })

  test('a guard record without a well-formed token cannot claim to be a guard', () => {
    const active = new Map<number, Identity>()

    plan.applyOwnerFileText(
      active,
      `${JSON.stringify({ pid: 15, startedAt: 1000, kind: 'guard' })}\n`,
      OWNER_FILE,
    )

    expect(active.get(15)?.kind).toBe('unknown')
  })
})

describe('classifyOwnedPid', () => {
  test('an exited pid is dead', () => {
    expect(classify({ liveness: 'dead' }).state).toBe('dead')
  })

  test('a kill(0) that failed for any other reason proves nothing', () => {
    expect(classify({ liveness: 'unknown' })).toEqual({
      state: 'unknown',
      reason: 'liveness',
    })
  })

  test.each([
    ['the ps snapshot could not be taken', { snapshotAvailable: false, entry: null }, 'no-snapshot'],
    ['the pid is missing from an otherwise good snapshot', { entry: null }, 'not-in-snapshot'],
  ])('%s is unknown, never proof of exit', (_name, overrides, reason) => {
    expect(classify(overrides)).toEqual({ state: 'unknown', reason })
  })

  test('a pid born outside the recorded window is someone else', () => {
    expect(
      classify({ entry: entryOf({ startedAt: LSTART_EPOCH_MS + 60_000 }) }),
    ).toEqual({ state: 'mismatch', reason: 'birth' })
  })

  test('a matching pid whose sentinel confirms it is owned', () => {
    expect(classify()).toEqual({ state: 'match', reason: 'verified' })
  })

  test('a sentinel the kernel says is absent disowns the pid', () => {
    expect(classify({ sentinel: 'mismatch' })).toEqual({
      state: 'mismatch',
      reason: 'sentinel',
    })
  })

  test('the sentinel is requested rather than assumed', () => {
    expect(classify({ sentinel: undefined }).state).toBe('needs-sentinel')
  })

  test('a guard whose command no longer carries its token is a reused pid', () => {
    expect(
      classify({
        identity: identityOf({ kind: 'guard', guardToken: GUARD_TOKEN }),
      }),
    ).toEqual({ state: 'mismatch', reason: 'guard-token' })
  })

  test('a guard is verified without a sentinel of its own', () => {
    expect(
      classify({
        identity: identityOf({ kind: 'guard', guardToken: GUARD_TOKEN }),
        entry: entryOf({ command: `node -e x ${GUARD_TOKEN}` }),
        sentinel: undefined,
      }),
    ).toEqual({ state: 'match', reason: 'verified' })
  })

  test.each([
    ['a foreign process group', { processGroup: 99 }],
    ['a command that does not start with the hint', { commandHint: 'sleep' }],
  ])('a tree-snapshot entry with %s is not owned', (_name, overrides) => {
    expect(
      classify({
        identity: identityOf({ kind: 'snapshot', ...overrides }),
        entry: entryOf({ command: 'yes' }),
        sentinel: undefined,
      }),
    ).toEqual({ state: 'mismatch', reason: 'snapshot-identity' })
  })

  test('windows decides on its birth time alone', () => {
    expect(
      classify({
        platform: 'win32',
        entry: null,
        snapshotAvailable: false,
        windowsStartedAt: LSTART_EPOCH_MS + 10,
        sentinel: undefined,
      }),
    ).toEqual({ state: 'match', reason: 'birth' })
  })
})

/**
 * The regression these tests exist for, and the reason there is no grace period.
 *
 * On Linux the watchdog cannot read a sibling's descriptor at all: measured in a
 * container, `readlink /proc/<pid>/fd/<n>` returns EACCES. Every such owner used
 * to classify as unproven, and an unproven owner is neither signalled nor
 * written off — so the process stayed alive and the session was never declared
 * clean. A grace period was then tried, and made it worse: the session guard
 * removes the owner records within ~100ms of the broker's death, so by the time
 * the grace expired the watchdog no longer had a record naming the process, and
 * it exited reporting success. The decision has to be made on the first round.
 */
describe('an unprovable sentinel', () => {
  const unreadable = (overrides: Record<string, unknown> = {}): Verdict =>
    classify({ sentinel: 'unreadable', ...overrides })

  test('is resolved on the first round, not waited out', () => {
    expect(unreadable()).toEqual({
      state: 'match',
      reason: 'sentinel-unreadable-resolved',
    })
  })

  test('names which of the two ways the descriptor was unavailable', () => {
    expect(unreadable({ sentinel: 'unknown' }).reason).toBe(
      'sentinel-unavailable-resolved',
    )
  })

  test('is disowned when the command contradicts the record', () => {
    // Same PID, born inside the same lstart second, running something else:
    // the only case the descriptor was there to catch.
    expect(
      unreadable({ entry: entryOf({ command: '/usr/bin/tail -f /dev/null' }) }),
    ).toEqual({ state: 'mismatch', reason: 'sentinel-unreadable-resolved' })
  })

  test('stays unknown when the record carries nothing to corroborate', () => {
    // Neither killed nor written off: an owner record that is only a PID and a
    // birth second is what a reused PID matches too, so both the process and
    // the evidence are left alone.
    expect(
      classify({
        sentinel: 'unreadable',
        identity: identityOf({ commandHint: null }),
      }),
    ).toEqual({ state: 'unknown', reason: 'sentinel-unreadable' })
  })
})

describe('classifyOwnedPids', () => {
  test('asks for a sentinel reading only where ownership still turns on one', () => {
    const first = plan.classifyOwnedPids({
      platform: 'linux',
      entries: [
        [10, identityOf()],
        [11, identityOf({ kind: 'guard', guardToken: GUARD_TOKEN })],
        [12, identityOf()],
      ],
      snapshot: new Map<number, Entry>([
        [10, entryOf()],
        [11, entryOf({ command: `node ${GUARD_TOKEN}` })],
      ]),
      liveness: new Map([[10, 'alive'], [11, 'alive'], [12, 'dead']]),
      windowsStartedAt: new Map(),
      sentinel: new Map(),
      elapsedMs: 0,
    })

    expect(first.needSentinel).toEqual([10])

    const second = plan.classifyOwnedPids({
      platform: 'linux',
      entries: [[10, identityOf()]],
      snapshot: new Map<number, Entry>([[10, entryOf()]]),
      liveness: new Map([[10, 'alive']]),
      windowsStartedAt: new Map(),
      sentinel: new Map([[10, 'match']]),
      elapsedMs: 0,
    })

    expect(second.needSentinel).toEqual([])
    expect(second.states.get(10)?.state).toBe('match')
  })
})

describe('planReapRoots', () => {
  const verdict = (state: string): Verdict => ({ state, reason: 'test' })

  test('only a verified root confers ownership on its children', () => {
    const active = new Map<number, Identity>([
      [10, identityOf()],
      [11, identityOf()],
    ])
    const states = new Map([[10, verdict('match')], [11, verdict('mismatch')]])

    expect(Array.from(plan.planReapRoots(states, active).roots.keys())).toEqual([
      10,
    ])
  })

  test('the session guard is never signalled from a reusable pid record', () => {
    const active = new Map<number, Identity>([
      [10, identityOf({ kind: 'guard', guardToken: GUARD_TOKEN })],
    ])
    const result = plan.planReapRoots(new Map([[10, verdict('match')]]), active)

    expect(result.roots.size).toBe(0)
    expect(result.sessionGuardAlive).toBe(true)
  })

  test('a live record that could not be authenticated blocks the clean exit', () => {
    const active = new Map<number, Identity>([[10, identityOf()]])

    expect(
      plan.planReapRoots(new Map([[10, verdict('unknown')]]), active).unknown,
    ).toBe(true)
  })

  test('a torn record is neither killed nor forgotten while it may be alive', () => {
    const active = new Map<number, Identity>([
      [10, identityOf({ kind: 'unknown' })],
    ])
    const result = plan.planReapRoots(new Map([[10, verdict('match')]]), active)

    expect(result.roots.size).toBe(0)
    expect(result.unknown).toBe(true)
  })

  test('a torn record whose pid is gone stops blocking', () => {
    const active = new Map<number, Identity>([
      [10, identityOf({ kind: 'unknown' })],
    ])

    expect(
      plan.planReapRoots(new Map([[10, verdict('dead')]]), active).unknown,
    ).toBe(false)
  })
})

describe('planReapSignals', () => {
  const snapshot = new Map<number, Entry>([
    [10, entryOf({ pgid: 10 })],
    [11, entryOf({ pgid: 10 })],
  ])

  test('signals a group leader by group and a follower by pid', () => {
    const states = new Map([
      [10, { state: 'match', reason: 'test' }],
      [11, { state: 'match', reason: 'test' }],
    ])
    const expanded = new Map<number, Identity | null>([[10, null], [11, null]])

    expect(
      plan.planReapSignals(states, expanded, {
        snapshot,
        selfPid: 900,
        brokerPid: 901,
      }).kill,
    ).toEqual([
      { pid: 10, target: 'group' },
      { pid: 11, target: 'process' },
    ])
  })

  test.each([
    ['itself', 900],
    ['the broker it reports for', 901],
  ])('never signals %s', (_name, pid) => {
    expect(plan.signalTargetFor(pid, entryOf({ pgid: pid }), 900, 901)).toBe(
      'skip',
    )
  })
})

describe('planReapOutcome', () => {
  const summary = (overrides = {}) => ({
    matching: 0,
    unknown: false,
    sessionGuardAlive: false,
    trustworthy: true,
    ...overrides,
  })

  test('cleans up only once nothing owned is left and every record was read', () => {
    expect(plan.planReapOutcome(summary())).toBe('cleanup')
  })

  test.each([
    ['something was just signalled', { matching: 1 }],
    ['an owner could not be authenticated', { unknown: true }],
    ['the guard is still finishing its own cleanup', { sessionGuardAlive: true }],
    ['a record could not be read', { trustworthy: false }],
  ])('retries while %s', (_name, overrides) => {
    expect(plan.planReapOutcome(summary(overrides))).toBe('retry')
  })
})

describe('reapRetryDelayMs', () => {
  test('polls quickly at first and backs off to a second', () => {
    expect([0, 1_000, 600_000].map(plan.reapRetryDelayMs)).toEqual([
      50, 100, 1_000,
    ])
  })

  test('tolerates a clock that ran backwards', () => {
    expect(plan.reapRetryDelayMs(-5_000)).toBe(50)
  })
})

describe('lstart fixture agreement', () => {
  test('the birth window is compared against the seconds ps reports', () => {
    // Guards the fixture itself: LSTART must parse, or every table above would
    // be comparing NaN and passing for the wrong reason.
    expect(Number.isFinite(Date.parse(LSTART))).toBe(true)
  })
})
