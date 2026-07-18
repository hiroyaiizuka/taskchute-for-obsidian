/**
 * AI Task - xterm.js terminal view adapter
 *
 * The ONLY module that touches @xterm/xterm. Everything else (the run pane
 * controller, the view) programs against TerminalViewAdapterLike, and Jest
 * tests always substitute a fake adapter — a real xterm instance is never
 * created in jsdom.
 *
 * The xterm stylesheet is imported as text (esbuild `.css` text loader) and
 * injected once per document through a created <style> element with
 * textContent only; it must never be pasted into styles.css.
 *
 * The Terminal instance is created lazily in open(): the factory itself is
 * safe to call anywhere (including tests), and writes that arrive before
 * open() are buffered and flushed when the terminal exists.
 */

import { FitAddon } from '@xterm/addon-fit'
import {
  Terminal,
  type IBufferLine,
  type IDisposable,
  type ILink,
  type ILinkProvider,
} from '@xterm/xterm'
import xtermCssText from '@xterm/xterm/css/xterm.css'
import { Platform } from 'obsidian'

import {
  findTerminalFileLinks,
  type TerminalFileLinkMatch,
} from './TerminalLinkMatcher'

/** Marker class of the injected <style> element carrying the xterm css */
export const XTERM_CSS_STYLE_CLASS = 'taskchute-xterm-css'

/** Scrollback kept by the embedded terminal (lines) */
const TERMINAL_SCROLLBACK_LINES = 2000

/**
 * Trailing debounce for container ResizeObserver events. Fitting on every
 * frame of a drag-resize forces layout, re-wraps the whole buffer, and sends
 * a PTY resize per frame; one fit after the burst settles is enough.
 */
const RESIZE_FIT_DEBOUNCE_MS = 60
/** Never let a broken/aborted xterm write callback block run persistence. */
const XTERM_WRITE_DRAIN_TIMEOUT_MS = 2_000

const TERMINAL_FONT_SIZE_PX = 12

/**
 * Concrete monospace stack: xterm measures glyphs itself, so a CSS variable
 * such as var(--font-monospace) cannot be resolved here.
 */
const TERMINAL_FONT_FAMILY =
  'Menlo, Monaco, "SF Mono", Consolas, "Liberation Mono", monospace'

/**
 * Small dark default theme. The embedded terminal deliberately keeps a
 * terminal-like appearance in both Obsidian themes.
 */
const TERMINAL_DARK_THEME = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#264f78',
}

