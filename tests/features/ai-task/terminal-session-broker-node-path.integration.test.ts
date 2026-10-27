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
import { BrokerTerminalDispatcher } from '@/features/ai-task/services/dispatchers/BrokerTerminalDispatcher'
import type { ProcessGateway } from '@/features/ai-task/services/NodeProcessGateway'
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

function brokerPid(identity: string): number {
  return (
    JSON.parse(readFileSync(getTerminalBrokerDescriptorPath(identity), 'utf8')) as { pid: number }
  ).pid
}

function brokerExecutable(identity: string): string {
  const descriptor = { pid: brokerPid(identity) }
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

describePosix('broker that refuses sessions because its node executable is gone (LEV-405)', () => {
  jest.setTimeout(40_000)

  test('a new terminal starts anyway, on a new broker, with nothing for the user to do', async () => {
    const unique = `${process.pid}-${Date.now()}`
    const identity = `broker-replace-${unique}`
    const oldPrefix = mkdtempSync(join(tmpdir(), 'taskchute-old-node-'))
    // A PATH with no node on it: the old broker has nowhere to fall back to
    // and refuses, as a broker from before LEV-400 does in any case.
    const nodelessPath = mkdtempSync(join(tmpdir(), 'taskchute-no-node-'))
    const oldNode = installNodePrefix(oldPrefix)
    let brokerPath = dirname(oldNode)
    const client = new TerminalSessionBrokerClient({
      identity,
      shutdownTimeoutMs: 5_000,
      getEnv: () => ({ ...process.env, PATH: `${brokerPath}${delimiter}${process.env.PATH ?? ''}` }),
    })
    const gateway = {
      buildPtyCommand: () => ({
        command: '/bin/sh',
        // PATH is empty here, so sleep by its absolute path.
        args: ['-c', 'echo NEW_BROKER_READY; while :; do /bin/sleep 10; done'],
      }),
      getBaseEnv: () => ({ PATH: nodelessPath }),
      getPtyTransport: () => 'script',
    } as unknown as ProcessGateway
    const dispatcher = new BrokerTerminalDispatcher(gateway, client)

    try {
      // The broker starts on the versioned node, then that node is removed.
      const exited = new Set<string>()
      await startEcho(client, `first-${unique}`, 'FIRST_READY', exited)
      const oldPid = brokerPid(identity)
      expect(brokerExecutable(identity)).toBe(realpathSync(oldNode))
      // Never while a terminal of this window still runs on it.
      await expect(client.replaceBroker()).rejects.toThrow('still has sessions')
      expect(brokerPid(identity)).toBe(oldPid)
      client.stop(`first-${unique}`, true)
      await withTimeout(
        (async () => {
          while (!exited.has(`first-${unique}`)) await new Promise((r) => setTimeout(r, 25))
        })(),
      )
      rmSync(oldPrefix, { force: true, recursive: true })
      brokerPath = ''

      const ready = deferred<void>()
      let output = ''
      dispatcher.start(
        {
          sessionId: `second-${unique}`,
          binaryPath: '/bin/sh',
          prompt: '',
          cwd: tmpdir(),
          extraArgs: [],
          rows: 24,
          cols: 80,
          transcriptPath: join(tmpdir(), `taskchute-second-${unique}.log`),
          mayReplaceBroker: () => true,
        },
        {
          onData: (data) => {
            output += data
            if (output.includes('NEW_BROKER_READY')) ready.resolve()
          },
          onExit: (outcome) =>
            ready.reject(new Error(`second exited: ${outcome.errorMessage ?? outcome.status}`)),
        },
      )
      await withTimeout(ready.promise)

      expect(brokerPid(identity)).not.toBe(oldPid)
      expect(brokerExecutable(identity)).toBe(realpathSync(process.execPath))

      // A terminal started while the broker is being replaced waits for the
      // new one instead of being lost with the old connection.
      client.stop(`second-${unique}`, true)
      await withTimeout(
        (async () => {
          while (client.hasSessions()) await new Promise((r) => setTimeout(r, 25))
        })(),
      )
      const secondPid = brokerPid(identity)
      const replacing = client.replaceBroker()
      const third = startEcho(client, `third-${unique}`, 'THIRD_READY', exited)
      await replacing
      await third
      expect(brokerPid(identity)).not.toBe(secondPid)

      // One stopped while it waits never runs at all, and still ends.
      client.stop(`third-${unique}`, true)
      await withTimeout(
        (async () => {
          while (client.hasSessions()) await new Promise((r) => setTimeout(r, 25))
        })(),
      )
      const marker = join(nodelessPath, 'fourth-ran')
      const fourthExit = deferred<AiRunExitOutcome>()
      const replacingAgain = client.replaceBroker()
      client.start(
        `fourth-${unique}`,
        { command: '/bin/sh', args: ['-c', `touch '${marker}'`], env: { ...process.env }, stdinMode: 'pipe' },
        join(tmpdir(), `taskchute-fourth-${unique}.log`),
        undefined,
        { onData: () => undefined, onExit: (outcome) => fourthExit.resolve(outcome) },
      )
      client.stop(`fourth-${unique}`, false)
      await replacingAgain
      expect((await withTimeout(fourthExit.promise)).status).toBe('stopped')
      expect(existsSync(marker)).toBe(false)
    } finally {
      await client.shutdown().catch(() => undefined)
      rmSync(oldPrefix, { force: true, recursive: true })
      rmSync(nodelessPath, { force: true, recursive: true })
    }
  })
})
