import { setIcon } from 'obsidian'
import type { DayComment } from '@/types'

/** Attribute naming the textareas that keep focus across a re-render. */
export const FOCUS_ATTR = 'data-tc-comment-focus'

export function formatCommentTime(at: number): string {
  const date = new Date(at)
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

export interface CommentItemOptions {
  editLabel?: string
  /** Rewrites it in place (LEV-413); without it there is no edit button. */
  onEdit?: (comment: DayComment) => void
  deleteLabel?: string
  /** Without it there is no delete button: a list only for reading. */
  onDelete?: (comment: DayComment) => void
}

function iconButton(parent: HTMLElement, cls: string, icon: string, label: string, onClick: () => void): void {
  const button = parent.createEl('button', {
    cls: `clickable-icon ${cls}`,
    attr: { type: 'button', 'aria-label': label, title: label },
  })
  setIcon(button, icon)
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick()
  })
}

/** One comment: time, text, and the buttons that edit and delete it, when given. */
export function createCommentItem(list: HTMLElement, comment: DayComment, options: CommentItemOptions): HTMLLIElement {
  const item = list.createEl('li')
  item.setAttribute('data-comment-id', comment.id)
  item.createEl('time', { text: formatCommentTime(comment.at) })
  item.createSpan({ cls: 'taskchute-comment-text', text: comment.text })
  const { onEdit, onDelete } = options
  if (!onEdit && !onDelete) return item
  const actions = item.createDiv({ cls: 'taskchute-comment-actions' })
  if (onEdit) {
    iconButton(actions, 'taskchute-comment-edit', 'pencil', options.editLabel ?? '', () => onEdit(comment))
  }
  if (onDelete) {
    iconButton(actions, 'taskchute-comment-delete', 'x', options.deleteLabel ?? '', () => onDelete(comment))
  }
  return item
}

export interface CommentEditorOptions {
  focusKey: string
  value: string
  submitOnEnter: boolean
  saveText: string
  cancelText: string
  onInput: (value: string) => void
  onSave: (text: string) => void
  onCancel: () => void
}

/**
 * A comment being rewritten (LEV-413): its time, then its text in an input
 * that grows with it. Enter saves and Esc cancels, as in the other inputs;
 * the buttons under it do the same for a phone.
 */
export function createCommentEditor(list: HTMLElement, comment: DayComment, options: CommentEditorOptions): HTMLLIElement {
  const item = list.createEl('li', { cls: 'is-editing' })
  item.setAttribute('data-comment-id', comment.id)
  item.createEl('time', { text: formatCommentTime(comment.at) })
  const body = item.createDiv({ cls: 'taskchute-comment-editor' })
  const textarea = createCommentTextarea(body, {
    cls: 'taskchute-comment-input taskchute-comment-editor__input',
    focusKey: options.focusKey,
    value: options.value,
    submitOnEnter: options.submitOnEnter,
    onInput: options.onInput,
    onSubmit: options.onSave,
    onEscape: options.onCancel,
  })
  const buttons = body.createDiv({ cls: 'taskchute-comment-editor__buttons' })
  const cancel = buttons.createEl('button', { text: options.cancelText, attr: { type: 'button' } })
  cancel.addEventListener('click', (event) => {
    event.stopPropagation()
    options.onCancel()
  })
  const save = buttons.createEl('button', { cls: 'mod-cta', text: options.saveText, attr: { type: 'button' } })
  save.addEventListener('click', (event) => {
    event.stopPropagation()
    options.onSave(textarea.value)
  })
  return item
}

export interface CommentTextareaOptions {
  cls: string
  focusKey: string
  value?: string
  placeholder?: string
  /** Height the box may grow to before it scrolls. */
  maxHeight?: number
  onInput?: (value: string) => void
  /** Enter (not while composing with an IME); Shift+Enter is a new line. */
  onSubmit: (value: string) => void
  /** false makes Enter a new line too (phones: there is no Shift, and a button adds). */
  submitOnEnter?: boolean
  onEscape?: () => void
}

/** A textarea that grows with its text, submitting on Enter. */
export function createCommentTextarea(parent: HTMLElement, options: CommentTextareaOptions): HTMLTextAreaElement {
  const textarea = parent.createEl('textarea', {
    cls: options.cls,
    attr: { rows: '1', [FOCUS_ATTR]: options.focusKey },
  })
  if (options.placeholder) textarea.placeholder = options.placeholder
  textarea.value = options.value ?? ''
  const maxHeight = options.maxHeight ?? 160
  const grow = () => {
    textarea.style.removeProperty('--tc-comment-input-height')
    const border = textarea.offsetHeight - textarea.clientHeight
    textarea.style.setProperty('--tc-comment-input-height', `${Math.min(textarea.scrollHeight + border, maxHeight)}px`)
  }
  textarea.addEventListener('input', () => {
    grow()
    options.onInput?.(textarea.value)
  })
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && options.onEscape) {
      event.preventDefault()
      event.stopPropagation()
      options.onEscape()
      return
    }
    if (options.submitOnEnter === false) return
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return
    event.preventDefault()
    options.onSubmit(textarea.value)
  })
  window.requestAnimationFrame(grow)
  return textarea
}

/**
 * Re-renders inside `root` keep the comment input that had focus, with its
 * caret: rebuilding replaces the textarea, so focus moves to the new one.
 */
export function preserveCommentFocus(root: HTMLElement | null | undefined, render: () => void): void {
  const active = root?.ownerDocument.activeElement
  const focusKey = active instanceof HTMLTextAreaElement && root?.contains(active)
    ? active.getAttribute(FOCUS_ATTR)
    : null
  const caret = focusKey ? (active as HTMLTextAreaElement).selectionEnd : 0
  render()
  if (!focusKey || !root) return
  const again = findFocusTarget(root, focusKey)
  if (again && again !== root.ownerDocument.activeElement) {
    again.focus()
    again.setSelectionRange(caret, caret)
  }
}

export function findFocusTarget(root: HTMLElement, focusKey: string): HTMLTextAreaElement | null {
  const candidates = root.querySelectorAll<HTMLTextAreaElement>(`textarea[${FOCUS_ATTR}]`)
  for (const candidate of Array.from(candidates)) {
    if (candidate.getAttribute(FOCUS_ATTR) === focusKey) return candidate
  }
  return null
}
