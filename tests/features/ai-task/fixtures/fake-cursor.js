#!/usr/bin/env node
'use strict'

/**
 * Fake Cursor Agent CLI for dispatcher tests.
 *
 * Emits stream-json lines shaped like `cursor-agent -p --output-format
 * stream-json` 2026.10.01: init, the echo of the prompt, thinking deltas, an
 * assistant message, a shell tool call (started/completed), and the result.
 * Real dispatcher argv is accepted and ignored apart from:
 *
 *   --resume <id>     continue that session (same session id, like the real CLI)
 *   --exit-code N     exit with code N after the stream
 *   --not-logged-in   print the real CLI's authentication error and exit 1
 */

const argv = process.argv.slice(2)

function argValue(flag) {
  const index = argv.indexOf(flag)
  if (index === -1 || index + 1 >= argv.length) return null
  return argv[index + 1]
}

if (argv.includes('--not-logged-in')) {
  process.stdout.write(
    "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\n",
  )
  process.exit(1)
}

const resumeSessionId = argValue('--resume')
const sessionId = resumeSessionId || 'fake-cursor-session'
const prompt = argv[argv.indexOf('--') + 1] || ''
const line = (value) => JSON.stringify({ ...value, session_id: sessionId })

const lines = [
  line({ type: 'system', subtype: 'init', apiKeySource: 'login', cwd: process.cwd(), model: 'Auto', permissionMode: 'default' }),
  line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }),
  line({ type: 'thinking', subtype: 'delta', text: 'Thinking about it' }),
  line({ type: 'thinking', subtype: 'completed' }),
]
if (resumeSessionId) {
  lines.push(line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Follow-up from fake cursor' }] } }))
} else {
  lines.push(
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello from fake cursor' }] } }),
    line({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'call-1',
      tool_call: { shellToolCall: { args: { command: 'echo hi' } } },
    }),
    line({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'call-1',
      tool_call: {
        shellToolCall: {
          args: { command: 'echo hi' },
          result: { success: { command: 'echo hi', exitCode: 0, stdout: 'hi\n', stderr: '', interleavedOutput: 'hi\n' } },
        },
      },
    }),
  )
}
lines.push(
  line({ type: 'result', subtype: 'success', duration_ms: 10, is_error: false, result: 'done', usage: { inputTokens: 1, outputTokens: 1 } }),
)

let index = 0
function next() {
  if (index >= lines.length) {
    process.exit(Number(argValue('--exit-code') || '0'))
  }
  process.stdout.write(lines[index] + '\n')
  index += 1
  setTimeout(next, 5)
}
next()
