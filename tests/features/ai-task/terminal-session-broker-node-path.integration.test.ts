import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { delimiter, dirname, join } from 'path'

import {
  getTerminalBrokerDescriptorPath,
  TerminalSessionBrokerClient,
} from '@/features/ai-task/services/TerminalSessionBroker'
import type { AiRunExitOutcome } from '@/features/ai-task/services/dispatchers/Dispatcher'
import { describePosix } from '@tests/support/platform'
import { deferred, withTimeout } from './brokerTestUtils'

// A versioned install prefix, as Homebrew lays out Cellar/node/<version>.
// Homebrew's node loads libnode from ../lib, so the prefix carries that too.
function installNodePrefix(prefix: string): string {
  const binary = join(prefix, 'bin', 'node')
  mkdirSync(dirname(binary))
  // A copy, not a hardlink: macOS lsof may name a hardlinked executable by
  // its other path, which would hide whether the broker really runs from here.
  copyFileSync(process.execPath, binary)
  chmodSync(binary, 0o755)
  const libraries = join(dirname(dirname(process.execPath)), 'lib')
  if (existsSync(libraries)) symlinkSync(libraries, join(prefix, 'lib'))
  return binary
}

function brokerExecutable(identity: string): string {
  const descriptor = JSON.parse(
    readFileSync(getTerminalBrokerDescriptorPath(identity), 'utf8'),
  ) as { pid: number }
  if (process.platform === 'linux') {
    return readlinkSync(`/proc/${descriptor.pid}/exe`)
  }
  const listing = execFileSync(
    'lsof',
    ['-a', '-p', String(descriptor.pid), '-d', 'txt', '-Fn'],
    { encoding: 'utf8' },
  )
  return listing.split('\n').find((line) => line.startsWith('n'))?.slice(1) ?? ''
}

function startEcho(
  client: TerminalSessionBrokerClient,
  sessionId: string,
  word: string,
  exited: Set<string>,
): Promise<void> {
  const printed = deferred<void>()
  let output = ''
  client.start(
    sessionId,
    {
      command: '/bin/sh',
      args: ['-c', `echo ${word}; while :; do sleep 10; done`],
      env: { ...process.env },
      stdinMode: 'pipe',
    },
    join(tmpdir(), `taskchute-${sessionId}.log`),
    undefined,
    {
      onData: (data) => {
        output += data
        if (output.includes(word)) printed.resolve()
      },
      onExit: (outcome: AiRunExitOutcome) => {
        exited.add(sessionId)
        printed.reject(
          new Error(`${word} exited: ${outcome.errorMessage ?? outcome.status}`),
        )
      },
      onUnavailable: () => printed.reject(new Error(`${word} unavailable`)),
    },
  )
  return withTimeout(printed.promise)
}

describePosix('broker whose own node executable was removed', () => {
  jest.setTimeout(30_000)

  test('starts a new session from PATH while the earlier session keeps running', async () => {
    const unique = `${process.pid}-${Date.now()}`
    const identity = `broker-node-path-${unique}`
    const oldPrefix = mkdtempSync(join(tmpdir(), 'taskchute-old-node-'))
    const oldNode = installNodePrefix(oldPrefix)
    const client = new TerminalSessionBrokerClient({
      identity,
      shutdownTimeoutMs: 5_000,
      getEnv: () => ({
        ...process.env,
        PATH: `${dirname(oldNode)}${delimiter}${process.env.PATH ?? ''}`,
      }),
    })

    const exited = new Set<string>()

    try {
      await startEcho(client, `first-${unique}`, 'FIRST_READY', exited)
      expect(brokerExecutable(identity)).toBe(realpathSync(oldNode))

      rmSync(oldPrefix, { force: true, recursive: true })

      await startEcho(client, `second-${unique}`, 'SECOND_READY', exited)
      expect(exited).toEqual(new Set())
    } finally {
      await client.shutdown().catch(() => undefined)
      rmSync(oldPrefix, { force: true, recursive: true })
    }
  })
})
