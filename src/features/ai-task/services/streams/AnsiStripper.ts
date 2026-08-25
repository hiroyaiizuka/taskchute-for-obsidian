/**
 * AI Task - ANSI/control-sequence stripper
 *
 * Reduces a raw PTY transcript (colors, cursor movement, OSC titles,
 * carriage-return progress redraws, backspace edits) to plain text suitable
 * for a markdown run-log note. Pure; no Node or DOM access.
 *
 * This is a lossy plain-text projection, not a terminal emulator: cursor
 * addressing is dropped rather than replayed, while same-line overwrites
 * (`\r`, `\b`) are simulated so progress bars collapse to their final state.
 */

/* eslint-disable no-control-regex -- this module's whole job is matching terminal control bytes */

/** OSC: ESC ] ... terminated by BEL or ST (ESC \), lazily matched */
const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g

/** DCS / SOS / PM / APC: ESC P|X|^|_ ... terminated by ST (ESC \) */
const STRING_SEQUENCE = /\u001b[PX^_][^\u001b]*(?:\u001b\\)?/g

/** CSI: ESC [ parameter bytes, intermediate bytes, one final byte */
const CSI_SEQUENCE = /\u001b\[[0-9:;<=>?]*[ !"#$%&'()*+,\-./]*[@-~]/g

/** Character-set selection and similar ESC <symbol> <char> pairs */
const CHARSET_SEQUENCE = /\u001b[()#*+\-./][0-9A-Za-z@]/g

/** Any remaining single-character escape (keypad modes ESC = / ESC >, ...) */
const SIMPLE_ESCAPE = /\u001b[@-Z\\^_a-z=><~]/g

/** Stray ESC bytes left over after the structured passes above */
const LONE_ESCAPE = /\u001b/g

/** C0 controls except backspace (08), tab (09), newline (0a), and CR (0d) */
const OTHER_CONTROL_CHARS = /[\u0000-\u0007\u000b\u000c\u000e-\u001f\u007f]/g

/* eslint-enable no-control-regex -- the control-byte pattern table ends here */

/**
 * Render one physical line, applying carriage-return (cursor to column 0)
 * and backspace (cursor left) as overwrite edits. The mutable cell array is
 * linear in the input size even for adversarial input such as a very long
 * line followed by thousands of `\rX` redraws; repeatedly slicing an
 * immutable buffer would copy that long tail on every redraw (quadratic).
 * `for...of` iterates Unicode code points, so surrogate pairs occupy one
 * overwrite cell.
 */
function renderLineEdits(line: string): string {
  if (!line.includes('\r') && !line.includes('\b')) return line
  const cells: string[] = []
  let column = 0
  for (const character of line) {
    if (character === '\r') {
      column = 0
      continue
    }
    if (character === '\b') {
      if (column > 0) column -= 1
      continue
    }
    cells[column] = character
    column += 1
  }
  return cells.join('')
}

/** Strip ANSI escape sequences and control characters from PTY output */
export function stripAnsiSequences(text: string): string {
  const withoutEscapes = text
    .replace(OSC_SEQUENCE, '')
    .replace(STRING_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(CHARSET_SEQUENCE, '')
    .replace(SIMPLE_ESCAPE, '')
    .replace(LONE_ESCAPE, '')
    .replace(OTHER_CONTROL_CHARS, '')

  // CRLF is a plain line ending; only lone \r means "overwrite this line".
  const normalized = withoutEscapes.replace(/\r\n/g, '\n')

  return normalized
    .split('\n')
    .map(renderLineEdits)
    .join('\n')
}
