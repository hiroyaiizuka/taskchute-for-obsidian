/** Smallest usable pane height: the header plus a couple of body rows. */
export const AI_PANE_MIN_HEIGHT_PX = 120
/** Largest share of the view the pane may take, leaving the task list a strip. */
export const AI_PANE_MAX_HEIGHT_RATIO = 0.9
/** Height change per ArrowUp/ArrowDown press on the focused handle. */
const KEYBOARD_STEP_PX = 16

export interface AiPaneResizerOptions {
  /** Host container (.ai-pane-container); the handle becomes its first child. */
  container: HTMLElement
  /** Accessible name for the separator. */
  label: string
  /** Height the ratio is measured against (the .main-container column). */
  getViewHeight: () => number
  /** Current pane height in pixels. */
  getPaneHeight: () => number
  /** Continuous feedback while the pointer moves (not a persistence point). */
  onResize: (ratio: number) => void
  /** The gesture settled on this ratio — persist it. */
  onCommit: (ratio: number) => void
  /** Drop the user height and fall back to the stylesheet default. */
  onReset: () => void
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Splitter between the task list and the AI run pane.
 *
 * The handle lives inside the pane container rather than between the two
 * columns, so it inherits the container's visibility (`--visible`) without
 * any extra synchronisation — a previous sibling cannot be selected in CSS.
 *
 * Heights are carried as a ratio of the view height, never as pixels: the
 * leaf can be split or the window resized after the value was stored, and a
 * ratio survives both.
 */
export class AiPaneResizer {
  private readonly handle: HTMLElement
  private readonly onPointerDown: (event: PointerEvent) => void
  private readonly onPointerMove: (event: PointerEvent) => void
  private readonly onPointerEnd: (event: PointerEvent) => void
  private readonly onKeyDown: (event: KeyboardEvent) => void
  private readonly onDoubleClick: () => void
  private pointerId: number | null = null
  private startY = 0
  private startHeight = 0
  private lastRatio: number | null = null

  constructor(private readonly options: AiPaneResizerOptions) {
    const handle = options.container.createDiv({
      cls: 'ai-pane-resizer',
      attr: {
        role: 'separator',
        'aria-orientation': 'horizontal',
        'aria-label': options.label,
        title: options.label,
        tabindex: '0',
      },
    })
    // createDiv appends; the splitter must sit above .ai-run-pane regardless
    // of the order the pane itself was mounted in.
    options.container.prepend(handle)
    this.handle = handle

    this.onPointerDown = (event) => this.handlePointerDown(event)
    this.onPointerMove = (event) => this.handlePointerMove(event)
    this.onPointerEnd = (event) => this.handlePointerEnd(event)
    this.onKeyDown = (event) => this.handleKeyDown(event)
    this.onDoubleClick = () => this.options.onReset()

    handle.addEventListener('pointerdown', this.onPointerDown)
    handle.addEventListener('pointermove', this.onPointerMove)
    handle.addEventListener('pointerup', this.onPointerEnd)
    handle.addEventListener('pointercancel', this.onPointerEnd)
    handle.addEventListener('keydown', this.onKeyDown)
    handle.addEventListener('dblclick', this.onDoubleClick)
  }

  get element(): HTMLElement {
    return this.handle
  }

  dispose(): void {
    this.releasePointer()
    this.handle.removeEventListener('pointerdown', this.onPointerDown)
    this.handle.removeEventListener('pointermove', this.onPointerMove)
    this.handle.removeEventListener('pointerup', this.onPointerEnd)
    this.handle.removeEventListener('pointercancel', this.onPointerEnd)
    this.handle.removeEventListener('keydown', this.onKeyDown)
    this.handle.removeEventListener('dblclick', this.onDoubleClick)
    this.handle.remove()
  }

  /**
   * Ratio a pixel height maps to, clamped to the usable band. Null while the
   * view has no measurable height (hidden leaf, jsdom) — there is no sane
   * ratio to report and the gesture must be ignored.
   */
  private ratioFor(heightPx: number): number | null {
    const viewHeight = this.options.getViewHeight()
    if (!(viewHeight > 0)) return null
    const minRatio = Math.min(
      AI_PANE_MIN_HEIGHT_PX / viewHeight,
      AI_PANE_MAX_HEIGHT_RATIO,
    )
    return clamp(heightPx / viewHeight, minRatio, AI_PANE_MAX_HEIGHT_RATIO)
  }

  private handlePointerDown(event: PointerEvent): void {
    if (event.button !== undefined && event.button !== 0) return
    const paneHeight = this.options.getPaneHeight()
    if (!(paneHeight > 0)) return
    if (this.ratioFor(paneHeight) === null) return

    event.preventDefault()
    this.pointerId = event.pointerId ?? null
    this.startY = event.clientY
    this.startHeight = paneHeight
    this.lastRatio = null
    this.handle.classList.add('is-dragging')
    if (this.pointerId !== null) {
      this.handle.setPointerCapture?.(this.pointerId)
    }
  }

  private handlePointerMove(event: PointerEvent): void {
    if (this.pointerId === null) return
    // Dragging upward grows the pane, so the delta is subtracted.
    const ratio = this.ratioFor(this.startHeight - (event.clientY - this.startY))
    if (ratio === null || ratio === this.lastRatio) return
    this.lastRatio = ratio
    this.options.onResize(ratio)
  }

  private handlePointerEnd(event: PointerEvent): void {
    if (this.pointerId === null) return
    if (event.type !== 'pointercancel') {
      const ratio = this.ratioFor(
        this.startHeight - (event.clientY - this.startY),
      )
      if (ratio !== null) {
        this.lastRatio = ratio
        this.options.onCommit(ratio)
      }
    }
    this.releasePointer()
  }

  private releasePointer(): void {
    if (this.pointerId !== null) {
      this.handle.releasePointerCapture?.(this.pointerId)
    }
    this.pointerId = null
    this.lastRatio = null
    this.handle.classList.remove('is-dragging')
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Home') {
      event.preventDefault()
      this.options.onReset()
      return
    }
    const step =
      event.key === 'ArrowUp'
        ? KEYBOARD_STEP_PX
        : event.key === 'ArrowDown'
          ? -KEYBOARD_STEP_PX
          : 0
    if (step === 0) return
    const ratio = this.ratioFor(this.options.getPaneHeight() + step)
    if (ratio === null) return
    event.preventDefault()
    this.options.onCommit(ratio)
  }
}
