/**
 * AI Task - stream-json line parsers
 *
 * Converts one JSONL line from a headless CLI into zero or more
 * AiStreamEvents. Both parsers are defensive by design: JSON.parse failures,
 * non-object payloads, and unknown event shapes degrade to a `raw` event so
 * nothing in the stream is ever lost, and the parsers never throw.
 */

import type { AiStreamEvent } from '../../types'

/**
 * Maximum characters of text stored per event. Longer payloads keep the tail
 * slice (progress/results live there; the session store also tail-slices)
 * behind a short truncation marker, so events stay bounded in memory and DOM.
 */
export const EVENT_TEXT_LIMIT = 16 * 1024

/**
 * Maximum events emitted from one JSONL record. A hostile assistant payload
 * can put hundreds of thousands of content blocks in a single valid line;
 * materializing all of them would bypass the run-level buffer cap and block
 * the renderer before the events ever reach it.
 *
 * One slot is reserved for an elision event when the record overflows.
 */
export const EVENTS_PER_LINE_LIMIT = 256

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

/**
 * Copy a slice into a fresh flat allocation. V8 represents
 * String.prototype.slice results as SlicedString views that retain the
 * ENTIRE parent string, so storing a 16KB slice of a multi-megabyte payload
 * in the long-lived event buffer would pin the whole payload in the heap.
 * The JSON round-trip materializes a fresh flat string in every JS engine,
 * losslessly (including lone surrogates). It deliberately runs for short
 * strings too: a tiny slice can otherwise pin a multi-megabyte parent.
 */
function flattenSlice(slice: string): string {
  return JSON.parse(JSON.stringify(slice)) as string
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function capTextTail(text: string): string {
  if (text.length <= EVENT_TEXT_LIMIT) return flattenSlice(text)
  let start = text.length - EVENT_TEXT_LIMIT
  // Never start on the low half of a surrogate pair the cut split.
  if (isLowSurrogate(text.charCodeAt(start))) start += 1
  const tail = flattenSlice(text.slice(start))
  return `…[+${text.length - tail.length} chars truncated]\n${tail}`
}

function capOptionalTextTail(text: string | undefined): string | undefined {
  return text === undefined ? undefined : capTextTail(text)
}

/**
 * Bound + flatten event text created outside this parser (e.g. dispatcher
 * stderr lines), so no event-creation site can bypass EVENT_TEXT_LIMIT.
 */
export function capEventText(text: string): string {
  return capTextTail(text)
}

/**
 * Identifier-ish fields (sessionId, model, toolName, subtype) are tiny in
 * every legitimate payload; anything longer is garbage that would otherwise
 * sit uncapped in the event buffer. Truncate hard (no marker) and flatten.
 */
export const EVENT_FIELD_LIMIT = 512

function capField(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (value.length <= EVENT_FIELD_LIMIT) return flattenSlice(value)
  let end = EVENT_FIELD_LIMIT
  if (isHighSurrogate(value.charCodeAt(end - 1))) end -= 1
  return flattenSlice(value.slice(0, end))
}

/**
 * Replace an oversized tool-use input with a bounded serialized preview
 * string (head slice; tool inputs carry their signal up front). Small inputs
 * pass through untouched so downstream JSON handling keeps working.
 */
function capToolUseInput(input: unknown): unknown {
  if (input === undefined) return undefined
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(input)
  } catch {
    return '[tool input omitted: serialization failed]'
  }
  if (serialized === undefined) {
    return '[tool input omitted: not JSON-serializable]'
  }
  if (serialized.length <= EVENT_TEXT_LIMIT) {
    // Parsed JSON values can contain short SlicedStrings backed by the full
    // multi-megabyte JSONL line. Reparse the bounded serialization so no
    // string reachable from the event retains that parent allocation.
    try {
      return JSON.parse(serialized) as unknown
    } catch {
      return '[tool input omitted: serialization could not be materialized]'
    }
  }
  let end = EVENT_TEXT_LIMIT
  // Never end on the high half of a surrogate pair the cut split.
  if (isHighSurrogate(serialized.charCodeAt(end - 1))) end -= 1
  const head = flattenSlice(serialized.slice(0, end))
  return `${head}…[+${serialized.length - head.length} chars truncated]`
}

interface LineEventAccumulator {
  events: AiStreamEvent[]
  omittedCount: number
}

function appendLineEvent(
  accumulator: LineEventAccumulator,
  createEvent: () => AiStreamEvent,
): void {
  if (accumulator.events.length < EVENTS_PER_LINE_LIMIT - 1) {
    accumulator.events.push(createEvent())
    return
  }
  accumulator.omittedCount += 1
}

function finishLineEvents(accumulator: LineEventAccumulator): AiStreamEvent[] {
  if (accumulator.omittedCount > 0) {
    accumulator.events.push({
      kind: 'elision',
      omittedCount: accumulator.omittedCount,
    })
  }
  return accumulator.events
}

function rawEvent(line: string): AiStreamEvent[] {
  return [{ kind: 'raw', text: capTextTail(line) }]
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

  const accumulator: LineEventAccumulator = { events: [], omittedCount: 0 }
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block['type'] === 'text') {
      const text = asString(block['text'])
      if (text !== undefined) {
        appendLineEvent(accumulator, () => ({
          kind: 'assistant-text',
          text: capTextTail(text),
        }))
      }
      continue
    }
    if (block['type'] === 'tool_use') {
      appendLineEvent(accumulator, () => ({
        kind: 'tool-use',
        toolName: capField(asString(block['name'])) ?? 'unknown',
        input: capToolUseInput(block['input']),
      }))
    }
  }
  return finishLineEvents(accumulator)
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

  const accumulator: LineEventAccumulator = { events: [], omittedCount: 0 }
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'tool_result') continue
    appendLineEvent(accumulator, () => ({
      kind: 'tool-result',
      text: capOptionalTextTail(extractToolResultText(block['content'])),
      isError: block['is_error'] === true,
    }))
  }
  return finishLineEvents(accumulator)
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
        sessionId: capField(asString(payload['session_id'])),
        model: capField(asString(payload['model'])),
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
        subtype: capField(asString(payload['subtype'])),
        isError: payload['is_error'] === true,
        totalCostUsd: asFiniteNumber(payload['total_cost_usd']),
        numTurns: asFiniteNumber(payload['num_turns']),
        text: capOptionalTextTail(asString(payload['result'])),
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
      return [{ kind: 'assistant-text', text: capTextTail(text) }]
    }
    return rawEvent(line)
  }
  if (itemType === 'command_execution') {
    const events: AiStreamEvent[] = [
      {
        kind: 'tool-use',
        toolName: 'command_execution',
        input: capToolUseInput(item['command']),
      },
    ]
    const output = asString(item['aggregated_output'])
    if (output !== undefined) {
      const exitCode = asFiniteNumber(item['exit_code'])
      events.push({
        kind: 'tool-result',
        text: capTextTail(output),
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
      return [{ kind: 'init', sessionId: capField(trimmed), model: undefined }]
    }
    return rawEvent(line)
  }

  const type = payload['type']
  if (type === 'thread.started') {
    return [
      {
        kind: 'init',
        sessionId: capField(asString(payload['thread_id']) ?? asString(payload['session_id'])),
        model: capField(asString(payload['model'])),
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
        text: capOptionalTextTail(
          isRecord(error) ? asString(error['message']) : asString(error),
        ),
      },
    ]
  }
  if (type === 'error') {
    return [
      {
        kind: 'result',
        subtype: 'error',
        isError: true,
        text: capOptionalTextTail(asString(payload['message'])),
      },
    ]
  }
  return rawEvent(line)
}
