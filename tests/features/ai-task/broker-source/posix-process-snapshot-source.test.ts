import { createContext, runInContext } from 'vm'

import { POSIX_PROCESS_SNAPSHOT_SOURCE } from '../../../../src/features/ai-task/services/broker-source/PosixProcessSnapshotSource'
import { buildTerminalBrokerSource } from '../../../../src/features/ai-task/services/TerminalSessionBrokerSource'
import { TERMINAL_SESSION_GUARD_SOURCE } from '../../../../src/features/ai-task/services/TerminalSessionGuardSource'
import { TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE } from '../../../../src/features/ai-task/services/TerminalSessionOwnerWatchdogSource'
import {
  DARWIN_PS_AXO_TEXT,
  DESCENDANT_TREE_TEXT,
  LINUX_PS_AXEWW_TEXT,
  LSTART,
  LSTART_EPOCH_MS,
  LSTART_SINGLE_DIGIT_DAY_EPOCH_MS,
  PS_DIALECTS,
} from './psSnapshots'

/**
 * The broker, guard and watchdog each ship as `node -e <one string>`, so this
 * code cannot be imported at runtime — it is spliced into all three. Evaluating
 * the fragment in a bare context is what lets the `ps` dialects be exercised
 * from either host: until this existed, the Linux `axeww` branch was
 * unreachable from a macOS checkout, and none of this parsing had a single
 * unit test.
 */
type SnapshotEntry = {
  ppid: number
  pgid: number
  startedAt: number | null
  command: string
}

type Identity = {
  lower: number
  upper: number
  kind: string
  parentPid: number
  processGroup: number
  commandHint: string
}

const context = createContext({ JSON, Map, Set, Date, Math, Number, String })
runInContext(POSIX_PROCESS_SNAPSHOT_SOURCE, context)

const posix = context as unknown as {
  parsePosixProcessSnapshot: (output: string) => Map<number, SnapshotEntry>
  posixBirthFloor: (ms: number) => number
  posixBirthAtOrAfter: (actualStart: number, lower: number) => boolean
  posixBirthSlackMs: () => number
  posixBirthWindowMatches: (
    actualStart: number,
    lower: number,
    upper: number,
  ) => boolean
  posixSnapshotChildren: (
    snapshot: Map<number, SnapshotEntry>,
  ) => Map<number, number[]>
  posixSnapshotDescendantPids: (
    snapshot: Map<number, SnapshotEntry>,
    rootPids: number[],
  ) => number[]
  posixSnapshotIdentity: (entry: SnapshotEntry | undefined) => Identity | null
  posixSnapshotPsArgs: (platform: string) => string[]
  posixSnapshotPsOptions: (baseEnv: Record<string, string>) => {
    encoding: string
    maxBuffer: number
    env: Record<string, string>
  }
  windowsBirthReaderArgv: (
    pid: number,
    systemRoot?: string,
  ) => { command: string; args: string[] }
  windowsBirthWindowMatches: (
    actualStart: number,
    lower: number,
    upper: number,
  ) => boolean
}

const PROGRAMS = [
  ['broker', buildTerminalBrokerSource()],
  ['session guard', TERMINAL_SESSION_GUARD_SOURCE],
  ['owner watchdog', TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE],
] as const

