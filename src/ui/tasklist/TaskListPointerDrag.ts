import type { TaskInstance } from '../../types'

/**
 * The slice of an event the drop math actually reads. `DragEvent` satisfies it,
 * so `TaskDragController` keeps working unchanged for anything still on the
 * HTML5 path while this module feeds it plain pointer coordinates.
 */
export interface DragPointer {
  clientY: number
}

export interface TaskListPointerDragHost {
  registerManagedDomEvent: (
    target: Document | HTMLElement,
    event: string,
    handler: EventListener,
  ) => void
  handleDragOver: (e: DragPointer, taskItem: HTMLElement, inst: TaskInstance) => void
  handleDrop: (e: DragPointer, taskItem: HTMLElement, inst: TaskInstance, payload?: string) => void
  handleSlotDrop: (e: DragPointer, slot: string, payload?: string) => void
  /** Lets the renderer suppress the slot header's collapse toggle mid-drag. */
  onDragStateChange: (dragging: boolean) => void
}

/** Movement before a press on the grip counts as a drag rather than a tap. */
const DRAG_THRESHOLD_PX = 6
/** Distance from the scroller's edge at which the list starts following. */
const EDGE_SCROLL_ZONE_PX = 56
const EDGE_SCROLL_STEP_PX = 14

type HoverTarget =
  | { kind: 'row'; el: HTMLElement; inst: TaskInstance }
  | { kind: 'slot'; el: HTMLElement; slot: string }

interface DragSession {
  pointerId: number
  handle: HTMLElement
  taskItem: HTMLElement
  payload: string
  startX: number
  startY: number
  grabOffsetX: number
  grabOffsetY: number
  started: boolean
  ghost: HTMLElement | null
  hover: HoverTarget | null
  scroller: HTMLElement | null
  scrollFrame: number | null
  lastClientY: number
}

/**
 * Reordering by pointer events instead of the HTML5 drag-and-drop API.
 *
 * iPadOS and iOS never fire `dragstart` for in-page content, so the grip was
 * inert on a tablet while working on the desktop. Rather than keeping the
 * native path and bolting a touch path beside it -- two code paths that drift
 * -- the list drags on Pointer Events everywhere: one implementation that a
 * mouse, a pen and a finger all drive identically.
 *
 * Drop targets carry no listeners of their own. The row under the pointer is
 * resolved with `elementFromPoint` on every move, which is what lets the same
 * code hit-test a finger and a cursor without caring which it has.
 */
export default class TaskListPointerDrag {
  private readonly rows = new WeakMap<HTMLElement, TaskInstance>()
  private readonly slotHeaders = new WeakMap<HTMLElement, string>()
  private session: DragSession | null = null

  constructor(private readonly host: TaskListPointerDragHost) {}

  /** Rows are drop targets only; they need no listeners, just an identity. */
  registerRow(taskItem: HTMLElement, inst: TaskInstance): void {
    this.rows.set(taskItem, inst)
  }

  registerSlotHeader(header: HTMLElement, slot: string): void {
    this.slotHeaders.set(header, slot)
  }

  /**
   * @param payload `slot::idx[::instanceId]`, the same string the HTML5 path
   * used to put on the dataTransfer. Keeping the format means the drop side
   * resolves the source exactly as before, board-view filtering included.
   */
  attachHandle(handle: HTMLElement, taskItem: HTMLElement, payload: string): void {
    this.host.registerManagedDomEvent(handle, 'pointerdown', (event) => {
      if (!(event instanceof PointerEvent)) return
      // Secondary buttons open the context menu; a non-primary pointer is a
      // second finger landing mid-drag.
      if (!event.isPrimary || event.button !== 0) return
      if (this.session) return
      this.begin(event, handle, taskItem, payload)
    })
    this.host.registerManagedDomEvent(handle, 'pointermove', (event) => {
      if (!(event instanceof PointerEvent)) return
      this.move(event)
    })
    this.host.registerManagedDomEvent(handle, 'pointerup', (event) => {
      if (!(event instanceof PointerEvent)) return
      this.finish(event)
    })
    this.host.registerManagedDomEvent(handle, 'pointercancel', (event) => {
      if (!(event instanceof PointerEvent)) return
      if (this.session?.pointerId !== event.pointerId) return
      this.cancel()
    })
  }

