/** Sidebar width until the user drags it (mirrors styles.css). */
export const AI_SIDEBAR_DEFAULT_WIDTH_PX = 180
/**
 * Narrowest the sidebar stays open at. It equals the snap point today, so a
 * drag narrows the sidebar smoothly right up to where it closes; were it
 * larger, a drag would stick here before closing.
 */
export const AI_SIDEBAR_MIN_WIDTH_PX = 35
/** Widest the sidebar may get, before the share cap below. */
export const AI_SIDEBAR_MAX_WIDTH_PX = 480
/** Largest share of the pane's layout row the sidebar may take. */
export const AI_SIDEBAR_MAX_WIDTH_RATIO = 0.5
/**
 * The pointer's distance from the sidebar's left edge below which a drag
 * closes the sidebar outright, the same as its toggle.
 */
export const AI_SIDEBAR_SNAP_CLOSE_PX = 35
/** Width change per ArrowLeft/ArrowRight press on the focused handle. */
const KEYBOARD_STEP_PX = 16
/**
 * Pointer travel before a press on the handle becomes a drag. Below it the
 * press is a click (or the first half of a double click) and changes nothing.
 */
const DRAG_THRESHOLD_PX = 3

export interface SidebarWidthBounds {
  min: number
  snap: number
  max: number
}

/** What a drag position means: the sidebar closed, or open at a width. */
export type SidebarDragResolution =
  | { collapsed: true }
  | { collapsed: false; width: number }

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Bounds for a layout row of the given width. `reservedWidth` is room the
 * rest of the row must keep (split panels at their minimum width), on top of
 * the share cap. No cap drops the maximum below the minimum: on a pane too
 * narrow for all of them, the sidebar keeps its minimum. An unmeasurable row
 * (hidden pane, jsdom) applies the absolute cap alone.
 */
export function sidebarWidthBounds(layoutWidth: number, reservedWidth = 0): SidebarWidthBounds {
  let max = AI_SIDEBAR_MAX_WIDTH_PX
  if (layoutWidth > 0) {
    max = Math.min(max, Math.floor(layoutWidth * AI_SIDEBAR_MAX_WIDTH_RATIO))
    if (reservedWidth > 0) max = Math.min(max, Math.floor(layoutWidth - reservedWidth))
  }
  return {
    min: AI_SIDEBAR_MIN_WIDTH_PX,
    snap: AI_SIDEBAR_SNAP_CLOSE_PX,
    max: Math.max(AI_SIDEBAR_MIN_WIDTH_PX, max),
  }
}

export function clampSidebarWidth(width: number, bounds: SidebarWidthBounds): number {
  return clamp(Math.round(width), bounds.min, bounds.max)
}

/**
 * Where the pointer is (`rawWidth`, measured from the sidebar's left edge)
 * decides the sidebar: closed below the snap point, otherwise open at that
 * width within the bounds.
 */
export function resolveSidebarDrag(
  rawWidth: number,
  bounds: SidebarWidthBounds,
): SidebarDragResolution {
  if (!Number.isFinite(rawWidth) || rawWidth < bounds.snap) return { collapsed: true }
  return { collapsed: false, width: clampSidebarWidth(rawWidth, bounds) }
}

export interface AiSidebarResizerOptions {
  /** The sidebar; the handle is inserted right after it, in the layout row. */
  sidebar: HTMLElement
  /** Accessible name for the separator. */
  label: string
  /** Bounds for the layout as it is now (read once per gesture or key). */
  getBounds: () => SidebarWidthBounds
  /** The sidebar's open width in pixels, as shown now. */
  getWidth: () => number
  isCollapsed: () => boolean
  /**
   * Continuous feedback while the pointer moves: visuals only, no
   * persistence and no terminal refit.
   */
  onPreview: (resolution: SidebarDragResolution) => void
  /** The gesture settled on this resolution — persist it. */
  onCommit: (resolution: SidebarDragResolution) => void
  /** The gesture was cancelled: put back the state it started from. */
  onCancel: () => void
  /** Drop the user width and fall back to the stylesheet default, open. */
  onReset: () => void
  /** Open or close the sidebar, as its toggle does. */
  onToggle: () => void
}

/**
 * Splitter on the sidebar's right edge (the counterpart of AiPaneResizer).
 *
 * The handle is a zero-width item of the layout row, so it takes no room;
 * styles.css widens its hit area over the edge. While the sidebar is closed
 * the same handle lies at the panels' left edge, and dragging it right opens
 * the sidebar again.
 */
export class AiSidebarResizer {
  private readonly handle: HTMLElement
  private readonly onPointerDown: (event: PointerEvent) => void
  private readonly onPointerMove: (event: PointerEvent) => void
  private readonly onPointerEnd: (event: PointerEvent) => void
  private readonly onLostCapture: () => void
  private readonly onKeyDown: (event: KeyboardEvent) => void
  private readonly onDoubleClick: () => void
  private pointerId: number | null = null
  private dragging = false
  /** The press has travelled past DRAG_THRESHOLD_PX and is now a drag. */
  private moved = false
  private startX = 0
  private startWidth = 0
  private bounds: SidebarWidthBounds = sidebarWidthBounds(0)
  private last: SidebarDragResolution | null = null

