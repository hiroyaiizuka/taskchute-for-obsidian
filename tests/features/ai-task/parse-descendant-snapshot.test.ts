import { parseDescendantSnapshot } from '../../../src/features/ai-task/services/process/parseDescendantSnapshot'

/**
 * Until this file existed, the gateway's `ps` parsing was reachable only by
 * spawning real processes: injecting the `snapshotDescendantPids` seam replaces
 * the exec and the parse together, so no test ever exercised the regex or the
 * walk.
 */
const LSTART = 'Mon Aug 25 09:14:07 2025'

/** `ps -axo pid=,ppid=,lstart=` right-aligns the numeric columns. */
const line = (pid: number, ppid: number, lstart = LSTART): string =>
  `${String(pid).padStart(6)} ${String(ppid).padStart(5)} ${lstart}`

describe('parseDescendantSnapshot', () => {
  test('follows a chain past the first level', () => {
    const output = [line(101, 100), line(102, 101), line(103, 102), ''].join('\n')

    expect(parseDescendantSnapshot(output, 100).map((entry) => entry.pid).sort()).toEqual(
      [101, 102, 103],
    )
  })

  test('carries the raw lstart text as the birth token', () => {
    // The token is compared as an opaque string to reject PID reuse, so it must
    // arrive intact rather than parsed.
    expect(parseDescendantSnapshot(`${line(101, 100)}\n`, 100)).toEqual([
      { pid: 101, birthToken: LSTART },
    ])
  })

  test('keeps a single-digit lstart day intact', () => {
    // `Aug  4` carries two spaces; the command column is `(.+)$`, so the token
    // must not be split on whitespace.
    const singleDigitDay = 'Mon Aug  4 09:14:07 2025'

    expect(
      parseDescendantSnapshot(`${line(101, 100, singleDigitDay)}\n`, 100)[0]?.birthToken,
    ).toBe(singleDigitDay)
  })

  test('keeps a locale-rendered lstart rather than dropping the process', () => {
    // A ps that ran without LC_ALL=C renders the month in the local language.
    // The pid still matters for reaping; only the token's text differs, and it
    // is only ever compared against another reading from the same machine.
    const french = 'lun. aoû  4 09:14:07 2025'

    expect(parseDescendantSnapshot(`${line(101, 100, french)}\n`, 100)).toEqual([
      { pid: 101, birthToken: french },
    ])
  })

  test('excludes the root itself', () => {
    const output = [line(100, 1), line(101, 100), ''].join('\n')

    expect(parseDescendantSnapshot(output, 100).map((entry) => entry.pid)).toEqual([101])
  })

  test('returns nothing for a root with no children', () => {
    expect(parseDescendantSnapshot(`${line(101, 100)}\n`, 999)).toEqual([])
  })

  test('does not treat pid 0 as the parent of everything', () => {
    const output = [line(101, 0), line(102, 101), ''].join('\n')

    expect(parseDescendantSnapshot(output, 0).map((entry) => entry.pid).sort()).toEqual([
      101, 102,
    ])
    expect(parseDescendantSnapshot(output, 100)).toEqual([])
  })

  test('terminates on a ppid cycle', () => {
    // A self-parenting entry, and a pair that point at each other. A walk
    // without a seen set never returns here.
    const output = [line(101, 100), line(102, 102), line(103, 104), line(104, 103), ''].join(
      '\n',
    )

    expect(parseDescendantSnapshot(output, 100).map((entry) => entry.pid)).toEqual([101])
  })

  test('never walks back into the root through a cycle', () => {
    const output = [line(101, 100), line(100, 101), ''].join('\n')

    expect(parseDescendantSnapshot(output, 100).map((entry) => entry.pid)).toEqual([101])
  })

  test('skips lines that are not process rows', () => {
    const output = [
      '   PID  PPID STARTED',
      line(101, 100),
      'ps: some error text',
      '',
    ].join('\n')

    expect(parseDescendantSnapshot(output, 100).map((entry) => entry.pid)).toEqual([101])
  })

  test('survives empty output', () => {
    expect(parseDescendantSnapshot('', 100)).toEqual([])
  })

  test('collects siblings as well as depth', () => {
    const output = [line(101, 100), line(102, 100), line(103, 101), ''].join('\n')

    expect(parseDescendantSnapshot(output, 100).map((entry) => entry.pid).sort()).toEqual([
      101, 102, 103,
    ])
  })
})
