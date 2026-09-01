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

/**
 * Obsidian's plugin review rejects three things upstream xterm.css uses: the
 * multi-keyword `text-decoration` shorthand, and `!important`. The vendored
 * block therefore is not byte-identical to the installed package — it is the
 * package plus exactly these substitutions, which this table pins so an
 * @xterm/xterm upgrade still fails the sync check above.
 */
const OBSIDIAN_REVIEW_PATCHES: ReadonlyArray<readonly [string, string]> = [
  [
    `.xterm-dim {
    /* Dim should not apply to background, so the opacity of the foreground color is applied
     * explicitly in the generated class and reset to 1 here */
    opacity: 1 !important;
}`,
    `/* xterm.js customization: upstream carries \`!important\` here and on the
   scrollbar arrow below. Obsidian's plugin review rejects \`!important\`, so both
   rules win on specificity instead — the selectors are scoped to the terminal's
   own subtree, which no theme rule reaches. */
.xterm .xterm-rows .xterm-dim {
    /* Dim should not apply to background, so the opacity of the foreground color is applied
     * explicitly in the generated class and reset to 1 here */
    opacity: 1;
}`,
  ],
  [
    `.xterm-underline-1 { text-decoration: underline; }
.xterm-underline-2 { text-decoration: double underline; }
.xterm-underline-3 { text-decoration: wavy underline; }
.xterm-underline-4 { text-decoration: dotted underline; }
.xterm-underline-5 { text-decoration: dashed underline; }

.xterm-overline {
    text-decoration: overline;
}

.xterm-overline.xterm-underline-1 { text-decoration: overline underline; }
.xterm-overline.xterm-underline-2 { text-decoration: overline double underline; }
.xterm-overline.xterm-underline-3 { text-decoration: overline wavy underline; }
.xterm-overline.xterm-underline-4 { text-decoration: overline dotted underline; }
.xterm-overline.xterm-underline-5 { text-decoration: overline dashed underline; }`,
    `/* xterm.js customization: upstream draws these with the \`text-decoration\`
   shorthand and its \`-line\` / \`-style\` longhands. Obsidian's plugin review
   accepts \`text-decoration\` only with a single keyword and rejects the
   longhands outright, so the underline styles collapse to a plain underline and
   the overline is drawn as a top border instead — a border on an inline box
   adds no height, so the rows keep their geometry, and overline now composes
   with underline without needing the five combined rules upstream carries. */
.xterm-underline-1,
.xterm-underline-2,
.xterm-underline-3,
.xterm-underline-4,
.xterm-underline-5 {
    text-decoration: underline;
}

.xterm-overline {
    border-top: 1px solid currentColor;
}`,
  ],
  [
    `.xterm .xterm-scrollable-element > .scrollbar > .scra {
	cursor: pointer;
	font-size: 11px !important;
}`,
    `.xterm .xterm-scrollable-element > .scrollbar > .scra.scra {
	cursor: pointer;
	font-size: 11px;
}`,
  ],
]

function applyObsidianReviewPatches(css: string): string {
  return OBSIDIAN_REVIEW_PATCHES.reduce((patched, [upstream, replacement]) => {
    expect(patched).toContain(upstream)
    return patched.replace(upstream, replacement)
  }, css)
}

describe('TerminalViewAdapter module', () => {
  beforeEach(() => {
    document.body.replaceChildren()
  })

  test('styles.css carries the installed xterm css, review patches aside', () => {
    const vendored = readFileSync(
      join(repoRoot, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
      'utf8',
    ).trim()
    const styles = readFileSync(join(repoRoot, 'styles.css'), 'utf8')

    // Fails after an @xterm/xterm upgrade until the new css is pasted back
    // into the vendored block at the end of styles.css and the patches below
    // are re-applied to it.
    expect(styles).toContain(applyObsidianReviewPatches(vendored))
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