const MAX_WRAPPED_SCAN_LINES = 40
const MAX_WRAPPED_SCAN_CHARS = 4096
const HTTP_URL_REGEX = /https?:\/\/[^\s<>"'`]+/gi
const TRAILING_URL_PUNCTUATION_REGEX = /[.,;:'"]+$/

export interface TerminalFilePathActivation {
  path: string
  line?: number
  column?: number
}

export interface TerminalViewAdapterOptions {
  /** Preferred Electron/Obsidian bridge for opening HTTP(S) URLs externally. */
  openExternalUrl?: (url: string) => void
  /** Test/embedding override; production defaults to Obsidian Platform. */
  isMacOS?: boolean
}

/** Thin view-layer contract implemented by the xterm adapter (mocked in tests) */
export interface TerminalViewAdapterLike {
  /** Create and attach the terminal with an initial cols x rows grid */
  open(container: HTMLElement, cols: number, rows: number): void
  /** Fit the xterm viewport to its current container when supported */
  fit?(): void
  /** Write raw PTY output (ANSI included) into the terminal */
  write(data: string): void
  /** Subscribe to keystrokes; returns a disposer */
  onData(callback: (data: string) => void): () => void
  /** Subscribe to fitted xterm grid changes (cols first, rows second). */
  onResize?(callback: (size: { cols: number; rows: number }) => void): () => void
  /** Subscribe to Cmd/Ctrl-clicked local-file references. */
  onFilePathActivate?(
    callback: (target: TerminalFilePathActivation) => void,
  ): () => void
  /**
   * Plain-text snapshot of the terminal buffer (scrollback + screen): each
   * line right-trimmed, runs of 3+ blank lines collapsed to a single blank
   * line, trailing blank lines removed. Returns '' before open() and after
   * dispose(). Used as the run-log transcript source for terminal runs (the
   * raw PTY transcript file is a TUI redraw stream that strips to garbage).
   */
  snapshotText(): string
  /**
   * Wait until xterm has parsed every write queued before this call, then
   * snapshot the buffer. Terminal exit and data frames share one ordered
   * broker socket, but xterm parses write() asynchronously; the barrier keeps
   * the final output from disappearing from the run log.
   */
  snapshotTextAfterWrites?(): Promise<string>
  focus(): void
  dispose(): void
}

export type TerminalViewAdapterFactory = () => TerminalViewAdapterLike

/**
 * Inject the imported xterm css once per owner DOM tree (resolved through
 * container.ownerDocument, never a global). Re-injects when a prior style
 * element was removed, e.g. after a pop-out window closed.
 */
export function ensureXtermCssInjected(container: HTMLElement): void {
  const doc = container.ownerDocument
  if (doc.querySelector(`style.${XTERM_CSS_STYLE_CLASS}`)) return
  const target: HTMLElement = doc.head ?? container
  // Vendored third-party css (bundled as text by esbuild) must not be pasted
  // into styles.css; a created style element with textContent is the one
  // sanctioned injection point for it.
  // eslint-disable-next-line obsidianmd/no-forbidden-elements
  target.createEl('style', { cls: XTERM_CSS_STYLE_CLASS, text: xtermCssText })
}

interface WrappedBufferLine {
  line: IBufferLine
  text: string
  y: number
}

interface CellSegment {
  startOffset: number
  endOffset: number
  startX: number
  endXExclusive: number
  y: number
}

interface BufferPosition {
  x: number
  y: number
}

interface HttpUrlMatch {
  url: string
  startIndex: number
  endIndex: number
}

function collectWrappedLineBlock(
  terminal: Terminal,
  bufferLineNumber: number,
): WrappedBufferLine[] {
  const active = terminal.buffer.active
  const lineIndex = bufferLineNumber - 1
  const current = active.getLine(lineIndex)
  if (!current) return []

  const lines = new Map<number, WrappedBufferLine>([
    [
      lineIndex,
      {
        line: current,
        text: current.translateToString(),
        y: bufferLineNumber,
      },
    ],
  ])
  let startIndex = lineIndex
  let endIndex = lineIndex
  let totalLines = 1
  let totalChars = lines.get(lineIndex)?.text.length ?? 0

  while (
    totalLines < MAX_WRAPPED_SCAN_LINES &&
    totalChars < MAX_WRAPPED_SCAN_CHARS
  ) {
    let expanded = false
    if (startIndex > 0 && active.getLine(startIndex)?.isWrapped) {
      const previousIndex = startIndex - 1
      const previous = active.getLine(previousIndex)
      if (previous) {
        const text = previous.translateToString()
        if (totalChars + text.length <= MAX_WRAPPED_SCAN_CHARS) {
          lines.set(previousIndex, {
            line: previous,
            text,
            y: previousIndex + 1,
          })
          startIndex = previousIndex
          totalLines += 1
          totalChars += text.length
          expanded = true
        }
      }
    }

    if (
      totalLines >= MAX_WRAPPED_SCAN_LINES ||
      totalChars >= MAX_WRAPPED_SCAN_CHARS
    ) {
      break
    }
    const nextIndex = endIndex + 1
    const next = active.getLine(nextIndex)
    if (next?.isWrapped) {
      const text = next.translateToString()
      if (totalChars + text.length <= MAX_WRAPPED_SCAN_CHARS) {
        lines.set(nextIndex, { line: next, text, y: nextIndex + 1 })
        endIndex = nextIndex
        totalLines += 1
        totalChars += text.length
        expanded = true
      }
    }
    if (!expanded) break
  }

  const result: WrappedBufferLine[] = []
  for (let index = startIndex; index <= endIndex; index += 1) {
    const line = lines.get(index)
    if (line) result.push(line)
  }
  return result
}

function buildCellSegments(lines: WrappedBufferLine[]): CellSegment[] {
  const segments: CellSegment[] = []
  let totalOffset = 0
  for (const wrappedLine of lines) {
    let lineOffset = 0
    for (
      let x = 0;
      x < wrappedLine.line.length && lineOffset < wrappedLine.text.length;
      x += 1
    ) {
      const cell = wrappedLine.line.getCell(x)
      if (!cell) break
      const width = cell.getWidth()
      if (width <= 0) continue
      const chars = cell.getChars()
      const characterLength = chars.length > 0 ? chars.length : 1
      const nextLineOffset = Math.min(
        lineOffset + characterLength,
        wrappedLine.text.length,
      )
      if (nextLineOffset <= lineOffset) continue
      segments.push({
        startOffset: totalOffset + lineOffset,
        endOffset: totalOffset + nextLineOffset,
        startX: x + 1,
        endXExclusive: x + 1 + width,
        y: wrappedLine.y,
      })
      lineOffset = nextLineOffset
    }
    totalOffset += wrappedLine.text.length
  }
  return segments
}

function isBefore(left: BufferPosition, right: BufferPosition): boolean {
  return left.y < right.y || (left.y === right.y && left.x < right.x)
}

function laterPosition(
  left: BufferPosition,
  right: BufferPosition,
): BufferPosition {
  return isBefore(left, right) ? right : left
}

function startOffsetToBufferPosition(
  segments: CellSegment[],
  startOffset: number,
  fallbackY: number,
): BufferPosition {
  if (segments.length === 0) return { x: startOffset + 1, y: fallbackY }
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    if (startOffset < segment.endOffset) {
      return { x: segment.startX, y: segment.y }
    }
    if (startOffset === segment.endOffset) {
      const next = segments[index + 1]
      if (next?.startOffset === startOffset) {
        return { x: next.startX, y: next.y }
      }
      return { x: segment.endXExclusive, y: segment.y }
    }
  }
  const last = segments[segments.length - 1]
  return { x: last.endXExclusive, y: last.y }
}

function endOffsetToBufferPosition(
  segments: CellSegment[],
  endOffset: number,
  fallbackStart: BufferPosition,
): BufferPosition {
  if (segments.length === 0) {
    return laterPosition(
      { x: Math.max(fallbackStart.x, endOffset), y: fallbackStart.y },
      fallbackStart,
    )
  }
  for (const segment of segments) {
    if (endOffset <= segment.endOffset) {
      return laterPosition(
        { x: segment.endXExclusive - 1, y: segment.y },
        fallbackStart,
      )
    }
  }
  const last = segments[segments.length - 1]
  return laterPosition(
    { x: last.endXExclusive - 1, y: last.y },
    fallbackStart,
  )
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function countCharacter(value: string, expected: string): number {
  let count = 0
  for (const character of value) {
    if (character === expected) count += 1
  }
  return count
}

function trimHttpUrlCandidate(candidate: string): string {
  let url = candidate.replace(TRAILING_URL_PUNCTUATION_REGEX, '')
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  while (url.length > 0) {
    const closing = url[url.length - 1]
    const opening = pairs[closing]
    if (!opening) break
    if (countCharacter(url, closing) <= countCharacter(url, opening)) break
    url = url.slice(0, -1).replace(TRAILING_URL_PUNCTUATION_REGEX, '')
  }
  return url
}

function findHttpUrls(text: string): HttpUrlMatch[] {
  const matches: HttpUrlMatch[] = []
  HTTP_URL_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = HTTP_URL_REGEX.exec(text)) !== null) {
    const url = trimHttpUrlCandidate(match[0])
    if (!isHttpUrl(url)) continue
    matches.push({
      url,
      startIndex: match.index,
      endIndex: match.index + url.length,
    })
  }
  return matches
}

