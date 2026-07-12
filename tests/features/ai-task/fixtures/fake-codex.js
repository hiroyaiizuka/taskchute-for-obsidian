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
 *
 * When invoked with the real resume argv shape (`exec resume <session-id>
 * ...`), the fixture emits a canned continuation on the SAME thread id (like
 * the real codex) with a follow-up assistant message.
 */

const argv = process.argv.slice(2)

// Mirror real `codex exec` (0.144.1): the non-interactive pipeline has no
// approval-policy flag, so clap rejects it with exit code 2. This keeps the
// dispatcher's interactive-only-flag sanitizing honest in fixture runs.
const separatorIndex = argv.indexOf('--')
const optionArgs = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex)
const approvalFlag = optionArgs.find(
  (arg) =>
    arg === '--ask-for-approval' ||
    arg.startsWith('--ask-for-approval=') ||
    arg === '-a' ||
    arg.startsWith('-a='),
)
if (approvalFlag) {
  process.stderr.write(
    "error: unexpected argument '" + approvalFlag + "' found\n",
  )
  process.exit(2)
}

function argValue(flag) {
  const index = argv.indexOf(flag)
  if (index === -1 || index + 1 >= argv.length) return null
  return argv[index + 1]
}

const exitCode = Number(argValue('--exit-code') || '0')
const hang = argv.includes('--hang')
const dumpEnv = argv.includes('--dump-env')
const errorResult = argv.includes('--error-result')
const resumeSessionId = argv[0] === 'exec' && argv[1] === 'resume' ? argv[2] : null

if (dumpEnv) {
  process.stderr.write(JSON.stringify(process.env) + '\n')
}

const threadId = resumeSessionId || 'fake-codex-thread'
const messageText = resumeSessionId ? 'Follow-up from fake codex' : 'Hello from fake codex'

const lines = [
  JSON.stringify({ type: 'thread.started', thread_id: threadId, model: 'fake-codex-model' }),
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({
    type: 'item.completed',
    item: { item_type: 'agent_message', text: messageText },
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
