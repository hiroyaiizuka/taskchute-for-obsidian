/**
 * Height of the box holding the day's comments.
 *
 * - Auto (no height set): the box fits its content up to three comments; past
 *   three it stops there and the rest scroll.
 * - Fixed (after dragging the grip under it): the box never grows past that
 *   height, but still shrinks to its content when the content is smaller.
 *
 * Double-clicking the grip goes back to auto. With no comments there is only
 * the input, and the grip is hidden. The fixed height is kept per device.
 */
export const DAY_COMMENTS_HEIGHT_STORAGE_KEY = 'taskchute-plus.day-comments-height'
const AUTO_ROWS = 3
/** The task list keeps at least this much when the box is dragged taller. */
const LIST_MIN_PX = 160
const KEY_STEP_PX = 16

export interface DayCommentsHeightHost {
  loadLocalStorage: (key: string) => unknown
  saveLocalStorage: (key: string, value: unknown) => void
  /** The task list, for how much room dragging may take. */
  getTaskListContainer: () => HTMLElement | null
}

export class DayCommentsHeight {
  private fixed: number | null

  constructor(
    private readonly box: HTMLElement,
    private readonly grip: HTMLElement,
    private readonly host: DayCommentsHeightHost,
  ) {
    const stored = host.loadLocalStorage(DAY_COMMENTS_HEIGHT_STORAGE_KEY)
    this.fixed = typeof stored === 'number' && Number.isFinite(stored) && stored > 0 ? stored : null
    this.bindGrip()
  }

  isFixed(): boolean {
    return this.fixed !== null
  }

  /** Re-measures after the box's content changed. */
  apply(): void {
    const rows = this.rows()
    this.grip.classList.toggle('taskchute-day-comments-resizer--hidden', rows.length === 0)
    this.box.classList.toggle('is-fixed', this.fixed !== null)
    const cap = this.fixed ?? (rows.length > AUTO_ROWS ? this.heightThrough(AUTO_ROWS) : null)
    // The input never gets cut off: once it opens (taller, with its footer),
    // the box makes room for it and the newest comment under it, whatever
    // height was fixed. It goes back to the cap when the input closes.
    const max = cap === null ? null : Math.max(cap, this.inputFloor(rows.length > 0))
    this.box.style.setProperty('--tc-day-comments-max', max === null ? 'none' : `${max}px`)
  }

  /** Height the box needs to show the whole input, plus the first comment when there is one. */
  private inputFloor(hasRows: boolean): number {
    const input = this.box.querySelector<HTMLElement>('.taskchute-comment-composer')
    if (!input) return 0
    const inputBottom = Math.ceil(input.getBoundingClientRect().bottom - this.box.getBoundingClientRect().top)
    return hasRows ? Math.max(inputBottom, this.heightThrough(1) ?? 0) : inputBottom
  }

  private rows(): HTMLElement[] {
    return Array.from(this.box.querySelectorAll<HTMLElement>('.taskchute-comment-list > li'))
  }

  /** Box height down to the bottom of the `n`th comment (1-based), as if unscrolled. */
  private heightThrough(n: number): number | null {
    const rows = this.rows()
    if (rows.length < n) return null
    const scroller = this.box.querySelector<HTMLElement>('.taskchute-day-comments__entries')
    const bottom = rows[n - 1].getBoundingClientRect().bottom + (scroller?.scrollTop ?? 0)
    return Math.ceil(bottom - this.box.getBoundingClientRect().top) + 2
  }

  private setFixed(height: number | null): void {
    this.fixed = height
    this.host.saveLocalStorage(DAY_COMMENTS_HEIGHT_STORAGE_KEY, height)
    this.apply()
  }

  private bounds(): { min: number; max: number } {
    const list = this.host.getTaskListContainer()
    const current = this.box.getBoundingClientRect().height
    const min = this.heightThrough(1) ?? current
    const room = current + (list?.getBoundingClientRect().height ?? 0) - LIST_MIN_PX
    return { min, max: Math.max(min, room) }
  }

  private bindGrip(): void {
    this.grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      const startY = event.clientY
      const startHeight = this.box.getBoundingClientRect().height
      const { min, max } = this.bounds()
      let height = startHeight
      this.grip.classList.add('is-dragging')
      this.grip.setPointerCapture?.(event.pointerId)
      const onMove = (move: PointerEvent) => {
        height = Math.round(Math.min(max, Math.max(min, startHeight + move.clientY - startY)))
        this.box.style.setProperty('--tc-day-comments-max', `${height}px`)
      }
      const onUp = () => {
        this.grip.classList.remove('is-dragging')
        this.grip.removeEventListener('pointermove', onMove)
        this.grip.removeEventListener('pointerup', onUp)
        this.grip.removeEventListener('pointercancel', onUp)
        this.setFixed(height)
      }
      this.grip.addEventListener('pointermove', onMove)
      this.grip.addEventListener('pointerup', onUp)
      this.grip.addEventListener('pointercancel', onUp)
    })
    this.grip.addEventListener('dblclick', () => this.setFixed(null))
    this.grip.addEventListener('keydown', (event) => {
      if (event.key === 'Home') {
        event.preventDefault()
        this.setFixed(null)
        return
      }
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      event.preventDefault()
      const { min, max } = this.bounds()
      const current = this.box.getBoundingClientRect().height
      const next = current + (event.key === 'ArrowDown' ? KEY_STEP_PX : -KEY_STEP_PX)
      this.setFixed(Math.round(Math.min(max, Math.max(min, next))))
    })
  }
}