  private begin(
    event: PointerEvent,
    handle: HTMLElement,
    taskItem: HTMLElement,
    payload: string,
  ): void {
    const rect = taskItem.getBoundingClientRect()
    this.session = {
      pointerId: event.pointerId,
      handle,
      taskItem,
      payload,
      startX: event.clientX,
      startY: event.clientY,
      grabOffsetX: event.clientX - rect.left,
      grabOffsetY: event.clientY - rect.top,
      started: false,
      ghost: null,
      hover: null,
      scroller: this.findScroller(taskItem),
      scrollFrame: null,
      lastClientY: event.clientY,
    }
    // Capture up front: once the finger leaves the 24px grip -- which it does
    // immediately -- only the capturing element keeps receiving moves.
    try {
      handle.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic pointers in tests, and pens that leave range, have no
      // capture to take. Hit-testing still works without it.
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

    // Keeps a pen or a trackpad from selecting text under the ghost.
    event.preventDefault()
    session.lastClientY = event.clientY
    this.positionGhost(session, event.clientX, event.clientY)
    this.updateHover(session, event.clientX, event.clientY)
    this.updateEdgeScroll(session, event.clientY)
  }

  private start(session: DragSession): void {
    session.started = true
    this.host.onDragStateChange(true)
    session.taskItem.classList.add('dragging')

    const rect = session.taskItem.getBoundingClientRect()
    const ghost = session.taskItem.cloneNode(true) as HTMLElement
    ghost.classList.add('task-item-drag-ghost', 'task-item-drag-ghost--floating')
    ghost.classList.remove('dragging')
    ghost.style.width = `${rect.width}px`
    ghost.style.height = `${rect.height}px`
    // ownerDocument, not the global one: the view can live in a popped-out window.
    session.taskItem.ownerDocument.body.appendChild(ghost)
    session.ghost = ghost
  }

  private positionGhost(session: DragSession, clientX: number, clientY: number): void {
    const ghost = session.ghost
    if (!ghost) return
    ghost.style.transform =
      `translate3d(${clientX - session.grabOffsetX}px, ${clientY - session.grabOffsetY}px, 0)`
  }

  private updateHover(session: DragSession, clientX: number, clientY: number): void {
    // The ghost is `pointer-events: none`, so it never hides what is under it.
    const doc = session.taskItem.ownerDocument
    const element = doc.elementFromPoint(clientX, clientY)
    const next = this.resolveTarget(session, element)

    if (next?.el !== session.hover?.el) {
      this.clearHover(session)
      session.hover = next ?? null
    }
    if (!next) return

    if (next.kind === 'row') {
      this.host.handleDragOver({ clientY }, next.el, next.inst)
    } else {
      next.el.classList.add('dragover')
    }
  }

  private resolveTarget(session: DragSession, element: Element | null): HoverTarget | null {
    if (!(element instanceof Element)) return null

    const row = element.closest('.task-item')
    if (row instanceof HTMLElement && row !== session.taskItem) {
      const inst = this.rows.get(row)
      if (inst) return { kind: 'row', el: row, inst }
    }

    const header = element.closest('.time-slot-header')
    if (header instanceof HTMLElement) {
      const slot = this.slotHeaders.get(header)
      if (slot !== undefined) return { kind: 'slot', el: header, slot }
    }

    return null
  }

  private clearHover(session: DragSession): void {
    const hover = session.hover
    if (!hover) return
    hover.el.classList.remove('dragover', 'dragover-top', 'dragover-bottom', 'dragover-invalid')
    delete hover.el.dataset.dragInvalidMessage
    session.hover = null
  }

  /**
   * The native drag path got edge scrolling from the browser. Driving the
   * scroller by hand is what keeps a long list reachable once that is gone --
   * on a tablet especially, where the list is taller than the screen.
   */
  private updateEdgeScroll(session: DragSession, clientY: number): void {
    const scroller = session.scroller
    if (!scroller) return

    const rect = scroller.getBoundingClientRect()
    const topGap = clientY - rect.top
    const bottomGap = rect.bottom - clientY
    let delta = 0
    if (topGap < EDGE_SCROLL_ZONE_PX) delta = -EDGE_SCROLL_STEP_PX
    else if (bottomGap < EDGE_SCROLL_ZONE_PX) delta = EDGE_SCROLL_STEP_PX

    if (delta === 0) {
      this.stopEdgeScroll(session)
      return
    }
    if (session.scrollFrame !== null) return

    const step = () => {
      if (!this.session || this.session !== session) return
      scroller.scrollTop += delta
      // Re-hit-test at the held position: the rows under the pointer change as
      // the list moves even though the pointer itself has not.
      this.updateHoverAtHeldPosition(session)
      session.scrollFrame = window.requestAnimationFrame(step)
    }
    session.scrollFrame = window.requestAnimationFrame(step)
  }

  private updateHoverAtHeldPosition(session: DragSession): void {
    const ghost = session.ghost
    if (!ghost) return
    const rect = ghost.getBoundingClientRect()
    this.updateHover(session, rect.left + session.grabOffsetX, session.lastClientY)
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
    const hover = session.hover
    if (hover?.kind === 'row') {
      this.host.handleDrop({ clientY: event.clientY }, hover.el, hover.inst, session.payload)
    } else if (hover?.kind === 'slot') {
      this.host.handleSlotDrop({ clientY: event.clientY }, hover.slot, session.payload)
    }
    this.teardown(session)
  }

  private cancel(): void {
    const session = this.session
    if (!session) return
    this.teardown(session)
  }

  private teardown(session: DragSession): void {
    this.stopEdgeScroll(session)
    this.clearHover(session)
    session.ghost?.remove()
    session.taskItem.classList.remove('dragging')
    try {
      session.handle.releasePointerCapture(session.pointerId)
    } catch {
      // Already released with the pointer itself.
    }
    if (session.started) {
      this.host.onDragStateChange(false)
    }
    this.session = null
  }

  private findScroller(from: HTMLElement): HTMLElement | null {
    let node: HTMLElement | null = from.parentElement
    while (node) {
      const overflowY = node.ownerDocument.defaultView?.getComputedStyle(node).overflowY
      if (
        (overflowY === 'auto' || overflowY === 'scroll') &&
        node.scrollHeight > node.clientHeight
      ) {
        return node
      }
      node = node.parentElement
    }
    return null
  }
}
