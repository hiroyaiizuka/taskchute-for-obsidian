import { Notice } from 'obsidian'
import type { TimePicker, TimePickerOptions } from './TimePickerFactory'

/** @deprecated Use TimePickerOptions from TimePickerFactory instead */
export type TimeEditPopupOptions = TimePickerOptions

export default class TimeEditPopup implements TimePicker {
  private containerEl: HTMLDivElement | null = null
  private removeListeners: (() => void) | null = null

  show(options: TimePickerOptions): void {
    this.close()

    const { anchor, currentValue, viewDate, validationDate, onSave, onCancel } = options

    const container = document.createElement('div')
    container.classList.add('taskchute-time-popup')
    this.containerEl = container

    const input = document.createElement('input')
    input.type = 'time'
    input.value = currentValue
    input.classList.add('taskchute-time-popup-input')
    container.appendChild(input)

    // Save button (✓)
    const saveBtn = document.createElement('button')
    saveBtn.type = 'button'
    saveBtn.classList.add('taskchute-time-popup-btn', 'taskchute-time-popup-btn-save')
    saveBtn.textContent = '✓'
    saveBtn.setAttribute('aria-label', 'Save')
    container.appendChild(saveBtn)

    // Cancel button (✕)
    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.classList.add('taskchute-time-popup-btn', 'taskchute-time-popup-btn-cancel')
    cancelBtn.textContent = '✕'
    cancelBtn.setAttribute('aria-label', 'Cancel')
    container.appendChild(cancelBtn)

    // Reset button (clear time)
    const resetBtn = document.createElement('button')
    resetBtn.type = 'button'
    resetBtn.classList.add('taskchute-time-popup-btn', 'taskchute-time-popup-btn-reset')
    resetBtn.textContent = '↺'
    resetBtn.setAttribute('aria-label', 'Reset')
    container.appendChild(resetBtn)

    // Position below anchor
    document.body.appendChild(container)
    const rect = anchor.getBoundingClientRect()
    container.style.setProperty('--time-popup-left', `${rect.left}px`)
    container.style.setProperty('--time-popup-top', `${rect.bottom + 4}px`)

    // Validation helper
    const isSameDay = (a: Date, b: Date): boolean =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()

    const validationBase = validationDate ?? viewDate
    const isValidationDateToday = isSameDay(validationBase, new Date())

    const toMinutes = (value: string): number => {
      const [hours, minutes] = value.split(':').map((n) => parseInt(n, 10))
      return hours * 60 + minutes
    }

    /**
     * Validate and save the time value.
     * @returns true if save succeeded, false if validation failed
     */
    const handleSave = (): boolean => {
      const val = input.value.trim()
      if (val && isValidationDateToday) {
        const now = new Date()
        const nowMinutes = now.getHours() * 60 + now.getMinutes()
        if (toMinutes(val) > nowMinutes) {
          const message = options.tv
            ? options.tv('forms.timeNotFuture', 'Time cannot be in the future')
            : 'Time cannot be in the future'
          new Notice(message)
          return false // Validation failed
        }
      }
      onSave(val)
      this.close()
      return true // Save succeeded
    }

    // Guard to prevent duplicate saves from multiple triggers
    let committed = false
    const commitOnce = () => {
      if (committed) return
      // Only mark as committed if save actually succeeded
      // This allows retry after validation failure
      if (handleSave()) {
        committed = true
      }
    }

    // Keyboard shortcuts (desktop)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        commitOnce()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        handleCancel()
      }
    })

    // Button handlers
    const handleCancel = () => {
      onCancel()
      this.close()
    }

    // Helper to force close iOS native picker
    const closeNativePicker = () => {
      const originalType = input.type
      input.type = 'text'
      input.blur()
      input.type = originalType
    }

    saveBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      closeNativePicker()
      commitOnce()
    })

    cancelBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      closeNativePicker()
      handleCancel()
    })

    resetBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      closeNativePicker()
      // Clear the time value and save directly (bypass commitOnce guard)
      onSave('')
      this.close()
    })

    // Click-away behavior differs by device type:
    // - Desktop (pointer: fine): click outside = save (traditional behavior)
    // - Touch/Mobile (pointer: coarse): click outside = cancel (explicit save button required)
    const isPointerFine = window.matchMedia?.('(pointer: fine)').matches ?? true

    // Record open time to ignore events from the same interaction that opened the popup
    const openTime = Date.now()
    const DEBOUNCE_MS = 150 // Ignore events within 150ms of opening

    const handleOutsideInteraction = (e: MouseEvent | TouchEvent) => {
      // Ignore events that happen too soon after opening (same interaction)
      if (Date.now() - openTime < DEBOUNCE_MS) return

      const target = e.target as Node
      if (this.containerEl && !this.containerEl.contains(target)) {
        if (isPointerFine) {
          // Desktop: click outside = save (traditional behavior)
          commitOnce()
        } else {
          // Touch/Mobile: click outside = cancel (user must explicitly click save button)
          handleCancel()
        }
      }
    }

    // Register both click and touchend for better mobile support
    document.addEventListener('click', handleOutsideInteraction, true)
    document.addEventListener('touchend', handleOutsideInteraction, true)

    this.removeListeners = () => {
      document.removeEventListener('click', handleOutsideInteraction, true)
      document.removeEventListener('touchend', handleOutsideInteraction, true)
    }

    input.focus()
  }

  close(): void {
    if (this.removeListeners) {
      this.removeListeners()
      this.removeListeners = null
    }
    if (this.containerEl) {
      this.containerEl.remove()
      this.containerEl = null
    }
  }
}
