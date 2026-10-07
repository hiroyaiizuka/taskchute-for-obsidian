import { Notice } from 'obsidian'

/** A notice with an undo button; the button runs `undo` once and hides the notice. */
export function showUndoNotice(message: string, undoLabel: string, undo: () => void, duration = 6000): Notice {
  const wrapper = createSpan({ cls: 'taskchute-undo-notice' })
  const fragment = createFragment((f) => f.appendChild(wrapper))
  wrapper.createSpan({ text: message })
  const button = wrapper.createEl('button', { cls: 'taskchute-undo-notice__button', text: undoLabel })
  const notice = new Notice(fragment, duration)
  let done = false
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    if (done) return
    done = true
    undo()
    notice.hide()
  })
  return notice
}
