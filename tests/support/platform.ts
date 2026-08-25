import { accessSync, constants } from 'fs'
import { delimiter, join } from 'path'

/**
 * Platform and binary gates for suites that drive real processes.
 *
 * The point of routing every such gate through here is that a suite which
 * cannot run says so. The previous shape — `if (!existsSync('/usr/bin/python3'))
 * return` inside the test body — reported a **pass**, so fifteen cases,
 * including every hook-disabling Python flag rejection, could report green on a
 * machine that never ran them.
 */

export const describePosix = process.platform === 'win32' ? describe.skip : describe
export const describeDarwin = process.platform === 'darwin' ? describe : describe.skip
export const describeLinux = process.platform === 'linux' ? describe : describe.skip

/**
 * Set in CI. Turns a missing binary into a failure rather than a skip, so a
 * runner image change cannot quietly reduce a suite to zero coverage — which
 * would be the same defect as the silent early return, one step removed.
 */
const REQUIRE_BINARIES_ENV = 'TASKCHUTE_TEST_REQUIRE_BINARIES'

// The absolute locations the production code itself hardcodes, tried before
// PATH so a test resolves the same binary the broker would spawn.
const WELL_KNOWN_DIRECTORIES = ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin']

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Absolute path to `name`, or null when it is not installed. Never throws. */
export function resolveBinary(name: string): string | null {
  if (name.includes('/')) return isExecutable(name) ? name : null
  for (const directory of WELL_KNOWN_DIRECTORIES) {
    const candidate = join(directory, name)
    if (isExecutable(candidate)) return candidate
  }
  for (const directory of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, name)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

function resolveAll(names: readonly string[]): {
  paths: Record<string, string>
  missing: string[]
} {
  const paths: Record<string, string> = {}
  const missing: string[] = []
  for (const name of names) {
    const resolved = resolveBinary(name)
    if (resolved === null) missing.push(name)
    else paths[name] = resolved
  }
  if (missing.length > 0 && process.env[REQUIRE_BINARIES_ENV] === '1') {
    throw new Error(
      `${REQUIRE_BINARIES_ENV}=1 but these are not installed: ${missing.join(', ')}`,
    )
  }
  return { paths, missing }
}

/**
 * describe() when every binary resolves, describe.skip() otherwise, with the
 * reason folded into the suite name — reporters always print a skipped suite,
 * while a console warning would be swallowed by tests/setup/console-silence.ts.
 *
 * The body receives the resolved absolute paths; when the suite is skipped they
 * are empty strings, which is safe because nothing in a skipped body runs.
 */
export function describeWithBinaries(
  names: readonly string[],
  suiteName: string,
  body: (paths: Record<string, string>) => void,
): void {
  const { paths, missing } = resolveAll(names)
  if (missing.length > 0) {
    describe.skip(`${suiteName} [requires ${missing.join(', ')}: not installed]`, () => {
      body(Object.fromEntries(names.map((name) => [name, ''])))
    })
    return
  }
  describe(suiteName, () => {
    body(paths)
  })
}

/**
 * The per-test form, for a suite where only some cases need the binary.
 * `test` is `it.skip` when anything is missing, and `paths` holds what resolved.
 */
export function testWithBinaries(names: readonly string[]): {
  test: jest.It
  paths: Record<string, string>
  missing: string[]
} {
  const { paths, missing } = resolveAll(names)
  return { test: missing.length > 0 ? it.skip : it, paths, missing }
}
