import {
  capEventText,
  EVENT_FIELD_LIMIT,
  EVENT_TEXT_LIMIT,
  EVENTS_PER_LINE_LIMIT,
  parseClaudeLine,
  parseCodexLine,
} from '../../../src/features/ai-task/services/streams/StreamJsonParser'

describe('parseClaudeLine', () => {
  test('returns no events for blank lines', () => {
    expect(parseClaudeLine('')).toEqual([])
    expect(parseClaudeLine('   ')).toEqual([])
  })

  test('returns a raw event for malformed JSON', () => {
    const line = '{"type":"assistant", broken'
    expect(parseClaudeLine(line)).toEqual([{ kind: 'raw', text: line }])
  })

  test('returns a raw event for non-object JSON values', () => {
    expect(parseClaudeLine('42')).toEqual([{ kind: 'raw', text: '42' }])
    expect(parseClaudeLine('"hello"')).toEqual([{ kind: 'raw', text: '"hello"' }])
    expect(parseClaudeLine('null')).toEqual([{ kind: 'raw', text: 'null' }])
  })

  test('parses the system init event', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-123',
      model: 'claude-sonnet-4-5',
      cwd: '/tmp',
    })
    expect(parseClaudeLine(line)).toEqual([
      { kind: 'init', sessionId: 'sess-123', model: 'claude-sonnet-4-5' },
    ])
  })

  test('reduces system events with other subtypes to a short marker', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      error: 'overloaded',
    })
    expect(parseClaudeLine(line)).toEqual([
      { kind: 'raw', text: '[unhandled] system/api_retry' },
    ])
  })

  test('parses assistant text blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello there' }] },
    })
    expect(parseClaudeLine(line)).toEqual([
      { kind: 'assistant-text', text: 'Hello there' },
    ])
  })

  test('parses mixed assistant text and tool_use blocks in order', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Running a command' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    })
    expect(parseClaudeLine(line)).toEqual([
      { kind: 'assistant-text', text: 'Running a command' },
      { kind: 'tool-use', toolName: 'Bash', input: { command: 'ls' } },
    ])
  })

  test('parses tool_use blocks without a name defensively', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', input: {} }] },
    })
    expect(parseClaudeLine(line)).toEqual([
      { kind: 'tool-use', toolName: 'unknown', input: {} },
    ])
  })

  test('treats an assistant event with a malformed message as raw', () => {
    const noMessage = JSON.stringify({ type: 'assistant' })
    expect(parseClaudeLine(noMessage)).toEqual([{ kind: 'raw', text: noMessage }])

    const nullMessage = JSON.stringify({ type: 'assistant', message: null })
    expect(parseClaudeLine(nullMessage)).toEqual([{ kind: 'raw', text: nullMessage }])

    const contentNotArray = JSON.stringify({
      type: 'assistant',
      message: { content: 'oops' },
    })
    expect(parseClaudeLine(contentNotArray)).toEqual([
      { kind: 'raw', text: contentNotArray },
    ])
  })

  // Claude emits one of these every turn. Dumping the line raw buried the run
  // pane under the block's signed base64 payload.
  test('emits nothing for an assistant message holding only thinking blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '', signature: 'EuoCCqgBCBEYAipAy8Em' },
        ],
      },
      session_id: '34f4fad3-b521-434d-98c3-d25e4f974c67',
    })
    expect(parseClaudeLine(line)).toEqual([])
  })

  test('emits nothing for a user message carrying no tool_result blocks', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'text', text: 'echoed prompt' }] },
    })
    expect(parseClaudeLine(line)).toEqual([])
  })

  test('parses user tool_result blocks with string content', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', content: 'file.txt', is_error: false }],
      },
    })
    expect(parseClaudeLine(line)).toEqual([
      { kind: 'tool-result', text: 'file.txt', isError: false },
    ])
  })

  test('parses tool_result blocks with nested text content arrays', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            content: [
              { type: 'text', text: 'line a' },
              { type: 'text', text: 'line b' },
            ],
            is_error: true,
          },
        ],
      },
    })
    expect(parseClaudeLine(line)).toEqual([
      { kind: 'tool-result', text: 'line a\nline b', isError: true },
    ])
  })

  test('parses the final result event', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: 0.0123,
      num_turns: 3,
      result: 'All done',
    })
    expect(parseClaudeLine(line)).toEqual([
      {
        kind: 'result',
        subtype: 'success',
        isError: false,
        totalCostUsd: 0.0123,
        numTurns: 3,
        text: 'All done',
      },
    ])
  })

  test('parses an error result event', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      num_turns: 5,
    })
    expect(parseClaudeLine(line)).toEqual([
      {
        kind: 'result',
        subtype: 'error_max_turns',
        isError: true,
        totalCostUsd: undefined,
        numTurns: 5,
        text: undefined,
      },
    ])
  })

  test('reduces unknown event types to a short marker', () => {
    const line = JSON.stringify({ type: 'stream_event', payload: 1 })
    expect(parseClaudeLine(line)).toEqual([
      { kind: 'raw', text: '[unhandled] stream_event' },
    ])
  })

  test('never throws on hostile shapes', () => {
    const hostile = [
      '[]',
      '{"type":42}',
      '{"type":"user","message":{"content":"oops"}}',
      '{"type":"result","is_error":"yes"}',
      '{"type":"assistant","message":{"content":[null]}}',
    ]
    hostile.forEach((line) => {
      expect(() => parseClaudeLine(line)).not.toThrow()
    })
  })
})

