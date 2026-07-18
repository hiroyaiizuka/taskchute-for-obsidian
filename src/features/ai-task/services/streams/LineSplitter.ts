/**
 * AI Task - stream line splitter
 *
 * Buffers stdout/stderr chunks and yields complete lines, keeping any
 * trailing partial line across chunk boundaries. LF and CRLF terminators are
 * both supported, including a CRLF pair split across two chunks.
 *
 * A pending partial line never grows beyond MAX_LINE_LENGTH: once the cap is
 * hit, only the first MAX_LINE_LENGTH characters are kept and the rest of the
 * line is dropped until the next newline. The truncated head is emitted as
 * the line, so a giant JSON line degrades to a bounded (unparseable) line
 * instead of exhausting memory.
 */

export const MAX_LINE_LENGTH = 4 * 1024 * 1024

function stripTrailingCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

export class LineSplitter {
  private buffer = ''
  private overflowing = false

  /** Append a chunk and return every newly completed line */
  push(chunk: string): string[] {
    const segments = chunk.split('\n')
    const trailing = segments.pop() ?? ''
    const completed: string[] = []
    for (const segment of segments) {
      this.append(segment)
      completed.push(stripTrailingCarriageReturn(this.takeBuffer()))
    }
    this.append(trailing)
    return completed
  }

  /** Return the remaining partial line (if any) and reset the buffer */
  flush(): string[] {
    const remainder = this.takeBuffer()
    if (remainder.length === 0) return []
    return [stripTrailingCarriageReturn(remainder)]
  }

  private append(segment: string): void {
    if (this.overflowing || segment.length === 0) return
    const capacity = MAX_LINE_LENGTH - this.buffer.length
    if (segment.length <= capacity) {
      this.buffer += segment
      return
    }
    this.buffer += segment.slice(0, capacity)
    this.overflowing = true
  }

  private takeBuffer(): string {
    const line = this.buffer
    this.buffer = ''
    this.overflowing = false
    return line
  }
}
