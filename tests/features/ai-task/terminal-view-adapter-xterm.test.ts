/**
 * XtermTerminalViewAdapter wiring against the recording xterm stub
 * (moduleNameMapper swaps @xterm/xterm for tests/setup/xterm-stub.js — no
 * real xterm ever runs in jsdom). Locks the contracts the terminal pane
 * relies on:
 *   - open() constructs the Terminal with the record's fixed cols/rows and a
 *     BOUNDED scrollback (very long sessions must not grow memory unbounded)
 *   - open() loads FitAddon, fits once after attachment, and a ResizeObserver
 *     keeps the xterm viewport fitted when its panel changes size
 *   - writes buffered before open() flush into the terminal in order
 *   - keystrokes relay through adapter.onData; disposers detach them
 *   - snapshotText() renders buffer.active as plain text (lines right-trimmed
 *     via translateToString(true), 3+ blank-line runs collapsed to one,
 *     trailing blanks removed; '' before open and after dispose)
 *   - dispose() disposes the Terminal; write/open afterwards are no-ops
 */
jest.mock('@xterm/addon-fit', () => {
  const stub = jest.requireActual<{
    FitAddon: unknown
  }>('../../setup/xterm-stub.js')
  return { FitAddon: stub.FitAddon }
})

import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import {
  createTerminalViewAdapter,
  type TerminalFilePathActivation,
} from '../../../src/features/ai-task/ui/TerminalViewAdapter'

interface RecordingLink {
  text: string
  range: {
    start: { x: number; y: number }
    end: { x: number; y: number }
  }
  activate(event: MouseEvent, text: string): void
}

interface RecordingLinkProvider {
  provideLinks(
    line: number,
    callback: (links: RecordingLink[] | undefined) => void,
  ): void
}

interface RecordingLinkProviderRegistration {
  provider: RecordingLinkProvider
  disposed: boolean
}

interface RecordingCellMetadata {
  chars: string
  width: number
}

interface RecordingLineMetadata {
  text: string
  isWrapped?: boolean
  cells?: RecordingCellMetadata[]
}

interface RecordingTerminal {
  options: Record<string, unknown>
  writes: string[]
  openedContainer: HTMLElement | null
  focusCount: number
  disposed: boolean
  bufferLines: string[]
  bufferLineMetadata: RecordingLineMetadata[]
  loadedAddons: RecordingFitAddon[]
  linkProviders: RecordingLinkProvider[]
  linkProviderRegistrations: RecordingLinkProviderRegistration[]
  emitData(data: string): void
  emitResize(cols: number, rows: number): void
}

interface RecordingFitAddon {
  fitCount: number
  disposed: boolean
}

const TerminalStub = Terminal as unknown as { instances: RecordingTerminal[] }
const FitAddonStub = FitAddon as unknown as { instances: RecordingFitAddon[] }

class RecordingResizeObserver implements ResizeObserver {
  static readonly instances: RecordingResizeObserver[] = []

  readonly observed: Element[] = []
  disconnected = false

  constructor(private readonly callback: ResizeObserverCallback) {
    RecordingResizeObserver.instances.push(this)
  }

  observe(target: Element): void {
    this.observed.push(target)
  }

  unobserve(target: Element): void {
    void target
  }

  disconnect(): void {
    this.disconnected = true
  }

  takeRecords(): ResizeObserverEntry[] {
    return []
  }

  emit(): void {
    this.callback([], this)
  }
}

