import {
  LineSplitter,
  MAX_LINE_LENGTH,
} from '../../../src/features/ai-task/services/streams/LineSplitter'
import { parseCodexLine } from '../../../src/features/ai-task/services/streams/StreamJsonParser'

describe('LineSplitter', () => {
  test('emits complete lines and buffers the trailing partial line', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('{"a":1}\n{"b":')).toEqual(['{"a":1}'])
    expect(splitter.push('2}\n')).toEqual(['{"b":2}'])
  })

  test('joins a line split across many chunks', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('{"ty')).toEqual([])
    expect(splitter.push('pe":"res')).toEqual([])
    expect(splitter.push('ult"}\n')).toEqual(['{"type":"result"}'])
  })

  test('returns multiple lines from a single chunk', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('one\ntwo\nthree\n')).toEqual(['one', 'two', 'three'])
  })

  test('emits empty lines as empty strings', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('a\n\nb\n')).toEqual(['a', '', 'b'])
  })

  test('strips CRLF line endings', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('one\r\ntwo\r\n')).toEqual(['one', 'two'])
  })

  test('handles CRLF split across chunk boundaries', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('one\r')).toEqual([])
    expect(splitter.push('\ntwo\r\n')).toEqual(['one', 'two'])
  })

  test('flush returns the remaining partial line and clears the buffer', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('no newline yet')).toEqual([])
    expect(splitter.flush()).toEqual(['no newline yet'])
    expect(splitter.flush()).toEqual([])
  })

  test('flush strips a trailing carriage return', () => {
    const splitter = new LineSplitter()
    splitter.push('tail\r')
    expect(splitter.flush()).toEqual(['tail'])
  })

  test('flush on an empty buffer returns no lines', () => {
    const splitter = new LineSplitter()
    expect(splitter.flush()).toEqual([])
  })

  test('push after flush starts from a clean buffer', () => {
    const splitter = new LineSplitter()
    splitter.push('partial')
    splitter.flush()
    expect(splitter.push('fresh\n')).toEqual(['fresh'])
  })

  describe('maximum line length', () => {
    test('truncates a giant single-chunk line to MAX_LINE_LENGTH', () => {
      const splitter = new LineSplitter()
      const giant = 'x'.repeat(MAX_LINE_LENGTH + 5000)
      const lines = splitter.push(`${giant}\nnext\n`)
      expect(lines).toHaveLength(2)
      expect(lines[0]).toHaveLength(MAX_LINE_LENGTH)
      expect(lines[0]).toBe(giant.slice(0, MAX_LINE_LENGTH))
      expect(lines[1]).toBe('next')
    })

    test('caps the pending partial line across many chunks', () => {
      const splitter = new LineSplitter()
      const chunk = 'y'.repeat(MAX_LINE_LENGTH / 2)
      expect(splitter.push(chunk)).toEqual([])
      expect(splitter.push(chunk)).toEqual([])
      expect(splitter.push(chunk)).toEqual([])
      expect(splitter.push(chunk)).toEqual([])
      const lines = splitter.push('tail\n')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toHaveLength(MAX_LINE_LENGTH)
    })

    test('keeps a line of exactly MAX_LINE_LENGTH intact', () => {
      const splitter = new LineSplitter()
      const exact = 'z'.repeat(MAX_LINE_LENGTH)
      const lines = splitter.push(`${exact}\n`)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toBe(exact)
    })

    test('recovers cleanly after emitting a truncated line', () => {
      const splitter = new LineSplitter()
      splitter.push('a'.repeat(MAX_LINE_LENGTH + 1))
      expect(splitter.push('still dropped\n{"b":')).toEqual([
        'a'.repeat(MAX_LINE_LENGTH),
      ])
      expect(splitter.push('2}\n')).toEqual(['{"b":2}'])
    })

    test('flush returns the truncated head of an overflowing partial line', () => {
      const splitter = new LineSplitter()
      splitter.push('c'.repeat(MAX_LINE_LENGTH + 100))
      const flushed = splitter.flush()
      expect(flushed).toHaveLength(1)
      expect(flushed[0]).toHaveLength(MAX_LINE_LENGTH)
      expect(splitter.flush()).toEqual([])
    })

    test('a truncated giant JSON line degrades to a bounded raw event and later lines still parse', () => {
      const splitter = new LineSplitter()
      const giantLine = JSON.stringify({
        type: 'item.completed',
        item: {
          item_type: 'command_execution',
          command: 'cat big.bin',
          aggregated_output: 'o'.repeat(MAX_LINE_LENGTH + 1000),
          exit_code: 0,
        },
      })
      const events = splitter
        .push(`${giantLine}\n${JSON.stringify({ type: 'thread.started', thread_id: 'th-1' })}\n`)
        .flatMap((line) => parseCodexLine(line))
      expect(events[0]?.kind).toBe('raw')
      expect(events[events.length - 1]).toEqual({
        kind: 'init',
        sessionId: 'th-1',
        model: undefined,
      })
    })
  })
})