describe('parseCodexLine', () => {
  test('returns no events for blank lines', () => {
    expect(parseCodexLine('')).toEqual([])
    expect(parseCodexLine('  ')).toEqual([])
  })

  test('returns a raw event for malformed JSON', () => {
    const line = 'not json at all'
    expect(parseCodexLine(line)).toEqual([{ kind: 'raw', text: line }])
  })

  test('parses thread.started as init', () => {
    const line = JSON.stringify({ type: 'thread.started', thread_id: 'th-9' })
    expect(parseCodexLine(line)).toEqual([
      { kind: 'init', sessionId: 'th-9', model: undefined },
    ])
  })

  test('ignores turn.started and non-completed item lifecycle events', () => {
    expect(
      parseCodexLine(JSON.stringify({ type: 'turn.started' })),
    ).toEqual([])
    expect(
      parseCodexLine(
        JSON.stringify({
          type: 'item.started',
          item: { item_type: 'command_execution', command: 'ls' },
        }),
      ),
    ).toEqual([])
    expect(
      parseCodexLine(
        JSON.stringify({
          type: 'item.updated',
          item: { item_type: 'agent_message', text: 'partial' },
        }),
      ),
    ).toEqual([])
  })

  test('parses completed agent_message items as assistant text', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { item_type: 'agent_message', text: 'Hi from codex' },
    })
    expect(parseCodexLine(line)).toEqual([
      { kind: 'assistant-text', text: 'Hi from codex' },
    ])
  })

  test('accepts item.type as an alternative to item.item_type', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'alt field name' },
    })
    expect(parseCodexLine(line)).toEqual([
      { kind: 'assistant-text', text: 'alt field name' },
    ])
  })

  test('parses completed command_execution items as tool use plus result', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        item_type: 'command_execution',
        command: 'echo hi',
        aggregated_output: 'hi\n',
        exit_code: 0,
      },
    })
    expect(parseCodexLine(line)).toEqual([
      { kind: 'tool-use', toolName: 'command_execution', input: 'echo hi' },
      { kind: 'tool-result', text: 'hi\n', isError: false },
    ])
  })

  test('marks failed command executions as error results', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        item_type: 'command_execution',
        command: 'false',
        aggregated_output: '',
        exit_code: 1,
      },
    })
    expect(parseCodexLine(line)).toEqual([
      { kind: 'tool-use', toolName: 'command_execution', input: 'false' },
      { kind: 'tool-result', text: '', isError: true },
    ])
  })

  test('reduces completed items of unknown type to a short marker', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { item_type: 'todo_list', items: [] },
    })
    expect(parseCodexLine(line)).toEqual([
      { kind: 'raw', text: '[unhandled] item.completed/todo_list' },
    ])
  })

  test('parses turn.completed as a success result', () => {
    const line = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    expect(parseCodexLine(line)).toEqual([
      { kind: 'result', subtype: 'turn.completed', isError: false },
    ])
  })

  test('parses turn.failed as an error result with a message', () => {
    const line = JSON.stringify({
      type: 'turn.failed',
      error: { message: 'boom' },
    })
    expect(parseCodexLine(line)).toEqual([
      { kind: 'result', subtype: 'turn.failed', isError: true, text: 'boom' },
    ])
  })

  test('parses error events as error results', () => {
    const line = JSON.stringify({ type: 'error', message: 'stream broke' })
    expect(parseCodexLine(line)).toEqual([
      { kind: 'result', subtype: 'error', isError: true, text: 'stream broke' },
    ])
  })

  test('reduces unknown event types to a short marker', () => {
    const line = JSON.stringify({ id: '1', msg: { type: 'agent_message' } })
    expect(parseCodexLine(line)).toEqual([
      { kind: 'raw', text: '[unhandled] unknown' },
    ])
  })

  test('never throws on hostile shapes', () => {
    const hostile = [
      '[]',
      'true',
      '{"type":"item.completed"}',
      '{"type":"item.completed","item":null}',
      '{"type":"turn.failed","error":"oops"}',
      '{"type":"thread.started","thread_id":7}',
    ]
    hostile.forEach((line) => {
      expect(() => parseCodexLine(line)).not.toThrow()
    })
  })
})

