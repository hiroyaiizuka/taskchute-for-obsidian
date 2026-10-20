import { App, Modal } from 'obsidian'
import { showConfirmModal } from '@/ui/modals/ConfirmModal'

jest.mock('obsidian', () => {
  class MockApp {}
  class Modal {
    app: MockApp
    modalEl: HTMLElement
    contentEl: HTMLElement

    constructor(app: MockApp) {
      this.app = app
      this.modalEl = document.createElement('div')
      this.contentEl = document.createElement('div')
      this.modalEl.appendChild(this.contentEl)
    }

    open(): void {
      document.body.appendChild(this.modalEl)
      const maybeOnOpen = (this as unknown as { onOpen?: () => void }).onOpen
      if (typeof maybeOnOpen === 'function') {
        maybeOnOpen.call(this)
      }
    }

    close(): void {
      const maybeOnClose = (this as unknown as { onClose?: () => void }).onClose
      if (typeof maybeOnClose === 'function') {
        maybeOnClose.call(this)
      }
      if (this.modalEl.parentElement) {
        this.modalEl.parentElement.removeChild(this.modalEl)
      }
    }
  }

  return {
    App: MockApp,
    Modal,
    Notice: jest.fn(),
  }
})

describe('ConfirmModal', () => {
  test('resolves true on confirm click', async () => {
    const promise = showConfirmModal(new App(), {
      title: 'Delete task',
      message: 'Delete "Sample"?',
      confirmText: 'Delete',
      cancelText: 'Cancel',
      destructive: true,
    })

    const confirmButton = document.querySelector('.taskchute-confirm-modal .form-button.danger')
    expect(confirmButton).toBeTruthy()
    confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await expect(promise).resolves.toBe(true)
    expect(document.querySelector('.taskchute-confirm-modal')).toBeNull()
  })

  test('resolves false on cancel click', async () => {
    const promise = showConfirmModal(new App(), {
      title: 'Delete task',
      message: 'Delete "Sample"?',
      confirmText: 'Delete',
      cancelText: 'Cancel',
    })

    const cancelButton = document.querySelector('.taskchute-confirm-modal .form-button.cancel')
    expect(cancelButton).toBeTruthy()
    cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await expect(promise).resolves.toBe(false)
  })

  test('resolves false when it closes without a button, as Escape does', async () => {
    const open = jest.spyOn(Modal.prototype, 'open')
    const promise = showConfirmModal(new App(), {
      title: 'Close "AI Weekly Journal"?',
      message: "This closes all 2 of the task's tabs.",
      confirmText: 'Close all',
      cancelText: 'Cancel',
      destructive: true,
    })
    const opened = open.mock.contexts[0] as Modal
    open.mockRestore()

    opened.close()

    await expect(promise).resolves.toBe(false)
    expect(document.querySelector('.taskchute-confirm-modal')).toBeNull()
  })
})
