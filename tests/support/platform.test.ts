import { resolveBinary, testWithBinaries } from './platform'

/**
 * The gate decides whether a suite runs, so a bug here silently removes
 * coverage — exactly the failure mode it was written to end.
 */
describe('resolveBinary', () => {
  test('finds a binary every POSIX host has', () => {
    // /bin/sh is what the broker itself spawns, so if this cannot be resolved
    // the integration suites could not run either.
    expect(resolveBinary('sh')).toMatch(/\/sh$/u)
  })

  test('returns null rather than throwing for something not installed', () => {
    expect(resolveBinary('taskchute-definitely-not-a-real-binary')).toBeNull()
  })

  test('accepts an absolute path and checks it is executable', () => {
    expect(resolveBinary('/bin/sh')).toBe('/bin/sh')
    expect(resolveBinary('/bin/taskchute-not-real')).toBeNull()
  })
})

describe('testWithBinaries', () => {
  test('hands back a runnable test and the resolved paths', () => {
    const gate = testWithBinaries(['sh'])

    expect(gate.missing).toEqual([])
    expect(gate.paths['sh']).toMatch(/\/sh$/u)
    expect(gate.test).toBe(it)
  })

  test('downgrades to it.skip and names what is missing', () => {
    // The name matters: a skip is printed by every reporter, whereas the old
    // `if (!existsSync(...)) return` reported a pass.
    const gate = testWithBinaries(['taskchute-definitely-not-a-real-binary'])

    expect(gate.missing).toEqual(['taskchute-definitely-not-a-real-binary'])
    expect(gate.test).toBe(it.skip)
  })

  test('fails loudly when CI demands the binaries be present', () => {
    const previous = process.env['TASKCHUTE_TEST_REQUIRE_BINARIES']
    process.env['TASKCHUTE_TEST_REQUIRE_BINARIES'] = '1'
    try {
      expect(() => testWithBinaries(['taskchute-definitely-not-a-real-binary'])).toThrow(
        /not installed: taskchute-definitely-not-a-real-binary/u,
      )
    } finally {
      if (previous === undefined) delete process.env['TASKCHUTE_TEST_REQUIRE_BINARIES']
      else process.env['TASKCHUTE_TEST_REQUIRE_BINARIES'] = previous
    }
  })
})
