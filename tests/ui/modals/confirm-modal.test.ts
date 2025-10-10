import { App } from 'obsidian'
import { showConfirmModal } from '../../../src/ui/modals/ConfirmModal'

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

    const confirmButton = document.querySelector('.taskchute-confirm-modal .taskchute-confirm-actions button.mod-cta')
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

    const cancelButton = document.querySelector('.taskchute-confirm-modal .taskchute-confirm-actions button.mod-cancel')
    expect(cancelButton).toBeTruthy()
    cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await expect(promise).resolves.toBe(false)
  })
})