  constructor(private readonly options: AiSidebarResizerOptions) {
    const handle = createDiv({
      cls: 'ai-run-pane__sidebar-resizer',
      attr: {
        role: 'separator',
        'aria-orientation': 'vertical',
        'aria-label': options.label,
        title: options.label,
        // 0 is the closed sidebar, the value it reports while closed.
        'aria-valuemin': '0',
        tabindex: '0',
      },
    })
    options.sidebar.after(handle)
    this.handle = handle

    this.onPointerDown = (event) => this.handlePointerDown(event)
    this.onPointerMove = (event) => this.handlePointerMove(event)
    this.onPointerEnd = (event) => this.handlePointerEnd(event)
    this.onLostCapture = () => this.handleLostCapture()
    this.onKeyDown = (event) => this.handleKeyDown(event)
    this.onDoubleClick = () => this.options.onReset()

    handle.addEventListener('pointerdown', this.onPointerDown)
    handle.addEventListener('pointermove', this.onPointerMove)
    handle.addEventListener('pointerup', this.onPointerEnd)
    handle.addEventListener('pointercancel', this.onPointerEnd)
    handle.addEventListener('lostpointercapture', this.onLostCapture)
    handle.addEventListener('keydown', this.onKeyDown)
    handle.addEventListener('dblclick', this.onDoubleClick)
    this.refresh()
  }

  get element(): HTMLElement {
    return this.handle
  }

  /**
   * Re-read the sidebar's state into the separator's ARIA values. It reads
   * layout, so it runs between gestures only; a drag reports the values it
   * already has (showValue).
   */
  refresh(): void {
    if (this.dragging) return
    const collapsed = this.options.isCollapsed()
    this.handle.setAttribute('aria-valuemax', String(this.options.getBounds().max))
    this.handle.setAttribute(
      'aria-valuenow',
      String(collapsed ? 0 : Math.round(this.options.getWidth())),
    )
  }

  private showValue(resolution: SidebarDragResolution): void {
    this.handle.setAttribute('aria-valuenow', String(resolution.collapsed ? 0 : resolution.width))
  }

  dispose(): void {
    this.releasePointer()
    this.handle.removeEventListener('pointerdown', this.onPointerDown)
    this.handle.removeEventListener('pointermove', this.onPointerMove)
    this.handle.removeEventListener('pointerup', this.onPointerEnd)
    this.handle.removeEventListener('pointercancel', this.onPointerEnd)
    this.handle.removeEventListener('lostpointercapture', this.onLostCapture)
    this.handle.removeEventListener('keydown', this.onKeyDown)
    this.handle.removeEventListener('dblclick', this.onDoubleClick)
    this.handle.remove()
  }

  private handlePointerDown(event: PointerEvent): void {
    if (event.button !== undefined && event.button !== 0) return
    event.preventDefault()
    this.pointerId = event.pointerId ?? null
    this.dragging = true
    this.moved = false
    this.startX = event.clientX
    // Closed, the pointer starts at the sidebar's (absent) left edge.
    this.startWidth = this.options.isCollapsed() ? 0 : this.options.getWidth()
    // Layout is read here, once; the moves that follow only write.
    this.bounds = this.options.getBounds()
    this.handle.setAttribute('aria-valuemax', String(this.bounds.max))
    this.last = null
    this.handle.classList.add('is-dragging')
    if (this.pointerId !== null) {
      this.handle.setPointerCapture?.(this.pointerId)
    }
  }

  private resolutionAt(clientX: number): SidebarDragResolution {
    return resolveSidebarDrag(this.startWidth + (clientX - this.startX), this.bounds)
  }

  private handlePointerMove(event: PointerEvent): void {
    if (!this.dragging) return
    if (!this.moved) {
      if (Math.abs(event.clientX - this.startX) < DRAG_THRESHOLD_PX) return
      this.moved = true
    }
    const next = this.resolutionAt(event.clientX)
    if (this.last && sameResolution(this.last, next)) return
    this.last = next
    this.options.onPreview(next)
    this.showValue(next)
  }

  private handlePointerEnd(event: PointerEvent): void {
    if (!this.dragging) return
    // A press that never became a drag is a click on the edge: nothing to
    // settle.
    const moved = this.moved
    const cancelled = event.type === 'pointercancel'
    const resolution = moved && !cancelled ? this.resolutionAt(event.clientX) : null
    this.releasePointer()
    if (resolution) this.options.onCommit(resolution)
    else if (moved) this.options.onCancel()
    this.refresh()
  }

  /**
   * Capture went away without a pointerup (the window lost focus, the system
   * took the pointer): end the gesture as cancelled rather than leave the
   * handle following a pointer whose button is up. After a normal pointerup
   * the gesture is already over and this is a no-op.
   */
  private handleLostCapture(): void {
    if (!this.dragging) return
    const moved = this.moved
    // The capture is gone already; there is nothing to release.
    this.pointerId = null
    this.releasePointer()
    if (moved) this.options.onCancel()
    this.refresh()
  }

  private releasePointer(): void {
    if (this.pointerId !== null) {
      this.handle.releasePointerCapture?.(this.pointerId)
    }
    this.pointerId = null
    this.dragging = false
    this.moved = false
    this.last = null
    this.handle.classList.remove('is-dragging')
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      this.options.onToggle()
      this.refresh()
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      this.options.onReset()
      this.refresh()
      return
    }
    const step =
      event.key === 'ArrowRight'
        ? KEYBOARD_STEP_PX
        : event.key === 'ArrowLeft'
          ? -KEYBOARD_STEP_PX
          : 0
    if (step === 0) return
    event.preventDefault()
    if (this.options.isCollapsed()) {
      // Closed, only "wider" means anything: it opens the sidebar again.
      if (step > 0) this.options.onToggle()
    } else {
      this.options.onCommit({
        collapsed: false,
        width: clampSidebarWidth(this.options.getWidth() + step, this.options.getBounds()),
      })
    }
    this.refresh()
  }
}

function sameResolution(a: SidebarDragResolution, b: SidebarDragResolution): boolean {
  if (a.collapsed || b.collapsed) return a.collapsed === b.collapsed
  return a.width === b.width
}
