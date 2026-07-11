import { LineSplitter } from '../../../src/features/ai-task/services/streams/LineSplitter'

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
})
