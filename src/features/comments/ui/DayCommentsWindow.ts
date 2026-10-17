import { setIcon } from 'obsidian'

/** Pulling a drawer's top down this far closes it. */
const SWIPE_CLOSE_PX = 120

export interface DayCommentsButtonState {
  /** Off in settings: no button at all. */
  visible: boolean
  count: number
  open: boolean
  label: string
}

/**
 * The round button at the bottom right of the task list (LEV-346). It opens
 * the day's comments and carries their count; while the window is open it
 * turns into a close button.
 */
export class DayCommentsButton {
  readonly el: HTMLButtonElement
  private shownCount = 0

  constructor(parent: HTMLElement, onClick: () => void) {
    this.el = parent.createEl('button', { cls: 'taskchute-day-comments-button', attr: { type: 'button' } })
    this.el.addEventListener('click', onClick)
  }

  update(state: DayCommentsButtonState): void {
    this.el.hidden = !state.visible
    this.el.classList.toggle('is-open', state.open)
    this.el.setAttribute('aria-label', state.label)
    this.el.setAttribute('aria-expanded', String(state.open))
    this.el.title = state.label
    this.el.empty()
    setIcon(this.el.createSpan({ cls: 'taskchute-day-comments-button__icon' }), state.open ? 'x' : 'message-square-text')
    if (state.count > 0 && !state.open) {
      const badge = this.el.createSpan({ cls: 'taskchute-day-comments-button__count', text: String(state.count) })
      // A comment just added: the count gives a small bump.
      if (state.count > this.shownCount) badge.classList.add('is-bumped')
    }
    this.shownCount = state.count
  }
}

export interface DayCommentsWindowOptions {
  /** Phones: a drawer over the whole view instead of a window. */
  drawer: boolean
  title: string
  /** "3 comments", or empty for none. */
  count: string
  label: string
  closeLabel: string
  onClose: () => void
}

export interface DayCommentsWindowParts {
  el: HTMLElement
  /** The list goes here; it scrolls. */
  body: HTMLElement
  /** The input goes here, under the list. */
  composer: HTMLElement
}

/**
 * The window over the bottom right of the task list, or the drawer on a
 * phone: a title with the day's count and a close button, the list, and the
 * input. It closes from the × , Esc, or (a drawer) by pulling its top down;
 * a click outside leaves it open so the tasks can be read while writing.
 */
export function createDayCommentsWindow(parent: HTMLElement, options: DayCommentsWindowOptions): DayCommentsWindowParts {
  const el = parent.createEl('section', {
    cls: `taskchute-day-comments-window${options.drawer ? ' is-drawer' : ''}`,
    attr: { role: 'dialog', 'aria-label': options.label },
  })
  const head = el.createDiv({ cls: 'taskchute-day-comments-window__head' })
  if (options.drawer) head.createDiv({ cls: 'taskchute-day-comments-window__handle', attr: { 'aria-hidden': 'true' } })
  const title = head.createDiv({ cls: 'taskchute-day-comments-window__title' })
  title.createSpan({ cls: 'taskchute-day-comments-window__title-text', text: options.title })
  if (options.count) title.createSpan({ cls: 'taskchute-day-comments-window__count', text: options.count })
  const close = head.createEl('button', {
    cls: 'clickable-icon taskchute-day-comments-window__close',
    attr: { type: 'button', 'aria-label': options.closeLabel, title: options.closeLabel },
  })
  setIcon(close, 'x')
  close.addEventListener('click', () => options.onClose())

  const body = el.createDiv({ cls: 'taskchute-day-comments-window__body' })
  const composer = el.createDiv({ cls: 'taskchute-day-comments-window__composer' })

  el.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault()
    options.onClose()
  })
  if (options.drawer) enableSwipeToClose(el, head, options.onClose)
  return { el, body, composer }
}

function enableSwipeToClose(drawer: HTMLElement, handle: HTMLElement, onClose: () => void): void {
  handle.addEventListener('pointerdown', (event) => {
    if ((event.target as HTMLElement | null)?.closest('button')) return
    const startY = event.clientY
    handle.setPointerCapture?.(event.pointerId)
    drawer.classList.add('is-dragging')
    const move = (e: PointerEvent) => {
      drawer.style.setProperty('--tc-drawer-offset', `${Math.max(0, e.clientY - startY)}px`)
    }
    const up = (e: PointerEvent) => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      drawer.classList.remove('is-dragging')
      drawer.style.removeProperty('--tc-drawer-offset')
      if (e.type === 'pointerup' && e.clientY - startY > SWIPE_CLOSE_PX) onClose()
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  })
}
