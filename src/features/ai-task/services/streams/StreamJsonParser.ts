/**
 * AI Task - stream-json line parsers
 *
 * Converts one JSONL line from a headless CLI into zero or more
 * AiStreamEvents. Both parsers are defensive by design: JSON.parse failures,
 * non-object payloads, and unknown event shapes degrade to a `raw` event so
 * nothing in the stream is ever lost, and the parsers never throw.
 */

import type { AiStreamEvent } from '../../types'

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function rawEvent(line: string): AiStreamEvent[] {
  return [{ kind: 'raw', text: line }]
}

function tryParseRecord(line: string): UnknownRecord | null {
  try {
    const parsed: unknown = JSON.parse(line)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Claude Code: `claude -p PROMPT --output-format stream-json --verbose`
// ---------------------------------------------------------------------------

function parseClaudeAssistant(payload: UnknownRecord): AiStreamEvent[] {
  const message = payload['message']
  if (!isRecord(message)) return []
  const content = message['content']
  if (!Array.isArray(content)) return []

  const events: AiStreamEvent[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block['type'] === 'text') {
      const text = asString(block['text'])
      if (text !== undefined) {
        events.push({ kind: 'assistant-text', text })
      }
      continue
    }
    if (block['type'] === 'tool_use') {
      events.push({
        kind: 'tool-use',
        toolName: asString(block['name']) ?? 'unknown',
        input: block['input'],
      })
    }
  }
  return events
}

function extractToolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const item of content) {
    if (isRecord(item) && item['type'] === 'text') {
      const text = asString(item['text'])
      if (text !== undefined) parts.push(text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

function parseClaudeUser(payload: UnknownRecord): AiStreamEvent[] {
  const message = payload['message']
  if (!isRecord(message)) return []
  const content = message['content']
  if (!Array.isArray(content)) return []

  const events: AiStreamEvent[] = []
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'tool_result') continue
    events.push({
      kind: 'tool-result',
      text: extractToolResultText(block['content']),
      isError: block['is_error'] === true,
    })
  }
  return events
}

/**
 * Parse one line of Claude Code stream-json output.
 * Returns [] for blank lines; falls back to a raw event otherwise.
 */
export function parseClaudeLine(line: string): AiStreamEvent[] {
  if (line.trim().length === 0) return []
  const payload = tryParseRecord(line)
  if (!payload) return rawEvent(line)

  const type = payload['type']
  if (type === 'system' && payload['subtype'] === 'init') {
    return [
      {
        kind: 'init',
        sessionId: asString(payload['session_id']),
        model: asString(payload['model']),
      },
    ]
  }
  if (type === 'assistant') {
    const events = parseClaudeAssistant(payload)
    return events.length > 0 ? events : rawEvent(line)
  }
  if (type === 'user') {
    const events = parseClaudeUser(payload)
    return events.length > 0 ? events : rawEvent(line)
  }
  if (type === 'result') {
    return [
      {
        kind: 'result',
        subtype: asString(payload['subtype']),
        isError: payload['is_error'] === true,
        totalCostUsd: asFiniteNumber(payload['total_cost_usd']),
        numTurns: asFiniteNumber(payload['num_turns']),
        text: asString(payload['result']),
      },
    ]
  }
  return rawEvent(line)
}

// ---------------------------------------------------------------------------
// Codex: `codex exec --json PROMPT`
// ---------------------------------------------------------------------------

function parseCodexCompletedItem(
  payload: UnknownRecord,
  line: string,
): AiStreamEvent[] {
  const item = payload['item']
  if (!isRecord(item)) return rawEvent(line)
  const itemType = asString(item['item_type']) ?? asString(item['type'])

  if (itemType === 'agent_message') {
    const text = asString(item['text'])
    if (text !== undefined) {
      return [{ kind: 'assistant-text', text }]
    }
    return rawEvent(line)
  }
  if (itemType === 'command_execution') {
    const events: AiStreamEvent[] = [
      {
        kind: 'tool-use',
        toolName: 'command_execution',
        input: item['command'],
      },
    ]
    const output = asString(item['aggregated_output'])
    if (output !== undefined) {
      const exitCode = asFiniteNumber(item['exit_code'])
      events.push({
        kind: 'tool-result',
        text: output,
        isError: exitCode !== undefined && exitCode !== 0,
      })
    }
    return events
  }
  return rawEvent(line)
}

/**
 * A bare session/thread UUID line some codex builds print before the JSONL
 * stream starts. Recognized so it can surface as an init event (and enable
 * resume follow-ups) instead of degrading to raw noise.
 */
const BARE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Parse one line of Codex `exec --json` output.
 * Returns [] for blank lines and ignored lifecycle events;
 * falls back to a raw event for anything unrecognized.
 */
export function parseCodexLine(line: string): AiStreamEvent[] {
  const trimmed = line.trim()
  if (trimmed.length === 0) return []
  const payload = tryParseRecord(line)
  if (!payload) {
    if (BARE_UUID_PATTERN.test(trimmed)) {
      return [{ kind: 'init', sessionId: trimmed, model: undefined }]
    }
    return rawEvent(line)
  }

  const type = payload['type']
  if (type === 'thread.started') {
    return [
      {
        kind: 'init',
        sessionId: asString(payload['thread_id']) ?? asString(payload['session_id']),
        model: asString(payload['model']),
      },
    ]
  }
  if (type === 'turn.started' || type === 'item.started' || type === 'item.updated') {
    return []
  }
  if (type === 'item.completed') {
    return parseCodexCompletedItem(payload, line)
  }
  if (type === 'turn.completed') {
    return [{ kind: 'result', subtype: 'turn.completed', isError: false }]
  }
  if (type === 'turn.failed') {
    const error = payload['error']
    return [
      {
        kind: 'result',
        subtype: 'turn.failed',
        isError: true,
        text: isRecord(error) ? asString(error['message']) : asString(error),
      },
    ]
  }
  if (type === 'error') {
    return [
      {
        kind: 'result',
        subtype: 'error',
        isError: true,
        text: asString(payload['message']),
      },
    ]
  }
  return rawEvent(line)
}