describe('event text capping', () => {
  test('caps huge claude tool_result text to the tail with a truncation marker', () => {
    const huge = `${'h'.repeat(EVENT_TEXT_LIMIT + 1000)}TAIL`
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', content: huge, is_error: false }],
      },
    })
    const events = parseClaudeLine(line)
    expect(events).toHaveLength(1)
    const event = events[0]
    if (event.kind !== 'tool-result') throw new Error('expected tool-result')
    expect(event.text).toMatch(/^…\[\+1004 chars truncated\]\n/)
    expect(event.text?.endsWith('TAIL')).toBe(true)
    expect(event.text?.length).toBeLessThanOrEqual(EVENT_TEXT_LIMIT + 64)
  })

  test('caps huge claude assistant text', () => {
    const huge = `${'a'.repeat(EVENT_TEXT_LIMIT * 2)}END`
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: huge }] },
    })
    const events = parseClaudeLine(line)
    expect(events).toHaveLength(1)
    const event = events[0]
    if (event.kind !== 'assistant-text') throw new Error('expected assistant-text')
    expect(event.text).toContain('chars truncated]')
    expect(event.text.endsWith('END')).toBe(true)
    expect(event.text.length).toBeLessThanOrEqual(EVENT_TEXT_LIMIT + 64)
  })

  test('replaces huge claude tool_use input with a bounded preview string', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Write',
            input: { path: 'big.txt', content: 'w'.repeat(EVENT_TEXT_LIMIT * 3) },
          },
        ],
      },
    })
    const events = parseClaudeLine(line)
    expect(events).toHaveLength(1)
    const event = events[0]
    if (event.kind !== 'tool-use') throw new Error('expected tool-use')
    expect(typeof event.input).toBe('string')
    const input = event.input as string
    expect(input.startsWith('{"path":"big.txt"')).toBe(true)
    expect(input).toMatch(/…\[\+\d+ chars truncated\]$/)
    expect(input.length).toBeLessThanOrEqual(EVENT_TEXT_LIMIT + 64)
  })

  test('keeps small tool_use input untouched', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }],
      },
    })
    expect(parseClaudeLine(line)).toEqual([
      { kind: 'tool-use', toolName: 'Bash', input: { command: 'ls' } },
    ])
  })

  test('bounds a deeply nested tool_use input without throwing', () => {
    const depth = 10_000
    const line =
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Deep","input":' +
      '['.repeat(depth) +
      '0' +
      ']'.repeat(depth) +
      '}]}}'
    const events = parseClaudeLine(line)
    expect(events).toHaveLength(1)
    const event = events[0]
    if (event.kind !== 'tool-use') throw new Error('expected tool-use')
    expect(typeof event.input).toBe('string')
    expect(event.input).toMatch(
      /(?:\[tool input omitted: serialization failed\]|…\[\+\d+ chars truncated\])$/,
    )
    expect(JSON.stringify(event).length).toBeLessThanOrEqual(EVENT_TEXT_LIMIT + 1024)
  })

  test('caps huge claude result text', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: `${'r'.repeat(EVENT_TEXT_LIMIT + 500)}DONE`,
    })
    const events = parseClaudeLine(line)
    expect(events).toHaveLength(1)
    const event = events[0]
    if (event.kind !== 'result') throw new Error('expected result')
    expect(event.text).toMatch(/^…\[\+504 chars truncated\]\n/)
    expect(event.text?.endsWith('DONE')).toBe(true)
  })

  test('caps huge codex aggregated_output with a tail-slice marker', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        item_type: 'command_execution',
        command: 'cat big.log',
        aggregated_output: `${'o'.repeat(EVENT_TEXT_LIMIT + 2000)}LAST`,
        exit_code: 0,
      },
    })
    const events = parseCodexLine(line)
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({
      kind: 'tool-use',
      toolName: 'command_execution',
      input: 'cat big.log',
    })
    const result = events[1]
    if (result.kind !== 'tool-result') throw new Error('expected tool-result')
    expect(result.text).toMatch(/^…\[\+2004 chars truncated\]\n/)
    expect(result.text?.endsWith('LAST')).toBe(true)
    expect(result.text?.length).toBeLessThanOrEqual(EVENT_TEXT_LIMIT + 64)
  })

  test('caps huge codex agent_message text', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { item_type: 'agent_message', text: 'm'.repeat(EVENT_TEXT_LIMIT * 2) },
    })
    const events = parseCodexLine(line)
    expect(events).toHaveLength(1)
    const event = events[0]
    if (event.kind !== 'assistant-text') throw new Error('expected assistant-text')
    expect(event.text.length).toBeLessThanOrEqual(EVENT_TEXT_LIMIT + 64)
  })

  test('caps raw fallback events for giant unparseable lines', () => {
    const line = `not json ${'p'.repeat(EVENT_TEXT_LIMIT * 2)}`
    const claudeEvents = parseClaudeLine(line)
    expect(claudeEvents).toHaveLength(1)
    const claudeEvent = claudeEvents[0]
    if (claudeEvent.kind !== 'raw') throw new Error('expected raw')
    expect(claudeEvent.text.length).toBeLessThanOrEqual(EVENT_TEXT_LIMIT + 64)
    expect(claudeEvent.text).toContain('chars truncated]')

    const codexEvents = parseCodexLine(line)
    expect(codexEvents).toHaveLength(1)
    const codexEvent = codexEvents[0]
    if (codexEvent.kind !== 'raw') throw new Error('expected raw')
    expect(codexEvent.text.length).toBeLessThanOrEqual(EVENT_TEXT_LIMIT + 64)
  })

  // The marker never carries the payload, so an oversized unknown line is
  // bounded by construction rather than by the text cap.
  test('keeps the unhandled marker short for giant unknown lines', () => {
    const line = JSON.stringify({
      type: 'mystery',
      payload: 'p'.repeat(EVENT_TEXT_LIMIT * 2),
    })
    expect(parseClaudeLine(line)).toEqual([
      { kind: 'raw', text: '[unhandled] mystery' },
    ])
    expect(parseCodexLine(line)).toEqual([
      { kind: 'raw', text: '[unhandled] mystery' },
    ])
  })

  test('caps an absurd type name inside the unhandled marker', () => {
    const line = JSON.stringify({ type: 't'.repeat(EVENT_TEXT_LIMIT) })
    const events = parseClaudeLine(line)
    expect(events).toHaveLength(1)
    const event = events[0]
    if (event.kind !== 'raw') throw new Error('expected raw')
    expect(event.text.length).toBeLessThanOrEqual(EVENT_FIELD_LIMIT + 32)
  })

  test('leaves text at exactly EVENT_TEXT_LIMIT untouched', () => {
    const exact = 'e'.repeat(EVENT_TEXT_LIMIT)
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: exact }] },
    })
    expect(parseClaudeLine(line)).toEqual([
      { kind: 'assistant-text', text: exact },
    ])
  })
})

