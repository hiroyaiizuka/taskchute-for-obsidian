/** Attribute naming the textareas that keep focus across a re-render. */
export const FOCUS_ATTR = 'data-tc-comment-focus'
/** Attribute on the clocks inside an open input, kept current by a ticker. */
export const NOW_ATTR = 'data-tc-comment-now'

export function formatCommentTime(at: number): string {
  const date = new Date(at)
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
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
