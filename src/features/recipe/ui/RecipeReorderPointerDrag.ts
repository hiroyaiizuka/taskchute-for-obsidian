import {
  parkTooltipSources,
  restoreTooltipSources,
  stripTooltipSources,
} from '../../../ui/tooltipSources'

/** The slice of a pointer position the drop math reads. */
interface DragPoint {
  clientX: number
  clientY: number
}

export interface RecipeReorderPointerDragOptions {
  /** Selector matching a droppable row, resolved from the element under the pointer. */
  rowSelector: string
  /** Toggled on the row being dragged. */
  draggingClass: string
  /** Toggled on the hovered row when the dragged row will land above it. */
  dropBeforeClass: string
  /** Toggled on the hovered row when the dragged row will land below it. */
  dropAfterClass: string
  /** Applied to the floating clone that follows the pointer. */
  ghostClass: string
  onReorder: (kind: string, fromIndex: number, toIndex: number) => void
}

interface RowIdentity {
  kind: string
  index: number
}

interface DragSession {
  pointerId: number
  handle: HTMLElement
  row: HTMLElement
  source: RowIdentity
  startX: number
  startY: number
  grabOffsetX: number
  grabOffsetY: number
  started: boolean
  ghost: HTMLElement | null
  /** The grip's tooltip attributes, parked for the duration of the drag. */
  parkedTooltip: Map<string, string>
  hover: HTMLElement | null
  scroller: HTMLElement | null
  scrollFrame: number | null
  lastClientY: number
}

/** Movement before a press on the grip counts as a drag rather than a tap. */
const DRAG_THRESHOLD_PX = 6
/** Distance from the scroller's edge at which the list starts following. */
const EDGE_SCROLL_ZONE_PX = 48
const EDGE_SCROLL_STEP_PX = 12

/**
 * Reordering by pointer events instead of the HTML5 drag-and-drop API.
 *
 * iPadOS and iOS never fire `dragstart` for in-page content, so the grips in the
 * recipe editor and the run popover were inert on a tablet while working on the
 * desktop -- `Alt+Arrow` was the only path that ever moved a row there. Driving
 * the gesture from Pointer Events gives a mouse, a pen and a finger one shared
 * implementation, the same way the task list already works.
 *
 * Rows carry no listeners of their own: the row under the pointer is resolved
 * with `elementFromPoint` on every move, which is what lets the same code
 * hit-test a cursor and a finger without caring which it has.
 */
export default class RecipeReorderPointerDrag {
  private readonly rows = new WeakMap<HTMLElement, RowIdentity>()
  private session: DragSession | null = null

  constructor(private readonly options: RecipeReorderPointerDragOptions) {}

  /** Rows are drop targets only; they need no listeners, just an identity. */
  registerRow(row: HTMLElement, kind: string, index: number): void {
    this.rows.set(row, { kind, index })
  }

  attachHandle(handle: HTMLElement, row: HTMLElement): void {
    handle.addEventListener('pointerdown', (event) => {
      // Secondary buttons open the context menu; a non-primary pointer is a
      // second finger landing mid-drag.
      if (!event.isPrimary || event.button !== 0) return
      if (this.session) return
      this.begin(event, handle, row)
    })
    handle.addEventListener('pointermove', (event) => this.move(event))
    handle.addEventListener('pointerup', (event) => this.finish(event))
    handle.addEventListener('pointercancel', (event) => {
      if (this.session?.pointerId !== event.pointerId) return
      this.teardown(this.session)
    })
  }

  /**
   * Abandons any drag in flight and takes the ghost with it.
   *
   * A pointer drag normally ends with `pointerup` or `pointercancel`, but the
   * host can disappear first -- Escape closes the run popover mid-drag, the row
   * and its grip go with it, and no further pointer event is ever delivered.
   * The ghost is parented to `body`, so without this it stays on screen with
   * nothing left to remove it. Every owner must call this when it tears down.
   */
  cancel(): void {
    this.teardown(this.session)
  }

