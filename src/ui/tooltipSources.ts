/**
 * Attributes that raise a tooltip over whatever the user is aiming at.
 *
 * `title` is the browser's own; `aria-label` is Obsidian's, which renders a
 * `.tooltip` element of its own on hover. During a pointer drag the pointer
 * stays on the element it grabbed for the whole gesture, so both tooltips
 * linger over the very rows the user is trying to aim at.
 *
 * Neither can be moved out of the way with a stacking level: the browser's is
 * drawn outside the page entirely, and Obsidian's sits on `--layer-tooltip`
 * (~70) -- far below the 10000-band this plugin's popovers occupy, so inside a
 * popover it renders *behind* the very thing it belongs to. Taking the
 * attributes away for the duration of the drag is the only fix.
 */
const TOOLTIP_ATTRIBUTES = ['title', 'aria-label'] as const

/** Matches anything `parkTooltipSources` would strip. */
export const TOOLTIP_SOURCE_SELECTOR = '[title], [aria-label]'

/**
 * Strips the tooltip attributes off `element`, recording them in `parked` so
 * `restoreTooltipSources` can put them back.
 *
 * Pass `null` for an element that is thrown away rather than restored -- a
 * drag ghost, typically.
 */
export function parkTooltipSources(
  element: HTMLElement,
  parked: Map<string, string> | null,
): void {
  for (const attribute of TOOLTIP_ATTRIBUTES) {
    const value = element.getAttribute(attribute)
    if (value === null) continue
    parked?.set(attribute, value)
    element.removeAttribute(attribute)
  }
}

/** Puts back everything `parkTooltipSources` recorded, and empties the map. */
export function restoreTooltipSources(
  element: HTMLElement,
  parked: Map<string, string>,
): void {
  parked.forEach((value, attribute) => element.setAttribute(attribute, value))
  parked.clear()
}

/** Strips the tooltip attributes off a subtree that will never be restored. */
export function stripTooltipSources(root: HTMLElement): void {
  parkTooltipSources(root, null)
  root
    .querySelectorAll<HTMLElement>(TOOLTIP_SOURCE_SELECTOR)
    .forEach((node) => parkTooltipSources(node, null))
}
