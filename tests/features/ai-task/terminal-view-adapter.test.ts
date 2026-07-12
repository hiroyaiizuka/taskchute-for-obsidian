/**
 * TerminalViewAdapter module contract:
 *   - ensureXtermCssInjected injects the imported xterm css exactly once per
 *     document via a createEl('style') element (never innerHTML)
 *   - createTerminalViewAdapter returns a lazily-initialised adapter that is
 *     safe to construct, buffer into, and dispose WITHOUT opening a real
 *     xterm instance (jsdom tests never instantiate xterm — see the pane
 *     controller tests, which mock the whole adapter)
 */
import {
  createTerminalViewAdapter,
  ensureXtermCssInjected,
  XTERM_CSS_STYLE_CLASS,
} from '../../../src/features/ai-task/ui/TerminalViewAdapter'

describe('TerminalViewAdapter module', () => {
  beforeEach(() => {
    document
      .querySelectorAll(`style.${XTERM_CSS_STYLE_CLASS}`)
      .forEach((el) => el.remove())
    document.body.replaceChildren()
  })

  test('ensureXtermCssInjected injects the css once per document', () => {
    const container = document.body.createDiv()

    ensureXtermCssInjected(container)
    ensureXtermCssInjected(container)

    const styles = document.querySelectorAll(`style.${XTERM_CSS_STYLE_CLASS}`)
    expect(styles).toHaveLength(1)
    expect(styles[0].textContent?.length ?? 0).toBeGreaterThan(0)
  })

  test('re-injects after the previous style element was removed', () => {
    const container = document.body.createDiv()
    ensureXtermCssInjected(container)
    document
      .querySelectorAll(`style.${XTERM_CSS_STYLE_CLASS}`)
      .forEach((el) => el.remove())

    ensureXtermCssInjected(container)

    expect(
      document.querySelectorAll(`style.${XTERM_CSS_STYLE_CLASS}`),
    ).toHaveLength(1)
  })

  test('factory returns an adapter whose pre-open calls are safe no-ops', () => {
    const adapter = createTerminalViewAdapter()

    expect(typeof adapter.open).toBe('function')
    expect(typeof adapter.write).toBe('function')
    expect(typeof adapter.onData).toBe('function')
    expect(typeof adapter.focus).toBe('function')
    expect(typeof adapter.dispose).toBe('function')

    // None of these may throw (or touch xterm) before open() is called.
    const dispose = adapter.onData(() => undefined)
    adapter.write('buffered before open')
    adapter.focus()
    dispose()
    adapter.dispose()
    // dispose is idempotent
    adapter.dispose()
  })
})