function isFileLinkActivation(event: MouseEvent, isMac: boolean): boolean {
  return isMac ? event.metaKey : event.ctrlKey
}

function openInOwnerWindow(doc: Document, url: string): void {
  if (!isHttpUrl(url)) return
  const opened = doc.defaultView?.open(
    url,
    '_blank',
    'noopener,noreferrer',
  )
  if (opened) opened.opener = null
}

function makeLink(
  match: Pick<TerminalFileLinkMatch, 'startIndex' | 'endIndex' | 'fullMatch'>,
  segments: CellSegment[],
  bufferLineNumber: number,
  activate: (event: MouseEvent) => void,
): ILink | null {
  const start = startOffsetToBufferPosition(
    segments,
    match.startIndex,
    bufferLineNumber,
  )
  const end = endOffsetToBufferPosition(segments, match.endIndex, start)
  if (start.y > bufferLineNumber || end.y < bufferLineNumber) return null
  return {
    range: { start, end },
    text: match.fullMatch,
    decorations: { pointerCursor: true, underline: true },
    activate,
  }
}

class FilePathLinkProvider implements ILinkProvider {
  constructor(
    private readonly terminal: Terminal,
    private readonly isMac: boolean,
    private readonly activatePath: (target: TerminalFilePathActivation) => void,
  ) {}