describe('session id extraction', () => {
  test('claude system/init carries the session id', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: '11111111-2222-3333-4444-555555555555',
      model: 'claude-sonnet-4-5',
    })
    expect(parseClaudeLine(line)).toEqual([
      {
        kind: 'init',
        sessionId: '11111111-2222-3333-4444-555555555555',
        model: 'claude-sonnet-4-5',
      },
    ])
  })

  test('codex thread.started falls back to session_id when thread_id is absent', () => {
    const line = JSON.stringify({
      type: 'thread.started',
      session_id: 'sess-fallback',
      model: 'gpt-5-codex',
    })
    expect(parseCodexLine(line)).toEqual([
      { kind: 'init', sessionId: 'sess-fallback', model: 'gpt-5-codex' },
    ])
  })

  test('codex thread.started prefers thread_id over session_id', () => {
    const line = JSON.stringify({
      type: 'thread.started',
      thread_id: 'th-primary',
      session_id: 'sess-secondary',
    })
    expect(parseCodexLine(line)).toEqual([
      { kind: 'init', sessionId: 'th-primary', model: undefined },
    ])
  })

  test('codex bare session UUID line becomes an init event', () => {
    const uuid = '019f54b3-17be-72f0-901f-a3a6c67c795b'
    expect(parseCodexLine(uuid)).toEqual([
      { kind: 'init', sessionId: uuid, model: undefined },
    ])
    // Surrounding whitespace is tolerated; the id is preserved trimmed.
    expect(parseCodexLine(`  ${uuid}  `)).toEqual([
      { kind: 'init', sessionId: uuid, model: undefined },
    ])
  })

  test('codex near-UUID and unknown lines still fall back to raw', () => {
    const notQuiteUuid = '019f54b3-17be-72f0-901f'
    expect(parseCodexLine(notQuiteUuid)).toEqual([
      { kind: 'raw', text: notQuiteUuid },
    ])
    const uuidWithSuffix = '019f54b3-17be-72f0-901f-a3a6c67c795b trailing words'
    expect(parseCodexLine(uuidWithSuffix)).toEqual([
      { kind: 'raw', text: uuidWithSuffix },
    ])
    const unknownJson = JSON.stringify({ type: 'session.snapshot', data: 1 })
    expect(parseCodexLine(unknownJson)).toEqual([
      { kind: 'raw', text: '[unhandled] session.snapshot' },
    ])
  })
})

