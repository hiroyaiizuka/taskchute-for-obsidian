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

import { Terminal } from '@xterm/xterm'
import xtermCssText from '@xterm/xterm/css/xterm.css'

/** Marker class of the injected <style> element carrying the xterm css */
export const XTERM_CSS_STYLE_CLASS = 'taskchute-xterm-css'

/** Scrollback kept by the embedded terminal (lines) */
const TERMINAL_SCROLLBACK_LINES = 10000

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

/** Thin view-layer contract implemented by the xterm adapter (mocked in tests) */
export interface TerminalViewAdapterLike {
  /** Create and attach the terminal with a fixed cols x rows grid */
  open(container: HTMLElement, cols: number, rows: number): void
  /** Write raw PTY output (ANSI included) into the terminal */
  write(data: string): void
  /** Subscribe to keystrokes; returns a disposer */
  onData(callback: (data: string) => void): () => void
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

class XtermTerminalViewAdapter implements TerminalViewAdapterLike {
  private terminal: Terminal | null = null
  private pendingWrites: string[] = []
  private readonly dataListeners = new Set<(data: string) => void>()
  private disposed = false

  open(container: HTMLElement, cols: number, rows: number): void {
    if (this.terminal || this.disposed) return
    ensureXtermCssInjected(container)
    const terminal = new Terminal({
      cols,
      rows,
      scrollback: TERMINAL_SCROLLBACK_LINES,
      fontSize: TERMINAL_FONT_SIZE_PX,
      fontFamily: TERMINAL_FONT_FAMILY,
      cursorBlink: true,
      theme: TERMINAL_DARK_THEME,
    })
    terminal.onData((data) => {
      for (const listener of Array.from(this.dataListeners)) {
        listener(data)
      }
    })
    terminal.open(container)
    this.terminal = terminal
    const buffered = this.pendingWrites
    this.pendingWrites = []
    for (const chunk of buffered) {
      terminal.write(chunk)
    }
  }

  write(data: string): void {
    if (this.disposed || data.length === 0) return
    if (this.terminal) {
      this.terminal.write(data)
      return
    }
    this.pendingWrites.push(data)
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback)
    return () => {
      this.dataListeners.delete(callback)
    }
  }

  focus(): void {
    this.terminal?.focus()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.dataListeners.clear()
    this.pendingWrites = []
    this.terminal?.dispose()
    this.terminal = null
  }
}

/** Production factory handed to the run pane controller by the view */
export function createTerminalViewAdapter(): TerminalViewAdapterLike {
  return new XtermTerminalViewAdapter()
}