  provideLinks(
    bufferLineNumber: number,
    callback: (links: ILink[] | undefined) => void,
  ): void {
    const wrappedLines = collectWrappedLineBlock(this.terminal, bufferLineNumber)
    if (wrappedLines.length === 0) {
      callback(undefined)
      return
    }
    const matches = findTerminalFileLinks(
      wrappedLines.map((line) => line.text).join(''),
    )
    const segments = buildCellSegments(wrappedLines)
    const links = matches
      .map((match) =>
        makeLink(match, segments, bufferLineNumber, (event) => {
          if (!isFileLinkActivation(event, this.isMac)) return
          this.activatePath({
            path: match.path,
            line: match.line,
            column: match.column,
          })
        }),
      )
      .filter((link): link is ILink => link !== null)
    callback(links.length > 0 ? links : undefined)
  }
}

class HttpUrlLinkProvider implements ILinkProvider {
  constructor(
    private readonly terminal: Terminal,
    private readonly activateUrl: (url: string) => void,
  ) {}

  provideLinks(
    bufferLineNumber: number,
    callback: (links: ILink[] | undefined) => void,
  ): void {
    const wrappedLines = collectWrappedLineBlock(this.terminal, bufferLineNumber)
    if (wrappedLines.length === 0) {
      callback(undefined)
      return
    }
    const matches = findHttpUrls(wrappedLines.map((line) => line.text).join(''))
    const segments = buildCellSegments(wrappedLines)
    const links = matches
      .map((match) =>
        makeLink(
          {
            startIndex: match.startIndex,
            endIndex: match.endIndex,
            fullMatch: match.url,
          },
          segments,
          bufferLineNumber,
          () => this.activateUrl(match.url),
        ),
      )
      .filter((link): link is ILink => link !== null)
    callback(links.length > 0 ? links : undefined)
  }
}

class XtermTerminalViewAdapter implements TerminalViewAdapterLike {
  private terminal: Terminal | null = null
  private fitAddon: FitAddon | null = null
  private resizeObserver: ResizeObserver | null = null
  private pendingWrites: string[] = []
  private pendingXtermWrites = 0
  private readonly writeDrainWaiters = new Set<() => void>()
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly resizeListeners = new Set<
    (size: { cols: number; rows: number }) => void
  >()
  private readonly filePathListeners = new Set<
    (target: TerminalFilePathActivation) => void
  >()
  private linkProviderDisposables: IDisposable[] = []
  private fitDebounceTimer: ReturnType<typeof activeWindow.setTimeout> | null =
    null
  private timerWindow: Window | null = null
  /** One-shot convergence fit after the browser commits the opening layout. */
  private postLayoutFitFrame: number | null = null
  private postLayoutFitFrameOwner: Window | null = null
  private lastGridSize: { cols: number; rows: number } | null = null
  private disposed = false

  constructor(private readonly options: TerminalViewAdapterOptions) {}

