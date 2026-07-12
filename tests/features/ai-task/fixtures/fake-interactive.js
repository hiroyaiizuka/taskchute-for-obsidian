#!/usr/bin/env node
'use strict'

/**
 * Fake interactive CLI for terminal-dispatcher tests.
 *
 * Prints a ready banner, then echoes every stdin line back with an `echo:`
 * prefix. Recognized input lines:
 *
 *   exit   print BYE and exit 0
 *   fail   exit with code 7 (no output)
 *   env    print JSON.stringify(process.env) on a single line
 *
 * SIGTERM prints TERMINATED and exits 0, so consumers can verify their
 * graceful-stop path without relying on signal exit codes.
 */

process.stdout.write('INTERACTIVE_READY\n')

process.on('SIGTERM', () => {
  process.stdout.write('TERMINATED\n')
  process.exit(0)
})

let buffer = ''

function handleLine(line) {
  if (line === 'exit') {
    process.stdout.write('BYE\n')
    process.exit(0)
  }
  if (line === 'fail') {
    process.exit(7)
  }
  if (line === 'env') {
    process.stdout.write(JSON.stringify(process.env) + '\n')
    return
  }
  process.stdout.write('echo:' + line + '\n')
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newlineIndex = buffer.indexOf('\n')
  while (newlineIndex !== -1) {
    const line = buffer.slice(0, newlineIndex).replace(/\r$/, '')
    buffer = buffer.slice(newlineIndex + 1)
    handleLine(line)
    newlineIndex = buffer.indexOf('\n')
  }
})

// Keep the event loop alive even if stdin ends (PTY sessions may not EOF).
process.stdin.on('end', () => {
  setInterval(() => {}, 1000)
})
