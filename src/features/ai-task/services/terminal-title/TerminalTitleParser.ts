/**
 * Streaming parser for the window title a program sets on its terminal.
 *
 * Programs name their terminal with OSC 0 (icon name + title) or OSC 2
 * (title): `ESC ] 0 ; <title> BEL`, or the same ended by ST (`ESC \`).
 * Claude Code sends `ESC]0;✳ Claude Code BEL` at startup and replaces it with
 * a summary of the conversation afterwards; that is what other terminals show
 * on their tabs.
 *
 * PTY output arrives in arbitrary chunks, so a sequence can be split anywhere
 * (even between ESC and `]`). The parser keeps its state across feed() calls
 * and reports only completed titles. OSC 1 (icon name only) and every other
 * OSC are consumed and ignored. Payloads longer than the cap are discarded up
 * to their terminator rather than kept in memory.
 */

const ESC = '\u001b'
const BEL = '\u0007'
/** 8-bit String Terminator, accepted where ESC \ is. */
const ST_C1 = '\u009c'
/** CAN and SUB abort a control sequence (ECMA-48). */
const CAN = '\u0018'
const SUB = '\u001a'

/** Longest OSC payload kept; longer ones are dropped whole. */
export const MAX_OSC_PAYLOAD_LENGTH = 4096
/** Longest title kept after cleanup. */
export const MAX_TERMINAL_TITLE_LENGTH = 200

type ParserState = 'text' | 'escape' | 'osc' | 'osc-escape'

/**
 * Status glyphs agents put in front of their title: Claude Code's spinner
 * frames (✢ ✳ ✶ ✻ ✽, and `·` when a space follows it) and the braille
 * spinners many TUIs use (U+2800–U+28FF). The tab's status dot already shows
 * that work is going on. `*` and a `·` that starts a word are kept: they can
 * be part of a real title (`*scratch*`).
 */
const LEADING_STATUS_GLYPHS = /^(?:[\s✢✳✶✻✽⠀-⣿]|·(?=\s))+/u
// eslint-disable-next-line no-control-regex -- control characters are exactly what is being removed
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu

/**
 * Title as it should appear on a tab: control characters and leading status
 * glyphs removed, whitespace collapsed, length capped. An empty result means
 * the program cleared its title.
 */
export function cleanTerminalTitle(raw: string): string {
  const cleaned = raw
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(LEADING_STATUS_GLYPHS, '')
    .replace(/\s+/gu, ' ')
    .trim()
  return Array.from(cleaned).slice(0, MAX_TERMINAL_TITLE_LENGTH).join('')
}

/** Index of the next character that ends or interrupts an OSC payload. */
function findOscStop(chunk: string, from: number): number {
  for (let index = from; index < chunk.length; index += 1) {
    const char = chunk[index]
    if (char === BEL || char === ESC || char === ST_C1 || char === CAN || char === SUB) {
      return index
    }
  }
  return chunk.length
}

export class TerminalTitleParser {
  private state: ParserState = 'text'
  private payload = ''
  private overflowed = false

  /**
   * Consume one chunk of PTY output. Returns the last title completed in it
   * (already cleaned; '' when the program cleared its title), or undefined
   * when the chunk completed no title sequence.
   */
  feed(chunk: string): string | undefined {
    let title: string | undefined
    let index = 0
    // TUIs redraw constantly; plain text between escapes is skipped with
    // indexOf instead of being walked character by character.
    while (index < chunk.length) {
      if (this.state === 'text') {
        const escape = chunk.indexOf(ESC, index)
        if (escape < 0) break
        this.state = 'escape'
        index = escape + 1
        continue
      }
      if (this.state === 'osc') {
        const end = findOscStop(chunk, index)
        this.append(chunk.slice(index, end))
        if (end >= chunk.length) break
        const stop = chunk[end]
        index = end + 1
        if (stop === BEL || stop === ST_C1) {
          title = this.finishOsc() ?? title
        } else if (stop === ESC) {
          this.state = 'osc-escape'
        } else {
          // CAN / SUB abort the sequence.
          this.resetToText()
        }
        continue
      }
      const char = chunk[index]
      index += 1
      if (this.state === 'escape') {
        if (char === ']') this.beginOsc()
        else if (char !== ESC) this.state = 'text'
      } else if (char === '\\') {
        // osc-escape: ESC \ is the String Terminator.
        title = this.finishOsc() ?? title
      } else if (char === ']') {
        // ESC ] inside an unterminated OSC starts a new one.
        this.beginOsc()
      } else {
        // Any other ESC sequence aborts the OSC.
        this.state = char === ESC ? 'escape' : 'text'
        this.payload = ''
      }
    }
    return title
  }

  private beginOsc(): void {
    this.state = 'osc'
    this.payload = ''
    this.overflowed = false
  }

  private append(text: string): void {
    if (this.overflowed || text.length === 0) return
    if (this.payload.length + text.length > MAX_OSC_PAYLOAD_LENGTH) {
      this.overflowed = true
      this.payload = ''
      return
    }
    this.payload += text
  }

  private finishOsc(): string | undefined {
    const payload = this.payload
    const overflowed = this.overflowed
    this.resetToText()
    if (overflowed) return undefined
    const separator = payload.indexOf(';')
    if (separator < 0) return undefined
    const command = payload.slice(0, separator)
    if (command !== '0' && command !== '2') return undefined
    return cleanTerminalTitle(payload.slice(separator + 1))
  }

  private resetToText(): void {
    this.state = 'text'
    this.payload = ''
    this.overflowed = false
  }
}