  open(container: HTMLElement, cols: number, rows: number): void {
    if (this.terminal || this.disposed) return
    ensureXtermCssInjected(container)
    this.timerWindow = container.ownerDocument.defaultView ?? window
    const terminal = new Terminal({
      cols,
      rows,
      scrollback: TERMINAL_SCROLLBACK_LINES,
      fontSize: TERMINAL_FONT_SIZE_PX,
      fontFamily: TERMINAL_FONT_FAMILY,
      cursorBlink: true,
      theme: TERMINAL_DARK_THEME,
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.onData((data) => {
      for (const listener of Array.from(this.dataListeners)) {
        listener(data)
      }
    })
    terminal.onResize((size) => {
      if (
        this.lastGridSize &&
        this.lastGridSize.cols === size.cols &&
        this.lastGridSize.rows === size.rows
      ) {
        return
      }
      this.lastGridSize = { cols: size.cols, rows: size.rows }
      for (const listener of Array.from(this.resizeListeners)) {
        listener(size)
      }
    })
    terminal.open(container)
    const activatePath = (target: TerminalFilePathActivation): void => {
      for (const listener of Array.from(this.filePathListeners)) listener(target)
    }
    const activateUrl =
      this.options.openExternalUrl ??
      ((url: string) => openInOwnerWindow(container.ownerDocument, url))
    this.linkProviderDisposables = [
      terminal.registerLinkProvider(
        new FilePathLinkProvider(
          terminal,
          this.options.isMacOS ?? Platform?.isMacOS ?? false,
          activatePath,
        ),
      ),
      terminal.registerLinkProvider(new HttpUrlLinkProvider(terminal, activateUrl)),
    ]
    this.terminal = terminal
    this.fitAddon = fitAddon
    this.lastGridSize = { cols, rows }

    const ResizeObserverCtor = container.ownerDocument.defaultView?.ResizeObserver
    if (ResizeObserverCtor) {
      this.resizeObserver = new ResizeObserverCtor(() => {
        this.scheduleDebouncedFit()
      })
      this.resizeObserver.observe(container)
    }

    // The controller applies its terminal-height chrome before open(), so
    // this synchronous fit can update the pending run grid before the PTY is
    // spawned. A single next-frame fit catches the remaining Obsidian flex
    // layout/font-metric convergence without restoring per-frame resize work.
    this.fit()
    this.schedulePostLayoutFit()

    const buffered = this.pendingWrites
    this.pendingWrites = []
    for (const chunk of buffered) {
      this.writeToTerminal(terminal, chunk)
    }
  }

  fit(): void {
    if (this.disposed || !this.terminal || !this.fitAddon) return
    // A fit that would land on the current grid is pure waste: FitAddon would
    // re-wrap the buffer and the resize relay would echo a redundant PTY
    // resize over IPC. Skip it entirely.
    const proposed = this.fitAddon.proposeDimensions()
    if (
      proposed &&
      this.lastGridSize &&
      this.lastGridSize.cols === proposed.cols &&
      this.lastGridSize.rows === proposed.rows
    ) {
      return
    }
    this.fitAddon.fit()
  }

  private schedulePostLayoutFit(): void {
    if (this.disposed || this.postLayoutFitFrame !== null) return
    const frameOwner = this.timerWindow ?? window
    const frameId = frameOwner.requestAnimationFrame(() => {
      if (
        this.postLayoutFitFrame !== frameId ||
        this.postLayoutFitFrameOwner !== frameOwner
      ) {
        return
      }
      this.postLayoutFitFrame = null
      this.postLayoutFitFrameOwner = null
      this.fit()
    })
    this.postLayoutFitFrameOwner = frameOwner
    this.postLayoutFitFrame = frameId
  }

  private scheduleDebouncedFit(): void {
    if (this.disposed) return
    if (this.fitDebounceTimer !== null) {
      this.timerWindow?.clearTimeout(this.fitDebounceTimer)
    }
    const timerWindow = this.timerWindow ?? window
    this.fitDebounceTimer = timerWindow.setTimeout(() => {
      this.fitDebounceTimer = null
      this.fit()
    }, RESIZE_FIT_DEBOUNCE_MS)
  }

  write(data: string): void {
    if (this.disposed || data.length === 0) return
    if (this.terminal) {
      this.writeToTerminal(this.terminal, data)
      return
    }
    this.pendingWrites.push(data)
  }

  private writeToTerminal(terminal: Terminal, data: string): void {
    this.pendingXtermWrites += 1
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      this.pendingXtermWrites = Math.max(0, this.pendingXtermWrites - 1)
      if (this.pendingXtermWrites !== 0) return
      for (const resolve of Array.from(this.writeDrainWaiters)) resolve()
      this.writeDrainWaiters.clear()
    }
    try {
      terminal.write(data, settle)
    } catch (error) {
      settle()
      throw error
    }
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback)
    return () => {
      this.dataListeners.delete(callback)
    }
  }

