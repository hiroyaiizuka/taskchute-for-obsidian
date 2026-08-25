import { createContext, runInContext } from 'vm'

import { TERMINAL_BROKER_PURE_SOURCE } from '../../../../src/features/ai-task/services/broker-source/TerminalBrokerPureSource'
import { TERMINAL_BROKER_SOURCE } from '../../../../src/features/ai-task/services/TerminalSessionBrokerSource'
import { buildTerminalShellLaunch } from '../../../../src/features/ai-task/services/dispatchers/TerminalShellBootstrap'
import { NodeProcessGateway } from '../../../../src/features/ai-task/services/NodeProcessGateway'

/**
 * The broker ships as `node -e <one string>`, so these functions cannot be
 * imported at runtime — they are spliced into TERMINAL_BROKER_SOURCE. The
 * fragment is free of fs, child_process, net and process, which is what lets it
 * be exercised here instead of through a spawned broker: the cases below used
 * to require real pipes, and their outcome then depended on how much a single
 * pipe read happened to deliver, which differs between macOS and Linux.
 */
const context = createContext({ JSON })
runInContext(TERMINAL_BROKER_PURE_SOURCE, context)

const broker = context as unknown as {
  boundStderrHead: (session: StderrSession) => void
  consumeStderrInto: (
    session: StderrSession,
    text: string,
    flush: boolean,
    marker: string,
    emit: (visible: string) => void,
  ) => void
  launchDisablesPythonOwnershipHook: (
    request: { command: string; args: string[] },
    initialInput?: string,
  ) => boolean
}

const stderrPendingLimit = runInContext(
  'stderrPendingLimit',
  context,
) as number

type StderrSession = {
  stderrPending: string
  stderrDroppedChars: number
  sentinelCode?: number
}

const MARKER = '__TASKCHUTE_AI_EXIT__'

function makeSession(): StderrSession {
  return { stderrPending: '', stderrDroppedChars: 0 }
}

function feed(
  session: StderrSession,
  text: string,
  chunkSize: number,
): string {
  let output = ''
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    broker.consumeStderrInto(
      session,
      text.slice(offset, offset + chunkSize),
      false,
      MARKER,
      (visible) => {
        output += visible
      },
    )
  }
  return output
}

describe('broker pure fragment composition', () => {
  test('the shipped broker program embeds the fragment verbatim', () => {
    expect(TERMINAL_BROKER_SOURCE).toContain(TERMINAL_BROKER_PURE_SOURCE)
  })

  test('the fragment reaches no host facility, so it can run detached', () => {
    expect(TERMINAL_BROKER_PURE_SOURCE).not.toMatch(
      /\b(?:require|process|__dirname|globalThis)\b/,
    )
  })
})

describe('stderr bounding', () => {
  // The read size is exactly what differed between runners: macOS delivered
  // small chunks and stayed under the cap by luck, Linux delivered ~24KB at a
  // time and blew past it. Pinning it as a parameter removes the platform from
  // the equation.
  const chunkSizes = [128, 4096, 24 * 1024, 64 * 1024]

  test.each(chunkSizes)(
    'bounds a newline-free run while preserving its tail and exit sentinel (%i-byte reads)',
    (chunkSize) => {
      const session = makeSession()
      const noise = 'e'.repeat(4 * 64 * 1024)
      const output =
        feed(session, `${noise}TAIL\n${MARKER}0\n`, chunkSize)

      expect(output).toMatch(/^…\[\+\d+ stderr chars truncated\]\n/)
      expect(output).toContain('TAIL\n')
      expect(output).not.toContain(MARKER)
      expect(output.length).toBeLessThanOrEqual(stderrPendingLimit + 128)
      expect(session.sentinelCode).toBe(0)
    },
  )

  test('a run shorter than the limit survives intact', () => {
    const session = makeSession()
    const line = 'x'.repeat(1024)

    expect(feed(session, `${line}\n`, 128)).toBe(`${line}\n`)
    expect(session.stderrDroppedChars).toBe(0)
  })

  test('bounding trims the head, not the tail that follows a newline', () => {
    const session = makeSession()
    session.stderrPending = `${'a'.repeat(stderrPendingLimit + 10)}\nkeep me`
    broker.boundStderrHead(session)

    expect(session.stderrDroppedChars).toBe(10)
    expect(session.stderrPending).toHaveLength(
      stderrPendingLimit + '\nkeep me'.length,
    )
    expect(session.stderrPending.endsWith('\nkeep me')).toBe(true)
  })

  test('a flush emits the newline-free tail and strips a bare sentinel', () => {
    const session = makeSession()
    let output = ''
    broker.consumeStderrInto(
      session,
      `bye${MARKER}7`,
      true,
      MARKER,
      (visible) => {
        output += visible
      },
    )

    expect(output).toBe('bye')
    expect(session.sentinelCode).toBe(7)
    expect(session.stderrPending).toBe('')
  })
})

