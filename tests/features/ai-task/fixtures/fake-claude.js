#!/usr/bin/env node
'use strict'

/**
 * Fake Claude Code CLI for dispatcher tests.
 *
 * Emits canned `--output-format stream-json` lines (one JSON object per line)
 * with small delays. Real dispatcher argv (`-p`, `--output-format`, ...) is
 * accepted and ignored; only the mode flags below are honored:
 *
 *   --exit-code N   exit with code N after emitting the stream
 *   --error-result  emit a result line with is_error=true (still exits 0)
 *   --hang          emit the init line, then stay alive until killed
 *   --dump-env      write JSON.stringify(process.env) to stderr first
 *   --multibyte     split the assistant line MID-multibyte-character (byte
 *                   level) across two stdout writes to exercise UTF-8
 *                   reassembly in the consumer
 */

const argv = process.argv.slice(2)

function argValue(flag) {
  const index = argv.indexOf(flag)
  if (index === -1 || index + 1 >= argv.length) return null
  return argv[index + 1]
}

const exitCode = Number(argValue('--exit-code') || '0')
const hang = argv.includes('--hang')
const dumpEnv = argv.includes('--dump-env')
const errorResult = argv.includes('--error-result')
const multibyte = argv.includes('--multibyte')

if (dumpEnv) {
  process.stderr.write(JSON.stringify(process.env) + '\n')
}

const initLine = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: 'fake-claude-session',
  model: 'fake-model',
})

const assistantTextLine = JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      { type: 'text', text: multibyte ? 'こんにちは、日本語の応答' : 'Hello from fake claude' },
    ],
  },
})

const toolUseLine = JSON.stringify({
  type: 'assistant',
  message: {
    content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } }],
  },
})

const toolResultLine = JSON.stringify({
  type: 'user',
  message: {
    content: [{ type: 'tool_result', content: 'hi', is_error: false }],
  },
})

const resultLine = JSON.stringify({
  type: 'result',
  subtype: errorResult ? 'error_during_execution' : 'success',
  is_error: errorResult,
  total_cost_usd: 0.01,
  num_turns: 1,
  result: errorResult ? undefined : 'Hello from fake claude',
})

function finish() {
  process.exitCode = exitCode
}

function emitTail() {
  process.stdout.write(toolUseLine + '\n')
  setTimeout(() => {
    process.stdout.write(toolResultLine + '\n')
    setTimeout(() => {
      process.stdout.write(resultLine + '\n')
      finish()
    }, 5)
  }, 5)
}

setTimeout(() => {
  process.stdout.write(initLine + '\n')

  if (hang) {
    // Keep the event loop alive until a signal terminates the process.
    setInterval(() => {}, 1000)
    return
  }

  // Write the assistant line in two chunks to exercise chunk-boundary
  // buffering in the consumer. In --multibyte mode, split at the BYTE level,
  // one byte into a 3-byte UTF-8 character, so naive per-chunk decoding
  // would produce U+FFFD on both halves.
  const lineBuffer = Buffer.from(assistantTextLine + '\n', 'utf8')
  let splitAt
  if (multibyte) {
    const multibyteCharOffset = lineBuffer.indexOf(Buffer.from('こ', 'utf8'))
    splitAt = multibyteCharOffset + 1
  } else {
    splitAt = Math.floor(lineBuffer.length / 2)
  }
  setTimeout(() => {
    process.stdout.write(lineBuffer.slice(0, splitAt))
    setTimeout(() => {
      process.stdout.write(lineBuffer.slice(splitAt))
      setTimeout(emitTail, 5)
    }, 5)
  }, 5)
}, 10)
