/**
 * The PTY wrapper's supervisor runs the CLI in the background and waits for
 * it. A non-interactive dash (/bin/sh on Debian and Ubuntu, where `script`
 * runs it on Linux since LEV-388) gives a background job /dev/null before
 * its redirections, so `<&0` alone left the CLI reading /dev/null: nothing
 * typed in the terminal reached it. Every POSIX shell here must hand the CLI
 * the wrapper's stdin.
 */

import { spawnSync } from 'child_process'
import * as fs from 'fs'
import { PTY_SUPERVISOR } from '@/features/ai-task/services/NodeProcessGateway'

const SHELLS = ['/bin/sh', '/bin/dash', '/bin/bash', '/bin/zsh'].filter((shell) => fs.existsSync(shell))
const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('PTY supervisor stdin', () => {
  test.each(SHELLS)('%s hands the CLI the input', (shell) => {
    const result = spawnSync(
      shell,
      ['-c', PTY_SUPERVISOR, '/bin/sh', '-c', 'IFS= read -r line; echo "GOT:$line"'],
      { input: 'hello\n', encoding: 'utf8', timeout: 10_000 },
    )
    expect(result.stdout).toContain('GOT:hello')
  })
})
