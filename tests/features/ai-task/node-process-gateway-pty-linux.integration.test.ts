/**
 * Linux-only: the REAL PTY wrapper (NodeProcessGateway.buildPtyCommand ->
 * /bin/sh -> dd | /usr/bin/script) keeps relaying the CLI's output while
 * input arrives.
 *
 * Regression: with `cat` as the stdin pump, a cat that copies with splice(2)
 * (uutils coreutils, Ubuntu 25.10+) holds the pipe's lock while it waits for
 * the next keystroke; `script` then hangs in read() on that pipe and nothing
 * the CLI prints gets through until another key arrives. Two inputs back to
 * back — what a terminal sends in reply to a CLI's startup queries — were
 * enough, and the terminal stayed empty for Claude Code and Cursor.
 */

import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { NodeProcessGateway } from '@/features/ai-task/services/NodeProcessGateway'

const describeLinux = process.platform === 'linux' && fs.existsSync('/usr/bin/script') ? describe : describe.skip

describeLinux('NodeProcessGateway PTY wrapper on Linux (real script)', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskchute-pty-linux-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Runs `program` under the wrapper; `inputs` are written to stdin at the given times. */
  function run(program: string, inputs: Array<{ atMs: number; data: string }>, forMs: number): Promise<string> {
    const command = new NodeProcessGateway().buildPtyCommand({
      binaryPath: '/bin/sh',
      args: ['-c', program],
      rows: 24,
      cols: 80,
      transcriptPath: path.join(dir, 'transcript.log'),
    })
    return new Promise((resolve) => {
      // stdin is Node's 'pipe' (a socketpair), exactly as the plugin spawns it.
      const child = spawn(command.command, command.args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true })
      let output = ''
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
      child.stdin.on('error', () => undefined)
      const timers = inputs.map(({ atMs, data }) => setTimeout(() => child.stdin.write(data), atMs))
      setTimeout(() => {
        timers.forEach(clearTimeout)
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        } catch {
          // The wrapper already reaped its own group.
        }
        resolve(output)
      }, forMs)
    })
  }

  const TICKS = 'stty -echo; for i in 1 2 3 4; do sleep 0.4; echo "TICK$i"; done; sleep 5'

  test('output keeps arriving when two inputs come back to back', async () => {
    const output = await run(TICKS, [{ atMs: 150, data: 'a' }, { atMs: 180, data: 'b' }], 3000)
    expect(output).toContain('TICK1')
    expect(output).toContain('TICK4')
  }, 15_000)

  test('input still reaches the program', async () => {
    const output = await run('IFS= read -r line; echo "GOT:$line"; sleep 5', [{ atMs: 300, data: 'hello\n' }], 2500)
    expect(output).toContain('GOT:hello')
  }, 15_000)
})