  private begin(event: PointerEvent, handle: HTMLElement, row: HTMLElement): void {
    const source = this.rows.get(row)
    if (!source) return

    const rect = row.getBoundingClientRect()
    this.session = {
      pointerId: event.pointerId,
      handle,
      row,
      source,
      startX: event.clientX,
      startY: event.clientY,
      grabOffsetX: event.clientX - rect.left,
      grabOffsetY: event.clientY - rect.top,
      started: false,
      ghost: null,
      parkedTooltip: new Map(),
      hover: null,
      scroller: this.findScroller(row),
      scrollFrame: null,
      lastClientY: event.clientY,
    }
    // Capture up front: once the finger leaves the small grip -- which it does
    // immediately -- only the capturing element keeps receiving moves.
    try {
      handle.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic pointers in tests, and pens that leave range, have no capture
      // to take. Hit-testing still works without it.
    }
  }

  private move(event: PointerEvent): void {
    const session = this.session
    if (!session || session.pointerId !== event.pointerId) return

    if (!session.started) {
      const dx = event.clientX - session.startX
      const dy = event.clientY - session.startY
      if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD_PX) return
      this.start(session)
    }

    // Keeps a pen or a trackpad from selecting the row's text under the ghost.
    event.preventDefault()
    session.lastClientY = event.clientY
    this.positionGhost(session, event)
    this.updateHover(session, event)
    this.updateEdgeScroll(session, event.clientY)
  }

  private start(session: DragSession): void {
    session.started = true
    session.row.classList.add(this.options.draggingClass)

    // The pointer stays on the grip for the whole drag, so both the browser's
    // `title` tooltip and Obsidian's `aria-label` one would hang over the rows
    // the user is aiming at. Neither can be stacked out of the way -- see
    // `tooltipSources`.
    parkTooltipSources(session.handle, session.parkedTooltip)

    const rect = session.row.getBoundingClientRect()
    const ghost = session.row.cloneNode(true) as HTMLElement
    ghost.classList.add(this.options.ghostClass)
    ghost.classList.remove(this.options.draggingClass)
    ghost.style.width = `${rect.width}px`
    ghost.style.height = `${rect.height}px`
    // The clone brings the whole row's tooltip sources with it -- the remove
    // button's included. It is decoration, so nothing on it should ever raise
    // a tooltip of its own.
    stripTooltipSources(ghost)
    // ownerDocument, not the global one: the view can live in a popped-out window.
    session.row.ownerDocument.body.appendChild(ghost)
    session.ghost = ghost
  }

  private positionGhost(session: DragSession, point: DragPoint): void {
    const ghost = session.ghost
    if (!ghost) return
    ghost.style.transform = `translate3d(${
      point.clientX - session.grabOffsetX
    }px, ${point.clientY - session.grabOffsetY}px, 0)`
  }

  private updateHover(session: DragSession, point: DragPoint): void {
    const next = this.resolveTarget(session, point)
    if (next === session.hover) return
    this.clearHover(session)
    session.hover = next
    if (!next) return
    // The reorder splices the row into the target's index, so a row travelling
    // down lands below the row it is over and one travelling up lands above it.
    // Marking that edge is what tells the user where the row will actually go.
    const target = this.rows.get(next)
    const landsBelow = target !== undefined && target.index > session.source.index
    next.classList.add(landsBelow ? this.options.dropAfterClass : this.options.dropBeforeClass)
  }

  private resolveTarget(session: DragSession, point: DragPoint): HTMLElement | null {
    // The ghost is `pointer-events: none`, so it never hides what is under it.
    const element = session.row.ownerDocument.elementFromPoint(point.clientX, point.clientY)
    if (!(element instanceof Element)) return null

    const row = element.closest(this.options.rowSelector)
    if (!(row instanceof HTMLElement)) return null

    const identity = this.rows.get(row)
    if (!identity) return null
    // A different list in the same popover, or the row already being dragged.
    if (identity.kind !== session.source.kind) return null
    if (identity.index === session.source.index) return null
    return row
  }

  private clearHover(session: DragSession): void {
    session.hover?.classList.remove(this.options.dropBeforeClass, this.options.dropAfterClass)
    session.hover = null
  }

  /**
   * The native drag path got edge scrolling from the browser. Driving the
   * scroller by hand is what keeps a long checklist reachable once that is gone.
   */
  private updateEdgeScroll(session: DragSession, clientY: number): void {
    const scroller = session.scroller
    if (!scroller) return

    const rect = scroller.getBoundingClientRect()
    let delta = 0
    if (clientY - rect.top < EDGE_SCROLL_ZONE_PX) delta = -EDGE_SCROLL_STEP_PX
    else if (rect.bottom - clientY < EDGE_SCROLL_ZONE_PX) delta = EDGE_SCROLL_STEP_PX

    if (delta === 0) {
      this.stopEdgeScroll(session)
      return
    }
    if (session.scrollFrame !== null) return

    const step = (): void => {
      if (this.session !== session) return
      scroller.scrollTop += delta
      // Re-hit-test at the held position: the rows under the pointer change as
      // the list moves even though the pointer itself has not.
      const ghost = session.ghost
      if (ghost) {
        const ghostRect = ghost.getBoundingClientRect()
        this.updateHover(session, {
          clientX: ghostRect.left + session.grabOffsetX,
          clientY: session.lastClientY,
        })
      }
      session.scrollFrame = window.requestAnimationFrame(step)
    }
    session.scrollFrame = window.requestAnimationFrame(step)
  }

  private stopEdgeScroll(session: DragSession): void {
    if (session.scrollFrame === null) return
    window.cancelAnimationFrame(session.scrollFrame)
    session.scrollFrame = null
  }

  private finish(event: PointerEvent): void {
    const session = this.session
    if (!session || session.pointerId !== event.pointerId) return

    // Never moved past the threshold: this was a tap, and the grip's own click
    // handler is the one that should act on it.
    if (!session.started) {
      this.teardown(session)
      return
    }

    event.preventDefault()
    const target = session.hover ? this.rows.get(session.hover) : undefined
    const source = session.source
    // Tear down before reordering: the callback re-renders the list, which
    // detaches the very row, handle and ghost this session still points at.
    this.teardown(session)
    if (!target) return
    this.options.onReorder(source.kind, source.index, target.index)
  }

  private teardown(session: DragSession | null): void {
    if (!session) return
    this.stopEdgeScroll(session)
    this.clearHover(session)
    session.ghost?.remove()
    session.row.classList.remove(this.options.draggingClass)
    restoreTooltipSources(session.handle, session.parkedTooltip)
    try {
      session.handle.releasePointerCapture(session.pointerId)
    } catch {
      // Already released with the pointer itself.
    }
    this.session = null
  }

  private findScroller(from: HTMLElement): HTMLElement | null {
    let node: HTMLElement | null = from.parentElement
    while (node) {
      const overflowY = node.ownerDocument.defaultView?.getComputedStyle(node).overflowY
      if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
        return node
      }
      node = node.parentElement
    }
    return null
  }
}

/** The six-dot grip shared by the recipe editor and the run popover. */
export function appendRecipeDragHandleIcon(container: HTMLElement): void {
  const svg = createSvg('svg')
  svg.setAttribute('viewBox', '0 0 12 16')
  svg.setAttribute('width', '12')
  svg.setAttribute('height', '16')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('recipe-step-drag-handle-icon')
  ;[
    ['2', '2'], ['8', '2'], ['2', '8'], ['8', '8'], ['2', '14'], ['8', '14'],
  ].forEach(([cx, cy]) => {
    const circle = createSvg('circle')
    circle.setAttribute('cx', cx)
    circle.setAttribute('cy', cy)
    circle.setAttribute('r', '1.5')
    svg.appendChild(circle)
  })
  container.appendChild(svg)
}
