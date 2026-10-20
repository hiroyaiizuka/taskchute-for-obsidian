/**
 * LEV-376: the window title a program sets on its terminal (OSC 0 / 2),
 * read out of PTY output that arrives in arbitrary chunks.
 */
import {
  MAX_OSC_PAYLOAD_LENGTH,
  MAX_TERMINAL_TITLE_LENGTH,
  TerminalTitleParser,
  cleanTerminalTitle,
} from '@/features/ai-task/services/terminal-title/TerminalTitleParser'

const ESC = '\u001b'
const BEL = '\u0007'

describe('TerminalTitleParser', () => {
  test('reads OSC 0 and OSC 2 titles ended by BEL or ST', () => {
    const parser = new TerminalTitleParser()
    expect(parser.feed(`${ESC}]0;Claude Code${BEL}`)).toBe('Claude Code')
    expect(parser.feed(`${ESC}]2;vim notes.md${ESC}\\`)).toBe('vim notes.md')
    expect(parser.feed(`${ESC}]0;eight-bit ST\u009c`)).toBe('eight-bit ST')
  })

  test('ignores plain output and other OSCs (icon name, colour queries, cwd)', () => {
    const parser = new TerminalTitleParser()
    expect(parser.feed('hello world\r\n')).toBeUndefined()
    expect(parser.feed(`${ESC}]1;icon${BEL}`)).toBeUndefined()
    expect(parser.feed(`${ESC}]11;?${ESC}\\`)).toBeUndefined()
    expect(parser.feed(`${ESC}]7;file:///Users/me${BEL}`)).toBeUndefined()
    expect(parser.feed(`${ESC}[31mred${ESC}[0m`)).toBeUndefined()
  })

  test('a sequence split across chunks at any point still completes', () => {
    const sequence = `before ${ESC}]0;✳ ID63 書き直し${BEL} after`
    for (let cut = 1; cut < sequence.length; cut += 1) {
      const parser = new TerminalTitleParser()
      const first = parser.feed(sequence.slice(0, cut))
      const second = parser.feed(sequence.slice(cut))
      expect(first ?? second).toBe('ID63 書き直し')
    }
  })

  test('ST split between its ESC and backslash', () => {
    const parser = new TerminalTitleParser()
    expect(parser.feed(`${ESC}]2;split${ESC}`)).toBeUndefined()
    expect(parser.feed('\\rest')).toBe('split')
  })

  test('the last title of a chunk wins', () => {
    const parser = new TerminalTitleParser()
    expect(parser.feed(`${ESC}]0;one${BEL}x${ESC}]0;two${BEL}`)).toBe('two')
  })

  test('an empty title is reported as cleared', () => {
    expect(new TerminalTitleParser().feed(`${ESC}]0;${BEL}`)).toBe('')
  })

  test('CAN aborts a title; a new ESC ] restarts one', () => {
    const parser = new TerminalTitleParser()
    expect(parser.feed(`${ESC}]0;lost\u0018${BEL}`)).toBeUndefined()
    expect(parser.feed(`${ESC}]0;half${ESC}]0;whole${BEL}`)).toBe('whole')
  })

  test('an oversized payload is dropped whole, and parsing resumes after it', () => {
    const parser = new TerminalTitleParser()
    const huge = 'x'.repeat(MAX_OSC_PAYLOAD_LENGTH + 10)
    expect(parser.feed(`${ESC}]0;${huge}${BEL}`)).toBeUndefined()
    expect(parser.feed(`${ESC}]0;next${BEL}`)).toBe('next')
  })
})

describe('cleanTerminalTitle', () => {
  test("strips Claude Code's status glyph and braille spinners", () => {
    expect(cleanTerminalTitle('✳ Claude Code')).toBe('Claude Code')
    expect(cleanTerminalTitle('⠂ ID63 書き直し')).toBe('ID63 書き直し')
    expect(cleanTerminalTitle('⠐⠂ ✻ build')).toBe('build')
  })

  test('keeps * and a · that starts a word: they can be part of the title', () => {
    expect(cleanTerminalTitle('*scratch*')).toBe('*scratch*')
    expect(cleanTerminalTitle('· thinking')).toBe('thinking')
    expect(cleanTerminalTitle('·dot')).toBe('·dot')
    expect(cleanTerminalTitle('✻ *draft* notes')).toBe('*draft* notes')
  })

  test('removes control characters and collapses whitespace', () => {
    expect(cleanTerminalTitle('  a\tb\u0007c\n  d ')).toBe('a b c d')
  })

  test('caps the length by characters, not UTF-16 units', () => {
    const long = '漢'.repeat(MAX_TERMINAL_TITLE_LENGTH + 50)
    expect(Array.from(cleanTerminalTitle(long))).toHaveLength(MAX_TERMINAL_TITLE_LENGTH)
  })
})
