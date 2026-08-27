import { setIcon } from 'obsidian'

/**
 * Lucide icon helpers.
 *
 * Obsidian bundles Lucide and exposes it through `setIcon()`, so the plugin
 * never ships an icon font or an extra dependency of its own. Everything that
 * used to be a literal emoji or an ASCII glyph ('<', '+', '×' …) goes through
 * these helpers so the markup stays uniform: an element carrying
 * `taskchute-icon` whose `<svg>` inherits `currentColor` and is sized by the
 * `--taskchute-icon-size` custom property (16px unless a caller overrides it).
 */
const ICON_CLASS = 'taskchute-icon'

/** Replace an element's content with `icon`, tagging it for the shared sizing rules. */
export function applyIcon(el: HTMLElement, icon: string): void {
  el.empty()
  el.addClass(ICON_CLASS)
  el.setAttr('data-icon', icon)
  setIcon(el, icon)
}

/** Create a `<span>` holding `icon`, optionally keeping a caller-owned class. */
export function createIconSpan(parent: HTMLElement, icon: string, cls?: string): HTMLSpanElement {
  const span = parent.createSpan(cls ? { cls } : {})
  applyIcon(span, icon)
  return span
}
