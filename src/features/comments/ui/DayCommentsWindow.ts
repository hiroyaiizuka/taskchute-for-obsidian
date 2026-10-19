import { setIcon } from 'obsidian'

/** Pulling a drawer's top down this far closes it. */
const SWIPE_CLOSE_PX = 120

export interface DayCommentsButtonState {
  /** Off in settings: no button at all. */
  visible: boolean
  open: boolean
  label: string
}

/**
 * The round button at the bottom right of the task list (LEV-346). It opens
 * the day's comments, whose count is in the window's title rather than on the
 * button; while the window is open it turns into a close button.
 */
export class DayCommentsButton {
  readonly el: HTMLButtonElement

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
  }
}

export interface CommentsWindowOptions {
  /**
   * `window`: the day's, over the bottom right of the task list. `drawer`: the
   * day's on a phone, over the whole view. `popover`: a running task's, under
   * its row's 💬.
   */
  kind: 'window' | 'drawer' | 'popover'
  title: string
  /** "3 comments", or empty for none. */
  count: string
  label: string
  closeLabel: string
  onClose: () => void
}

export interface CommentsWindowParts {
  el: HTMLElement
  /** The list goes here; it scrolls. */
  body: HTMLElement
  /** The input goes here, under the list. */
  composer: HTMLElement
}

/**
 * A comments window: a title with the count and a close button, the list,
 * and the input fixed under it. It closes from the × , Esc, or (a drawer) by
 * pulling its top down; a click outside leaves it open so the tasks can be
 * read while writing.
 */
export function createCommentsWindow(parent: HTMLElement, options: CommentsWindowOptions): CommentsWindowParts {
  // A popover has a root of its own (anything looking for the day's window
  // must not find it) and shares the day's window's parts inside.
  const cls = {
    window: 'taskchute-day-comments-window',
    drawer: 'taskchute-day-comments-window is-drawer',
    popover: 'taskchute-task-comments-popover',
  }[options.kind]
  const el = parent.createEl('section', { cls, attr: { role: 'dialog', 'aria-label': options.label } })
  const head = el.createDiv({ cls: 'taskchute-day-comments-window__head' })
  if (options.kind === 'drawer') head.createDiv({ cls: 'taskchute-day-comments-window__handle', attr: { 'aria-hidden': 'true' } })
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
  if (options.kind === 'drawer') enableSwipeToClose(el, head, options.onClose)
  return { el, body, composer }
}

/**
 * Lines a popover up under the 💬 it opened from. The popover hangs from an
 * anchor placed right after the task's row, so the row is the anchor's
 * previous sibling; its right edge and its point follow that row's 💬
 * (the stylesheet's defaults hold when the button cannot be found).
 */
export function pointAtCommentButton(anchor: HTMLElement, popover: HTMLElement): void {
  const button = anchor.previousElementSibling?.querySelector<HTMLElement>('.comment-button')
  if (!button) return
  const from = anchor.getBoundingClientRect()
  const to = button.getBoundingClientRect()
  if (to.width === 0) return
  popover.style.setProperty('--tc-comments-popover-right', `${Math.max(0, from.right - to.right)}px`)
  popover.style.setProperty('--tc-comments-caret-right', `${to.width / 2}px`)
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
