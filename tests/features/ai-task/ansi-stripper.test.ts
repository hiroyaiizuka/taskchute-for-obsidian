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

  test('treats astral (surrogate-pair) characters as single overwrite columns', () => {
    expect(stripAnsiSequences('😀😀😀\rXY')).toBe('XY😀')
    expect(stripAnsiSequences('abc\r😀')).toBe('😀bc')
    expect(stripAnsiSequences('😀b\b\bXY')).toBe('XY')
  })

  test('collapses many carriage-return redraws to the final overwrite state', () => {
    const redraws = Array.from({ length: 200 }, (_, i) => `progress ${i}`).join('\r')
    expect(stripAnsiSequences(redraws)).toBe('progress 199')
  })

  test('keeps the longer earlier tail when a shorter overwrite follows', () => {
    expect(stripAnsiSequences('abcdef\rXY\bZ')).toBe('XZcdef')
  })

  test('handles a long line with thousands of short redraws without quadratic copies', () => {
    const longTail = 'a'.repeat(200_000)
    const redraws = '\rX'.repeat(5_000)
    const result = stripAnsiSequences(longTail + redraws)
    expect(result).toHaveLength(longTail.length)
    expect(result.startsWith('X')).toBe(true)
    expect(result.endsWith('a')).toBe(true)
  })
})