  onResize(callback: (size: { cols: number; rows: number }) => void): () => void {
    this.resizeListeners.add(callback)
    return () => {
      this.resizeListeners.delete(callback)
    }
  }

  onFilePathActivate(
    callback: (target: TerminalFilePathActivation) => void,
  ): () => void {
    if (this.disposed) return () => undefined
    this.filePathListeners.add(callback)
    return () => {
      this.filePathListeners.delete(callback)
    }
  }

  snapshotText(): string {
    const terminal = this.terminal
    if (!terminal) return ''
    const buffer = terminal.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buffer.length; i += 1) {
      // translateToString(true) right-trims the padded cells of each row.
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
    }
    return (
      lines
        .join('\n')
        // 3+ consecutive blank lines (4+ newlines) collapse to ONE blank line.
        .replace(/\n{4,}/g, '\n\n')
        // Drop trailing blank lines (the unused rest of the screen).
        .replace(/\n+$/, '')
    )
  }

  async snapshotTextAfterWrites(): Promise<string> {
    if (this.disposed || !this.terminal) return ''
    if (this.pendingXtermWrites > 0) {
      const drained = await new Promise<boolean>((resolve) => {
        let settled = false
        const finish = (value: boolean): void => {
          if (settled) return
          settled = true
          this.writeDrainWaiters.delete(onDrain)
          timerWindow.clearTimeout(timeout)
          resolve(value)
        }
        const onDrain = (): void => finish(true)
        const timerWindow = this.timerWindow ?? window
        const timeout = timerWindow.setTimeout(
          () => finish(false),
          XTERM_WRITE_DRAIN_TIMEOUT_MS,
        )
        this.writeDrainWaiters.add(onDrain)
        // A write callback may have drained between the check and insertion.
        if (this.pendingXtermWrites === 0) {
          finish(true)
        }
      })
      // A timed-out write queue is not authoritative. Returning blank makes
      // the manager use and delete the raw PTY transcript fallback instead
      // of silently logging a partial xterm screen.
      if (!drained) return ''
    }
    return this.snapshotText()
  }

  focus(): void {
    this.terminal?.focus()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.fitDebounceTimer !== null) {
      this.timerWindow?.clearTimeout(this.fitDebounceTimer)
      this.fitDebounceTimer = null
    }
    if (this.postLayoutFitFrame !== null) {
      ;(this.postLayoutFitFrameOwner ?? this.timerWindow ?? window)
        .cancelAnimationFrame(this.postLayoutFitFrame)
      this.postLayoutFitFrame = null
      this.postLayoutFitFrameOwner = null
    }
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.dataListeners.clear()
    this.resizeListeners.clear()
    this.filePathListeners.clear()
    this.pendingWrites = []
    this.pendingXtermWrites = 0
    for (const resolve of Array.from(this.writeDrainWaiters)) resolve()
    this.writeDrainWaiters.clear()
    for (const disposable of this.linkProviderDisposables.splice(0)) {
      disposable.dispose()
    }
    this.terminal?.dispose()
    this.terminal = null
    this.fitAddon = null
    this.timerWindow = null
  }
}

/** Production factory handed to the run pane controller by the view */
export function createTerminalViewAdapter(
  options: TerminalViewAdapterOptions = {},
): TerminalViewAdapterLike {
  return new XtermTerminalViewAdapter(options)
}
