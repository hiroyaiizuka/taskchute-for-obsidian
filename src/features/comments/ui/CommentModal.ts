import { App, Modal } from 'obsidian'
import { createModalFooter, type ModalFooterButtonSpec } from '@/ui/components/modalFooter'
import { formatCommentTime } from './commentDom'

export interface CommentModalOptions {
  title: string
  at: number
  value?: string
  placeholder?: string
  submitText: string
  cancelText: string
  /** Return false to keep the modal open (e.g. blank text). */
  onSubmit: (text: string) => boolean | void
  /** Every keystroke, so an unsent draft survives closing the modal. */
  onDraft?: (text: string) => void
  /**
   * Enter sends and Shift+Enter is a new line, as in the other comment
   * inputs. Off on a phone, which has no Shift: there Enter is a new line.
   */
  submitOnEnter?: boolean
}

/**
 * On a phone, adding a comment to a running task happens here instead of in place:
 * the in-place input is too cramped once the keyboard is up. The command for a
 * running task's comment opens it everywhere (LEV-415).
 */
export class CommentModal extends Modal {
  constructor(app: App, private readonly options: CommentModalOptions) {
    super(app)
  }

  onOpen(): void {
    const { options } = this
    this.modalEl.addClass('taskchute-modal', 'taskchute-comment-entry-modal')
    this.setTitle(options.title)
    this.contentEl.createEl('time', { cls: 'taskchute-comment-entry-modal__time', text: formatCommentTime(options.at) })
    const textarea = this.contentEl.createEl('textarea', { cls: 'taskchute-comment-entry-modal__text' })
    textarea.value = options.value ?? ''
    if (options.placeholder) textarea.placeholder = options.placeholder
    textarea.addEventListener('input', () => options.onDraft?.(textarea.value))
    const submit = () => {
      if (options.onSubmit(textarea.value) !== false) this.close()
    }
    if (options.submitOnEnter) {
      textarea.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return
        event.preventDefault()
        submit()
      })
    }

    const buttons: ModalFooterButtonSpec[] = [
      { text: options.cancelText, role: 'cancel', onClick: () => this.close() },
      { text: options.submitText, role: 'primary', onClick: submit },
    ]
    createModalFooter(this.contentEl, buttons)
    window.setTimeout(() => {
      textarea.focus()
      textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    }, 0)
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