describe('posix snapshot fragment composition', () => {
  test.each(PROGRAMS)(
    'the shipped %s program embeds the fragment verbatim',
    (_name, source) => {
      expect(source).toContain(POSIX_PROCESS_SNAPSHOT_SOURCE)
    },
  )

  test('the fragment reaches no host facility, so it can run detached', () => {
    // Comments stripped first: they discuss `process`es and `ps` in prose, and
    // the claim being made here is about the code.
    const code = POSIX_PROCESS_SNAPSHOT_SOURCE.replace(/^\s*\/\/.*$/gmu, '')

    expect(code).not.toMatch(/\b(?:require|__dirname|globalThis)\b/u)
    expect(code).not.toMatch(/\b(?:process|cp|fs|net)\s*\./u)
  })

  // `toContain` alone would still pass if a program grew a second, private copy
  // beside the shared one, which is exactly how the three drifted apart before.
  test.each(PROGRAMS)('%s keeps no private copy of the parser', (_name, source) => {
    const outsideFragment = source.replace(POSIX_PROCESS_SNAPSHOT_SOURCE, '')

    expect(outsideFragment).not.toMatch(
      /function\s+(?:snapshotIdentity|parsePosixSnapshot)\b/u,
    )
    expect(outsideFragment).not.toMatch(/const\s+posixPsArgs\b/u)
    // The floor-to-the-second rule now lives in posixBirthFloor. Any surviving
    // copy is a birth comparison that will drift the next time it is tuned.
    expect(
      outsideFragment.match(/Math\.floor\([^)]*\/\s*1000\)\s*\*\s*1000/gu) ?? [],
    ).toEqual([])
    // posixBirthFloor on its own is not enough: compared directly it drops the
    // slack the floor exists to be paired with. Every comparison goes through
    // posixBirthWindowMatches or posixBirthAtOrAfter.
    expect(outsideFragment).not.toMatch(/[<>]=?\s*posixBirthFloor\(/u)
    expect(outsideFragment).not.toMatch(/posixBirthFloor\([^)]*\)\s*[<>]/u)
  })
})

describe('posixSnapshotPsArgs', () => {
  // The Linux form is what no macOS test run could ever produce before.
  test('asks Linux for the environment-bearing form', () => {
    expect(posix.posixSnapshotPsArgs('linux')).toEqual([
      'axeww',
      '-o',
      'pid=,ppid=,pgid=,lstart=,command=',
    ])
  })

  test.each(['darwin', 'win32', 'freebsd'])(
    'asks %s for the plain form',
    (platform) => {
      expect(posix.posixSnapshotPsArgs(platform)).toEqual([
        '-axo',
        'pid=,ppid=,pgid=,lstart=,command=',
      ])
    },
  )

  test('pins the locale so lstart stays parseable', () => {
    const options = posix.posixSnapshotPsOptions({ LANG: 'ja_JP.UTF-8', HOME: '/home/x' })

    expect(options.env.LC_ALL).toBe('C')
    expect(options.env.LANG).toBe('C')
    expect(options.env.HOME).toBe('/home/x')
  })
})

describe('parsePosixProcessSnapshot', () => {
  test.each(PS_DIALECTS)('reads the %s dialect', (_platform, text) => {
    const snapshot = posix.parsePosixProcessSnapshot(text)

    expect(snapshot.get(501)).toMatchObject({
      ppid: 1,
      pgid: 501,
      startedAt: LSTART_EPOCH_MS,
    })
    expect(snapshot.get(502)?.ppid).toBe(501)
    expect(snapshot.get(503)?.ppid).toBe(502)
  })

  test.each(PS_DIALECTS)(
    'keeps a single-digit lstart day in the %s dialect',
    (_platform, text) => {
      // `Aug  4` carries two spaces, which is where a naive
      // `\S+\s+\S+\s+\d+` split loses the year.
      expect(posix.parsePosixProcessSnapshot(text).get(601)?.startedAt).toBe(
        LSTART_SINGLE_DIGIT_DAY_EPOCH_MS,
      )
    },
  )

  test.each(PS_DIALECTS)(
    'keeps an empty command column in the %s dialect',
    (_platform, text) => {
      const entry = posix.parsePosixProcessSnapshot(text).get(602)

      expect(entry).toBeDefined()
      expect(entry?.command).toBe('')
    },
  )

  test('preserves runs of whitespace inside a command', () => {
    expect(posix.parsePosixProcessSnapshot(DARWIN_PS_AXO_TEXT).get(123456)?.command).toBe(
      '/usr/bin/python3   -c   print(1)',
    )
  })

  test('keeps the environment Linux appends after the argv', () => {
    const entry = posix.parsePosixProcessSnapshot(LINUX_PS_AXEWW_TEXT).get(801)

    expect(entry?.command).toContain(
      'TASKCHUTE_BROKER_OWNER_PID_FILE=/tmp/owner-a.jsonl',
    )
  })

  test('reads a bracketed kernel thread', () => {
    expect(posix.parsePosixProcessSnapshot(LINUX_PS_AXEWW_TEXT).get(9)).toMatchObject({
      ppid: 2,
      pgid: 0,
      command: '[kworker/0:1]',
    })
  })

  test.each(PS_DIALECTS)('skips the header line in the %s dialect', (_platform, text) => {
    const snapshot = posix.parsePosixProcessSnapshot(text)

    for (const pid of snapshot.keys()) expect(Number.isFinite(pid)).toBe(true)
    expect(snapshot.has(Number.NaN)) .toBe(false)
  })

  test('records an unparseable lstart as null rather than trusting it', () => {
    // A non-C locale renders the month in the local language; Date.parse then
    // yields NaN and the entry must not claim a birth time.
    const snapshot = posix.parsePosixProcessSnapshot(
      `  501     1   501 lun. aoû  4 09:14:07 2025 sleep 10\n`,
    )

    expect(snapshot.get(501)?.startedAt ?? 'absent').not.toBe(LSTART_EPOCH_MS)
  })
})

