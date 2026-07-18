import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { execFileSync, spawn as spawnChild } from 'child_process'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { createServer, type AddressInfo } from 'net'

import {
  getTerminalBrokerDescriptorPath,
  TerminalSessionBrokerClient,
  type TerminalBrokerSessionCallbacks,
} from '../../../src/features/ai-task/services/TerminalSessionBroker'
import { NodeProcessGateway } from '../../../src/features/ai-task/services/NodeProcessGateway'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = 8_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Broker integration test timed out')),
      timeoutMs,
    )
    void promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function ownerPidFiles(descriptorPath: string): string[] {
  const directory = dirname(descriptorPath)
  const prefix = `${basename(descriptorPath)}.owner-`
  return readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.jsonl'))
    .map((name) => join(directory, name))
}

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('TerminalSessionBrokerClient integration', () => {
  jest.setTimeout(20_000)

  test('stale input, resize, and stop handles never create an empty broker', async () => {
    const unique = `stale-handle-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const client = new TerminalSessionBrokerClient({ identity })

    client.write('missing-session', 'late input\n')
    client.resize('missing-session', 120, 40)
    client.stop('missing-session', true)
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(existsSync(descriptorPath)).toBe(false)
    await client.shutdown()
  })

  test('a second renderer client attaches to the same live process and can type', async () => {
    const unique = `${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const sessionId = `session-${process.pid}-${Date.now()}`
    const transcriptPath = `/tmp/taskchute-broker-integration-${unique}.log`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const logs: string[] = []
    const firstAttached = deferred<number | undefined>()
    const firstReady = deferred<void>()
    let firstOutput = ''
    const firstCallbacks: TerminalBrokerSessionCallbacks = {
      onAttached: firstAttached.resolve,
      onData: (data) => {
        firstOutput += data
        if (firstOutput.includes('READY')) firstReady.resolve()
      },
      onExit: (outcome) => firstReady.reject(
        new Error(`Unexpected early exit: ${outcome.status}`),
      ),
    }
    const firstClient = new TerminalSessionBrokerClient({
      identity,
      log: (level, ...args) => logs.push(`${level}:${args.map(String).join(' ')}`),
    })

    firstClient.start(
      sessionId,
      {
        command: '/bin/sh',
        args: [
          '-c',
          'printf "READY\\n"; while IFS= read -r line; do printf "ECHO:%s\\n" "$line"; [ "$line" = exit ] && exit 0; done',
        ],
        env: { ...process.env },
        stdinMode: 'pipe',
      },
      transcriptPath,
      undefined,
      firstCallbacks,
    )
    const originalPid = await withTimeout(firstAttached.promise)
    await withTimeout(firstReady.promise)
    expect(originalPid).toEqual(expect.any(Number))
    expect(existsSync(descriptorPath)).toBe(true)

    // Simulate renderer teardown: the client transport disappears, but the
    // broker-owned shell remains alive for the next renderer.
    firstClient.detach()

    const secondAttached = deferred<number | undefined>()
    const replayed = deferred<void>()
    const echoed = deferred<void>()
    const exited = deferred<void>()
    let secondOutput = ''
    const secondClient = new TerminalSessionBrokerClient({
      identity,
      log: (level, ...args) => logs.push(`${level}:${args.map(String).join(' ')}`),
    })
    secondClient.attach(sessionId, {
      onAttached: secondAttached.resolve,
      onData: (data) => {
        secondOutput += data
        if (secondOutput.includes('READY')) replayed.resolve()
        if (secondOutput.includes('ECHO:after-reload')) echoed.resolve()
      },
      onExit: (outcome) => {
        if (outcome.status === 'succeeded') exited.resolve()
        else exited.reject(new Error(`Unexpected exit: ${outcome.status}`))
      },
      onUnavailable: () => replayed.reject(new Error('Broker session was lost')),
    })

    expect(await withTimeout(secondAttached.promise)).toBe(originalPid)
    await withTimeout(replayed.promise)
    secondClient.write(sessionId, 'after-reload\n')
    await withTimeout(echoed.promise)
    secondClient.write(sessionId, 'exit\n')
    await withTimeout(exited.promise)
    await secondClient.shutdown()

    expect(existsSync(descriptorPath)).toBe(false)
    expect(secondOutput).toContain('READY')
    expect(secondOutput).toContain('ECHO:after-reload')
    expect(logs.filter((line) => line.includes('Spawn failed'))).toEqual([])
  })

  test('shutdown waits until its live child and broker process are gone', async () => {
    const unique = `shutdown-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const sessionId = `session-${process.pid}-${Date.now()}`
    const attached = deferred<number | undefined>()
    const ready = deferred<void>()
    const exited = deferred<void>()
    const logs: string[] = []
    const client = new TerminalSessionBrokerClient({
      identity,
      log: (level, ...args) => logs.push(`${level}:${args.map(String).join(' ')}`),
    })
    client.start(
      sessionId,
      {
        command: '/bin/sh',
        args: ['-c', 'printf "READY\\n"; while :; do sleep 1; done'],
        env: { ...process.env },
        stdinMode: 'pipe',
      },
      `/tmp/taskchute-broker-integration-${unique}.log`,
      undefined,
      {
        onAttached: attached.resolve,
        onData: (data) => {
          if (data.includes('READY')) ready.resolve()
        },
        onExit: () => exited.resolve(),
      },
    )
    const childPid = await withTimeout(attached.promise)
    await withTimeout(ready.promise)
    expect(childPid).toEqual(expect.any(Number))

    await client.shutdown()
    await withTimeout(exited.promise)

    // AiTaskManager's delayed force-kill sweep can still call an old handle
    // after broker shutdown. It must be a no-op, never a request that starts
    // a brand-new empty broker and leaves a stale descriptor behind.
    client.stop(sessionId, true)
    client.write(sessionId, 'late input\n')
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(() => process.kill(childPid ?? -1, 0)).toThrow()
    expect(existsSync(getTerminalBrokerDescriptorPath(identity))).toBe(false)
    expect(logs.filter((line) => line.includes('Timed out'))).toEqual([])
  })

  test('replaces a refused stale descriptor even when its pid was reused by a live process', async () => {
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const stalePort = (probe.address() as AddressInfo).port
    await new Promise((resolve) => probe.close(resolve))
    const unique = `stale-reused-pid-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    writeFileSync(
      descriptorPath,
      JSON.stringify({
        version: 1,
        port: stalePort,
        token: 'd'.repeat(64),
        // This PID is alive but is the Jest process, not the broker.
        pid: process.pid,
      }),
      { mode: 0o600 },
    )
    const attached = deferred<number | undefined>()
    const ready = deferred<void>()
    const client = new TerminalSessionBrokerClient({
      identity,
      startupTimeoutMs: 3_000,
      connectTimeoutMs: 100,
    })
    try {
      client.start(
        `session-${unique}`,
        {
          command: '/bin/sh',
          args: ['-c', 'printf "READY\\n"; while :; do sleep 1; done'],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onAttached: attached.resolve,
          onData: (data) => {
            if (data.includes('READY')) ready.resolve()
          },
          onExit: (outcome) =>
            ready.reject(new Error(`Unexpected early exit: ${outcome.status}`)),
          onUnavailable: () =>
            ready.reject(new Error('Replacement broker was unavailable')),
        },
      )

      const wrapperPid = await withTimeout(attached.promise)
      await withTimeout(ready.promise)
      expect(wrapperPid).toEqual(expect.any(Number))
      expect(wrapperPid).not.toBe(process.pid)
    } finally {
      await client.shutdown().catch(() => undefined)
      if (existsSync(descriptorPath)) rmSync(descriptorPath, { force: true })
    }
  })

  test('shutdown racing the initial broker startup never sends a late spawn', async () => {
    const unique = `shutdown-start-race-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    let attachedPid: number | undefined
    let output = ''
    const client = new TerminalSessionBrokerClient({
      identity,
      startupTimeoutMs: 3_000,
      shutdownTimeoutMs: 3_000,
    })

    client.start(
      `session-${unique}`,
      {
        command: '/bin/sh',
        args: ['-c', 'echo ORPHAN_STARTED; while :; do sleep 1; done'],
        env: { ...process.env },
        stdinMode: 'pipe',
      },
      `/tmp/taskchute-broker-integration-${unique}.log`,
      undefined,
      {
        onAttached: (pid) => {
          attachedPid = pid
        },
        onData: (data) => {
          output += data
        },
        onExit: () => undefined,
      },
    )

    await withTimeout(client.shutdown(), 8_000)
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(existsSync(descriptorPath)).toBe(false)
    expect(attachedPid).toBeUndefined()
    expect(output).not.toContain('ORPHAN_STARTED')
  })

  test('shutdown kills a Node-spawned detached descendant before resolving', async () => {
    const unique = `detached-descendant-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const sessionId = `session-${process.pid}-${Date.now()}`
    const ready = deferred<void>()
    let output = ''
    let detachedPid: number | undefined
    const client = new TerminalSessionBrokerClient({
      identity,
      shutdownTimeoutMs: 4_000,
    })
    const nodeCode =
      "const {spawn}=require('child_process');" +
      "const c=spawn('/bin/sh',['-c','while :; do sleep 1; done']," +
      "{detached:true,stdio:'ignore'});" +
      "console.log('DETACHED_PID:'+c.pid);c.unref();"

    try {
      client.start(
        sessionId,
        {
          command: '/bin/sh',
          args: [
            '-c',
            `node -e ${JSON.stringify(nodeCode)}; echo READY; while :; do sleep 1; done`,
          ],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        `/tmp/taskchute-broker-integration-${unique}.log`,
        undefined,
        {
          onData: (data) => {
            output += data
            const match = /DETACHED_PID:(\d+)/u.exec(output)
            if (match) detachedPid = Number(match[1])
            if (output.includes('READY') && detachedPid !== undefined) {
              ready.resolve()
            }
          },
          onExit: () => undefined,
          onUnavailable: () =>
            ready.reject(new Error('Detached descendant session was unavailable')),
        },
      )

      await withTimeout(ready.promise)
      expect(detachedPid).toEqual(expect.any(Number))
      await withTimeout(client.shutdown(), 8_000)
      expect(() => process.kill(detachedPid ?? -1, 0)).toThrow()
      expect(existsSync(getTerminalBrokerDescriptorPath(identity))).toBe(false)
    } finally {
      if (detachedPid !== undefined) {
        try {
          process.kill(-detachedPid, 'SIGKILL')
        } catch {
          try {
            process.kill(detachedPid, 'SIGKILL')
          } catch {
            // Already reaped by the broker.
          }
        }
      }
      await client.shutdown().catch(() => undefined)
    }
  })

  test('natural root exit reaps a detached child that keeps inherited stdio open', async () => {
    const unique = `natural-exit-detached-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const exited = deferred<void>()
    let output = ''
    let detachedPid: number | undefined
    const client = new TerminalSessionBrokerClient({
      identity,
      shutdownTimeoutMs: 5_000,
    })
    const nodeCode =
      "const {spawn}=require('child_process');" +
      "const child=spawn('/bin/sh',['-c','while :; do sleep 10; done']," +
      "{detached:true,stdio:'inherit'});" +
      "console.log('DETACHED_PID:'+child.pid);child.unref();"

    try {
      client.start(
        `session-${unique}`,
        {
          command: 'node',
          args: ['-e', nodeCode],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onData: (data) => {
            output += data
            const match = /DETACHED_PID:(\d+)/u.exec(output)
            if (match) detachedPid = Number(match[1])
          },
          onExit: () => exited.resolve(),
          onUnavailable: () =>
            exited.reject(new Error('Natural-exit session was unavailable')),
        },
      )

      await withTimeout(exited.promise)
      expect(detachedPid).toEqual(expect.any(Number))
      expect(() => process.kill(detachedPid ?? -1, 0)).toThrow()
      await withTimeout(client.shutdown())
    } finally {
      if (detachedPid !== undefined) {
        try {
          process.kill(-detachedPid, 'SIGKILL')
        } catch {
          // Already reaped by the broker.
        }
      }
      await client.shutdown().catch(() => undefined)
    }
  })

  test('shutdown tracks a detached child created by promisified exec', async () => {
    const unique = `promisified-detached-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const ready = deferred<void>()
    let output = ''
    let detachedPid: number | undefined
    const client = new TerminalSessionBrokerClient({
      identity,
      shutdownTimeoutMs: 5_000,
    })
    const nodeCode =
      "const {promisify}=require('util');" +
      "const cp=require('child_process');" +
      "const pending=promisify(cp.exec)('while :; do sleep 10; done'," +
      "{detached:true});" +
      "console.log('DETACHED_PID:'+pending.child.pid);pending.child.unref();" +
      "setInterval(()=>{},1000);"

    try {
      client.start(
        `session-${unique}`,
        {
          command: 'node',
          args: ['-e', nodeCode],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onData: (data) => {
            output += data
            const match = /DETACHED_PID:(\d+)/u.exec(output)
            if (match) {
              detachedPid = Number(match[1])
              ready.resolve()
            }
          },
          onExit: () => undefined,
          onUnavailable: () =>
            ready.reject(new Error('Promisified detached session was unavailable')),
        },
      )

      await withTimeout(ready.promise)
      await withTimeout(client.shutdown())
      expect(() => process.kill(detachedPid ?? -1, 0)).toThrow()
    } finally {
      if (detachedPid !== undefined) {
        try {
          process.kill(-detachedPid, 'SIGKILL')
        } catch {
          // Already reaped by the broker.
        }
      }
      await client.shutdown().catch(() => undefined)
    }
  })

  test('Python intermediary tracking chains sitecustomize and survives a localized broker environment', async () => {
    if (!existsSync('/usr/bin/python3')) return
    const unique = `python-detached-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const customSiteDir = mkdtempSync(join(tmpdir(), 'taskchute-sitecustomize-'))
    const markerPath = join(customSiteDir, 'existing-sitecustomize-ran')
    writeFileSync(
      join(customSiteDir, 'sitecustomize.py'),
      "import os\nopen(os.environ['TASKCHUTE_TEST_SITE_MARKER'], 'w').write('CHAINED')\n",
      { mode: 0o600 },
    )
    const ready = deferred<void>()
    let output = ''
    let detachedPid: number | undefined
    const client = new TerminalSessionBrokerClient({
      identity,
      shutdownTimeoutMs: 5_000,
      getEnv: () => ({
        ...process.env,
        LC_ALL: 'fr_FR.UTF-8',
        LANG: 'fr_FR.UTF-8',
      }),
    })
    const pythonCode =
      "import subprocess; p = subprocess.Popen(['/bin/sh', '-c', 'while :; do sleep 10; done'], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); print('DETACHED_PID:' + str(p.pid), flush=True)"
    const nodeCode =
      "const {spawn}=require('child_process');" +
      `const child=spawn('/usr/bin/python3',['-c',${JSON.stringify(pythonCode)}],` +
      "{stdio:['ignore','pipe','inherit']});" +
      "child.stdout.pipe(process.stdout);" +
      "child.on('close',()=>console.log('READY'));"

    try {
      client.start(
        `session-${unique}`,
        {
          command: '/bin/sh',
          args: [
            '-c',
            `node -e ${JSON.stringify(nodeCode)}; while :; do sleep 10; done`,
          ],
          env: {
            ...process.env,
            PYTHONPATH: customSiteDir,
            TASKCHUTE_TEST_SITE_MARKER: markerPath,
          },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onData: (data) => {
            output += data
            const match = /DETACHED_PID:(\d+)/u.exec(output)
            if (match) detachedPid = Number(match[1])
            if (output.includes('READY') && detachedPid !== undefined) {
              ready.resolve()
            }
          },
          onExit: () => undefined,
          onUnavailable: () =>
            ready.reject(new Error('Python detached session was unavailable')),
        },
      )

      await withTimeout(ready.promise)
      expect(existsSync(markerPath)).toBe(true)
      await withTimeout(client.shutdown())
      expect(() => process.kill(detachedPid ?? -1, 0)).toThrow()
      const hookPrefix = `${basename(descriptorPath)}.owner-python-`
      expect(
        readdirSync(dirname(descriptorPath)).filter((name) =>
          name.startsWith(hookPrefix)),
      ).toEqual([])
    } finally {
      if (detachedPid !== undefined) {
        try {
          process.kill(-detachedPid, 'SIGKILL')
        } catch {
          // Already reaped by the broker.
        }
      }
      await client.shutdown().catch(() => undefined)
      rmSync(customSiteDir, { force: true, recursive: true })
    }
  })

  test.each([
    ['direct', '/usr/bin/python3 -S'],
    ['ignore environment', '/usr/bin/python3 -E'],
    ['isolated mode', '/usr/bin/python3 -I'],
    ['combined flags', '/usr/bin/python3 -ES'],
    ['env launcher', '/usr/bin/env python3 -B -S'],
    ['env clear', '/usr/bin/env -i /usr/bin/python3'],
    ['env unset Python path', '/usr/bin/env -u PYTHONPATH /usr/bin/python3'],
    ['env replace Python path', '/usr/bin/env PYTHONPATH= /usr/bin/python3'],
    ['shell command prefix', 'command /usr/bin/python3 -S'],
  ])('rejects %s hook-disabling Python flags before they can leak a detached child', async (
    label,
    pythonLaunch,
  ) => {
    if (!existsSync('/usr/bin/python3')) return
    const safeLabel = label.replace(/[^A-Za-z0-9_-]/gu, '-')
    const unique =
      `python-no-site-detached-${safeLabel}-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const failed = deferred<{
      status: string
      errorMessage?: string
    }>()
    let output = ''
    const client = new TerminalSessionBrokerClient({
      identity,
      shutdownTimeoutMs: 6_000,
    })
    const pythonCode =
      "import subprocess; p = subprocess.Popen(['/bin/sh', '-c', 'while :; do sleep 10; done'], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); print('DETACHED_PID:' + str(p.pid), flush=True)"

    try {
      client.start(
        `session-${unique}`,
        {
          command: '/bin/sh',
          args: [
            '-c',
            `${pythonLaunch} -c ${JSON.stringify(pythonCode)}; echo READY; while :; do sleep 10; done`,
          ],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onData: (data) => {
            output += data
          },
          onExit: failed.resolve,
          onUnavailable: () =>
            failed.reject(new Error('Python -S rejection was unavailable')),
        },
      )

      const outcome = await withTimeout(failed.promise)
      expect(outcome.status).toBe('failed')
      expect(outcome.errorMessage).toContain(
        'Python interpreter flags',
      )
      expect(output).not.toContain('DETACHED_PID:')
      expect(output).not.toContain('READY')
    } finally {
      await client.shutdown().catch(() => undefined)
    }
  })

  test.each(['-S', '-E', '-I', '-ES'])(
    'rejects Python %s through the production PTY wrapper shape before spawn',
    async (pythonFlag) => {
    if (!existsSync('/usr/bin/python3')) return
    const unique =
      `python-no-site-production-pty-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const failed = deferred<{ status: string; errorMessage?: string }>()
    const transcriptPath = join(tmpdir(), `taskchute-broker-${unique}.log`)
    const gateway = new NodeProcessGateway()
    const ptyCommand = gateway.buildPtyCommand({
      binaryPath: '/usr/bin/python3',
      args: [pythonFlag, '-c', 'print("SHOULD_NOT_RUN")'],
      rows: 24,
      cols: 80,
      transcriptPath,
    })
    const client = new TerminalSessionBrokerClient({ identity })
    let output = ''
    try {
      client.start(
        `session-${unique}`,
        {
          command: ptyCommand.command,
          args: ptyCommand.args,
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        transcriptPath,
        undefined,
        {
          onData: (data) => {
            output += data
          },
          onExit: failed.resolve,
          onUnavailable: () =>
            failed.reject(new Error('Production PTY rejection was unavailable')),
        },
      )

      const outcome = await withTimeout(failed.promise)
      expect(outcome.status).toBe('failed')
      expect(outcome.errorMessage).toContain('Python interpreter flags')
      expect(output).not.toContain('SHOULD_NOT_RUN')
    } finally {
      await client.shutdown().catch(() => undefined)
      rmSync(transcriptPath, { force: true })
      rmSync(`${transcriptPath}.tty`, { force: true })
    }
    },
  )

  test.each([
    ['clear environment', ['-i']],
    ['unset Node options', ['-u', 'NODE_OPTIONS']],
    ['replace Node options', ['NODE_OPTIONS=']],
  ])(
    'rejects production PTY env launch that would %s',
    async (_label, envArgs) => {
      const unique =
        `owner-env-production-pty-${process.pid}-${Date.now()}-${Math.random()}`
      const identity = `broker-integration-${unique}`
      const failed = deferred<{ status: string; errorMessage?: string }>()
      const transcriptPath = join(tmpdir(), `taskchute-broker-${unique}.log`)
      const gateway = new NodeProcessGateway()
      const ptyCommand = gateway.buildPtyCommand({
        binaryPath: '/usr/bin/env',
        args: [
          ...envArgs,
          process.execPath,
          '-e',
          'console.log("SHOULD_NOT_RUN")',
        ],
        rows: 24,
        cols: 80,
        transcriptPath,
      })
      const client = new TerminalSessionBrokerClient({ identity })
      let output = ''
      try {
        client.start(
          `session-${unique}`,
          {
            command: ptyCommand.command,
            args: ptyCommand.args,
            env: { ...process.env },
            stdinMode: 'pipe',
          },
          transcriptPath,
          undefined,
          {
            onData: (data) => {
              output += data
            },
            onExit: failed.resolve,
            onUnavailable: () =>
              failed.reject(new Error('Environment rejection was unavailable')),
          },
        )

        const outcome = await withTimeout(failed.promise)
        expect(outcome.status).toBe('failed')
        expect(outcome.errorMessage).toContain(
          'Ownership-disabling environment options',
        )
        expect(output).not.toContain('SHOULD_NOT_RUN')
      } finally {
        await client.shutdown().catch(() => undefined)
        rmSync(transcriptPath, { force: true })
        rmSync(`${transcriptPath}.tty`, { force: true })
      }
    },
  )

  test('a malformed owner record fails cleanup in bounded time instead of hanging', async () => {
    const unique =
      `owner-malformed-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const ready = deferred<void>()
    const exited = deferred<{ status: string; errorMessage?: string }>()
    const client = new TerminalSessionBrokerClient({ identity })
    const nodeCode =
      "const fs=require('fs');" +
      "fs.appendFileSync(process.env.TASKCHUTE_BROKER_OWNER_PID_FILE,'{malformed}\\n');" +
      "console.log('READY');process.stdin.once('data',()=>process.exit(0));"
    try {
      client.start(
        `session-${unique}`,
        {
          command: 'node',
          args: ['-e', nodeCode],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onData: (data) => {
            if (data.includes('READY')) ready.resolve()
          },
          onExit: exited.resolve,
          onUnavailable: () =>
            exited.reject(new Error('Malformed owner session was unavailable')),
        },
      )

      await withTimeout(ready.promise)
      client.write(`session-${unique}`, 'exit\n')
      const outcome = await withTimeout(exited.promise, 4_000)
      expect(outcome.status).toBe('failed')
      expect(outcome.errorMessage).toContain(
        'ownership tracking became unavailable',
      )
    } finally {
      await client.shutdown().catch(() => undefined)
    }
  })

  test('a newline-free partial owner record fails closed without signalling its PID', async () => {
    const unique =
      `owner-partial-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const sessionId = `session-${unique}`
    const ready = deferred<void>()
    const exited = deferred<{ status: string; errorMessage?: string }>()
    const client = new TerminalSessionBrokerClient({ identity })
    let detached: ReturnType<typeof spawnChild> | undefined
    try {
      client.start(
        sessionId,
        {
          command: '/bin/sh',
          args: ['-c', 'printf "READY\\n"; IFS= read -r _'],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onData: (data) => {
            if (data.includes('READY')) ready.resolve()
          },
          onExit: exited.resolve,
          onUnavailable: () =>
            exited.reject(new Error('Partial owner session was unavailable')),
        },
      )

      await withTimeout(ready.promise)
      const [ownerPidFile] = ownerPidFiles(descriptorPath)
      expect(ownerPidFile).toBeDefined()
      detached = spawnChild(
        '/bin/sh',
        ['-c', 'while :; do sleep 10; done'],
        { detached: true, stdio: 'ignore' },
      )
      detached.unref()
      const detachedPid = detached.pid
      expect(detachedPid).toEqual(expect.any(Number))
      const startedAt = Date.parse(
        execFileSync(
          '/bin/ps',
          ['-p', String(detachedPid), '-o', 'lstart='],
          {
            encoding: 'utf8',
            env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
          },
        ).trim(),
      )
      expect(Number.isFinite(startedAt)).toBe(true)
      writeFileSync(
        ownerPidFile,
        `{"pid":${detachedPid},"startedAt":${startedAt},"startedAtLower":${startedAt}`,
        { flag: 'a' },
      )

      client.write(sessionId, 'exit\n')
      const outcome = await withTimeout(exited.promise, 4_000)
      expect(outcome.status).toBe('failed')
      expect(outcome.errorMessage).toContain(
        'ownership tracking became unavailable',
      )
      expect(() => process.kill(detachedPid ?? -1, 0)).not.toThrow()
    } finally {
      if (detached?.pid !== undefined) {
        try {
          process.kill(-detached.pid, 'SIGKILL')
        } catch {
          // Already terminated during test cleanup.
        }
      }
      await client.shutdown().catch(() => undefined)
    }
  })

  test.each(['file', 'hooks'])(
    'ownership %s setup failure rejects before spawning and leaves no pid file',
    async (failureMode) => {
      const unique =
        `owner-setup-${failureMode}-${process.pid}-${Date.now()}-${Math.random()}`
      const identity = `broker-integration-${unique}`
      const descriptorPath = getTerminalBrokerDescriptorPath(identity)
      const markerPath = join(tmpdir(), `taskchute-owner-spawned-${unique}`)
      const failed = deferred<{ status: string; errorMessage?: string }>()
      const client = new TerminalSessionBrokerClient({
        identity,
        getEnv: () => ({
          ...process.env,
          TASKCHUTE_BROKER_TEST_OWNER_SETUP_FAILURE: failureMode,
        }),
      })
      try {
        client.start(
          `session-${unique}`,
          {
            command: '/bin/sh',
            args: ['-c', `printf spawned > ${JSON.stringify(markerPath)}`],
            env: { ...process.env },
            stdinMode: 'pipe',
          },
          join(tmpdir(), `taskchute-broker-${unique}.log`),
          undefined,
          {
            onData: () => undefined,
            onExit: failed.resolve,
            onUnavailable: () =>
              failed.reject(new Error('Owner setup rejection was unavailable')),
          },
        )

        const outcome = await withTimeout(failed.promise)
        expect(outcome.status).toBe('failed')
        expect(outcome.errorMessage).toContain(
          failureMode === 'file' ? 'tracking could not' : 'hooks could not',
        )
        expect(existsSync(markerPath)).toBe(false)
        expect(ownerPidFiles(descriptorPath)).toEqual([])
      } finally {
        await client.shutdown().catch(() => undefined)
        rmSync(markerPath, { force: true })
      }
    },
  )

  test('an asynchronous ENOENT spawn fails without crashing the broker', async () => {
    const unique =
      `owner-enoent-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const failed = deferred<{ status: string; errorMessage?: string }>()
    const recovered = deferred<void>()
    const client = new TerminalSessionBrokerClient({ identity })
    try {
      client.start(
        `session-missing-${unique}`,
        {
          command: `/definitely-missing-taskchute-${unique}`,
          args: [],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-missing-${unique}.log`),
        undefined,
        {
          onData: () => undefined,
          onExit: failed.resolve,
          onUnavailable: () =>
            failed.reject(new Error('Missing binary was unavailable')),
        },
      )

      const outcome = await withTimeout(failed.promise)
      expect(outcome.status).toBe('failed')
      expect(ownerPidFiles(descriptorPath)).toEqual([])

      client.start(
        `session-recovered-${unique}`,
        {
          command: '/bin/sh',
          args: ['-c', 'printf "BROKER_RECOVERED\\n"'],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-recovered-${unique}.log`),
        undefined,
        {
          onData: (data) => {
            if (data.includes('BROKER_RECOVERED')) recovered.resolve()
          },
          onExit: () => undefined,
          onUnavailable: () =>
            recovered.reject(new Error('Broker did not recover after ENOENT')),
        },
      )
      await withTimeout(recovered.promise)
    } finally {
      await client.shutdown().catch(() => undefined)
    }
  })

  test('does not reject quoted Python -S text that is not a shell command', async () => {
    const unique = `python-no-site-literal-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const exited = deferred<void>()
    let output = ''
    const client = new TerminalSessionBrokerClient({ identity })
    try {
      client.start(
        `session-${unique}`,
        {
          command: '/bin/sh',
          args: [
            '-c',
            `printf '%s\\n' '; python3 -S' 'READY'`,
          ],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onData: (data) => {
            output += data
          },
          onExit: (outcome) => {
            if (outcome.status === 'succeeded') exited.resolve()
            else exited.reject(new Error(`Unexpected exit: ${outcome.status}`))
          },
          onUnavailable: () =>
            exited.reject(new Error('Literal shell session was unavailable')),
        },
      )

      await withTimeout(exited.promise)
      expect(output).toContain('; python3 -S')
      expect(output).toContain('READY')
    } finally {
      await client.shutdown().catch(() => undefined)
    }
  })

  test('owner-record backlog cannot hide a detached child at the tail', async () => {
    const unique = `owner-backlog-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const ready = deferred<void>()
    let output = ''
    let detachedPid: number | undefined
    const client = new TerminalSessionBrokerClient({
      identity,
      shutdownTimeoutMs: 5_000,
    })
    const nodeCode =
      "const fs=require('fs');const cp=require('child_process');" +
      "const file=process.env.TASKCHUTE_BROKER_OWNER_PID_FILE;" +
      "const record=JSON.stringify({pid:999999,startedAt:1,active:false})+'\\n';" +
      "fs.appendFileSync(file,record.repeat(1800));" +
      "const child=cp.spawn('/bin/sh',['-c','while :; do sleep 10; done']," +
      "{detached:true,stdio:'ignore'});" +
      "console.log('DETACHED_PID:'+child.pid);child.unref();" +
      "setInterval(()=>{},1000);"

    try {
      client.start(
        `session-${unique}`,
        {
          command: 'node',
          args: ['-e', nodeCode],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onData: (data) => {
            output += data
            const match = /DETACHED_PID:(\d+)/u.exec(output)
            if (match) {
              detachedPid = Number(match[1])
              ready.resolve()
            }
          },
          onExit: () => undefined,
          onUnavailable: () =>
            ready.reject(new Error('Owner-backlog session was unavailable')),
        },
      )

      await withTimeout(ready.promise)
      await withTimeout(client.shutdown(), 10_000)
      expect(() => process.kill(detachedPid ?? -1, 0)).toThrow()
    } finally {
      if (detachedPid !== undefined) {
        try {
          process.kill(-detachedPid, 'SIGKILL')
        } catch {
          // Already reaped by the broker.
        }
      }
      await client.shutdown().catch(() => undefined)
    }
  })

  test('the Node ownership hook preserves custom promisify contracts', async () => {
    const unique = `owner-hook-promisify-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const exited = deferred<void>()
    let output = ''
    const client = new TerminalSessionBrokerClient({ identity })
    const nodeCode =
      "const {promisify}=require('util');" +
      "const cp=require('child_process');" +
      "promisify(cp.exec)('printf hook-ok').then(result=>" +
      "console.log('PROMISIFY:'+typeof result+':'+result.stdout));"

    try {
      client.start(
        `session-${unique}`,
        {
          command: '/bin/sh',
          args: ['-c', `node -e ${JSON.stringify(nodeCode)}`],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        `/tmp/taskchute-broker-integration-${unique}.log`,
        undefined,
        {
          onData: (data) => {
            output += data
          },
          onExit: (outcome) => {
            if (outcome.status === 'succeeded') exited.resolve()
            else exited.reject(new Error(
              `Unexpected outcome: ${outcome.status}: ${outcome.errorMessage ?? ''}: ${output}`,
            ))
          },
          onUnavailable: () =>
            exited.reject(new Error('Owner-hook session was unavailable')),
        },
      )

      await withTimeout(exited.promise)
      expect(output).toContain('PROMISIFY:object:hook-ok')
    } finally {
      await client.shutdown().catch(() => undefined)
    }
  })

  test('two renderer clients can shut down the same live broker concurrently', async () => {
    const unique = `concurrent-shutdown-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-integration-${unique}`
    const sessionId = `session-${process.pid}-${Date.now()}`
    const firstAttached = deferred<number | undefined>()
    const secondAttached = deferred<number | undefined>()
    const ready = deferred<void>()
    const first = new TerminalSessionBrokerClient({ identity })
    const second = new TerminalSessionBrokerClient({ identity })

    first.start(
      sessionId,
      {
        command: '/bin/sh',
        args: ['-c', 'printf "READY\\n"; while :; do sleep 1; done'],
        env: { ...process.env },
        stdinMode: 'pipe',
      },
      `/tmp/taskchute-broker-integration-${unique}.log`,
      undefined,
      {
        onAttached: firstAttached.resolve,
        onData: (data) => {
          if (data.includes('READY')) ready.resolve()
        },
        onExit: () => undefined,
      },
    )
    const childPid = await withTimeout(firstAttached.promise)
    await withTimeout(ready.promise)
    second.attach(sessionId, {
      onAttached: secondAttached.resolve,
      onData: () => undefined,
      onExit: () => undefined,
      onUnavailable: () => secondAttached.reject(
        new Error('Second renderer could not attach'),
      ),
    })
    expect(await withTimeout(secondAttached.promise)).toBe(childPid)

    await withTimeout(Promise.all([first.shutdown(), second.shutdown()]))

    expect(() => process.kill(childPid ?? -1, 0)).toThrow()
    expect(existsSync(getTerminalBrokerDescriptorPath(identity))).toBe(false)
  })
})
