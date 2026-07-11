/**
 * AI Task - stream line splitter
 *
 * Buffers stdout/stderr chunks and yields complete lines, keeping any
 * trailing partial line across chunk boundaries. LF and CRLF terminators are
 * both supported, including a CRLF pair split across two chunks.
 */

function stripTrailingCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

export class LineSplitter {
  private buffer = ''

  /** Append a chunk and return every newly completed line */
  push(chunk: string): string[] {
    this.buffer += chunk
    const segments = this.buffer.split('\n')
    this.buffer = segments.pop() ?? ''
    return segments.map(stripTrailingCarriageReturn)
  }

  /** Return the remaining partial line (if any) and reset the buffer */
  flush(): string[] {
    const remainder = this.buffer
    this.buffer = ''
    if (remainder.length === 0) return []
    return [stripTrailingCarriageReturn(remainder)]
  }
}