describe('posixSnapshotIdentity', () => {
  test('describes a snapshot entry by group and command prefix', () => {
    const snapshot = posix.parsePosixProcessSnapshot(DARWIN_PS_AXO_TEXT)

    expect(posix.posixSnapshotIdentity(snapshot.get(502))).toEqual({
      lower: LSTART_EPOCH_MS,
      upper: LSTART_EPOCH_MS,
      kind: 'snapshot',
      parentPid: 501,
      processGroup: 501,
      commandHint: 'sleep 10',
    })
  })

  test('refuses an entry with no usable birth time', () => {
    expect(posix.posixSnapshotIdentity(undefined)).toBeNull()
    expect(
      posix.posixSnapshotIdentity({
        ppid: 1,
        pgid: 1,
        startedAt: null,
        command: 'sleep 10',
      }),
    ).toBeNull()
  })

  test('caps the command hint so a Linux environment cannot bloat the record', () => {
    const identity = posix.posixSnapshotIdentity({
      ppid: 1,
      pgid: 1,
      startedAt: LSTART_EPOCH_MS,
      command: 'x'.repeat(4096),
    })

    expect(identity?.commandHint).toHaveLength(512)
  })
})

describe('birth windows', () => {
  const second = Date.parse(LSTART)

  test('floors a millisecond bound to the second ps reports', () => {
    expect(posix.posixBirthFloor(second + 999)).toBe(second)
    expect(posix.posixBirthFloor(second)).toBe(second)
  })

  test('matches a birth recorded mid-second on either side of the spawn', () => {
    // The owner record brackets spawn(); ps only ever reports the floor.
    expect(posix.posixBirthWindowMatches(second, second + 120, second + 880)).toBe(true)
  })

  /**
   * The failure that took four integration tests down on Linux and nowhere
   * else, and that no amount of test isolation would have touched.
   *
   * Linux has no wall-clock start time to report: it derives one, as boot time
   * plus the process' start in jiffies, and both are truncated. The second it
   * reports is therefore sometimes the second BEFORE the clock reading that
   * bracketed spawn(). Measured in a container at HZ=100, 7 of 40 spawns came
   * back one second early — while macOS, which keeps a real timeval, was exact
   * 40 times out of 40. A process reported early failed every ownership check,
   * so it was never signalled, which is what left orphans behind on CI runs
   * that passed locally.
   */
  test('accepts the second below, which Linux reports for a process born in this one', () => {
    expect(posix.posixBirthWindowMatches(second - 1000, second, second + 500)).toBe(true)
  })

  test('rejects the second above, which truncation cannot produce', () => {
    expect(posix.posixBirthWindowMatches(second + 1000, second, second + 500)).toBe(false)
  })

  test('rejects a birth further below than truncation can explain', () => {
    expect(posix.posixBirthWindowMatches(second - 2000, second, second + 500)).toBe(false)
  })

  test('spends exactly the one second the truncation can lose', () => {
    expect(posix.posixBirthSlackMs()).toBe(1_000)
  })

  /**
   * The same rule for a caller that has only a lower bound — the session
   * guard, deciding whether a process in the target's group is young enough to
   * belong to this session. It was open-coded as `startedAt <
   * posixBirthFloor(lower)`, which skips the slack, so a background process the
   * kernel reported one second early was never captured and never signalled:
   * the session then waited for a PTY that process was holding open. Same
   * defect as above, a second spelling of it.
   */
  test('accepts a member the kernel reported a second before its session', () => {
    expect(posix.posixBirthAtOrAfter(second - 1000, second)).toBe(true)
  })

  test('accepts a member started later than its session', () => {
    expect(posix.posixBirthAtOrAfter(second + 5_000, second)).toBe(true)
  })

  test('rejects a member older than truncation can explain', () => {
    expect(posix.posixBirthAtOrAfter(second - 2000, second)).toBe(false)
  })

  test('rejects an unusable birth time instead of accepting everything', () => {
    expect(posix.posixBirthAtOrAfter(Number.NaN, second)).toBe(false)
  })

  test('accepts a zero-width window', () => {
    expect(posix.posixBirthWindowMatches(second, second, second)).toBe(true)
  })

  test('rejects an unusable birth time instead of matching everything', () => {
    expect(posix.posixBirthWindowMatches(Number.NaN, second, second)).toBe(false)
  })

  test('uses full precision on Windows, which reports sub-second starts', () => {
    expect(posix.windowsBirthWindowMatches(second + 500, second, second + 900)).toBe(true)
    expect(posix.windowsBirthWindowMatches(second, second + 100, second + 900)).toBe(false)
  })
})

