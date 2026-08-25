/**
 * TerminalViewAdapter module contract:
 *   - the xterm css ships vendored inside styles.css (Obsidian forbids
 *     plugins from attaching <style>/<link> elements), so the copy there must
 *     stay identical to the installed @xterm/xterm package
 *   - createTerminalViewAdapter returns a lazily-initialised adapter that is
 *     safe to construct, buffer into, and dispose WITHOUT opening a real
 *     xterm instance (jsdom tests never instantiate xterm — see the pane
 *     controller tests, which mock the whole adapter)
 */
import { readFileSync } from 'fs'
import { join } from 'path'

import { createTerminalViewAdapter } from '../../../src/features/ai-task/ui/TerminalViewAdapter'

const repoRoot = join(__dirname, '..', '..', '..')

describe('TerminalViewAdapter module', () => {
  beforeEach(() => {
    document.body.replaceChildren()
  })

  test('styles.css carries the installed xterm css verbatim', () => {
    const vendored = readFileSync(
      join(repoRoot, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
      'utf8',
    ).trim()
    const styles = readFileSync(join(repoRoot, 'styles.css'), 'utf8')

    // Fails after an @xterm/xterm upgrade until the new css is pasted back
    // into the vendored block at the end of styles.css.
    expect(styles).toContain(vendored)
  })

  test('factory returns an adapter whose pre-open calls are safe no-ops', () => {
    const adapter = createTerminalViewAdapter()

    expect(typeof adapter.open).toBe('function')
    expect(typeof adapter.write).toBe('function')
    expect(typeof adapter.onData).toBe('function')
    expect(typeof adapter.onFilePathActivate).toBe('function')
    expect(typeof adapter.fit).toBe('function')
    expect(typeof adapter.focus).toBe('function')
    expect(typeof adapter.dispose).toBe('function')

    // None of these may throw (or touch xterm) before open() is called.
    const dispose = adapter.onData(() => undefined)
    const disposeFilePath = adapter.onFilePathActivate?.(() => undefined)
    adapter.write('buffered before open')
    adapter.fit?.()
    adapter.focus()
    dispose()
    disposeFilePath?.()
    adapter.dispose()
    // dispose is idempotent
    adapter.dispose()
  })
})
