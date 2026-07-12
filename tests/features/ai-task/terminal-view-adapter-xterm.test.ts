/**
 * XtermTerminalViewAdapter wiring against the recording xterm stub
 * (moduleNameMapper swaps @xterm/xterm for tests/setup/xterm-stub.js — no
 * real xterm ever runs in jsdom). Locks the contracts the terminal pane
 * relies on:
 *   - open() constructs the Terminal with the record's fixed cols/rows and a
 *     BOUNDED scrollback (very long sessions must not grow memory unbounded)
 *   - writes buffered before open() flush into the terminal in order
 *   - keystrokes relay through adapter.onData; disposers detach them
 *   - snapshotText() renders buffer.active as plain text (lines right-trimmed
 *     via translateToString(true), 3+ blank-line runs collapsed to one,
 *     trailing blanks removed; '' before open and after dispose)
 *   - dispose() disposes the Terminal; write/open afterwards are no-ops
 */
import { Terminal } from '@xterm/xterm'
import { createTerminalViewAdapter } from '../../../src/features/ai-task/ui/TerminalViewAdapter'

interface RecordingTerminal {
  options: Record<string, unknown>
  writes: string[]
  openedContainer: HTMLElement | null
  focusCount: number
  disposed: boolean
  bufferLines: string[]
  emitData(data: string): void
}

const TerminalStub = Terminal as unknown as { instances: RecordingTerminal[] }

describe('XtermTerminalViewAdapter (recording stub)', () => {
  beforeEach(() => {
    document.body.replaceChildren()
    TerminalStub.instances.length = 0
  })

  function lastTerminal(): RecordingTerminal {
    const instance = TerminalStub.instances[TerminalStub.instances.length - 1]
    if (!instance) throw new Error('No Terminal was constructed')
    return instance
  }

  test('open() constructs the terminal with the given grid and a bounded scrollback', () => {
    const adapter = createTerminalViewAdapter()
    const container = document.body.createDiv()

    adapter.open(container, 111, 31)

    expect(TerminalStub.instances).toHaveLength(1)
    const terminal = lastTerminal()
    expect(terminal.options.cols).toBe(111)
    expect(terminal.options.rows).toBe(31)
    expect(typeof terminal.options.scrollback).toBe('number')
    expect(terminal.options.scrollback as number).toBeGreaterThan(0)
    expect(terminal.options.scrollback as number).toBeLessThanOrEqual(10_000)
    expect(terminal.openedContainer).toBe(container)
  })

  test('open() is one-shot: a second open never constructs another terminal', () => {
    const adapter = createTerminalViewAdapter()
    adapter.open(document.body.createDiv(), 80, 24)
    adapter.open(document.body.createDiv(), 120, 40)

    expect(TerminalStub.instances).toHaveLength(1)
  })

  test('writes buffered before open() flush in order, then writes go straight through', () => {
    const adapter = createTerminalViewAdapter()
    adapter.write('first ')
    adapter.write('second')

    adapter.open(document.body.createDiv(), 80, 24)
    adapter.write(' third')

    expect(lastTerminal().writes).toEqual(['first ', 'second', ' third'])
  })

  test('keystrokes relay through onData and detach via the disposer', () => {
    const adapter = createTerminalViewAdapter()
    adapter.open(document.body.createDiv(), 80, 24)
    const seen: string[] = []
    const dispose = adapter.onData((data) => seen.push(data))

    lastTerminal().emitData('ls -la\r')
    expect(seen).toEqual(['ls -la\r'])

    dispose()
    lastTerminal().emitData('ignored')
    expect(seen).toEqual(['ls -la\r'])
  })

  test('focus() reaches the terminal', () => {
    const adapter = createTerminalViewAdapter()
    adapter.open(document.body.createDiv(), 80, 24)

    adapter.focus()

    expect(lastTerminal().focusCount).toBe(1)
  })

  test('snapshotText() returns the empty string before open()', () => {
    const adapter = createTerminalViewAdapter()

    expect(adapter.snapshotText()).toBe('')
  })

  test('snapshotText() joins the buffer lines with newlines, right-trimming each line', () => {
    const adapter = createTerminalViewAdapter()
    adapter.open(document.body.createDiv(), 80, 24)
    lastTerminal().bufferLines = ['$ claude   ', '  answer text', 'done']

    expect(adapter.snapshotText()).toBe('$ claude\n  answer text\ndone')
  })

  test('snapshotText() collapses runs of 3+ blank lines to one and trims trailing blanks', () => {
    const adapter = createTerminalViewAdapter()
    adapter.open(document.body.createDiv(), 80, 24)
    lastTerminal().bufferLines = [
      'top',
      '',
      '',
      '',
      '',
      'bottom',
      '',
      '',
      '',
      '',
      '',
    ]

    expect(adapter.snapshotText()).toBe('top\n\nbottom')
  })

  test('snapshotText() keeps short blank runs (1-2 blank lines) verbatim', () => {
    const adapter = createTerminalViewAdapter()
    adapter.open(document.body.createDiv(), 80, 24)
    lastTerminal().bufferLines = ['a', '', 'b', '', '', 'c']

    expect(adapter.snapshotText()).toBe('a\n\nb\n\n\nc')
  })

  test('snapshotText() returns the empty string for an all-blank buffer and after dispose()', () => {
    const adapter = createTerminalViewAdapter()
    adapter.open(document.body.createDiv(), 80, 24)
    lastTerminal().bufferLines = ['', '', '', '']
    expect(adapter.snapshotText()).toBe('')

    lastTerminal().bufferLines = ['content']
    adapter.dispose()
    expect(adapter.snapshotText()).toBe('')
  })

  test('dispose() disposes the terminal; write and open afterwards are no-ops', () => {
    const adapter = createTerminalViewAdapter()
    adapter.open(document.body.createDiv(), 80, 24)
    const terminal = lastTerminal()

    adapter.dispose()
    expect(terminal.disposed).toBe(true)

    adapter.write('after dispose')
    adapter.open(document.body.createDiv(), 80, 24)
    expect(terminal.writes).toEqual([])
    expect(TerminalStub.instances).toHaveLength(1)
  })
})
