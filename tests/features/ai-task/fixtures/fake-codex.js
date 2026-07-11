#!/usr/bin/env node
'use strict'

/**
 * Fake Codex CLI for dispatcher tests.
 *
 * Emits canned `codex exec --json` JSONL lines with small delays. Real
 * dispatcher argv (`exec`, `--json`, prompt, ...) is accepted and ignored;
 * only the mode flags below are honored:
 *
 *   --exit-code N   exit with code N after emitting the stream
 *   --error-result  emit a turn.failed line instead of turn.completed
 *   --hang          emit the thread.started line, then stay alive until killed
 *   --dump-env      write JSON.stringify(process.env) to stderr first
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

if (dumpEnv) {
  process.stderr.write(JSON.stringify(process.env) + '\n')
}

const lines = [
  JSON.stringify({ type: 'thread.started', thread_id: 'fake-codex-thread', model: 'fake-codex-model' }),
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({
    type: 'item.completed',
    item: { item_type: 'agent_message', text: 'Hello from fake codex' },
  }),
  errorResult
    ? JSON.stringify({ type: 'turn.failed', error: { message: 'fake codex failure' } })
    : JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
]

function emitLines(remaining) {
  if (remaining.length === 0) {
    process.exitCode = exitCode
    return
  }
  process.stdout.write(remaining[0] + '\n')
  if (hang && remaining.length === lines.length) {
    // Keep the event loop alive until a signal terminates the process.
    setInterval(() => {}, 1000)
    return
  }
  setTimeout(() => emitLines(remaining.slice(1)), 5)
}

setTimeout(() => emitLines(lines), 10)
