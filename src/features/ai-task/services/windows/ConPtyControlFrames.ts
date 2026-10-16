/**
 * AI Task - ConPTY host control channel frames
 *
 * Keystrokes and resizes share stdio 3, and xterm input can contain any byte,
 * so every write is a frame (decoded by the C# host in ConPtyHostSource):
 *
 *   type (1 byte) | payload length (uint32 BE) | payload
 *   0x01 input = UTF-8 keystrokes    0x02 resize = cols, rows (uint16 BE)
 */

export const CONPTY_FRAME_INPUT = 0x01
export const CONPTY_FRAME_RESIZE = 0x02
export const CONPTY_FRAME_HEADER_BYTES = 5

/** Same clamp as the POSIX resize path. */
const MAX_DIMENSION = 999

export function encodeConPtyInputFrame(text: string): Uint8Array {
  const payload = encodeUtf8(text)
  const frame = new Uint8Array(CONPTY_FRAME_HEADER_BYTES + payload.length)
  frame[0] = CONPTY_FRAME_INPUT
  writeUint32BigEndian(frame, 1, payload.length)
  frame.set(payload, CONPTY_FRAME_HEADER_BYTES)
  return frame
}

/** Null when either dimension is not a usable grid size. */
export function encodeConPtyResizeFrame(
  cols: number,
  rows: number,
): Uint8Array | null {
  const normalizedCols = normalizeDimension(cols)
  const normalizedRows = normalizeDimension(rows)
  if (normalizedCols === null || normalizedRows === null) return null
  const frame = new Uint8Array(CONPTY_FRAME_HEADER_BYTES + 4)
  frame[0] = CONPTY_FRAME_RESIZE
  writeUint32BigEndian(frame, 1, 4)
  frame[5] = normalizedCols >> 8
  frame[6] = normalizedCols & 0xff
  frame[7] = normalizedRows >> 8
  frame[8] = normalizedRows & 0xff
  return frame
}

function normalizeDimension(value: number): number | null {
  if (!Number.isFinite(value)) return null
  const floored = Math.floor(value)
  if (floored < 1) return null
  return Math.min(floored, MAX_DIMENSION)
}

function writeUint32BigEndian(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff
  target[offset + 1] = (value >>> 16) & 0xff
  target[offset + 2] = (value >>> 8) & 0xff
  target[offset + 3] = value & 0xff
}

/** TextEncoder-compatible UTF-8 (lone surrogates → U+FFFD); jsdom lacks TextEncoder. */
export function encodeUtf8(text: string): Uint8Array {
  const bytes: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    let codePoint = text.charCodeAt(index)
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00)
        index += 1
      } else {
        codePoint = 0xfffd
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = 0xfffd
    }
    if (codePoint < 0x80) {
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f))
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      )
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      )
    }
  }
  return Uint8Array.from(bytes)
}