describe('posixSnapshotDescendantPids', () => {
  const snapshot = () => posix.parsePosixProcessSnapshot(DESCENDANT_TREE_TEXT)

  test('walks past the first level and stops at the tree it was given', () => {
    expect(posix.posixSnapshotDescendantPids(snapshot(), [100]).sort()).toEqual([
      101, 102, 103,
    ])
  })

  test('never returns a root', () => {
    expect(posix.posixSnapshotDescendantPids(snapshot(), [100])).not.toContain(100)
  })

  test('walks from every root at once', () => {
    expect(
      posix.posixSnapshotDescendantPids(snapshot(), [100, 200]).sort(),
    ).toEqual([101, 102, 103, 201])
  })

  test('terminates on a self-parenting entry', () => {
    expect(posix.posixSnapshotDescendantPids(snapshot(), [104])).toEqual([])
  })

  test('returns nothing for a root that is not in the snapshot', () => {
    expect(posix.posixSnapshotDescendantPids(snapshot(), [99_999])).toEqual([])
  })

  test('does not treat pid 0 as a parent of everything', () => {
    expect(posix.posixSnapshotDescendantPids(snapshot(), [0])).toEqual([])
  })

  test('indexes children by parent', () => {
    expect(posix.posixSnapshotChildren(snapshot()).get(100)?.sort()).toEqual([101, 102])
  })
})

describe('windowsBirthReaderArgv', () => {
  // Buildable and assertable from a POSIX checkout, which is the point: no
  // Windows machine has ever run this construction under test.
  test('builds the PowerShell path from SystemRoot', () => {
    expect(posix.windowsBirthReaderArgv(1234, 'D:\\Win').command).toBe(
      'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
  })

  test('strips trailing separators from SystemRoot', () => {
    expect(posix.windowsBirthReaderArgv(1234, 'D:\\Win\\\\').command).toBe(
      'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
  })

  test('falls back when SystemRoot is unset', () => {
    expect(posix.windowsBirthReaderArgv(1234, undefined).command).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
  })

  test('asks for the start time of one pid in a round-trippable format', () => {
    expect(posix.windowsBirthReaderArgv(1234, 'C:\\Windows').args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "(Get-Process -Id 1234 -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')",
    ])
  })
})