describe('identifier field capping', () => {
  test('caps oversized sessionId/model/toolName/subtype at EVENT_FIELD_LIMIT', () => {
    const giant = 'g'.repeat(EVENT_FIELD_LIMIT * 100)
    const init = parseClaudeLine(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: giant, model: giant }),
    )[0]
    expect(init.kind).toBe('init')
    if (init.kind === 'init') {
      expect(init.sessionId?.length).toBe(EVENT_FIELD_LIMIT)
      expect(init.model?.length).toBe(EVENT_FIELD_LIMIT)
    }
    const toolUse = parseClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: giant, input: {} }] },
      }),
    )[0]
    if (toolUse.kind === 'tool-use') {
      expect(toolUse.toolName.length).toBe(EVENT_FIELD_LIMIT)
    }
    const result = parseClaudeLine(
      JSON.stringify({ type: 'result', subtype: giant, is_error: false }),
    )[0]
    if (result.kind === 'result') {
      expect(result.subtype?.length).toBe(EVENT_FIELD_LIMIT)
    }
    const codexInit = parseCodexLine(
      JSON.stringify({ type: 'thread.started', thread_id: giant }),
    )[0]
    if (codexInit.kind === 'init') {
      expect(codexInit.sessionId?.length).toBe(EVENT_FIELD_LIMIT)
    }
  })

  test('legitimate identifiers pass through untouched', () => {
    const init = parseClaudeLine(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-123',
        model: 'claude-fable-5',
      }),
    )[0]
    if (init.kind === 'init') {
      expect(init.sessionId).toBe('sess-123')
      expect(init.model).toBe('claude-fable-5')
    }
  })
})

