import { stripAnsiSequences } from '../../../src/features/ai-task/services/streams/AnsiStripper'

describe('stripAnsiSequences', () => {
  test('removes CSI color sequences', () => {
    expect(stripAnsiSequences('\u001b[31mred\u001b[0m plain \u001b[1;32;40mbold\u001b[m')).toBe(
      'red plain bold',
    )
  })

  test('removes CSI cursor and erase sequences', () => {
    expect(stripAnsiSequences('\u001b[2J\u001b[H\u001b[3;10Hhello\u001b[K')).toBe('hello')
  })

  test('removes private-mode CSI sequences (cursor visibility, alt screen)', () => {
    expect(stripAnsiSequences('\u001b[?25l\u001b[?1049hbody\u001b[?25h')).toBe('body')
  })

  test('removes OSC sequences terminated by BEL', () => {
    expect(stripAnsiSequences('\u001b]0;window title\u0007hello')).toBe('hello')
  })

  test('removes OSC sequences terminated by ST', () => {
    expect(stripAnsiSequences('\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\')).toBe(
      'link',
    )
  })

  test('removes charset selection and keypad-mode escapes', () => {
    expect(stripAnsiSequences('\u001b(Btext\u001b=more\u001b>')).toBe('textmore')
  })

  test('applies backspace as an in-line cursor move with overwrite', () => {
    expect(stripAnsiSequences('abcd\b\bX')).toBe('abXd')
    expect(stripAnsiSequences('\bnothing before')).toBe('nothing before')
  })

  test('normalizes CRLF to LF', () => {
    expect(stripAnsiSequences('line1\r\nline2\r\n')).toBe('line1\nline2\n')
  })

  test('applies a lone carriage return as an overwrite from column zero', () => {
    expect(stripAnsiSequences('progress 10%\rprogress 99%')).toBe('progress 99%')
    expect(stripAnsiSequences('abcdef\rXY')).toBe('XYcdef')
  })

  test('drops other control characters but keeps tabs and newlines', () => {
    expect(stripAnsiSequences('a\u0007b\u0000c\td\ne')).toBe('abc\td\ne')
  })

  test('passes plain multibyte text through unchanged', () => {
    expect(stripAnsiSequences('こんにちは、世界')).toBe('こんにちは、世界')
  })
})