describe('python ownership-hook detection', () => {
  const disables = (command: string, args: string[], initialInput?: string) =>
    broker.launchDisablesPythonOwnershipHook({ command, args }, initialInput)
  const toRequest = (pty: { command: string; args: string[] }): [string, string[]] => [
    pty.command,
    pty.args,
  ]

  test('accepts an ordinary python launch', () => {
    expect(disables('/usr/bin/python3', ['script.py'])).toBe(false)
  })

  test.each([['-S'], ['-E'], ['-I']])(
    'rejects python launched with %s',
    (flag) => {
      expect(disables('/usr/bin/python3', [flag, 'script.py'])).toBe(true)
    },
  )

  test('sees through an env(1) prefix but not through its assignments', () => {
    expect(disables('/usr/bin/env', ['python3', '-S'])).toBe(true)
    expect(disables('/usr/bin/env', ['FOO=bar', 'python3', 'script.py'])).toBe(
      false,
    )
  })

  test('rejects NODE_OPTIONS being overwritten through env(1)', () => {
    expect(
      disables('/usr/bin/env', ['NODE_OPTIONS=--x', 'python3', 'script.py']),
    ).toBe(true)
  })

  test('sees a hook-disabling python inside a shell -c program', () => {
    expect(disables('/bin/sh', ['-c', 'echo hi; python3 -S -c pass'])).toBe(
      true,
    )
    expect(disables('/bin/sh', ['-c', 'echo hi; python3 script.py'])).toBe(
      false,
    )
  })

  test('does not reject quoted -S text that is not a command', () => {
    expect(disables('/bin/sh', ['-c', 'echo "python3 -S"'])).toBe(false)
  })

  test('sees it in the initial input typed into a plain shell', () => {
    expect(disables('/bin/zsh', [], 'python3 -S\n')).toBe(true)
  })

  // The production launch nests the real binary inside the PTY wrapper and the
  // argv bootstrap, where a naive reader sees only shell text. Both wrapper
  // dialects are built here from an injected platform, so a macOS checkout
  // covers the Linux shape and the reverse.
  test.each([['darwin'], ['linux']])(
    'sees it hidden in the %s PTY wrapper and argv bootstrap',
    (platform) => {
      const gateway = new NodeProcessGateway(undefined, platform)
      const ptyCommandFor = (args: string[], commandArgs: string[]) => {
        const launch = buildTerminalShellLaunch(
          '/bin/sh',
          '/usr/bin/python3',
          args,
          commandArgs,
        )
        return gateway.buildPtyCommand({
          binaryPath: launch.binaryPath,
          args: launch.args,
          rows: 24,
          cols: 80,
          transcriptPath: '/tmp/taskchute-broker-test.log',
        })
      }

      expect(
        disables(...toRequest(ptyCommandFor(['-S'], ['-c', 'print(1)']))),
      ).toBe(true)
      expect(disables(...toRequest(ptyCommandFor(['script.py'], [])))).toBe(
        false,
      )
    },
  )
})
