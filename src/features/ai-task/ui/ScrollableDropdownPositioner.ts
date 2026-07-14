const DROPDOWN_GAP_PX = 4

interface PositionScrollableDropdownOptions {
  anchor: HTMLElement
  menu: HTMLElement
  boundary: HTMLElement | null
}

/**
 * Keep an absolute dropdown inside the visible modal viewport.
 *
 * The menu must be visible before this runs so its CSS-constrained height can
 * be measured. When neither side has enough room, the larger side wins and
 * receives an inline max-height so the menu itself becomes scrollable.
 */
export function positionScrollableDropdown({
  anchor,
  menu,
  boundary,
}: PositionScrollableDropdownOptions): void {
  menu.classList.remove('is-open-upward')
  menu.style.removeProperty('max-height')

  const anchorRect = anchor.getBoundingClientRect()
  const menuRect = menu.getBoundingClientRect()
  const boundaryRect = boundary?.getBoundingClientRect()
  const viewportHeight = anchor.ownerDocument.defaultView?.innerHeight ?? 0
  const boundaryTop = boundaryRect?.top ?? 0
  const boundaryBottom = boundaryRect?.bottom ?? viewportHeight

  if (
    boundaryBottom <= boundaryTop ||
    anchorRect.bottom < anchorRect.top ||
    menuRect.height <= 0
  ) {
    return
  }

  const availableAbove = Math.max(
    0,
    anchorRect.top - boundaryTop - DROPDOWN_GAP_PX,
  )
  const availableBelow = Math.max(
    0,
    boundaryBottom - anchorRect.bottom - DROPDOWN_GAP_PX,
  )
  const openUpward =
    availableBelow < menuRect.height && availableAbove > availableBelow
  const availableHeight = openUpward ? availableAbove : availableBelow

  menu.classList.toggle('is-open-upward', openUpward)
  if (availableHeight < menuRect.height) {
    menu.style.maxHeight = `${Math.floor(availableHeight)}px`
  }
}
