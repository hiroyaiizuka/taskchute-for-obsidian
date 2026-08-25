import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync as fsWriteFileSync,
} from 'fs'
import { execFileSync, spawn } from 'child_process'
import { createConnection, createServer, type AddressInfo } from 'net'
import { tmpdir } from 'os'
import type { Writable } from 'stream'
import { basename, dirname, join } from 'path'

import {
  getTerminalBrokerDescriptorPath,
  TerminalSessionBrokerClient,
  type TerminalBrokerSessionCallbacks,
} from '../../../src/features/ai-task/services/TerminalSessionBroker'
import { NodeProcessGateway } from '../../../src/features/ai-task/services/NodeProcessGateway'
import { TERMINAL_BROKER_SOURCE } from '../../../src/features/ai-task/services/TerminalSessionBrokerSource'
import { TERMINAL_SESSION_GUARD_SOURCE } from '../../../src/features/ai-task/services/TerminalSessionGuardSource'
import { TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE } from '../../../src/features/ai-task/services/TerminalSessionOwnerWatchdogSource'

function writeFileSync(
  path: Parameters<typeof fsWriteFileSync>[0],
  data: Parameters<typeof fsWriteFileSync>[1],
  options?: Parameters<typeof fsWriteFileSync>[2],
): void {
  if (options && typeof options === 'object') {
    fsWriteFileSync(path, data, { ...options, mode: options.mode ?? 0o600 })
    return
  }
  if (options !== undefined) {
    fsWriteFileSync(path, data, options)
    return
  }
  fsWriteFileSync(path, data, { mode: 0o600 })
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = 15_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Broker resilience test timed out')),
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sourceSection(
  source: string,
  start: string,
  end: string,
): string {
  const endIndex = source.lastIndexOf(end)
  const startIndex = source.lastIndexOf(start, endIndex)
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Unable to extract source section: ${start}`)
  }
  return source.slice(startIndex, endIndex)
}

function ownerArtifactPaths(descriptorPath: string): string[] {
  const directory = dirname(descriptorPath)
  const prefix = `${basename(descriptorPath)}.owner-`
  return readdirSync(directory)
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(directory, name))
}

function spawnOwnerWatchdogForTest(
  ownerPrefix: string,
  descriptorPath: string,
  extraEnv: Record<string, string> = {},
) {
  const token = 'b'.repeat(64)
  const ready = deferred<void>()
  const child = spawn(
    process.execPath,
    ['-e', TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE],
    {
      detached: true,
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        TASKCHUTE_OWNER_WATCH_PREFIX: ownerPrefix,
        TASKCHUTE_OWNER_WATCH_DESCRIPTOR: descriptorPath,
        TASKCHUTE_OWNER_WATCH_TOKEN: token,
        TASKCHUTE_OWNER_WATCH_BROKER_PID: String(process.pid),
        TASKCHUTE_OWNER_WATCH_HOOK: `${descriptorPath}.owner-hook-test.cjs`,
        TASKCHUTE_OWNER_WATCH_PYTHON: `${descriptorPath}.owner-python-test`,
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    },
  )
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (data: string) => {
    if (data.includes('READY')) ready.resolve()
  })
  child.once('error', ready.reject)
  return { child, ready: ready.promise }
}

type MockWindowsGuardOwnership = 'match' | 'mismatch' | 'unknown' | 'dead'

async function runMockWindowsGuardIdentityScenario(
  ownership: MockWindowsGuardOwnership,
  taskkillFails: boolean,
): Promise<{ taskkillCalls: number; childKillCalls: number }> {
  const unique =
    `guard-windows-identity-${process.pid}-${Date.now()}-${Math.random()}`
  const ownerPath = join(tmpdir(), `taskchute-guard-owner-${unique}.jsonl`)
  const markerPath = join(tmpdir(), `taskchute-guard-signal-${unique}.json`)
  const guardToken = 'c'.repeat(48)
  const targetPid = 424_260
  writeFileSync(ownerPath, '')
  writeFileSync(markerPath, JSON.stringify({
    taskkillCalls: 0,
    childKillCalls: 0,
  }))
  const request = Buffer.from(JSON.stringify({
    command: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    guardToken,
    controlFd: 3,
  })).toString('base64')
  const bootstrap =
    "const fs=require('fs');" +
    "const cp=require('child_process');" +
    "const {EventEmitter}=require('events');" +
    "const {PassThrough}=require('stream');" +
    "Object.defineProperty(process,'platform',{value:'win32'});" +
    "Date.now=()=>1700000000000;" +
    `const ownership=${JSON.stringify(ownership)};` +
    `const marker=${JSON.stringify(markerPath)};` +
    "const state={taskkillCalls:0,childKillCalls:0};" +
    "const save=()=>fs.writeFileSync(marker,JSON.stringify(state));" +
    "process.kill=(pid,signal)=>{" +
      `if(pid===${String(targetPid)}&&signal===0&&ownership==='dead'){` +
        "const error=new Error('missing');error.code='ESRCH';throw error" +
      "}" +
      "return true" +
    "};" +
    "let fakeChild;" +
    "const finish=signal=>queueMicrotask(()=>{" +
      "fakeChild.emit('exit',null,signal);" +
      "fakeChild.stdout.end();fakeChild.stderr.end();" +
      "fakeChild.emit('close',null,signal)" +
    "});" +
    "cp.spawn=()=>{" +
      "fakeChild=new EventEmitter();" +
      `fakeChild.pid=${String(targetPid)};` +
      "fakeChild.stdin=new PassThrough();" +
      "fakeChild.stdout=new PassThrough();" +
      "fakeChild.stderr=new PassThrough();" +
      "fakeChild.kill=signal=>{" +
        "state.childKillCalls+=1;save();finish(signal);return true" +
      "};" +
      "return fakeChild" +
    "};" +
    "cp.execFileSync=(file,args)=>{" +
      "if(String(file).toLowerCase().includes('taskkill')){" +
        "state.taskkillCalls+=1;save();" +
        (taskkillFails
          ? "throw new Error('taskkill failed');"
          : "finish('SIGKILL');return Buffer.alloc(0);") +
      "}" +
      "if(ownership==='unknown')throw new Error('Get-Process failed');" +
      "return new Date(ownership==='mismatch'?1699999999000:1700000000000).toISOString()" +
    "};" +
    `(0,eval)(${JSON.stringify(TERMINAL_SESSION_GUARD_SOURCE)});`
  const guard = spawn(
    process.execPath,
    ['-e', bootstrap, guardToken],
    {
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        TASKCHUTE_SESSION_GUARD_REQUEST: request,
        TASKCHUTE_BROKER_OWNER_PID_FILE: ownerPath,
      },
      stdio: ['pipe', 'ignore', 'ignore', 'pipe'],
    },
  )
  try {
    await sleep(75)
    guard.stdin?.end()
    if (ownership === 'match' || ownership === 'dead' || ownership === 'mismatch') {
      await withTimeout(new Promise<void>((resolve, reject) => {
        guard.once('exit', () => resolve())
        guard.once('error', reject)
      }))
    } else {
      await sleep(225)
      expect(guard.exitCode).toBeNull()
    }
    return JSON.parse(readFileSync(markerPath, 'utf8')) as {
      taskkillCalls: number
      childKillCalls: number
    }
  } finally {
    if (guard.pid) {
      try { process.kill(guard.pid, 'SIGKILL') } catch {
        // A birth-matched scenario already exited through its fake target.
      }
    }
    rmSync(ownerPath, { force: true })
    rmSync(markerPath, { force: true })
  }
}

const OVERSIZED_FRAME = 'x'.repeat(1024 * 1024 + 64 * 1024)

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('TerminalSessionBroker resilience', () => {
  jest.setTimeout(30_000)

  test('every authenticated shutdown waiter receives an ACK after fan-out begins', async () => {
    const unique = `shutdown-waiters-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-resilience-${unique}`
    const sessionId = `session-shutdown-waiters-${process.pid}-${Date.now()}`
    const rendererLeaseToken = `lease-${unique}`
    const rendererLeaseOwnerId = 'taskchute-plus-ai-terminal'
    const rendererLeaseGeneration = 1
    const client = new TerminalSessionBrokerClient({
      identity,
      rendererLeaseToken,
      rendererLeaseOwnerId,
      rendererLeaseGeneration,
    })
    const exited = deferred<void>()
    let firstControl: ReturnType<typeof createConnection> | null = null
    let lateControl: ReturnType<typeof createConnection> | null = null
    try {
      // Start the real broker through its production client, then let the
      // short-lived child exit. The broker remains available for raw socket
      // protocol assertions.
      client.start(
        sessionId,
        {
          command: '/bin/sh',
          args: ['-c', 'exit 0'],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onData: () => undefined,
          onExit: () => exited.resolve(),
          onUnavailable: () => exited.reject(new Error('Broker session was unavailable')),
        },
      )
      await withTimeout(exited.promise)
      const descriptor = JSON.parse(
        readFileSync(getTerminalBrokerDescriptorPath(identity), 'utf8'),
      ) as { port: number; token: string }

      firstControl = createConnection({
        host: '127.0.0.1',
        port: descriptor.port,
      })
      lateControl = createConnection({
        host: '127.0.0.1',
        port: descriptor.port,
      })
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          firstControl?.once('connect', resolve)
          firstControl?.once('error', reject)
        }),
        new Promise<void>((resolve, reject) => {
          lateControl?.once('connect', resolve)
          lateControl?.once('error', reject)
        }),
      ])

      const firstAck = deferred<void>()
      let firstBuffer = ''
      firstControl.setEncoding('utf8')
      firstControl.on('data', (chunk) => {
        firstBuffer += chunk.toString()
        if (firstBuffer.includes('"type":"shutdown-ack"')) firstAck.resolve()
      })

      // Authenticate the second socket before shutdown starts. server.close()
      // stops new accepts but deliberately leaves this connection alive.
      const lateAuthenticated = deferred<void>()
      const lateAck = deferred<void>()
      let lateBuffer = ''
      lateControl.setEncoding('utf8')
      lateControl.on('data', (chunk) => {
        lateBuffer += chunk.toString()
        if (lateBuffer.includes('"type":"missing"')) lateAuthenticated.resolve()
        if (lateBuffer.includes('"type":"shutdown-ack"')) lateAck.resolve()
      })
      lateControl.write(`${JSON.stringify({
        token: descriptor.token,
        op: 'attach',
        sessionId: 'missing-shutdown-waiter',
        rendererLeaseToken,
        rendererLeaseOwnerId,
        rendererLeaseGeneration,
      })}\n`)
      await withTimeout(lateAuthenticated.promise)

      firstControl.write(`${JSON.stringify({
        token: descriptor.token,
        op: 'shutdown',
        rendererLeaseToken,
        rendererLeaseOwnerId,
        rendererLeaseGeneration,
      })}\n`)
      await withTimeout(firstAck.promise)

      // This request arrives after the first ACK fan-out has cleared the
      // waiter set. It must receive its own ACK instead of waiting for the
      // renderer-side shutdown timeout.
      lateControl.write(`${JSON.stringify({
        token: descriptor.token,
        op: 'shutdown',
        rendererLeaseToken,
        rendererLeaseOwnerId,
        rendererLeaseGeneration,
      })}\n`)
      await withTimeout(lateAck.promise, 750)
    } finally {
      firstControl?.destroy()
      lateControl?.destroy()
      await client.shutdown()
    }
  })

  test('terminate-unavailable confirms the broker-owned child is dead before acknowledging', async () => {
    const unique = `terminate-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-resilience-${unique}`
    const sessionId = `session-terminate-${process.pid}-${Date.now()}`
    const transcriptPath = join(tmpdir(), `taskchute-broker-${unique}.log`)
    const rendererLeaseToken = `lease-${unique}`
    const rendererLeaseOwnerId = 'taskchute-plus-ai-terminal'
    const rendererLeaseGeneration = 1
    const client = new TerminalSessionBrokerClient({
      identity,
      rendererLeaseToken,
      rendererLeaseOwnerId,
      rendererLeaseGeneration,
    })
    const ready = deferred<void>()
    const attached = deferred<number>()
    try {
      client.start(
        sessionId,
        {
          command: '/bin/sh',
          args: [
            '-c',
            'printf "READY\\n"; while :; do sleep 1; done',
          ],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        transcriptPath,
        undefined,
        {
          onAttached: (pid) => {
            if (pid !== undefined) attached.resolve(pid)
          },
          onData: (data) => {
            if (data.includes('READY')) ready.resolve()
          },
          onExit: () => undefined,
        },
      )
      const childPid = await withTimeout(attached.promise)
      await withTimeout(ready.promise)
      const descriptor = JSON.parse(
        readFileSync(getTerminalBrokerDescriptorPath(identity), 'utf8'),
      ) as { port: number; token: string }

      // Reproduce the control path used after the ordinary replay socket has
      // become unusable. The termination socket receives no replay/data.
      client.detach()
      const terminated = deferred<{
        interrupted: boolean
        outcome?: { status?: string }
      }>()
      const control = createConnection({
        host: '127.0.0.1',
        port: descriptor.port,
      })
      let buffer = ''
      control.setEncoding('utf8')
      control.on('error', (error) => terminated.reject(error))
      control.on('data', (chunk) => {
        buffer += chunk.toString()
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        terminated.resolve(JSON.parse(buffer.slice(0, newline)))
      })
      await new Promise<void>((resolve) => control.on('connect', resolve))
      control.write(`${JSON.stringify({
        token: descriptor.token,
        op: 'terminate-unavailable',
        sessionId,
        rendererLeaseToken,
        rendererLeaseOwnerId,
        rendererLeaseGeneration,
      })}\n`)

      const acknowledgment = await withTimeout(terminated.promise)
      expect(acknowledgment).toMatchObject({
        interrupted: true,
        outcome: { status: 'stopped' },
      })
      // The source emits the acknowledgement from finish(), which only runs
      // after the wrapper child close event. PID liveness is checked as an
      // independent process-level assertion.
      expect(() => process.kill(childPid, 0)).toThrow()
      control.end()
      control.destroy()
    } finally {
      await client.shutdown()
    }
  })

  test('termination continues when the isolated control socket closes before child close', async () => {
    const unique = `terminate-close-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-resilience-${unique}`
    const sessionId = `session-terminate-close-${process.pid}-${Date.now()}`
    const rendererLeaseToken = `lease-${unique}`
    const rendererLeaseOwnerId = 'taskchute-plus-ai-terminal'
    const rendererLeaseGeneration = 1
    const client = new TerminalSessionBrokerClient({
      identity,
      rendererLeaseToken,
      rendererLeaseOwnerId,
      rendererLeaseGeneration,
    })
    const ready = deferred<void>()
    const attached = deferred<number>()
    try {
      client.start(
        sessionId,
        {
          command: '/bin/sh',
          args: [
            '-c',
            'printf "READY\\n"; while :; do sleep 1; done',
          ],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onAttached: (pid) => {
            if (pid !== undefined) attached.resolve(pid)
          },
          onData: (data) => {
            if (data.includes('READY')) ready.resolve()
          },
          onExit: () => undefined,
        },
      )
      const childPid = await withTimeout(attached.promise)
      await withTimeout(ready.promise)
      const descriptor = JSON.parse(
        readFileSync(getTerminalBrokerDescriptorPath(identity), 'utf8'),
      ) as { port: number; token: string }
      client.detach()

      const control = createConnection({
        host: '127.0.0.1',
        port: descriptor.port,
      })
      await new Promise<void>((resolve) => control.on('connect', resolve))
      // end(frame) flushes the command and immediately closes this isolated
      // waiter. Broker socket cleanup removes the waiter, but must not undo
      // the already-issued process-tree SIGKILL.
      control.end(`${JSON.stringify({
        token: descriptor.token,
        op: 'terminate-unavailable',
        sessionId,
        rendererLeaseToken,
        rendererLeaseOwnerId,
        rendererLeaseGeneration,
      })}\n`)

      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        try {
          process.kill(childPid, 0)
          await sleep(25)
        } catch {
          break
        }
      }
      expect(() => process.kill(childPid, 0)).toThrow()
    } finally {
      await client.shutdown()
    }
  })

  test('an authenticated broker SIGTERM kills its entire owned process tree', async () => {
    const unique = `broker-sigterm-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-resilience-${unique}`
    const sessionId = `session-broker-sigterm-${process.pid}-${Date.now()}`
    const client = new TerminalSessionBrokerClient({ identity })
    const ready = deferred<void>()
    const attached = deferred<number>()
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    try {
      client.start(
        sessionId,
        {
          command: '/bin/sh',
          args: [
            '-c',
            'printf "READY\\n"; while :; do sleep 1; done',
          ],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onAttached: (pid) => {
            if (pid !== undefined) attached.resolve(pid)
          },
          onData: (data) => {
            if (data.includes('READY')) ready.resolve()
          },
          onExit: () => undefined,
          onUnavailable: () => undefined,
        },
      )
      const childPid = await withTimeout(attached.promise)
      await withTimeout(ready.promise)
      const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as {
        pid: number
      }

      process.kill(descriptor.pid, 'SIGTERM')
      // Do not let this renderer reconnect while the broker's signal handler
      // is completing its process-tree shutdown.
      client.detach()
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        let childAlive = true
        let brokerAlive = true
        try {
          process.kill(childPid, 0)
        } catch {
          childAlive = false
        }
        try {
          process.kill(descriptor.pid, 0)
        } catch {
          brokerAlive = false
        }
        if (!childAlive && !brokerAlive) break
        await sleep(25)
      }
      expect(() => process.kill(childPid, 0)).toThrow()
      expect(() => process.kill(descriptor.pid, 0)).toThrow()
    } finally {
      await client.shutdown()
    }
  })

  test('a broker SIGKILL closes the watchdog pipe and kills its owned process tree', async () => {
    const unique = `broker-sigkill-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-resilience-${unique}`
    const sessionId = `session-broker-sigkill-${process.pid}-${Date.now()}`
    const client = new TerminalSessionBrokerClient({
      identity,
      unavailableRecoveryBaseMs: 20,
      unavailableRecoveryMaxMs: 40,
    })
    const ready = deferred<void>()
    const attached = deferred<number>()
    const unavailable = deferred<void>()
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    let childPid: number | undefined
    let brokerPid: number | undefined
    try {
      client.start(
        sessionId,
        {
          command: '/bin/sh',
          args: [
            '-c',
            'if [ "$TASKCHUTE_BROKER_WATCH_FD" = "3" ]; then ' +
              '(IFS= read -r _ <&3; kill -9 0 2>/dev/null) & ' +
              'fi; printf "READY\\n"; while :; do sleep 1; done',
          ],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onAttached: (pid) => {
            if (pid !== undefined) {
              childPid = pid
              attached.resolve(pid)
            }
          },
          onData: (data) => {
            if (data.includes('READY')) ready.resolve()
          },
          onExit: () => undefined,
          onUnavailable: () => unavailable.resolve(),
        },
      )
      const confirmedChildPid = await withTimeout(attached.promise)
      await withTimeout(ready.promise)
      const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as {
        pid: number
      }
      brokerPid = descriptor.pid

      process.kill(descriptor.pid, 'SIGKILL')
      await withTimeout(unavailable.promise, 8_000)

      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        let childAlive = true
        let brokerAlive = true
        try {
          process.kill(confirmedChildPid, 0)
        } catch {
          childAlive = false
        }
        try {
          process.kill(descriptor.pid, 0)
        } catch {
          brokerAlive = false
        }
        if (!childAlive && !brokerAlive) break
        await sleep(25)
      }
      expect(() => process.kill(confirmedChildPid, 0)).toThrow()
      expect(() => process.kill(descriptor.pid, 0)).toThrow()
    } finally {
      client.detach()
      if (childPid !== undefined) {
        try {
          process.kill(-childPid, 'SIGKILL')
        } catch {
          // Already terminated by the watchdog.
        }
      }
      if (brokerPid !== undefined) {
        try {
          process.kill(brokerPid, 'SIGKILL')
        } catch {
          // Already terminated by the test.
        }
      }
      try {
        unlinkSync(descriptorPath)
      } catch {
        // The broker normally removes its own descriptor before this point.
      }
      for (const artifactPath of ownerArtifactPaths(descriptorPath)) {
        rmSync(artifactPath, { recursive: true, force: true })
      }
    }
  })

  test('the bounded no-client TTL stops the broker and every owned process', async () => {
    const unique =
      `broker-idle-ttl-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-resilience-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const attached = deferred<number>()
    const ready = deferred<void>()
    const client = new TerminalSessionBrokerClient({
      identity,
      idleTtlMs: 5_000,
    })
    let guardPid: number | undefined
    let brokerPid: number | undefined
    try {
      client.start(
        `session-${unique}`,
        {
          command: '/bin/sh',
          args: ['-c', 'printf "TTL_READY\\n"; while :; do sleep 10; done'],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onAttached: (pid) => {
            if (pid !== undefined) attached.resolve(pid)
          },
          onData: (data) => {
            if (data.includes('TTL_READY')) ready.resolve()
          },
          onExit: () => undefined,
          onUnavailable: () => undefined,
        },
      )
      guardPid = await withTimeout(attached.promise)
      await withTimeout(ready.promise)
      const descriptor = JSON.parse(
        readFileSync(descriptorPath, 'utf8'),
      ) as { pid: number }
      brokerPid = descriptor.pid

      client.detach()
      const deadline = Date.now() + 9_000
      while (Date.now() < deadline) {
        let brokerAlive = true
        let guardAlive = true
        try { process.kill(descriptor.pid, 0) } catch { brokerAlive = false }
        try { process.kill(guardPid, 0) } catch { guardAlive = false }
        if (!brokerAlive && !guardAlive) break
        await sleep(50)
      }

      expect(() => process.kill(descriptor.pid, 0)).toThrow()
      expect(() => process.kill(guardPid ?? -1, 0)).toThrow()
      expect(existsSync(descriptorPath)).toBe(false)
      expect(ownerArtifactPaths(descriptorPath)).toEqual([])
    } finally {
      client.detach()
      if (guardPid !== undefined) {
        try { process.kill(-guardPid, 'SIGKILL') } catch {
          // Already terminated by the bounded idle cleanup.
        }
      }
      if (brokerPid !== undefined) {
        try { process.kill(brokerPid, 'SIGKILL') } catch {
          // Already terminated by the bounded idle cleanup.
        }
      }
      for (const artifactPath of ownerArtifactPaths(descriptorPath)) {
        rmSync(artifactPath, { recursive: true, force: true })
      }
      rmSync(descriptorPath, { force: true })
    }
  })

  test('the production PTY watchdog reaps a detached descendant after broker SIGKILL', async () => {
    const unique =
      `broker-real-pty-sigkill-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-resilience-${unique}`
    const sessionId = `session-real-pty-sigkill-${process.pid}-${Date.now()}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const transcriptPath = join(tmpdir(), `taskchute-broker-${unique}.log`)
    const gateway = new NodeProcessGateway()
    const detachedProgram =
      "const cp=require('child_process');" +
      "const child=cp.spawn('/bin/sh',['-c','while :; do sleep 10; done']," +
      "{detached:true,stdio:'ignore'});" +
      "child.unref();" +
      "console.log('DETACHED_PID:'+child.pid);" +
      "console.log('REAL_PTY_READY');" +
      "setInterval(()=>{},1000);"
    const ptyCommand = gateway.buildPtyCommand({
      binaryPath: process.execPath,
      args: ['-e', detachedProgram],
      rows: 24,
      cols: 80,
      transcriptPath,
    })
    const first = new TerminalSessionBrokerClient({
      identity,
      unavailableRecoveryBaseMs: 20,
      unavailableRecoveryMaxMs: 40,
    })
    const ready = deferred<void>()
    const attached = deferred<number>()
    let wrapperPid: number | undefined
    let detachedPid: number | undefined
    let brokerPid: number | undefined
    let staleArtifacts: string[] = []
    let output = ''
    try {
      first.start(
        sessionId,
        {
          command: ptyCommand.command,
          args: ptyCommand.args,
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        transcriptPath,
        undefined,
        {
          onAttached: (pid) => {
            if (pid !== undefined) {
              wrapperPid = pid
              attached.resolve(pid)
            }
          },
          onData: (data) => {
            output += data
            const match = output.match(/DETACHED_PID:(\d+)/u)
            if (match) detachedPid = Number(match[1])
            if (data.includes('REAL_PTY_READY')) ready.resolve()
          },
          onExit: () => undefined,
          onUnavailable: () => undefined,
        },
      )

      const confirmedWrapperPid = await withTimeout(attached.promise)
      await withTimeout(ready.promise)
      expect(detachedPid).toEqual(expect.any(Number))
      const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as {
        pid: number
      }
      brokerPid = descriptor.pid
      staleArtifacts = ownerArtifactPaths(descriptorPath)
      expect(staleArtifacts.length).toBeGreaterThanOrEqual(3)

      // Simulate the renderer/app disappearing before the broker. Cleanup
      // must be owned by the guard processes, not by an onUnavailable callback.
      first.detach()
      process.kill(descriptor.pid, 'SIGKILL')
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        let wrapperAlive = true
        let detachedAlive = true
        try {
          process.kill(confirmedWrapperPid, 0)
        } catch {
          wrapperAlive = false
        }
        try {
          process.kill(detachedPid ?? -1, 0)
        } catch {
          detachedAlive = false
        }
        if (!wrapperAlive && !detachedAlive) break
        await sleep(25)
      }
      expect(() => process.kill(confirmedWrapperPid, 0)).toThrow()
      expect(() => process.kill(detachedPid ?? -1, 0)).toThrow()

      const artifactDeadline = Date.now() + 3_000
      while (
        Date.now() < artifactDeadline &&
        staleArtifacts.some((path) => existsSync(path))
      ) {
        await sleep(25)
      }
      expect(staleArtifacts.every((path) => !existsSync(path))).toBe(true)

      const secondReady = deferred<void>()
      const second = new TerminalSessionBrokerClient({
        identity,
      })
      try {
        second.start(
          `session-after-${unique}`,
          {
            command: '/bin/sh',
            args: ['-c', 'printf "AFTER_CRASH_READY\\n"'],
            env: { ...process.env },
            stdinMode: 'pipe',
          },
          join(tmpdir(), `taskchute-broker-after-${unique}.log`),
          undefined,
          {
            onData: (data) => {
              if (data.includes('AFTER_CRASH_READY')) secondReady.resolve()
            },
            onExit: () => undefined,
            onUnavailable: () =>
              secondReady.reject(new Error('Replacement broker was unavailable')),
          },
        )
        await withTimeout(secondReady.promise)
        expect(staleArtifacts.every((path) => !existsSync(path))).toBe(true)
      } finally {
        await second.shutdown().catch(() => undefined)
      }
      expect(ownerArtifactPaths(descriptorPath)).toEqual([])
    } finally {
      first.detach()
      if (wrapperPid !== undefined) {
        try {
          process.kill(-wrapperPid, 'SIGKILL')
        } catch {
          // Already terminated by the production wrapper watchdog.
        }
      }
      if (detachedPid !== undefined) {
        try {
          process.kill(-detachedPid, 'SIGKILL')
        } catch {
          try {
            process.kill(detachedPid, 'SIGKILL')
          } catch {
            // Already terminated by the owner watchdog.
          }
        }
      }
      if (brokerPid !== undefined) {
        try {
          process.kill(brokerPid, 'SIGKILL')
        } catch {
          // Already terminated by the test.
        }
      }
      for (const artifactPath of ownerArtifactPaths(descriptorPath)) {
        rmSync(artifactPath, { recursive: true, force: true })
      }
      rmSync(descriptorPath, { force: true })
      rmSync(transcriptPath, { force: true })
      rmSync(`${transcriptPath}.tty`, { force: true })
    }
  })

  test('owner sentinel cleanup covers Node child_process options-only overloads', async () => {
    const unique = `broker-overload-sentinel-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-resilience-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const transcriptPath = join(tmpdir(), `taskchute-overload-${unique}.log`)
    const forkModulePath = join(tmpdir(), `taskchute-overload-${unique}.cjs`)
    writeFileSync(forkModulePath, 'setInterval(() => {}, 1000)\n')
    const program =
      "const cp=require('child_process');" +
      `const forkModule=${JSON.stringify(forkModulePath)};` +
      "const children=[" +
        "cp.spawn('/usr/bin/yes',{detached:true,stdio:'ignore'})," +
        "cp.execFile('/usr/bin/tail',{detached:true},()=>{})," +
        "cp.fork(forkModule,{detached:true,stdio:'ignore'})," +
        "cp.exec('sleep 30',{detached:true},()=>{})" +
      "];" +
      "console.log('OVERLOAD_PIDS:'+children.map(child=>child.pid).join(','));" +
      "setInterval(()=>{},1000);"
    const client = new TerminalSessionBrokerClient({ identity })
    const ready = deferred<number[]>()
    let output = ''
    let childPids: number[] = []
    let brokerPid: number | undefined
    try {
      client.start(
        `session-${unique}`,
        {
          command: process.execPath,
          args: ['-e', program],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        transcriptPath,
        undefined,
        {
          onData: (data) => {
            output += data
            const match = /OVERLOAD_PIDS:([\d,]+)/u.exec(output)
            if (match) {
              ready.resolve(match[1].split(',').map(Number))
            }
          },
          onExit: () => undefined,
          onUnavailable: () =>
            ready.reject(new Error('Options-only overload session unavailable')),
        },
      )
      childPids = await withTimeout(ready.promise)
      expect(childPids).toHaveLength(4)
      const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as {
        pid: number
      }
      brokerPid = descriptor.pid
      client.detach()
      process.kill(descriptor.pid, 'SIGKILL')

      const deadline = Date.now() + 6_000
      while (Date.now() < deadline) {
        const alive = childPids.some((pid) => {
          try {
            process.kill(pid, 0)
            return true
          } catch {
            return false
          }
        })
        if (!alive) break
        await sleep(25)
      }
      for (const pid of childPids) {
        expect(() => process.kill(pid, 0)).toThrow()
      }
    } finally {
      client.detach()
      for (const pid of childPids) {
        try { process.kill(-pid, 'SIGKILL') } catch {
          try { process.kill(pid, 'SIGKILL') } catch {
            // The sentinel cleanup already terminated this child.
          }
        }
      }
      if (brokerPid !== undefined) {
        try { process.kill(brokerPid, 'SIGKILL') } catch {
          // The broker was already terminated by the test.
        }
      }
      for (const artifactPath of ownerArtifactPaths(descriptorPath)) {
        rmSync(artifactPath, { recursive: true, force: true })
      }
      rmSync(descriptorPath, { force: true })
      rmSync(transcriptPath, { force: true })
      rmSync(forkModulePath, { force: true })
    }
  })

  test('the session guard closes the spawn-to-owner-record broker crash window', async () => {
    const unique =
      `broker-guard-spawn-window-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-resilience-${unique}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    const transcriptPath = join(tmpdir(), `taskchute-broker-${unique}.log`)
    const markerPath = join(tmpdir(), `taskchute-guard-child-${unique}.pid`)
    const gateway = new NodeProcessGateway()
    const targetProgram =
      "const fs=require('fs');const cp=require('child_process');" +
      "const child=cp.spawn('/bin/sh',['-c','while :; do sleep 10; done']," +
      "{detached:true,stdio:'ignore'});child.unref();" +
      `fs.writeFileSync(${JSON.stringify(markerPath)},String(child.pid));` +
      // Keep writing while the broker is killed. This deterministically
      // exercises the guard's stdout-destination EPIPE path; the guard must
      // stay alive long enough to reap the unrecorded detached child.
      "setInterval(()=>process.stdout.write('x'.repeat(65536)),1);"
    const ptyCommand = gateway.buildPtyCommand({
      binaryPath: process.execPath,
      args: ['-e', targetProgram],
      rows: 24,
      cols: 80,
      transcriptPath,
    })
    const client = new TerminalSessionBrokerClient({
      identity,
      getEnv: () => ({
        ...process.env,
        TASKCHUTE_BROKER_TEST_ROOT_RECORD_DELAY_MS: '3000',
        TASKCHUTE_OWNER_WATCH_TEST_PS_FAILURE: '1',
      }),
    })
    let detachedPid: number | undefined
    let brokerPid: number | undefined
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
          onData: () => undefined,
          onExit: () => undefined,
          onUnavailable: () => undefined,
        },
      )

      const markerDeadline = Date.now() + 5_000
      while (!existsSync(markerPath) && Date.now() < markerDeadline) {
        await sleep(20)
      }
      expect(existsSync(markerPath)).toBe(true)
      detachedPid = Number(readFileSync(markerPath, 'utf8'))
      expect(detachedPid).toEqual(expect.any(Number))
      if (detachedPid === undefined || !Number.isInteger(detachedPid)) {
        throw new Error('Detached guard child PID was not recorded')
      }
      const confirmedDetachedPid = detachedPid
      const descriptor = JSON.parse(
        readFileSync(descriptorPath, 'utf8'),
      ) as { pid: number }
      brokerPid = descriptor.pid

      client.detach()
      process.kill(descriptor.pid, 'SIGKILL')

      const processDeadline = Date.now() + 6_000
      while (Date.now() < processDeadline) {
        try {
          process.kill(confirmedDetachedPid, 0)
          await sleep(25)
        } catch {
          break
        }
      }
      expect(() => process.kill(detachedPid ?? -1, 0)).toThrow()

      const artifactDeadline = Date.now() + 3_000
      while (
        Date.now() < artifactDeadline &&
        ownerArtifactPaths(descriptorPath).length > 0
      ) {
        await sleep(25)
      }
      expect(ownerArtifactPaths(descriptorPath)).toEqual([])
    } finally {
      client.detach()
      if (detachedPid !== undefined) {
        try {
          process.kill(-detachedPid, 'SIGKILL')
        } catch {
          try {
            process.kill(detachedPid, 'SIGKILL')
          } catch {
            // Already terminated by the session guard.
          }
        }
      }
      if (brokerPid !== undefined) {
        try {
          process.kill(brokerPid, 'SIGKILL')
        } catch {
          // Already terminated by the test.
        }
      }
      for (const artifactPath of ownerArtifactPaths(descriptorPath)) {
        rmSync(artifactPath, { recursive: true, force: true })
      }
      rmSync(descriptorPath, { force: true })
      rmSync(markerPath, { force: true })
      rmSync(transcriptPath, { force: true })
      rmSync(`${transcriptPath}.tty`, { force: true })
    }
  })

  test('a non-force stop preserves the target SIGTERM grace period', async () => {
    const unique = `guard-graceful-stop-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-resilience-${unique}`
    const sessionId = `session-${unique}`
    const markerPath = join(tmpdir(), `taskchute-guard-graceful-${unique}`)
    const transcriptPath = join(tmpdir(), `taskchute-guard-graceful-${unique}.log`)
    const ready = deferred<void>()
    const exited = deferred<void>()
    const client = new TerminalSessionBrokerClient({ identity })
    const program =
      "const fs=require('fs');" +
      `process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(markerPath)},'graceful');process.exit(0)});` +
      "process.stdout.write('READY\\n');setInterval(()=>{},1000);"
    try {
      client.start(
        sessionId,
        {
          command: process.execPath,
          args: ['-e', program],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        transcriptPath,
        undefined,
        {
          onData: (data) => {
            if (data.includes('READY')) ready.resolve()
          },
          onExit: () => exited.resolve(),
          onUnavailable: () =>
            exited.reject(new Error('Graceful-stop session became unavailable')),
        },
      )
      await withTimeout(ready.promise)
      client.stop(sessionId, false)
      await withTimeout(exited.promise)
      expect(readFileSync(markerPath, 'utf8')).toBe('graceful')
    } finally {
      await client.shutdown().catch(() => undefined)
      rmSync(markerPath, { force: true })
      rmSync(transcriptPath, { force: true })
    }
  })

  test('target exit retries descendant cleanup after a transient ps failure', async () => {
    const unique = `guard-exit-retry-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-resilience-${unique}`
    const sessionId = `session-${unique}`
    const markerPath = join(tmpdir(), `taskchute-guard-exit-child-${unique}.pid`)
    const transcriptPath = join(tmpdir(), `taskchute-guard-exit-${unique}.log`)
    const exited = deferred<void>()
    const client = new TerminalSessionBrokerClient({
      identity,
      getEnv: () => ({
        ...process.env,
        TASKCHUTE_SESSION_GUARD_TEST_PS_FAILURE_COUNT: '3',
      }),
    })
    const program =
      "const fs=require('fs');const cp=require('child_process');" +
      "const child=cp.spawn('/bin/sh',['-c','while :; do sleep 10; done']," +
      "{detached:true,stdio:'ignore'});child.unref();" +
      `fs.writeFileSync(${JSON.stringify(markerPath)},String(child.pid));`
    let detachedPid: number | undefined
    try {
      client.start(
        sessionId,
        {
          command: process.execPath,
          args: ['-e', program],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        transcriptPath,
        undefined,
        {
          onData: () => undefined,
          onExit: () => exited.resolve(),
          onUnavailable: () =>
            exited.reject(new Error('Target-exit cleanup became unavailable')),
        },
      )
      const markerDeadline = Date.now() + 5_000
      while (!existsSync(markerPath) && Date.now() < markerDeadline) {
        await sleep(20)
      }
      expect(existsSync(markerPath)).toBe(true)
      detachedPid = Number(readFileSync(markerPath, 'utf8'))
      await withTimeout(exited.promise)
      expect(() => process.kill(detachedPid ?? -1, 0)).toThrow()
    } finally {
      await client.shutdown().catch(() => undefined)
      if (detachedPid !== undefined) {
        try { process.kill(-detachedPid, 'SIGKILL') } catch {
          // Already terminated by the target-exit reaper.
        }
      }
      rmSync(markerPath, { force: true })
      rmSync(transcriptPath, { force: true })
    }
  })

  test('target exit captures and reaps an unhooked native background group member', async () => {
    const unique = `guard-native-background-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-resilience-${unique}`
    const sessionId = `session-${unique}`
    const transcriptPath = join(tmpdir(), `taskchute-guard-native-${unique}.log`)
    const childReady = deferred<number>()
    const exited = deferred<void>()
    const client = new TerminalSessionBrokerClient({ identity })
    let childPid: number | undefined
    try {
      client.start(
        sessionId,
        {
          command: '/bin/sh',
          args: ['-c', 'sleep 30 & printf "NATIVE_CHILD:%s\\n" "$!"'],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        transcriptPath,
        undefined,
        {
          onData: (data) => {
            const match = /NATIVE_CHILD:(\d+)/u.exec(data)
            if (match) childReady.resolve(Number(match[1]))
          },
          onExit: () => exited.resolve(),
          onUnavailable: () =>
            exited.reject(new Error('Native background cleanup became unavailable')),
        },
      )
      childPid = await withTimeout(childReady.promise)
      await withTimeout(exited.promise)
      expect(() => process.kill(childPid ?? -1, 0)).toThrow()
    } finally {
      await client.shutdown().catch(() => undefined)
      if (childPid !== undefined) {
        try { process.kill(-childPid, 'SIGKILL') } catch {
          // The guard already reaped the native background process.
        }
      }
      rmSync(transcriptPath, { force: true })
    }
  })

  test('the guard never expands a live PID whose birth predates its fake target', async () => {
    const unique = `guard-pid-reuse-${process.pid}-${Date.now()}-${Math.random()}`
    const ownerPath = join(tmpdir(), `taskchute-guard-owner-${unique}.jsonl`)
    writeFileSync(ownerPath, '')
    const childReady = deferred<number>()
    const unrelated = spawn(
      process.execPath,
      [
        '-e',
        "const cp=require('child_process');" +
          "const child=cp.spawn('/bin/sh',['-c','while :; do sleep 10; done']," +
          "{stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000);",
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    unrelated.stdout?.setEncoding('utf8')
    unrelated.stdout?.once('data', (data: string) => {
      childReady.resolve(Number(data.trim()))
    })
    let unrelatedChildPid: number | undefined
    let guard: ReturnType<typeof spawn> | undefined
    try {
      unrelatedChildPid = await withTimeout(childReady.promise)
      const guardToken = 'c'.repeat(48)
      const request = Buffer.from(JSON.stringify({
        command: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        guardToken,
        controlFd: 3,
      })).toString('base64')
      const bootstrap =
        "const cp=require('child_process');" +
        "const {EventEmitter}=require('events');" +
        "const {PassThrough}=require('stream');" +
        `const fakePid=${String(unrelated.pid)};` +
        "let fakeChild;" +
        "cp.spawn=()=>{" +
          "const child=fakeChild=new EventEmitter();" +
          "child.pid=fakePid;" +
          "child.stdin=new PassThrough();" +
          "child.stdout=new PassThrough();" +
          "child.stderr=new PassThrough();" +
          "child.kill=()=>true;" +
          "return child" +
        "};" +
        `(0,eval)(${JSON.stringify(TERMINAL_SESSION_GUARD_SOURCE)});` +
        "process.stdin.once('end',()=>queueMicrotask(()=>{" +
          "fakeChild.emit('exit',0,null);" +
          "fakeChild.stdout.end();fakeChild.stderr.end();" +
          "fakeChild.emit('close',0,null)" +
        "}));"
      guard = spawn(process.execPath, ['-e', bootstrap, guardToken], {
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          TASKCHUTE_SESSION_GUARD_REQUEST: request,
          TASKCHUTE_BROKER_OWNER_PID_FILE: ownerPath,
        },
        stdio: ['pipe', 'ignore', 'ignore', 'pipe'],
      })
      await sleep(100)
      guard.stdin?.end()
      await withTimeout(new Promise<void>((resolve, reject) => {
        guard?.once('exit', () => resolve())
        guard?.once('error', reject)
      }))
      expect(() => process.kill(unrelated.pid ?? -1, 0)).not.toThrow()
      expect(() => process.kill(unrelatedChildPid ?? -1, 0)).not.toThrow()
    } finally {
      if (guard?.pid) {
        try { process.kill(guard.pid, 'SIGKILL') } catch {
          // The guard already exited after broker-pipe EOF.
        }
      }
      if (unrelated.pid) {
        try { process.kill(-unrelated.pid, 'SIGKILL') } catch {
          // Already terminated during test cleanup.
        }
      }
      rmSync(ownerPath, { force: true })
    }
  })

  test('the Windows guard force-cleans its directly owned target with taskkill /T /F', async () => {
    const unique = `guard-windows-taskkill-${process.pid}-${Date.now()}-${Math.random()}`
    const ownerPath = join(tmpdir(), `taskchute-guard-owner-${unique}.jsonl`)
    const markerPath = join(tmpdir(), `taskchute-guard-taskkill-${unique}.json`)
    writeFileSync(ownerPath, '')
    const guardToken = 'd'.repeat(48)
    const request = Buffer.from(JSON.stringify({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      guardToken,
      controlFd: 3,
    })).toString('base64')
    const bootstrap =
      "const fs=require('fs');" +
      "const cp=require('child_process');" +
      "const {EventEmitter}=require('events');" +
      "const {PassThrough}=require('stream');" +
      "Object.defineProperty(process,'platform',{value:'win32'});" +
      "Date.now=()=>1700000000000;" +
      "process.kill=(pid,signal)=>{" +
        "if(pid===424242&&signal===0)return true;" +
        "return true" +
      "};" +
      "let fakeChild;" +
      "cp.spawn=()=>{" +
        "fakeChild=new EventEmitter();" +
        "fakeChild.pid=424242;" +
        "fakeChild.stdin=new PassThrough();" +
        "fakeChild.stdout=new PassThrough();" +
        "fakeChild.stderr=new PassThrough();" +
        "fakeChild.kill=()=>true;" +
        "return fakeChild" +
      "};" +
      "cp.execFileSync=(file,args)=>{" +
        "if(String(file).toLowerCase().includes('taskkill')){" +
          `fs.writeFileSync(${JSON.stringify(markerPath)},JSON.stringify(args));` +
          "queueMicrotask(()=>{" +
            "fakeChild.emit('exit',null,'SIGKILL');" +
            "fakeChild.stdout.end();fakeChild.stderr.end();" +
            "fakeChild.emit('close',null,'SIGKILL')" +
          "});return Buffer.alloc(0)" +
        "}" +
        "return new Date(Date.now()).toISOString()" +
      "};" +
      `(0,eval)(${JSON.stringify(TERMINAL_SESSION_GUARD_SOURCE)});`
    const guard = spawn(process.execPath, ['-e', bootstrap, guardToken], {
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        TASKCHUTE_SESSION_GUARD_REQUEST: request,
        TASKCHUTE_BROKER_OWNER_PID_FILE: ownerPath,
      },
      stdio: ['pipe', 'ignore', 'ignore', 'pipe'],
    })
    try {
      await sleep(100)
      guard.stdin?.end()
      await withTimeout(new Promise<void>((resolve, reject) => {
        guard.once('exit', () => resolve())
        guard.once('error', reject)
      }))
      expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toEqual([
        '/PID',
        '424242',
        '/T',
        '/F',
      ])
    } finally {
      if (guard.pid) {
        try { process.kill(guard.pid, 'SIGKILL') } catch {
          // The mocked Windows guard already exited.
        }
      }
      rmSync(ownerPath, { force: true })
      rmSync(markerPath, { force: true })
    }
  })

  test('the Windows guard receives graceful stop over its control pipe without /F', async () => {
    const unique = `guard-windows-graceful-${process.pid}-${Date.now()}-${Math.random()}`
    const ownerPath = join(tmpdir(), `taskchute-guard-owner-${unique}.jsonl`)
    const markerPath = join(tmpdir(), `taskchute-guard-taskkill-${unique}.json`)
    const guardToken = 'a'.repeat(48)
    writeFileSync(ownerPath, '')
    const request = Buffer.from(JSON.stringify({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      guardToken,
      controlFd: 3,
    })).toString('base64')
    const bootstrap =
      "const fs=require('fs');" +
      "const cp=require('child_process');" +
      "const {EventEmitter}=require('events');" +
      "const {PassThrough}=require('stream');" +
      "Object.defineProperty(process,'platform',{value:'win32'});" +
      "Date.now=()=>1700000000000;" +
      "process.kill=(pid,signal)=>{" +
        "if(pid===424244&&signal===0)return true;" +
        "return true" +
      "};" +
      "let fakeChild;" +
      "cp.spawn=()=>{" +
        "fakeChild=new EventEmitter();" +
        "fakeChild.pid=424244;" +
        "fakeChild.stdin=new PassThrough();" +
        "fakeChild.stdout=new PassThrough();" +
        "fakeChild.stderr=new PassThrough();" +
        "fakeChild.kill=()=>true;" +
        "return fakeChild" +
      "};" +
      "cp.execFileSync=(file,args)=>{" +
        "if(String(file).toLowerCase().includes('taskkill')){" +
          `fs.appendFileSync(${JSON.stringify(markerPath)},JSON.stringify(args)+'\\n');` +
          "queueMicrotask(()=>{" +
            "fakeChild.emit('exit',0,null);" +
            "fakeChild.stdout.end();fakeChild.stderr.end();" +
            "fakeChild.emit('close',0,null)" +
          "});return Buffer.alloc(0)" +
        "}" +
        "return new Date(Date.now()).toISOString()" +
      "};" +
      `(0,eval)(${JSON.stringify(TERMINAL_SESSION_GUARD_SOURCE)});`
    const guard = spawn(
      process.execPath,
      ['-e', bootstrap, guardToken],
      {
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          TASKCHUTE_SESSION_GUARD_REQUEST: request,
          TASKCHUTE_BROKER_OWNER_PID_FILE: ownerPath,
        },
        stdio: ['pipe', 'ignore', 'ignore', 'pipe'],
      },
    )
    try {
      await sleep(100)
      ;(guard.stdio[3] as Writable | null | undefined)?.write('GRACEFUL_STOP\n')
      await withTimeout(new Promise<void>((resolve, reject) => {
        guard.once('exit', () => resolve())
        guard.once('error', reject)
      }))
      const taskkillCalls = readFileSync(markerPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[])
      expect(taskkillCalls[0]).toEqual([
        '/PID',
        '424244',
        '/T',
      ])
    } finally {
      if (guard.pid) {
        try { process.kill(guard.pid, 'SIGKILL') } catch {
          // The mocked Windows guard already exited.
        }
      }
      rmSync(ownerPath, { force: true })
      rmSync(markerPath, { force: true })
    }
  })

  test('the Windows guard never bypasses birth validation before its ChildProcess fallback', async () => {
    for (const ownership of ['dead', 'mismatch', 'unknown'] as const) {
      const rejected = await runMockWindowsGuardIdentityScenario(
        ownership,
        true,
      )
      expect(rejected).toEqual({
        taskkillCalls: 0,
        childKillCalls: 0,
      })
    }

    const matched = await runMockWindowsGuardIdentityScenario('match', true)
    expect(matched.taskkillCalls).toBeGreaterThanOrEqual(1)
    expect(matched.childKillCalls).toBe(1)
  })

  test('the Windows broker only falls back to ChildProcess.kill after a birth-matched taskkill failure', () => {
    type MockSession = {
      completed: boolean
      child: { pid: number; kill: jest.Mock }
      rootExited: boolean
      ownedPids: Map<number, { lower: number; upper: number }>
    }
    type SignalTree = (
      session: MockSession,
      signal: string,
      snapshot?: Map<number, unknown>,
    ) => void
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the production broker is itself a generated Node program; this harness evaluates only the checked-in source slice with injected mocks
    const factory = new Function(
      'process',
      'cp',
      'readPosixProcessSnapshot',
      'scanOwnedPids',
      'pidOwnershipState',
      `${sourceSection(
        TERMINAL_BROKER_SOURCE,
        'function runWindowsTaskkill',
        'function requestGuardStop',
      )}\nreturn signalTree;`,
    ) as (
      processValue: unknown,
      cpValue: unknown,
      readSnapshot: unknown,
      scanOwned: unknown,
      ownershipState: unknown,
    ) => SignalTree
    const processKill = jest.fn()
    const execFileSyncMock = jest.fn(() => {
      throw new Error('taskkill failed')
    })
    let ownership: 'match' | 'mismatch' | 'unknown' = 'unknown'
    const signalTree = factory(
      {
        platform: 'win32',
        env: { SystemRoot: 'C:\\Windows' },
        pid: 999_999,
        kill: processKill,
      },
      { execFileSync: execFileSyncMock },
      () => new Map<number, unknown>(),
      () => {},
      () => ownership,
    )
    const createSession = (): MockSession => ({
      completed: false,
      child: { pid: 424_250, kill: jest.fn() },
      rootExited: false,
      ownedPids: new Map([[
        424_250,
        { lower: 1_700_000_000_000, upper: 1_700_000_000_001 },
      ]]),
    })

    const unknown = createSession()
    signalTree(unknown, 'SIGKILL', new Map())
    expect(execFileSyncMock).not.toHaveBeenCalled()
    expect(unknown.child.kill).not.toHaveBeenCalled()
    expect(unknown.ownedPids.has(unknown.child.pid)).toBe(true)

    ownership = 'mismatch'
    const mismatched = createSession()
    signalTree(mismatched, 'SIGKILL', new Map())
    expect(execFileSyncMock).not.toHaveBeenCalled()
    expect(mismatched.child.kill).not.toHaveBeenCalled()
    expect(mismatched.ownedPids.has(mismatched.child.pid)).toBe(false)
    expect(processKill).not.toHaveBeenCalled()

    ownership = 'match'
    const matched = createSession()
    signalTree(matched, 'SIGKILL', new Map())
    expect(execFileSyncMock).toHaveBeenCalledTimes(1)
    expect(matched.child.kill).toHaveBeenCalledTimes(1)
    expect(matched.child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  test('the guard exponentially backs off while process identity is unprovable', async () => {
    const unique = `guard-cleanup-backoff-${process.pid}-${Date.now()}-${Math.random()}`
    const ownerPath = join(tmpdir(), `taskchute-guard-owner-${unique}.jsonl`)
    const countPath = join(tmpdir(), `taskchute-guard-ps-count-${unique}`)
    const guardToken = 'f'.repeat(48)
    writeFileSync(ownerPath, '')
    const request = Buffer.from(JSON.stringify({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      guardToken,
      controlFd: 3,
    })).toString('base64')
    const bootstrap =
      "const fs=require('fs');" +
      "const cp=require('child_process');" +
      "const {EventEmitter}=require('events');" +
      "const {PassThrough}=require('stream');" +
      "process.kill=(pid,signal)=>{" +
        "if(pid===424243&&signal===0)return true;" +
        "return true" +
      "};" +
      "let calls=0;" +
      "cp.execFileSync=()=>{" +
        "calls+=1;" +
        `fs.writeFileSync(${JSON.stringify(countPath)},String(calls));` +
        "throw new Error('forced ps failure')" +
      "};" +
      "cp.spawn=()=>{" +
        "const child=new EventEmitter();" +
        "child.pid=424243;" +
        "child.stdin=new PassThrough();" +
        "child.stdout=new PassThrough();" +
        "child.stderr=new PassThrough();" +
        "child.kill=()=>true;" +
        "return child" +
      "};" +
      `(0,eval)(${JSON.stringify(TERMINAL_SESSION_GUARD_SOURCE)});`
    const guard = spawn(
      process.execPath,
      ['-e', bootstrap, guardToken],
      {
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          TASKCHUTE_SESSION_GUARD_REQUEST: request,
          TASKCHUTE_BROKER_OWNER_PID_FILE: ownerPath,
        },
        stdio: ['pipe', 'ignore', 'ignore', 'pipe'],
      },
    )
    try {
      await sleep(100)
      guard.stdin?.end()
      await sleep(700)
      const psCalls = Number(readFileSync(countPath, 'utf8'))
      expect(psCalls).toBeLessThanOrEqual(20)
      expect(() => process.kill(guard.pid ?? -1, 0)).not.toThrow()
    } finally {
      if (guard.pid) {
        try { process.kill(guard.pid, 'SIGKILL') } catch {
          // Already terminated during test cleanup.
        }
      }
      rmSync(ownerPath, { force: true })
      rmSync(countPath, { force: true })
    }
  })

  test('owner watchdog never derives children from a birth-mismatched reused PID', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'taskchute-owner-mismatch-'))
    const descriptorPath = join(sandbox, 'descriptor.json')
    const ownerPrefix = `${descriptorPath}.owner-session-test-`
    const ownerPath = `${ownerPrefix}mismatch.jsonl`
    const childReady = deferred<number>()
    const unrelated = spawn(
      process.execPath,
      [
        '-e',
        "const cp=require('child_process');" +
          "const child=cp.spawn('/bin/sh',['-c','while :; do sleep 10; done']," +
          "{stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000);",
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    unrelated.stdout?.setEncoding('utf8')
    unrelated.stdout?.once('data', (data: string) => {
      childReady.resolve(Number(data.trim()))
    })
    let unrelatedChildPid: number | undefined
    let watchdog: ReturnType<typeof spawn> | undefined
    try {
      unrelatedChildPid = await withTimeout(childReady.promise)
      const parentPid = unrelated.pid
      expect(parentPid).toEqual(expect.any(Number))
      // Deliberately stale birth bracket for the live parent PID.
      writeFileSync(
        ownerPath,
        `${JSON.stringify({
          pid: parentPid,
          startedAt: 1,
          startedAtLower: 1,
          active: true,
        })}\n`,
      )
      const started = spawnOwnerWatchdogForTest(ownerPrefix, descriptorPath)
      watchdog = started.child
      await withTimeout(started.ready)
      watchdog.stdin?.end()
      await withTimeout(new Promise<void>((resolve, reject) => {
        watchdog?.once('exit', () => resolve())
        watchdog?.once('error', reject)
      }))

      expect(() => process.kill(parentPid ?? -1, 0)).not.toThrow()
      expect(() => process.kill(unrelatedChildPid ?? -1, 0)).not.toThrow()
      expect(existsSync(ownerPath)).toBe(false)
    } finally {
      if (unrelated.pid !== undefined) {
        try {
          process.kill(-unrelated.pid, 'SIGKILL')
        } catch {
          // Already cleaned by the test.
        }
      }
      if (watchdog?.pid !== undefined) {
        try {
          process.kill(-watchdog.pid, 'SIGKILL')
        } catch {
          // Already exited after preserving the unrelated process tree.
        }
      }
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('owner watchdog requires the unique guard token even within the same birth second', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'taskchute-owner-guard-token-'))
    const descriptorPath = join(sandbox, 'descriptor.json')
    const ownerPrefix = `${descriptorPath}.owner-session-test-`
    const ownerPath = `${ownerPrefix}guard-token.jsonl`
    const guardToken = 'e'.repeat(48)
    const unrelated = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      { detached: true, stdio: 'ignore' },
    )
    let watchdog: ReturnType<typeof spawn> | undefined
    try {
      const unrelatedPid = unrelated.pid
      expect(unrelatedPid).toEqual(expect.any(Number))
      const startedAt = Date.parse(execFileSync(
        '/bin/ps',
        ['-p', String(unrelatedPid), '-o', 'lstart='],
        {
          encoding: 'utf8',
          env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        },
      ).trim())
      writeFileSync(
        ownerPath,
        `${JSON.stringify({
          pid: unrelatedPid,
          startedAt,
          startedAtLower: startedAt,
          active: true,
          kind: 'guard',
          guardToken,
        })}\n`,
      )
      const started = spawnOwnerWatchdogForTest(ownerPrefix, descriptorPath)
      watchdog = started.child
      await withTimeout(started.ready)
      watchdog.stdin?.end()
      await withTimeout(new Promise<void>((resolve, reject) => {
        watchdog?.once('exit', () => resolve())
        watchdog?.once('error', reject)
      }))

      expect(() => process.kill(unrelatedPid ?? -1, 0)).not.toThrow()
      expect(existsSync(ownerPath)).toBe(false)
    } finally {
      if (unrelated.pid !== undefined) {
        try { process.kill(-unrelated.pid, 'SIGKILL') } catch {
          // Already terminated during test cleanup.
        }
      }
      if (watchdog?.pid !== undefined) {
        try { process.kill(-watchdog.pid, 'SIGKILL') } catch {
          // The watchdog already exited after rejecting the stale identity.
        }
      }
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('owner watchdog fails closed when a complete guard record omits its token', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'taskchute-owner-tokenless-guard-'))
    const descriptorPath = join(sandbox, 'descriptor.json')
    const ownerPrefix = `${descriptorPath}.owner-session-test-`
    const ownerPath = `${ownerPrefix}tokenless-guard.jsonl`
    const unrelated = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      { detached: true, stdio: 'ignore' },
    )
    let watchdog: ReturnType<typeof spawn> | undefined
    try {
      const unrelatedPid = unrelated.pid
      expect(unrelatedPid).toEqual(expect.any(Number))
      const startedAt = Date.parse(execFileSync(
        '/bin/ps',
        ['-p', String(unrelatedPid), '-o', 'lstart='],
        {
          encoding: 'utf8',
          env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        },
      ).trim())
      writeFileSync(
        ownerPath,
        `${JSON.stringify({
          pid: unrelatedPid,
          startedAt,
          startedAtLower: startedAt,
          active: true,
          kind: 'guard',
        })}\n`,
      )
      const started = spawnOwnerWatchdogForTest(ownerPrefix, descriptorPath)
      watchdog = started.child
      await withTimeout(started.ready)
      watchdog.stdin?.end()
      await sleep(350)

      const watchdogPid = watchdog.pid
      expect(watchdogPid).toEqual(expect.any(Number))
      expect(() => process.kill(unrelatedPid ?? -1, 0)).not.toThrow()
      expect(() => process.kill(watchdogPid ?? -1, 0)).not.toThrow()
      expect(existsSync(ownerPath)).toBe(true)
    } finally {
      if (unrelated.pid !== undefined) {
        try { process.kill(-unrelated.pid, 'SIGKILL') } catch {
          // The unrelated process may already have exited during teardown.
        }
      }
      if (watchdog?.pid !== undefined) {
        try { process.kill(-watchdog.pid, 'SIGKILL') } catch {
          // The watchdog may already have reached its bounded TTL.
        }
      }
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('owner watchdog never trusts a same-second generic PID without lineage evidence', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'taskchute-owner-generic-identity-'))
    const descriptorPath = join(sandbox, 'descriptor.json')
    const ownerPrefix = `${descriptorPath}.owner-session-test-`
    const ownerPath = `${ownerPrefix}generic.jsonl`
    const unrelated = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      { detached: true, stdio: 'ignore' },
    )
    let watchdog: ReturnType<typeof spawn> | undefined
    try {
      const unrelatedPid = unrelated.pid
      expect(unrelatedPid).toEqual(expect.any(Number))
      const startedAt = Date.parse(execFileSync(
        '/bin/ps',
        ['-p', String(unrelatedPid), '-o', 'lstart='],
        {
          encoding: 'utf8',
          env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        },
      ).trim())
      // This is exactly the ambiguous legacy record that used to authorize
      // killing any process that reused the PID within the same lstart second.
      writeFileSync(
        ownerPath,
        `${JSON.stringify({
          pid: unrelatedPid,
          startedAt,
          startedAtLower: startedAt,
          active: true,
          kind: 'process',
        })}\n`,
      )
      const started = spawnOwnerWatchdogForTest(ownerPrefix, descriptorPath)
      watchdog = started.child
      await withTimeout(started.ready)
      watchdog.stdin?.end()
      await sleep(350)

      const watchdogPid = watchdog.pid
      expect(watchdogPid).toEqual(expect.any(Number))
      expect(() => process.kill(unrelatedPid ?? -1, 0)).not.toThrow()
      expect(() => process.kill(watchdogPid ?? -1, 0)).not.toThrow()
      expect(existsSync(ownerPath)).toBe(true)
    } finally {
      if (unrelated.pid !== undefined) {
        try { process.kill(-unrelated.pid, 'SIGKILL') } catch {
          // The unrelated process may already have exited during teardown.
        }
      }
      if (watchdog?.pid !== undefined) {
        try { process.kill(-watchdog.pid, 'SIGKILL') } catch {
          // The watchdog may already have reached its bounded TTL.
        }
      }
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('owner watchdog rejects a same-second process whose sentinel points elsewhere', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'taskchute-owner-sentinel-mismatch-'))
    const descriptorPath = join(sandbox, 'descriptor.json')
    const ownerPrefix = `${descriptorPath}.owner-session-test-`
    const ownerPath = `${ownerPrefix}sentinel-mismatch.jsonl`
    const unrelatedSentinelPath = join(sandbox, 'unrelated-sentinel')
    writeFileSync(unrelatedSentinelPath, 'unrelated')
    const unrelated = spawn(
      '/bin/sh',
      [
        '-c',
        `exec 3<${JSON.stringify(unrelatedSentinelPath)}; ` +
          `exec ${JSON.stringify(process.execPath)} -e ` +
          `${JSON.stringify('setInterval(()=>{},1000)')}`,
      ],
      { detached: true, stdio: 'ignore' },
    )
    let watchdog: ReturnType<typeof spawn> | undefined
    try {
      const unrelatedPid = unrelated.pid
      expect(unrelatedPid).toEqual(expect.any(Number))
      const startedAt = Date.parse(execFileSync(
        '/bin/ps',
        ['-p', String(unrelatedPid), '-o', 'lstart='],
        {
          encoding: 'utf8',
          env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        },
      ).trim())
      writeFileSync(
        ownerPath,
        `${JSON.stringify({
          pid: unrelatedPid,
          startedAt,
          startedAtLower: startedAt,
          active: true,
          kind: 'process',
          sentinelFd: 3,
          sentinelPath: ownerPath,
        })}\n`,
      )
      const started = spawnOwnerWatchdogForTest(ownerPrefix, descriptorPath)
      watchdog = started.child
      await withTimeout(started.ready)
      watchdog.stdin?.end()
      await withTimeout(new Promise<void>((resolve, reject) => {
        watchdog?.once('exit', () => resolve())
        watchdog?.once('error', reject)
      }))

      expect(() => process.kill(unrelatedPid ?? -1, 0)).not.toThrow()
      expect(existsSync(ownerPath)).toBe(false)
    } finally {
      if (unrelated.pid !== undefined) {
        try { process.kill(-unrelated.pid, 'SIGKILL') } catch {
          // The unrelated process may already have exited during teardown.
        }
      }
      if (watchdog?.pid !== undefined) {
        try { process.kill(-watchdog.pid, 'SIGKILL') } catch {
          // The watchdog already exited after rejecting the sentinel.
        }
      }
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('owner watchdog never signals a torn record whose guard discriminator is missing', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'taskchute-owner-torn-guard-'))
    const descriptorPath = join(sandbox, 'descriptor.json')
    const ownerPrefix = `${descriptorPath}.owner-session-test-`
    const ownerPath = `${ownerPrefix}torn-guard.jsonl`
    const unrelated = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      { detached: true, stdio: 'ignore' },
    )
    let watchdog: ReturnType<typeof spawn> | undefined
    try {
      const unrelatedPid = unrelated.pid
      expect(unrelatedPid).toEqual(expect.any(Number))
      const startedAt = Date.parse(execFileSync(
        '/bin/ps',
        ['-p', String(unrelatedPid), '-o', 'lstart='],
        {
          encoding: 'utf8',
          env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        },
      ).trim())
      writeFileSync(
        ownerPath,
        `{"pid":${String(unrelatedPid)},"startedAt":${String(startedAt)},` +
          `"startedAtLower":${String(startedAt)},"active":true`,
      )
      const started = spawnOwnerWatchdogForTest(ownerPrefix, descriptorPath)
      watchdog = started.child
      await withTimeout(started.ready)
      watchdog.stdin?.end()
      await sleep(500)

      expect(() => process.kill(unrelatedPid ?? -1, 0)).not.toThrow()
      expect(() => process.kill(watchdog?.pid ?? -1, 0)).not.toThrow()
      expect(existsSync(ownerPath)).toBe(true)
    } finally {
      if (unrelated.pid !== undefined) {
        try { process.kill(-unrelated.pid, 'SIGKILL') } catch {
          // Already terminated during test cleanup.
        }
      }
      if (watchdog?.pid !== undefined) {
        try { process.kill(-watchdog.pid, 'SIGKILL') } catch {
          // Already terminated during test cleanup.
        }
      }
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('owner watchdog keeps retrying when ps cannot prove a live PID identity', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'taskchute-owner-ps-failure-'))
    const descriptorPath = join(sandbox, 'descriptor.json')
    const ownerPrefix = `${descriptorPath}.owner-session-test-`
    const ownerPath = `${ownerPrefix}live.jsonl`
    const owned = spawn(
      '/bin/sh',
      ['-c', 'while :; do sleep 10; done'],
      { detached: true, stdio: 'ignore' },
    )
    let watchdog: ReturnType<typeof spawn> | undefined
    try {
      const ownedPid = owned.pid
      expect(ownedPid).toEqual(expect.any(Number))
      const startedAt = Date.parse(execFileSync(
        '/bin/ps',
        ['-p', String(ownedPid), '-o', 'lstart='],
        {
          encoding: 'utf8',
          env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        },
      ).trim())
      writeFileSync(
        ownerPath,
        `${JSON.stringify({
          pid: ownedPid,
          startedAt,
          startedAtLower: startedAt,
          active: true,
        })}\n`,
      )
      const started = spawnOwnerWatchdogForTest(
        ownerPrefix,
        descriptorPath,
        { TASKCHUTE_OWNER_WATCH_TEST_PS_FAILURE: '1' },
      )
      watchdog = started.child
      await withTimeout(started.ready)
      watchdog.stdin?.end()
      await sleep(300)

      expect(watchdog.exitCode).toBeNull()
      expect(() => process.kill(ownedPid ?? -1, 0)).not.toThrow()
      expect(existsSync(ownerPath)).toBe(true)

      if (ownedPid !== undefined) process.kill(-ownedPid, 'SIGKILL')
      await withTimeout(new Promise<void>((resolve, reject) => {
        watchdog?.once('exit', () => resolve())
        watchdog?.once('error', reject)
      }))
      expect(existsSync(ownerPath)).toBe(false)
    } finally {
      if (owned.pid !== undefined) {
        try {
          process.kill(-owned.pid, 'SIGKILL')
        } catch {
          // Already terminated after the unknown-state assertion.
        }
      }
      if (watchdog?.pid !== undefined) {
        try {
          process.kill(-watchdog.pid, 'SIGKILL')
        } catch {
          // Already exited after the owned process disappeared.
        }
      }
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('owner watchdog does not treat a failed owner-directory scan as clean', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'taskchute-owner-readdir-'))
    const missingDirectory = join(sandbox, 'not-created-yet')
    const descriptorPath = join(missingDirectory, 'descriptor.json')
    const ownerPrefix = `${descriptorPath}.owner-session-test-`
    const started = spawnOwnerWatchdogForTest(ownerPrefix, descriptorPath)
    const watchdog = started.child
    try {
      await withTimeout(started.ready)
      watchdog.stdin?.end()
      await sleep(300)
      expect(watchdog.exitCode).toBeNull()

      mkdirSync(missingDirectory, { mode: 0o700 })
      await withTimeout(new Promise<void>((resolve, reject) => {
        watchdog.once('exit', () => resolve())
        watchdog.once('error', reject)
      }))
    } finally {
      if (watchdog.pid !== undefined) {
        try {
          process.kill(-watchdog.pid, 'SIGKILL')
        } catch {
          // Already exited after the directory became readable.
        }
      }
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('a stuck attached client is dropped while a healthy client receives everything', async () => {
    process.env.TASKCHUTE_BROKER_STUCK_MS = '1000'
    const unique = `stuck-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-resilience-${unique}`
    const sessionId = `session-stuck-${process.pid}-${Date.now()}`
    const transcriptPath = join(tmpdir(), `taskchute-broker-${unique}.log`)
    const client = new TerminalSessionBrokerClient({ identity })
    try {
      const ready = deferred<void>()
      const done = deferred<void>()
      // Loopback kernel buffers absorb writes silently up to
      // kern.ipc.maxsockbuf (8MB on macOS) before socket.write() ever
      // returns false, so the payload must be far larger to guarantee the
      // never-reading client actually back-pressures the broker.
      const payloadBytes = 512 * 65536
      const expectedTotal = 'READY\n'.length + payloadBytes + '\nDONE\n'.length
      let received = 0
      let tail = ''
      client.start(
        sessionId,
        {
          command: '/bin/sh',
          args: [
            '-c',
            'printf "READY\\n"; IFS= read -r line; dd if=/dev/zero bs=65536 count=512 2>/dev/null | tr "\\000" "x"; printf "\\nDONE\\n"',
          ],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        transcriptPath,
        undefined,
        {
          onData: (data) => {
            received += data.length
            tail = (tail + data).slice(-12)
            if (tail.includes('READY')) ready.resolve()
            if (received >= expectedTotal) done.resolve()
          },
          onExit: () => undefined,
        },
      )
      await withTimeout(ready.promise)

      const descriptor = JSON.parse(
        readFileSync(getTerminalBrokerDescriptorPath(identity), 'utf8'),
      ) as { port: number; token: string }
      const stuckClosed = deferred<void>()
      const stuck = createConnection({ host: '127.0.0.1', port: descriptor.port })
      // Never read: the kernel window closes and the broker's writes to this
      // socket back-pressure while the healthy client stays responsive.
      stuck.pause()
      stuck.on('error', () => stuckClosed.resolve())
      stuck.on('close', () => stuckClosed.resolve())
      await new Promise<void>((resolve) => stuck.on('connect', resolve))
      stuck.write(
        `${JSON.stringify({ token: descriptor.token, op: 'attach', sessionId })}\n`,
      )
      await sleep(200)

      client.write(sessionId, 'go\n')
      await withTimeout(done.promise)

      // The broker drops a stuck client two ways: markPressured's
      // stuck-client timer, and sendRaw destroying it the moment its buffered
      // bytes pass clientBufferLimit. Which one fires depends on how much the
      // kernel absorbs first - macOS loopback buffers up to 8MB, so the timer
      // wins there, while Linux passes the 4MB limit almost immediately.
      // Asserting a floor here would only pin down which path ran.
      // Exact length proves the paused stream resumed without losing or
      // duplicating output once the stuck client was dropped.
      expect(received).toBe(expectedTotal)
      expect(tail.endsWith('DONE\n')).toBe(true)

      // A paused socket never reads the FIN the broker sent when it
      // destroyed this connection; resume so the close becomes observable.
      stuck.resume()
      await withTimeout(stuckClosed.promise)
    } finally {
      delete process.env.TASKCHUTE_BROKER_STUCK_MS
      await client.shutdown()
    }
  })

  test('reattach replay heavy in control chars is trimmed to fit the client frame limit', async () => {
    const unique = `trim-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-resilience-${unique}`
    const sessionId = `session-trim-${process.pid}-${Date.now()}`
    const transcriptPath = join(tmpdir(), `taskchute-broker-${unique}.log`)
    const firstReady = deferred<void>()
    let firstOutput = ''
    const firstClient = new TerminalSessionBrokerClient({ identity })
    firstClient.start(
      sessionId,
      {
        command: '/bin/sh',
        args: [
          '-c',
          // 190KB of \x01 stays under the raw 200KB replay cap but serializes
          // to ~1.1MB of \u0001 escapes, beyond the client's 1MB frame limit.
          'printf "HEAD-MARKER"; dd if=/dev/zero bs=1024 count=190 2>/dev/null | tr "\\000" "\\001"; printf "TAIL-MARKER\\nREADY\\n"; while IFS= read -r line; do [ "$line" = exit ] && exit 0; done',
        ],
        env: { ...process.env },
        stdinMode: 'pipe',
      },
      transcriptPath,
      undefined,
      {
        onData: (data) => {
          firstOutput += data
          if (firstOutput.includes('READY')) firstReady.resolve()
        },
        onExit: () => firstReady.reject(new Error('Unexpected early exit')),
      },
    )
    await withTimeout(firstReady.promise)
    firstClient.detach()

    const replayed = deferred<void>()
    const exited = deferred<void>()
    let replay = ''
    const secondClient = new TerminalSessionBrokerClient({ identity })
    const secondCallbacks: TerminalBrokerSessionCallbacks = {
      onData: (data) => {
        if (!replay.includes('READY')) replay += data
        if (replay.includes('READY')) replayed.resolve()
      },
      onExit: (outcome) => {
        if (outcome.status === 'succeeded') exited.resolve()
        else exited.reject(new Error(`Unexpected exit: ${outcome.status}`))
      },
      onUnavailable: () => replayed.reject(new Error('Broker session was lost')),
    }
    secondClient.attach(sessionId, secondCallbacks)
    await withTimeout(replayed.promise)

    expect(replay).toContain('TAIL-MARKER')
    expect(replay).toContain('READY')
    expect(replay).toContain('\u0001')
    expect(replay).not.toContain('HEAD-MARKER')
    expect(JSON.stringify(replay).length).toBeLessThanOrEqual(700 * 1024)

    secondClient.write(sessionId, 'exit\n')
    await withTimeout(exited.promise)
    await secondClient.shutdown()
  })

  test('bounds newline-free stderr while preserving its tail and exit sentinel', async () => {
    const unique = `stderr-cap-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-resilience-${unique}`
    const sessionId = `session-stderr-cap-${process.pid}-${Date.now()}`
    const transcriptPath = join(tmpdir(), `taskchute-broker-${unique}.log`)
    const exited = deferred<void>()
    let output = ''
    const client = new TerminalSessionBrokerClient({ identity })
    try {
      client.start(
        sessionId,
        {
          command: '/bin/sh',
          args: [
            '-c',
            'dd if=/dev/zero bs=65536 count=4 2>/dev/null | tr "\\000" "e" >&2; printf "TAIL\\n__TASKCHUTE_AI_EXIT__0\\n" >&2',
          ],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        transcriptPath,
        undefined,
        {
          onData: (data) => {
            output += data
          },
          onExit: (outcome) => {
            if (outcome.status === 'succeeded') exited.resolve()
            else exited.reject(new Error(`Unexpected exit: ${outcome.status}`))
          },
        },
      )
      await withTimeout(exited.promise)

      expect(output).toMatch(/^…\[\+\d+ stderr chars truncated\]\n/)
      expect(output).toContain('TAIL\n')
      expect(output).not.toContain('__TASKCHUTE_AI_EXIT__')
      expect(output.length).toBeLessThanOrEqual(64 * 1024 + 128)
    } finally {
      await client.shutdown()
    }
  })

  test('uses a close-flushed sentinel without a trailing newline for the final outcome', async () => {
    const unique = `sentinel-close-flush-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-resilience-${unique}`
    const exited = deferred<{
      status: string
      exitCode: number | null
    }>()
    const client = new TerminalSessionBrokerClient({ identity })
    try {
      client.start(
        `session-${unique}`,
        {
          command: '/bin/sh',
          args: [
            '-c',
            'printf "__TASKCHUTE_AI_EXIT__7" >&2; exit 0',
          ],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        join(tmpdir(), `taskchute-broker-${unique}.log`),
        undefined,
        {
          onData: () => undefined,
          onExit: (outcome) => exited.resolve({
            status: outcome.status,
            exitCode: outcome.exitCode,
          }),
          onUnavailable: () =>
            exited.reject(new Error('Sentinel session was unavailable')),
        },
      )

      await expect(withTimeout(exited.promise)).resolves.toEqual({
        status: 'failed',
        exitCode: 7,
      })
    } finally {
      await client.shutdown()
    }
  })

  test('an attach ACK timeout terminates through the authenticated control channel before notifying', async () => {
    let attachRequests = 0
    let terminationRequests = 0
    const server = createServer((socket) => {
      let buffer = ''
      socket.on('error', () => undefined)
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as {
            op: string
            sessionId?: string
          }
          buffer = buffer.slice(newline + 1)
          if (message.op === 'attach') {
            // Simulate a live but wedged ordinary data path.
            attachRequests += 1
          } else if (message.op === 'terminate-unavailable') {
            terminationRequests += 1
            socket.write(`${JSON.stringify({
              type: 'terminated-unavailable',
              sessionId: message.sessionId,
              interrupted: true,
            })}\n`)
          }
          newline = buffer.indexOf('\n')
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const identity = `broker-ack-timeout-${process.pid}-${Date.now()}-${Math.random()}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    writeFileSync(
      descriptorPath,
      JSON.stringify({
        version: 1,
        port,
        token: 'a'.repeat(64),
        pid: process.pid,
      }),
    )
    const unavailable = deferred<void>()
    let unavailableCount = 0
    let exitCount = 0
    const client = new TerminalSessionBrokerClient({
      identity,
      sessionAckTimeoutMs: 40,
      unavailableTerminationTimeoutMs: 200,
    })
    try {
      client.attach(`session-${identity}`, {
        onData: () => undefined,
        onExit: () => {
          exitCount += 1
        },
        onUnavailable: () => {
          unavailableCount += 1
          unavailable.resolve()
        },
      })

      await withTimeout(unavailable.promise)
      expect(attachRequests).toBe(1)
      expect(terminationRequests).toBe(1)
      expect(unavailableCount).toBe(1)
      expect(exitCount).toBe(0)
      await sleep(100)
      expect(unavailableCount).toBe(1)
    } finally {
      client.detach()
      if (existsSync(descriptorPath)) unlinkSync(descriptorPath)
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test('a transient initial attach connection failure retries authenticated termination before notifying', async () => {
    const portProbe = createServer()
    await new Promise<void>((resolve) =>
      portProbe.listen(0, '127.0.0.1', resolve))
    const port = (portProbe.address() as AddressInfo).port
    await new Promise((resolve) => portProbe.close(resolve))

    let terminationRequests = 0
    const recoveryServer = createServer((socket) => {
      let buffer = ''
      socket.on('error', () => undefined)
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as {
            op: string
            sessionId?: string
          }
          buffer = buffer.slice(newline + 1)
          if (message.op === 'terminate-unavailable') {
            terminationRequests += 1
            socket.write(`${JSON.stringify({
              type: 'terminated-unavailable',
              sessionId: message.sessionId,
              interrupted: true,
            })}\n`)
          }
          newline = buffer.indexOf('\n')
        }
      })
    })
    const identity =
      `broker-connect-recovery-${process.pid}-${Date.now()}-${Math.random()}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    writeFileSync(
      descriptorPath,
      JSON.stringify({
        version: 1,
        port,
        token: 'b'.repeat(64),
        pid: process.pid,
      }),
    )
    const unavailable = deferred<void>()
    let unavailableCount = 0
    const client = new TerminalSessionBrokerClient({
      identity,
      connectTimeoutMs: 30,
      unavailableTerminationTimeoutMs: 30,
      unavailableRecoveryBaseMs: 20,
      unavailableRecoveryMaxMs: 40,
    })
    try {
      client.attach(`session-${identity}`, {
        onData: () => undefined,
        onExit: () => undefined,
        onUnavailable: () => {
          unavailableCount += 1
          unavailable.resolve()
        },
      })

      // The first ordinary connection and at least one control attempt see
      // ECONNREFUSED. Once the same trusted descriptor becomes reachable,
      // recovery must terminate/confirm before the UI callback fires.
      await sleep(90)
      await new Promise<void>((resolve) =>
        recoveryServer.listen(port, '127.0.0.1', resolve))
      await withTimeout(unavailable.promise)

      expect(terminationRequests).toBeGreaterThanOrEqual(1)
      expect(unavailableCount).toBe(1)
    } finally {
      client.detach()
      if (existsSync(descriptorPath)) unlinkSync(descriptorPath)
      if (recoveryServer.listening) {
        await new Promise((resolve) => recoveryServer.close(resolve))
      }
    }
  })

  test('an immediate stop cannot erase the pending attach failure settlement', async () => {
    const portProbe = createServer()
    await new Promise<void>((resolve) =>
      portProbe.listen(0, '127.0.0.1', resolve))
    const port = (portProbe.address() as AddressInfo).port
    await new Promise((resolve) => portProbe.close(resolve))
    const identity =
      `broker-stop-during-attach-${process.pid}-${Date.now()}-${Math.random()}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    writeFileSync(
      descriptorPath,
      JSON.stringify({
        version: 1,
        port,
        token: 'c'.repeat(64),
        // Deliberately alive and unrelated: the client must not signal it.
        pid: process.pid,
      }),
    )
    const unavailable = deferred<void>()
    let unavailableCount = 0
    let exitCount = 0
    const sessionId = `session-${identity}`
    const client = new TerminalSessionBrokerClient({
      identity,
      connectTimeoutMs: 30,
      unavailableTerminationTimeoutMs: 30,
    })
    try {
      client.attach(sessionId, {
        onData: () => undefined,
        onExit: () => {
          exitCount += 1
        },
        onUnavailable: () => {
          unavailableCount += 1
          unavailable.resolve()
        },
      })
      client.stop(sessionId, true)

      await withTimeout(unavailable.promise)
      await sleep(60)
      expect(unavailableCount).toBe(1)
      expect(exitCount).toBe(0)
      expect(existsSync(descriptorPath)).toBe(false)
    } finally {
      client.detach()
      if (existsSync(descriptorPath)) unlinkSync(descriptorPath)
    }
  })

  test('rapid resizes coalesce into few stty runs and always apply the final size', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'taskchute-broker-stty-'))
    const logPath = join(dir, 'stty.log')
    const fakeStty = join(dir, 'fake-stty')
    writeFileSync(fakeStty, `#!/bin/sh\necho "$@" >> "${logPath}"\nsleep 0.2\n`, {
      mode: 0o755,
    })
    process.env.TASKCHUTE_BROKER_STTY = fakeStty
    const unique = `resize-${process.pid}-${Date.now()}-${Math.random()}`
    const identity = `broker-resilience-${unique}`
    const sessionId = `session-resize-${process.pid}-${Date.now()}`
    const transcriptPath = join(dir, 'transcript.log')
    writeFileSync(`${transcriptPath}.tty`, '/dev/ttys001\n')
    const client = new TerminalSessionBrokerClient({ identity })
    try {
      const ready = deferred<void>()
      const exited = deferred<void>()
      client.start(
        sessionId,
        {
          command: '/bin/sh',
          args: [
            '-c',
            'printf "READY\\n"; while IFS= read -r line; do [ "$line" = exit ] && exit 0; done',
          ],
          env: { ...process.env },
          stdinMode: 'pipe',
        },
        transcriptPath,
        undefined,
        {
          onData: (data) => {
            if (data.includes('READY')) ready.resolve()
          },
          onExit: () => exited.resolve(),
        },
      )
      await withTimeout(ready.promise)

      for (let i = 0; i < 20; i += 1) {
        client.resize(sessionId, 80 + i, 24)
      }
      await sleep(1_500)

      const lines = readFileSync(logPath, 'utf8').trim().split('\n')
      expect(lines.length).toBeGreaterThanOrEqual(1)
      expect(lines.length).toBeLessThanOrEqual(5)
      expect(lines[lines.length - 1]).toContain('rows 24 cols 99')

      // Re-sending the already-applied size must not spawn stty again.
      client.resize(sessionId, 99, 24)
      await sleep(600)
      expect(readFileSync(logPath, 'utf8').trim().split('\n')).toHaveLength(
        lines.length,
      )

      client.write(sessionId, 'exit\n')
      await withTimeout(exited.promise)
    } finally {
      delete process.env.TASKCHUTE_BROKER_STTY
      await client.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('client stops reconnecting after three consecutive oversized frames', async () => {
    let connections = 0
    let oversizedConnections = 0
    let terminationRequests = 0
    const server = createServer((socket) => {
      connections += 1
      let responded = false
      let buffer = ''
      socket.on('error', () => undefined)
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as {
            op: string
            sessionId: string
          }
          buffer = buffer.slice(newline + 1)
          if (message.op === 'terminate-unavailable') {
            terminationRequests += 1
            socket.write(`${JSON.stringify({
              type: 'terminated-unavailable',
              sessionId: message.sessionId,
              interrupted: true,
              transcriptPath: '/tmp/broker-confirmed-transcript',
              outcome: {
                status: 'stopped',
                exitCode: null,
                signal: 'SIGKILL',
              },
            })}\n`)
          } else if (!responded) {
            responded = true
            oversizedConnections += 1
            socket.write(OVERSIZED_FRAME)
          }
          newline = buffer.indexOf('\n')
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const identity = `broker-loop-guard-${process.pid}-${Date.now()}-${Math.random()}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    writeFileSync(
      descriptorPath,
      JSON.stringify({ version: 1, port, token: 'a'.repeat(64), pid: process.pid }),
    )
    try {
      const unavailable = deferred<void>()
      let confirmedTranscriptPath: string | undefined
      const client = new TerminalSessionBrokerClient({ identity })
      client.attach('session-loop-guard', {
        onData: () => undefined,
        onExit: () => undefined,
        onUnavailable: (transcriptPath) => {
          confirmedTranscriptPath = transcriptPath
          unavailable.resolve()
        },
      })
      await withTimeout(unavailable.promise, 10_000)
      expect(oversizedConnections).toBe(3)
      expect(terminationRequests).toBe(1)
      expect(confirmedTranscriptPath).toBe(
        '/tmp/broker-confirmed-transcript',
      )
      expect(connections).toBe(4)
      await sleep(400)
      expect(connections).toBe(4)
    } finally {
      unlinkSync(descriptorPath)
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test('termination timeout falls back to authenticated shutdown without signalling a stale descriptor pid', async () => {
    let oversizedConnections = 0
    let terminationRequests = 0
    let shutdownRequests = 0
    let descriptorPath = ''
    const brokerSentinel = spawn(
      process.execPath,
      ['-e', 'setInterval(() => undefined, 1000)'],
      { stdio: 'ignore' },
    )
    const server = createServer((socket) => {
      let responded = false
      let buffer = ''
      socket.on('error', () => undefined)
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as {
            op: string
            sessionId?: string
          }
          buffer = buffer.slice(newline + 1)
          if (message.op === 'terminate-unavailable') {
            // Simulate an authenticated old broker: it accepts the token and
            // keeps one session pending, but another session's normal exit
            // wins the race and is acknowledged before the timeout.
            terminationRequests += 1
            if (message.sessionId === 'session-completed-race') {
              socket.write(`${JSON.stringify({
                type: 'terminated-unavailable',
                sessionId: message.sessionId,
                interrupted: false,
                transcriptPath: '/tmp/completed-race.log',
                outcome: {
                  status: 'succeeded',
                  exitCode: 0,
                  signal: null,
                },
              })}\n`)
            }
          } else if (message.op === 'shutdown') {
            shutdownRequests += 1
            brokerSentinel.kill('SIGKILL')
            try {
              unlinkSync(descriptorPath)
            } catch {
              // Test cleanup remains idempotent.
            }
            socket.write(`${JSON.stringify({ type: 'shutdown-ack' })}\n`)
          } else if (!responded) {
            responded = true
            oversizedConnections += 1
            socket.write(OVERSIZED_FRAME)
          }
          newline = buffer.indexOf('\n')
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const identity = `broker-loop-guard-old-${process.pid}-${Date.now()}-${Math.random()}`
    descriptorPath = getTerminalBrokerDescriptorPath(identity)
    expect(brokerSentinel.pid).toEqual(expect.any(Number))
    writeFileSync(
      descriptorPath,
      JSON.stringify({
        version: 1,
        port,
        token: 'a'.repeat(64),
        pid: brokerSentinel.pid,
      }),
    )
    try {
      const unavailable = deferred<void>()
      const completed = deferred<void>()
      let unavailableCount = 0
      let completedExitCount = 0
      let completedUnavailableCount = 0
      const client = new TerminalSessionBrokerClient({
        identity,
        unavailableTerminationTimeoutMs: 100,
      })
      client.attach('session-completed-race', {
        onData: () => undefined,
        onExit: (outcome) => {
          if (outcome.status === 'succeeded') {
            completedExitCount += 1
            completed.resolve()
          } else {
            completed.reject(new Error(`Unexpected outcome: ${outcome.status}`))
          }
        },
        onUnavailable: () => {
          completedUnavailableCount += 1
          completed.reject(new Error('Completed session became unavailable'))
        },
      })
      client.attach('session-old-broker', {
        onData: () => undefined,
        onExit: () => undefined,
        onUnavailable: () => {
          unavailableCount += 1
          unavailable.resolve()
        },
      })

      await withTimeout(
        Promise.all([unavailable.promise, completed.promise]),
        10_000,
      )
      expect(oversizedConnections).toBe(3)
      expect(terminationRequests).toBe(2)
      expect(shutdownRequests).toBe(1)
      expect(unavailableCount).toBe(1)
      expect(completedExitCount).toBe(1)
      expect(completedUnavailableCount).toBe(0)
      // The renderer remains alive: only the authenticated server-side
      // shutdown owns termination of the descriptor process.
      expect(() => process.kill(process.pid, 0)).not.toThrow()
      await sleep(200)
      expect(unavailableCount).toBe(1)
    } finally {
      try {
        unlinkSync(descriptorPath)
      } catch {
        // Authenticated shutdown already removed it.
      }
      brokerSentinel.kill('SIGKILL')
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test('does not report unavailable when termination and authenticated shutdown both time out', async () => {
    let oversizedConnections = 0
    let terminationRequests = 0
    let shutdownRequests = 0
    const fallbackFailed = deferred<void>()
    const server = createServer((socket) => {
      let responded = false
      let buffer = ''
      socket.on('error', () => undefined)
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as {
            op: string
          }
          buffer = buffer.slice(newline + 1)
          if (message.op === 'terminate-unavailable') {
            // The process-owning broker is alive but its termination handler
            // is wedged: no child-exit acknowledgement arrives.
            terminationRequests += 1
          } else if (message.op === 'shutdown') {
            // The authenticated compatibility path is wedged as well. The
            // client must not claim the process stopped without this ACK.
            shutdownRequests += 1
          } else if (!responded) {
            responded = true
            oversizedConnections += 1
            socket.write(OVERSIZED_FRAME)
          }
          newline = buffer.indexOf('\n')
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const identity = `broker-loop-guard-unconfirmed-${process.pid}-${Date.now()}-${Math.random()}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    let client: TerminalSessionBrokerClient | undefined
    writeFileSync(
      descriptorPath,
      JSON.stringify({ version: 1, port, token: 'a'.repeat(64), pid: process.pid }),
    )
    try {
      let unavailableCount = 0
      let exitCount = 0
      client = new TerminalSessionBrokerClient({
        identity,
        unavailableTerminationTimeoutMs: 100,
        shutdownTimeoutMs: 100,
        log: (_level, ...args) => {
          if (
            args[0] ===
            '[TerminalBroker] Authenticated broker shutdown failed'
          ) {
            fallbackFailed.resolve()
          }
        },
      })
      client.attach('session-unconfirmed-termination', {
        onData: () => undefined,
        onExit: () => {
          exitCount += 1
        },
        onUnavailable: () => {
          unavailableCount += 1
        },
      })

      await withTimeout(fallbackFailed.promise, 10_000)
      // Let terminateUnavailableSessions finish its callback loop after the
      // shutdown failure log that resolved fallbackFailed.
      await sleep(50)

      expect(oversizedConnections).toBe(3)
      expect(terminationRequests).toBe(1)
      expect(shutdownRequests).toBe(1)
      expect(unavailableCount).toBe(0)
      expect(exitCount).toBe(0)
      // A stale descriptor PID must still never be used as a kill fallback.
      expect(() => process.kill(process.pid, 0)).not.toThrow()
    } finally {
      await client?.shutdown().catch(() => undefined)
      if (existsSync(descriptorPath)) unlinkSync(descriptorPath)
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test('retries an unconfirmed termination and settles exactly once after a later ACK', async () => {
    let oversizedConnections = 0
    let terminationRequests = 0
    let shutdownRequests = 0
    const firstUnconfirmed = deferred<void>()
    const server = createServer((socket) => {
      let responded = false
      let buffer = ''
      socket.on('error', () => undefined)
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as {
            op: string
            sessionId?: string
          }
          buffer = buffer.slice(newline + 1)
          if (message.op === 'terminate-unavailable') {
            terminationRequests += 1
            if (terminationRequests >= 2) {
              socket.write(`${JSON.stringify({
                type: 'terminated-unavailable',
                sessionId: message.sessionId,
                interrupted: true,
              })}\n`)
            }
          } else if (message.op === 'shutdown') {
            shutdownRequests += 1
          } else if (!responded) {
            responded = true
            oversizedConnections += 1
            socket.write(OVERSIZED_FRAME)
          }
          newline = buffer.indexOf('\n')
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const identity = `broker-recovery-${process.pid}-${Date.now()}-${Math.random()}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    writeFileSync(
      descriptorPath,
      JSON.stringify({ version: 1, port, token: 'a'.repeat(64), pid: process.pid }),
    )
    let client: TerminalSessionBrokerClient | undefined
    try {
      let unavailableCount = 0
      client = new TerminalSessionBrokerClient({
        identity,
        unavailableTerminationTimeoutMs: 40,
        unavailableRecoveryBaseMs: 20,
        unavailableRecoveryMaxMs: 40,
        shutdownTimeoutMs: 50,
        log: (_level, ...args) => {
          if (
            args[0] ===
            '[TerminalBroker] Session termination remains unconfirmed; retrying with backoff'
          ) {
            firstUnconfirmed.resolve()
          }
        },
      })
      const unavailable = deferred<void>()
      client.attach('session-recovery', {
        onData: () => undefined,
        onExit: () => undefined,
        onUnavailable: () => {
          unavailableCount += 1
          unavailable.resolve()
        },
      })

      await withTimeout(firstUnconfirmed.promise)
      expect(unavailableCount).toBe(0)
      await withTimeout(unavailable.promise)

      expect(oversizedConnections).toBe(3)
      expect(terminationRequests).toBe(2)
      expect(shutdownRequests).toBe(1)
      expect(unavailableCount).toBe(1)
      await sleep(150)
      expect(terminationRequests).toBe(2)
      expect(unavailableCount).toBe(1)
    } finally {
      await client?.shutdown().catch(() => undefined)
      if (existsSync(descriptorPath)) unlinkSync(descriptorPath)
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test('detach cancels a sleeping unavailable-recovery generation and stale callbacks', async () => {
    let terminationRequests = 0
    let shutdownRequests = 0
    const firstUnconfirmed = deferred<void>()
    const server = createServer((socket) => {
      let responded = false
      let buffer = ''
      socket.on('error', () => undefined)
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as {
            op: string
          }
          buffer = buffer.slice(newline + 1)
          if (message.op === 'terminate-unavailable') {
            terminationRequests += 1
          } else if (message.op === 'shutdown') {
            shutdownRequests += 1
          } else if (!responded) {
            responded = true
            socket.write(OVERSIZED_FRAME)
          }
          newline = buffer.indexOf('\n')
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const identity = `broker-detach-recovery-${process.pid}-${Date.now()}-${Math.random()}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    writeFileSync(
      descriptorPath,
      JSON.stringify({ version: 1, port, token: 'a'.repeat(64), pid: process.pid }),
    )
    let unavailableCount = 0
    const client = new TerminalSessionBrokerClient({
      identity,
      unavailableTerminationTimeoutMs: 30,
      unavailableRecoveryBaseMs: 100,
      unavailableRecoveryMaxMs: 100,
      shutdownTimeoutMs: 30,
      log: (_level, ...args) => {
        if (
          args[0] ===
          '[TerminalBroker] Session termination remains unconfirmed; retrying with backoff'
        ) {
          firstUnconfirmed.resolve()
        }
      },
    })
    try {
      client.attach('session-detach-recovery', {
        onData: () => undefined,
        onExit: () => undefined,
        onUnavailable: () => {
          unavailableCount += 1
        },
      })
      await withTimeout(firstUnconfirmed.promise)

      client.detach()
      await sleep(300)

      expect(terminationRequests).toBe(1)
      expect(shutdownRequests).toBe(1)
      expect(unavailableCount).toBe(0)
    } finally {
      client.detach()
      if (existsSync(descriptorPath)) unlinkSync(descriptorPath)
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test('an explicit stop interrupts unavailable-recovery backoff immediately', async () => {
    let terminationRequests = 0
    const firstUnconfirmed = deferred<void>()
    const server = createServer((socket) => {
      let responded = false
      let buffer = ''
      socket.on('error', () => undefined)
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as {
            op: string
            sessionId?: string
          }
          buffer = buffer.slice(newline + 1)
          if (message.op === 'terminate-unavailable') {
            terminationRequests += 1
            if (terminationRequests >= 2) {
              socket.write(`${JSON.stringify({
                type: 'terminated-unavailable',
                sessionId: message.sessionId,
                interrupted: true,
              })}\n`)
            }
          } else if (!responded && message.op !== 'shutdown') {
            responded = true
            socket.write(OVERSIZED_FRAME)
          }
          newline = buffer.indexOf('\n')
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const identity = `broker-stop-recovery-${process.pid}-${Date.now()}-${Math.random()}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    writeFileSync(
      descriptorPath,
      JSON.stringify({ version: 1, port, token: 'a'.repeat(64), pid: process.pid }),
    )
    const unavailable = deferred<void>()
    const client = new TerminalSessionBrokerClient({
      identity,
      unavailableTerminationTimeoutMs: 30,
      unavailableRecoveryBaseMs: 1_000,
      unavailableRecoveryMaxMs: 1_000,
      shutdownTimeoutMs: 30,
      log: (_level, ...args) => {
        if (
          args[0] ===
          '[TerminalBroker] Session termination remains unconfirmed; retrying with backoff'
        ) {
          firstUnconfirmed.resolve()
        }
      },
    })
    try {
      client.attach('session-stop-recovery', {
        onData: () => undefined,
        onExit: () => undefined,
        onUnavailable: () => unavailable.resolve(),
      })
      await withTimeout(firstUnconfirmed.promise)

      client.stop('session-stop-recovery', true)
      await withTimeout(unavailable.promise, 500)

      expect(terminationRequests).toBe(2)
    } finally {
      client.detach()
      if (existsSync(descriptorPath)) unlinkSync(descriptorPath)
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test('retries only the unconfirmed member after a partial termination ACK', async () => {
    const requestCounts = new Map<string, number>()
    let shutdownRequests = 0
    const server = createServer((socket) => {
      let responded = false
      let buffer = ''
      socket.on('error', () => undefined)
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as {
            op: string
            sessionId?: string
          }
          buffer = buffer.slice(newline + 1)
          if (message.op === 'terminate-unavailable') {
            const sessionId = message.sessionId ?? ''
            const count = (requestCounts.get(sessionId) ?? 0) + 1
            requestCounts.set(sessionId, count)
            if (sessionId === 'session-partial-a' || count >= 2) {
              socket.write(`${JSON.stringify({
                type: 'terminated-unavailable',
                sessionId,
                interrupted: true,
              })}\n`)
            }
          } else if (message.op === 'shutdown') {
            shutdownRequests += 1
          } else if (!responded) {
            responded = true
            socket.write(OVERSIZED_FRAME)
          }
          newline = buffer.indexOf('\n')
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const identity = `broker-partial-${process.pid}-${Date.now()}-${Math.random()}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    writeFileSync(
      descriptorPath,
      JSON.stringify({ version: 1, port, token: 'a'.repeat(64), pid: process.pid }),
    )
    let client: TerminalSessionBrokerClient | undefined
    try {
      const settledA = deferred<void>()
      const settledB = deferred<void>()
      let callbacksA = 0
      let callbacksB = 0
      client = new TerminalSessionBrokerClient({
        identity,
        unavailableTerminationTimeoutMs: 40,
        unavailableRecoveryBaseMs: 20,
        unavailableRecoveryMaxMs: 40,
        shutdownTimeoutMs: 50,
      })
      client.attach('session-partial-a', {
        onData: () => undefined,
        onExit: () => undefined,
        onUnavailable: () => {
          callbacksA += 1
          settledA.resolve()
        },
      })
      client.attach('session-partial-b', {
        onData: () => undefined,
        onExit: () => undefined,
        onUnavailable: () => {
          callbacksB += 1
          settledB.resolve()
        },
      })

      await withTimeout(Promise.all([settledA.promise, settledB.promise]))
      expect(requestCounts.get('session-partial-a')).toBe(1)
      expect(requestCounts.get('session-partial-b')).toBe(2)
      expect(shutdownRequests).toBe(1)
      expect(callbacksA).toBe(1)
      expect(callbacksB).toBe(1)
      await sleep(150)
      expect(callbacksA).toBe(1)
      expect(callbacksB).toBe(1)
    } finally {
      await client?.shutdown().catch(() => undefined)
      if (existsSync(descriptorPath)) unlinkSync(descriptorPath)
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test('shutdown rejects and preserves a live descriptor when authentication cannot connect', async () => {
    const portProbe = createServer()
    await new Promise<void>((resolve) => portProbe.listen(0, '127.0.0.1', resolve))
    const port = (portProbe.address() as AddressInfo).port
    await new Promise<void>((resolve) => portProbe.close(() => resolve()))
    const identity = `broker-shutdown-closed-${process.pid}-${Date.now()}-${Math.random()}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    writeFileSync(
      descriptorPath,
      JSON.stringify({ version: 1, port, token: 'a'.repeat(64), pid: process.pid }),
    )
    const client = new TerminalSessionBrokerClient({
      identity,
      connectTimeoutMs: 30,
      shutdownTimeoutMs: 80,
    })
    try {
      await expect(client.shutdown()).rejects.toThrow(
        'Terminal broker shutdown remains unconfirmed',
      )
      expect(existsSync(descriptorPath)).toBe(true)
      expect(() => process.kill(process.pid, 0)).not.toThrow()
    } finally {
      if (existsSync(descriptorPath)) unlinkSync(descriptorPath)
    }
  })

  test('shutdown rejects when ACK arrives but broker PID and descriptor remain live', async () => {
    const server = createServer((socket) => {
      let buffer = ''
      socket.on('error', () => undefined)
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const message = JSON.parse(buffer.slice(0, newline)) as { op: string }
        if (message.op === 'shutdown') {
          socket.write(`${JSON.stringify({ type: 'shutdown-ack' })}\n`)
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const identity = `broker-shutdown-live-${process.pid}-${Date.now()}-${Math.random()}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    writeFileSync(
      descriptorPath,
      JSON.stringify({ version: 1, port, token: 'a'.repeat(64), pid: process.pid }),
    )
    const client = new TerminalSessionBrokerClient({
      identity,
      shutdownTimeoutMs: 80,
    })
    try {
      await expect(client.shutdown()).rejects.toThrow(
        'Terminal broker shutdown remains unconfirmed',
      )
      expect(existsSync(descriptorPath)).toBe(true)
      expect(() => process.kill(process.pid, 0)).not.toThrow()
    } finally {
      if (existsSync(descriptorPath)) unlinkSync(descriptorPath)
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test('a later shutdown call retries after an earlier truthful rejection', async () => {
    let shutdownRequests = 0
    let descriptorPath = ''
    const brokerSentinel = spawn(
      process.execPath,
      ['-e', 'setInterval(() => undefined, 1000)'],
      { stdio: 'ignore' },
    )
    const server = createServer((socket) => {
      let buffer = ''
      socket.on('error', () => undefined)
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const message = JSON.parse(buffer.slice(0, newline)) as { op: string }
        if (message.op !== 'shutdown') return
        shutdownRequests += 1
        if (shutdownRequests >= 2) {
          brokerSentinel.kill('SIGKILL')
          try {
            unlinkSync(descriptorPath)
          } catch {
            // Idempotent cleanup.
          }
        }
        socket.write(`${JSON.stringify({ type: 'shutdown-ack' })}\n`)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const identity = `broker-shutdown-retry-${process.pid}-${Date.now()}-${Math.random()}`
    descriptorPath = getTerminalBrokerDescriptorPath(identity)
    writeFileSync(
      descriptorPath,
      JSON.stringify({
        version: 1,
        port,
        token: 'a'.repeat(64),
        pid: brokerSentinel.pid,
      }),
    )
    const client = new TerminalSessionBrokerClient({
      identity,
      shutdownTimeoutMs: 80,
    })
    try {
      await expect(client.shutdown()).rejects.toThrow(
        'Terminal broker shutdown remains unconfirmed',
      )
      await expect(client.shutdown()).resolves.toBeUndefined()
      expect(shutdownRequests).toBe(2)
      expect(existsSync(descriptorPath)).toBe(false)
    } finally {
      brokerSentinel.kill('SIGKILL')
      if (existsSync(descriptorPath)) unlinkSync(descriptorPath)
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test('a parsed frame does NOT reset the oversized-frame streak (multi-session interleave)', async () => {
    // An old broker with several sessions interleaves a small valid
    // 'attached' before the oversized one on EVERY reconnect. If a parsed
    // frame reset the streak, this pattern would reconnect forever.
    const sessionId = 'session-loop-guard-interleave'
    const otherSessionId = 'session-loop-guard-interleave-other'
    let connections = 0
    let attachedCount = 0
    let oversizedConnections = 0
    let terminationRequests = 0
    const server = createServer((socket) => {
      connections += 1
      let responded = false
      let buffer = ''
      socket.on('error', () => undefined)
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as {
            op: string
            sessionId: string
          }
          buffer = buffer.slice(newline + 1)
          if (message.op === 'terminate-unavailable') {
            terminationRequests += 1
            socket.write(`${JSON.stringify({
              type: 'terminated-unavailable',
              sessionId: message.sessionId,
              interrupted: true,
              outcome: {
                status: 'stopped',
                exitCode: null,
                signal: 'SIGKILL',
              },
            })}\n`)
          } else if (!responded) {
            responded = true
            oversizedConnections += 1
            socket.write(
              `${JSON.stringify({ type: 'attached', sessionId, status: 'running', replay: '' })}\n`,
            )
            // Let the client parse the valid frame before the oversized bytes.
            setTimeout(() => {
              socket.write(OVERSIZED_FRAME)
            }, 100)
          }
          newline = buffer.indexOf('\n')
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const identity = `broker-loop-guard-interleave-${process.pid}-${Date.now()}-${Math.random()}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    writeFileSync(
      descriptorPath,
      JSON.stringify({ version: 1, port, token: 'a'.repeat(64), pid: process.pid }),
    )
    try {
      const unavailable = deferred<void>()
      const otherUnavailable = deferred<void>()
      const client = new TerminalSessionBrokerClient({ identity })
      client.attach(sessionId, {
        onAttached: () => {
          attachedCount += 1
        },
        onData: () => undefined,
        onExit: () => undefined,
        onUnavailable: () => unavailable.resolve(),
      })
      client.attach(otherSessionId, {
        onData: () => undefined,
        onExit: () => undefined,
        onUnavailable: () => otherUnavailable.resolve(),
      })
      await withTimeout(
        Promise.all([unavailable.promise, otherUnavailable.promise]),
        10_000,
      )
      expect(oversizedConnections).toBe(3)
      // Every session registered on the corrupted shared transport is
      // terminated and acknowledged; none may keep an unattended CLI.
      expect(terminationRequests).toBe(2)
      expect(connections).toBe(4)
      expect(attachedCount).toBeGreaterThanOrEqual(1)
      await sleep(400)
      expect(connections).toBe(4)
    } finally {
      unlinkSync(descriptorPath)
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test('the overflow streak resets after a quiet period', async () => {
    let connections = 0
    let oversizedConnections = 0
    let terminationRequests = 0
    const server = createServer((socket) => {
      connections += 1
      let responded = false
      let buffer = ''
      socket.on('error', () => undefined)
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as {
            op: string
            sessionId: string
          }
          buffer = buffer.slice(newline + 1)
          if (message.op === 'terminate-unavailable') {
            terminationRequests += 1
            socket.write(`${JSON.stringify({
              type: 'terminated-unavailable',
              sessionId: message.sessionId,
              interrupted: true,
              outcome: {
                status: 'stopped',
                exitCode: null,
                signal: 'SIGKILL',
              },
            })}\n`)
          } else if (!responded) {
            responded = true
            oversizedConnections += 1
            socket.write(OVERSIZED_FRAME)
          }
          newline = buffer.indexOf('\n')
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const identity = `broker-loop-guard-quiet-${process.pid}-${Date.now()}-${Math.random()}`
    const descriptorPath = getTerminalBrokerDescriptorPath(identity)
    writeFileSync(
      descriptorPath,
      JSON.stringify({ version: 1, port, token: 'a'.repeat(64), pid: process.pid }),
    )
    try {
      const unavailable = deferred<void>()
      // now() is consumed once per overflow destroy. Overflows 1-2 land in
      // one streak window; overflow 3 arrives after a >5s quiet gap, so the
      // streak restarts and give-up needs overflows 3-5.
      const nowValues = [0, 100, 10_000, 10_100, 10_200]
      let nowIndex = 0
      const client = new TerminalSessionBrokerClient({
        identity,
        now: () => nowValues[Math.min(nowIndex++, nowValues.length - 1)],
      })
      client.attach('session-loop-guard-quiet', {
        onData: () => undefined,
        onExit: () => undefined,
        onUnavailable: () => unavailable.resolve(),
      })
      await withTimeout(unavailable.promise, 10_000)
      expect(oversizedConnections).toBe(5)
      expect(terminationRequests).toBe(1)
      expect(connections).toBe(6)
      await sleep(400)
      expect(connections).toBe(6)
    } finally {
      unlinkSync(descriptorPath)
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test('rejects permissive and symlinked broker descriptors before connecting', async () => {
    let connections = 0
    const server = createServer((socket) => {
      connections += 1
      socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const targetDir = mkdtempSync(join(tmpdir(), 'taskchute-descriptor-security-'))

    const expectUnavailableWithoutConnect = async (
      identity: string,
    ): Promise<void> => {
      const unavailable = deferred<void>()
      const client = new TerminalSessionBrokerClient({ identity })
      client.attach(`session-${identity}`, {
        onData: () => undefined,
        onExit: () => undefined,
        onUnavailable: () => unavailable.resolve(),
      })
      await withTimeout(unavailable.promise)
      await client.shutdown()
    }

    try {
      const permissiveIdentity =
        `broker-permissive-${process.pid}-${Date.now()}-${Math.random()}`
      const permissivePath =
        getTerminalBrokerDescriptorPath(permissiveIdentity)
      writeFileSync(
        permissivePath,
        JSON.stringify({
          version: 1,
          port,
          token: 'a'.repeat(64),
          pid: process.pid,
        }),
      )
      chmodSync(permissivePath, 0o644)
      await expectUnavailableWithoutConnect(permissiveIdentity)
      unlinkSync(permissivePath)

      const symlinkIdentity =
        `broker-symlink-${process.pid}-${Date.now()}-${Math.random()}`
      const symlinkPath = getTerminalBrokerDescriptorPath(symlinkIdentity)
      const targetPath = join(targetDir, 'descriptor.json')
      writeFileSync(
        targetPath,
        JSON.stringify({
          version: 1,
          port,
          token: 'b'.repeat(64),
          pid: process.pid,
        }),
      )
      symlinkSync(targetPath, symlinkPath)
      await expectUnavailableWithoutConnect(symlinkIdentity)
      unlinkSync(symlinkPath)

      expect(connections).toBe(0)
    } finally {
      rmSync(targetDir, { force: true, recursive: true })
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
