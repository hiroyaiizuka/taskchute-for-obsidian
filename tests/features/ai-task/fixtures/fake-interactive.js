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
 *   size   print the current PTY rows x columns
 *
 * `--ignore-signals` makes the fixture ignore SIGTERM and SIGHUP so the real
 * PTY integration test can prove the wrapper supervisor reaps a hostile CLI.
 * Otherwise SIGTERM prints TERMINATED and exits 0.
 * `--spawn-detached-child` additionally creates a signal-ignoring child in a
 * separate session/process group for app-shutdown E2E cleanup verification.
 */

process.stdout.write('INTERACTIVE_READY\n')
process.stdout.write('INTERACTIVE_PID:' + process.pid + '\n')

if (process.argv.includes('--report-prompt')) {
  const { createHash } = require('crypto')
  const separatorIndex = process.argv.indexOf('--')
  const prompt = separatorIndex >= 0
    ? (process.argv[separatorIndex + 1] || '')
    : ''
  process.stdout.write(
    'PROMPT_BYTES:' + Buffer.byteLength(prompt, 'utf8') + '\n',
  )
  process.stdout.write('PROMPT_TAIL:' + prompt.slice(-64) + '\n')
  process.stdout.write(
    'PROMPT_SHA256:' +
      createHash('sha256').update(prompt, 'utf8').digest('hex') +
      '\n',
  )
}

if (process.argv.includes('--spawn-detached-child')) {
  const { spawn } = require('child_process')
  const detached = spawn(
    process.execPath,
    [
      '-e',
      'process.on("SIGTERM",()=>{});process.on("SIGHUP",()=>{});setInterval(()=>{},1000)',
    ],
    { detached: true, stdio: 'ignore' },
  )
  detached.unref()
  process.stdout.write('DETACHED_PID:' + detached.pid + '\n')
}

if (process.argv.includes('--ignore-signals')) {
  process.on('SIGTERM', () => {})
  process.on('SIGHUP', () => {})
} else {
  process.on('SIGTERM', () => {
    process.stdout.write('TERMINATED\n')
    process.exit(0)
  })
}

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
  if (line === 'size') {
    process.stdout.write(`SIZE:${process.stdout.rows}x${process.stdout.columns}\n`)
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
