import {
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

  test('treats system events with other subtypes as raw', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'compact' })
    expect(parseClaudeLine(line)).toEqual([{ kind: 'raw', text: line }])
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

  test('treats an assistant event without recognizable content as raw', () => {
    const noMessage = JSON.stringify({ type: 'assistant' })
    expect(parseClaudeLine(noMessage)).toEqual([{ kind: 'raw', text: noMessage }])

    const nullMessage = JSON.stringify({ type: 'assistant', message: null })
    expect(parseClaudeLine(nullMessage)).toEqual([{ kind: 'raw', text: nullMessage }])

    const unknownBlocks = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'hmm' }] },
    })
    expect(parseClaudeLine(unknownBlocks)).toEqual([
      { kind: 'raw', text: unknownBlocks },
    ])
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

  test('returns raw for unknown event types', () => {
    const line = JSON.stringify({ type: 'stream_event', payload: 1 })
    expect(parseClaudeLine(line)).toEqual([{ kind: 'raw', text: line }])
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

  test('falls back to raw for completed items of unknown type', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { item_type: 'todo_list', items: [] },
    })
    expect(parseCodexLine(line)).toEqual([{ kind: 'raw', text: line }])
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

  test('returns raw for unknown event types', () => {
    const line = JSON.stringify({ id: '1', msg: { type: 'agent_message' } })
    expect(parseCodexLine(line)).toEqual([{ kind: 'raw', text: line }])
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