describe('XtermTerminalViewAdapter (recording stub)', () => {
  beforeEach(() => {
    document.body.replaceChildren()
    TerminalStub.instances.length = 0
    FitAddonStub.instances.length = 0
    RecordingResizeObserver.instances.length = 0
    window.ResizeObserver = RecordingResizeObserver
  })

  function lastTerminal(): RecordingTerminal {
    const instance = TerminalStub.instances[TerminalStub.instances.length - 1]
    if (!instance) throw new Error('No Terminal was constructed')
    return instance
  }

  function provideLinks(providerIndex: number, line: number): RecordingLink[] {
    let links: RecordingLink[] | undefined
    lastTerminal().linkProviders[providerIndex]?.provideLinks(line, (provided) => {
      links = provided
    })
    return links ?? []
  }

  function cellsForText(text: string): RecordingCellMetadata[] {
    const cells: RecordingCellMetadata[] = []
    for (const character of Array.from(text)) {
      const isWide = (character.codePointAt(0) ?? 0) > 0xff
      cells.push({ chars: character, width: isWide ? 2 : 1 })
      if (isWide) cells.push({ chars: '', width: 0 })
    }
    return cells
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

  test('open() loads FitAddon, fits after attachment, and observes the container', () => {
    const adapter = createTerminalViewAdapter()
    const container = document.body.createDiv()

    adapter.open(container, 80, 24)

    expect(FitAddonStub.instances).toHaveLength(1)
    expect(lastTerminal().loadedAddons).toEqual([FitAddonStub.instances[0]])
    expect(FitAddonStub.instances[0].fitCount).toBe(1)
    expect(RecordingResizeObserver.instances).toHaveLength(1)
    expect(RecordingResizeObserver.instances[0].observed).toEqual([container])
  })

  test('ResizeObserver and public fit() refit the opened terminal', () => {
    const adapter = createTerminalViewAdapter()
    adapter.fit?.()
    adapter.open(document.body.createDiv(), 80, 24)
    const fitAddon = FitAddonStub.instances[0]

    RecordingResizeObserver.instances[0].emit()
    adapter.fit?.()

    expect(fitAddon.fitCount).toBe(3)
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

  test('registers file and HTTP(S) link providers when the terminal opens', () => {
    const adapter = createTerminalViewAdapter()

    adapter.open(document.body.createDiv(), 80, 24)

    expect(lastTerminal().linkProviders).toHaveLength(2)
    expect(lastTerminal().linkProviderRegistrations).toHaveLength(2)
  })

  test('file links require Ctrl on non-Mac platforms and notify subscribed listeners', () => {
    const adapter = createTerminalViewAdapter()
    const seen: TerminalFilePathActivation[] = []
    const disposeListener = adapter.onFilePathActivate?.((target) => seen.push(target))
    adapter.open(document.body.createDiv(), 80, 24)
    lastTerminal().bufferLineMetadata = [
      { text: 'Open src/features/example.ts:17:3' },
    ]
    const [link] = provideLinks(0, 1)

    expect(link.text).toBe('src/features/example.ts:17:3')
    link.activate({ ctrlKey: false, metaKey: false } as MouseEvent, link.text)
    link.activate({ ctrlKey: false, metaKey: true } as MouseEvent, link.text)
    expect(seen).toEqual([])

    link.activate({ ctrlKey: true, metaKey: false } as MouseEvent, link.text)
    expect(seen).toEqual([
      { path: 'src/features/example.ts', line: 17, column: 3 },
    ])

    disposeListener?.()
    link.activate({ ctrlKey: true, metaKey: false } as MouseEvent, link.text)
    expect(seen).toHaveLength(1)
  })

  test('file links require Command on Mac platforms', () => {
    const adapter = createTerminalViewAdapter({ isMacOS: true })
    const seen: TerminalFilePathActivation[] = []
    adapter.onFilePathActivate?.((target) => seen.push(target))
    adapter.open(document.body.createDiv(), 80, 24)
    lastTerminal().bufferLineMetadata = [{ text: 'Open package.json' }]
    const [link] = provideLinks(0, 1)

    link.activate({ ctrlKey: true, metaKey: false } as MouseEvent, link.text)
    expect(seen).toEqual([])
    link.activate({ ctrlKey: false, metaKey: true } as MouseEvent, link.text)
    expect(seen).toEqual([
      { path: 'package.json', line: undefined, column: undefined },
    ])
  })

  test('maps wrapped lines and wide cells to xterm cell coordinates', () => {
    const adapter = createTerminalViewAdapter()
    const seen: TerminalFilePathActivation[] = []
    adapter.onFilePathActivate?.((target) => seen.push(target))
    adapter.open(document.body.createDiv(), 80, 24)
    const first = 'あ /Users/me/project/very/'
    const second = 'long/日本語.ts:8:2'
    lastTerminal().bufferLineMetadata = [
      { text: first, cells: cellsForText(first) },
      {
        text: second,
        isWrapped: true,
        cells: cellsForText(second),
      },
    ]

    const [link] = provideLinks(0, 2)

    expect(link.text).toBe('/Users/me/project/very/long/日本語.ts:8:2')
    expect(link.range.start).toEqual({ x: 4, y: 1 })
    expect(link.range.end).toEqual({ x: 18, y: 2 })
    link.activate({ ctrlKey: true, metaKey: false } as MouseEvent, link.text)
    expect(seen).toEqual([
      {
        path: '/Users/me/project/very/long/日本語.ts',
        line: 8,
        column: 2,
      },
    ])
  })

  test('HTTP(S) links use the injected external-open callback on ordinary click', () => {
    const openExternalUrl = jest.fn<void, [string]>()
    const adapter = createTerminalViewAdapter({ openExternalUrl })
    adapter.open(document.body.createDiv(), 80, 24)
    lastTerminal().bufferLineMetadata = [
      { text: 'See https://example.com/docs/file.ts?line=2.' },
    ]

    expect(provideLinks(0, 1)).toEqual([])
    const [link] = provideLinks(1, 1)
    expect(link.text).toBe('https://example.com/docs/file.ts?line=2')

    link.activate({ ctrlKey: false, metaKey: false } as MouseEvent, link.text)
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://example.com/docs/file.ts?line=2',
    )
  })

  test('HTTP(S) links preserve balanced URL parentheses and trim only wrappers', () => {
    const openExternalUrl = jest.fn<void, [string]>()
    const adapter = createTerminalViewAdapter({ openExternalUrl })
    adapter.open(document.body.createDiv(), 80, 24)
    lastTerminal().bufferLineMetadata = [
      {
        text: 'See https://en.wikipedia.org/wiki/Function_(mathematics)',
      },
      { text: 'Then (https://example.com/help).' },
      { text: 'IPv6 https://[::1]' },
    ]

    const [balanced] = provideLinks(1, 1)
    balanced.activate(
      { ctrlKey: false, metaKey: false } as MouseEvent,
      balanced.text,
    )
    const [wrapped] = provideLinks(1, 2)
    wrapped.activate(
      { ctrlKey: false, metaKey: false } as MouseEvent,
      wrapped.text,
    )
    const [ipv6] = provideLinks(1, 3)
    ipv6.activate(
      { ctrlKey: false, metaKey: false } as MouseEvent,
      ipv6.text,
    )

    expect(openExternalUrl.mock.calls).toEqual([
      ['https://en.wikipedia.org/wiki/Function_(mathematics)'],
      ['https://example.com/help'],
      ['https://[::1]'],
    ])
  })

  test('HTTP(S) links fall back to the owner document window with noopener', () => {
    const open = jest
      .spyOn(window, 'open')
      .mockImplementation(() => null)
    const adapter = createTerminalViewAdapter()
    adapter.open(document.body.createDiv(), 80, 24)
    lastTerminal().bufferLineMetadata = [{ text: 'https://example.com/help' }]
    const [link] = provideLinks(1, 1)

    link.activate({ ctrlKey: false, metaKey: false } as MouseEvent, link.text)

    expect(open).toHaveBeenCalledWith(
      'https://example.com/help',
      '_blank',
      'noopener,noreferrer',
    )
    open.mockRestore()
  })

  test('grid resize events relay even when subscribed before open and can detach', () => {
    const adapter = createTerminalViewAdapter()
    const seen: Array<{ cols: number; rows: number }> = []
    const dispose = adapter.onResize?.((size) => seen.push(size))
    adapter.open(document.body.createDiv(), 80, 24)

    lastTerminal().emitResize(132, 41)
    expect(seen).toEqual([{ cols: 132, rows: 41 }])

    dispose?.()
    lastTerminal().emitResize(100, 30)
    expect(seen).toEqual([{ cols: 132, rows: 41 }])
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
    const seen: TerminalFilePathActivation[] = []
    adapter.onFilePathActivate?.((target) => seen.push(target))
    terminal.bufferLineMetadata = [{ text: 'Open package.json' }]
    const [fileLink] = provideLinks(0, 1)

    const registrations = [...terminal.linkProviderRegistrations]
    adapter.dispose()
    expect(terminal.disposed).toBe(true)
    expect(registrations.every((registration) => registration.disposed)).toBe(true)
    expect(terminal.linkProviders).toEqual([])
    expect(FitAddonStub.instances[0].disposed).toBe(true)
    expect(RecordingResizeObserver.instances[0].disconnected).toBe(true)
    fileLink.activate(
      { ctrlKey: true, metaKey: false } as MouseEvent,
      fileLink.text,
    )
    expect(seen).toEqual([])

    adapter.write('after dispose')
    adapter.fit?.()
    adapter.open(document.body.createDiv(), 80, 24)
    expect(terminal.writes).toEqual([])
    expect(FitAddonStub.instances[0].fitCount).toBe(1)
    expect(TerminalStub.instances).toHaveLength(1)
  })
})