describe('capEventText', () => {
  test('passes small text through untouched and caps oversized text to the tail', () => {
    expect(capEventText('small')).toBe('small')
    const capped = capEventText(`${'x'.repeat(EVENT_TEXT_LIMIT * 2)}TAIL`)
    expect(capped.startsWith('…[+')).toBe(true)
    expect(capped.endsWith('TAIL')).toBe(true)
    expect(capped.length).toBeLessThanOrEqual(EVENT_TEXT_LIMIT + 64)
  })

  test('never starts the kept tail on the low half of a split surrogate pair', () => {
    // Position a surrogate pair so the tail cut lands between its halves.
    const pad = 'p'.repeat(EVENT_TEXT_LIMIT)
    const text = `${pad}\u{1F600}${'z'.repeat(EVENT_TEXT_LIMIT - 1)}`
    const capped = capEventText(text)
    const tail = capped.slice(capped.indexOf('\n') + 1)
    const first = tail.charCodeAt(0)
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false)
    expect(tail.endsWith('z')).toBe(true)
  })

  test('capped text is a fresh flat copy, not a view of the giant parent', () => {
    // Behavioral proxy for the V8 SlicedString hazard: the JSON round-trip
    // in the cap must reproduce content exactly, including lone surrogates.
    const lone = `${'a'.repeat(EVENT_TEXT_LIMIT * 2)}\ud800end`
    const capped = capEventText(lone)
    expect(capped.endsWith('\ud800end')).toBe(true)
  })

  test('short slices and lone surrogates preserve their exact contents', () => {
    const giantParent = `${'p'.repeat(EVENT_TEXT_LIMIT * 4)}short\ud800text`
    const shortSlice = giantParent.slice(-10)
    expect(capEventText(shortSlice)).toBe('short\ud800text')
  })
})

describe('events per JSONL line capping', () => {
  test('bounds a Claude assistant record and reports omitted blocks', () => {
    const content = Array.from(
      { length: EVENTS_PER_LINE_LIMIT + 1_000 },
      (_, index) => ({ type: 'text', text: `block-${index}` }),
    )
    const events = parseClaudeLine(
      JSON.stringify({ type: 'assistant', message: { content } }),
    )

    expect(events).toHaveLength(EVENTS_PER_LINE_LIMIT)
    expect(events[0]).toEqual({ kind: 'assistant-text', text: 'block-0' })
    expect(events[EVENTS_PER_LINE_LIMIT - 2]).toEqual({
      kind: 'assistant-text',
      text: `block-${EVENTS_PER_LINE_LIMIT - 2}`,
    })
    expect(events[EVENTS_PER_LINE_LIMIT - 1]).toEqual({
      kind: 'elision',
      omittedCount: 1_001,
    })
  })

  test('does not materialize omitted oversized tool inputs', () => {
    const content = [
      ...Array.from(
        { length: EVENTS_PER_LINE_LIMIT - 1 },
        (_, index) => ({ type: 'text', text: `kept-${index}` }),
      ),
      ...Array.from({ length: 20 }, () => ({
        type: 'tool_use',
        name: 'Write',
        input: { content: 'x'.repeat(EVENT_TEXT_LIMIT * 2) },
      })),
    ]
    const events = parseClaudeLine(
      JSON.stringify({ type: 'assistant', message: { content } }),
    )

    expect(events).toHaveLength(EVENTS_PER_LINE_LIMIT)
    expect(events[EVENTS_PER_LINE_LIMIT - 1]).toEqual({
      kind: 'elision',
      omittedCount: 20,
    })
  })
})
