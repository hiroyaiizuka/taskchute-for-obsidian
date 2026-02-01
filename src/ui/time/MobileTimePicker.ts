import { Notice } from 'obsidian'
import type { TimePicker, TimePickerOptions } from './TimePickerFactory'

/**
 * Mobile-optimized time picker with drum roller UI
 * Slides up from the bottom of the screen
 */
export class MobileTimePicker implements TimePicker {
  private overlayEl: HTMLDivElement | null = null
  private containerEl: HTMLDivElement | null = null
  private options: TimePickerOptions | null = null

  private hourWheel: HTMLDivElement | null = null
  private minuteWheel: HTMLDivElement | null = null

  private selectedHour = 0
  private selectedMinute = 0

  // Prevent closing until picker is fully ready
  private isReady = false

  show(options: TimePickerOptions): void {
    this.close()
    this.options = options
    this.isReady = false

    // Parse current value
    if (options.currentValue) {
      const [h, m] = options.currentValue.split(':').map((n) => parseInt(n, 10))
      this.selectedHour = isNaN(h) ? 0 : h
      this.selectedMinute = isNaN(m) ? 0 : m
    } else {
      // Default to current time
      const now = new Date()
      this.selectedHour = now.getHours()
      this.selectedMinute = now.getMinutes()
    }

    // Create overlay
    this.overlayEl = document.createElement('div')
    this.overlayEl.classList.add('taskchute-mobile-time-picker-overlay')

    // Create container
    this.containerEl = document.createElement('div')
    this.containerEl.classList.add('taskchute-mobile-time-picker')

    // Prevent any events on the container from bubbling up
    this.containerEl.addEventListener('click', (e) => e.stopPropagation())
    this.containerEl.addEventListener('touchstart', (e) => e.stopPropagation())
    this.containerEl.addEventListener('touchend', (e) => e.stopPropagation())

    // Header
    const header = document.createElement('div')
    header.classList.add('taskchute-mobile-time-picker-header')
    header.textContent = options.tv
      ? options.tv('forms.selectTime', '時刻を選択')
      : '時刻を選択'
    this.containerEl.appendChild(header)

    // Wheels container
    const wheelsContainer = document.createElement('div')
    wheelsContainer.classList.add('taskchute-mobile-time-picker-wheels')

    // Hour wheel
    const hourSection = document.createElement('div')
    hourSection.classList.add('taskchute-mobile-time-picker-section')

    this.hourWheel = this.createWheel(24, this.selectedHour, (value) => {
      this.selectedHour = value
    })
    hourSection.appendChild(this.hourWheel)

    const hourLabel = document.createElement('div')
    hourLabel.classList.add('taskchute-mobile-time-picker-label')
    hourLabel.textContent = options.tv ? options.tv('forms.hour', '時') : '時'
    hourSection.appendChild(hourLabel)

    wheelsContainer.appendChild(hourSection)

    // Separator
    const separator = document.createElement('div')
    separator.classList.add('taskchute-mobile-time-picker-separator')
    separator.textContent = ':'
    wheelsContainer.appendChild(separator)

    // Minute wheel
    const minuteSection = document.createElement('div')
    minuteSection.classList.add('taskchute-mobile-time-picker-section')

    this.minuteWheel = this.createWheel(60, this.selectedMinute, (value) => {
      this.selectedMinute = value
    })
    minuteSection.appendChild(this.minuteWheel)

    const minuteLabel = document.createElement('div')
    minuteLabel.classList.add('taskchute-mobile-time-picker-label')
    minuteLabel.textContent = options.tv ? options.tv('forms.minute', '分') : '分'
    minuteSection.appendChild(minuteLabel)

    wheelsContainer.appendChild(minuteSection)

    this.containerEl.appendChild(wheelsContainer)

    // Highlight bar (centered selection indicator)
    const highlightBar = document.createElement('div')
    highlightBar.classList.add('taskchute-mobile-time-picker-highlight')
    wheelsContainer.appendChild(highlightBar)

    // Buttons
    const buttonsContainer = document.createElement('div')
    buttonsContainer.classList.add('taskchute-mobile-time-picker-buttons')

    // Reset button
    const resetBtn = document.createElement('button')
    resetBtn.type = 'button'
    resetBtn.classList.add(
      'taskchute-mobile-time-picker-btn',
      'taskchute-mobile-time-picker-btn-reset',
    )
    resetBtn.textContent = '↺'
    resetBtn.setAttribute('aria-label', 'Reset')
    resetBtn.addEventListener('click', this.handleReset)
    buttonsContainer.appendChild(resetBtn)

    // Cancel button
    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.classList.add(
      'taskchute-mobile-time-picker-btn',
      'taskchute-mobile-time-picker-btn-cancel',
    )
    cancelBtn.textContent = options.tv
      ? options.tv('forms.cancel', 'キャンセル')
      : 'キャンセル'
    cancelBtn.addEventListener('click', this.handleCancel)
    buttonsContainer.appendChild(cancelBtn)

    // Save button
    const saveBtn = document.createElement('button')
    saveBtn.type = 'button'
    saveBtn.classList.add(
      'taskchute-mobile-time-picker-btn',
      'taskchute-mobile-time-picker-btn-save',
    )
    saveBtn.textContent = options.tv ? options.tv('forms.save', '保存') : '保存'
    saveBtn.addEventListener('click', this.handleSave)
    buttonsContainer.appendChild(saveBtn)

    this.containerEl.appendChild(buttonsContainer)

    // Append to DOM
    document.body.appendChild(this.overlayEl)
    document.body.appendChild(this.containerEl)

    // Trigger animation
    requestAnimationFrame(() => {
      this.overlayEl?.classList.add('taskchute-mobile-time-picker-overlay-visible')
      this.containerEl?.classList.add('taskchute-mobile-time-picker-visible')
    })

    // Scroll to initial values after render
    requestAnimationFrame(() => {
      this.scrollToValue(this.hourWheel, this.selectedHour)
      this.scrollToValue(this.minuteWheel, this.selectedMinute)
    })

    // Mark as ready and add overlay click listener after a delay
    // This prevents the same tap that opened the picker from closing it
    setTimeout(() => {
      this.isReady = true
      this.overlayEl?.addEventListener('click', this.handleOverlayClick)
      this.overlayEl?.addEventListener('touchend', this.handleOverlayClick)
    }, 500)
  }

  close(): void {
    if (this.overlayEl) {
      this.overlayEl.classList.remove('taskchute-mobile-time-picker-overlay-visible')
      this.overlayEl.removeEventListener('click', this.handleOverlayClick)
      this.overlayEl.removeEventListener('touchend', this.handleOverlayClick)
    }
    if (this.containerEl) {
      this.containerEl.classList.remove('taskchute-mobile-time-picker-visible')
    }

    // Remove after animation
    const overlayToRemove = this.overlayEl
    const containerToRemove = this.containerEl

    this.overlayEl = null
    this.containerEl = null
    this.hourWheel = null
    this.minuteWheel = null
    this.options = null
    this.isReady = false

    setTimeout(() => {
      overlayToRemove?.remove()
      containerToRemove?.remove()
    }, 300)
  }

  private createWheel(
    count: number,
    initialValue: number,
    onChange: (value: number) => void,
  ): HTMLDivElement {
    const wheel = document.createElement('div')
    wheel.classList.add('taskchute-time-wheel')

    // Add padding items at top and bottom for proper centering
    const paddingTop = document.createElement('div')
    paddingTop.classList.add('taskchute-time-wheel-padding')
    wheel.appendChild(paddingTop)

    for (let i = 0; i < count; i++) {
      const item = document.createElement('div')
      item.classList.add('taskchute-time-wheel-item')
      item.textContent = String(i).padStart(2, '0')
      item.dataset.value = String(i)
      wheel.appendChild(item)
    }

    const paddingBottom = document.createElement('div')
    paddingBottom.classList.add('taskchute-time-wheel-padding')
    wheel.appendChild(paddingBottom)

    // Handle scroll end to snap to nearest value
    let scrollTimeout: ReturnType<typeof setTimeout> | null = null
    wheel.addEventListener('scroll', () => {
      if (scrollTimeout) clearTimeout(scrollTimeout)
      scrollTimeout = setTimeout(() => {
        const value = this.getSelectedValue(wheel)
        if (value !== null) {
          onChange(value)
          this.scrollToValue(wheel, value)
        }
      }, 100)
    })

    return wheel
  }

  private scrollToValue(wheel: HTMLDivElement | null, value: number): void {
    if (!wheel) return

    const itemHeight = 44 // Match CSS item height
    const scrollTop = value * itemHeight
    wheel.scrollTo({
      top: scrollTop,
      behavior: 'smooth',
    })
  }

  private getSelectedValue(wheel: HTMLDivElement): number | null {
    const itemHeight = 44
    const scrollTop = wheel.scrollTop
    const index = Math.round(scrollTop / itemHeight)
    return Math.max(0, index)
  }

  /**
   * Sync the selected values from current wheel scroll positions.
   * This ensures we capture the latest values even if the scroll debounce hasn't fired yet.
   */
  private syncWheelValues(): void {
    if (this.hourWheel) {
      const hourValue = this.getSelectedValue(this.hourWheel)
      if (hourValue !== null) {
        this.selectedHour = Math.min(hourValue, 23)
      }
    }
    if (this.minuteWheel) {
      const minuteValue = this.getSelectedValue(this.minuteWheel)
      if (minuteValue !== null) {
        this.selectedMinute = Math.min(minuteValue, 59)
      }
    }
  }

  private handleOverlayClick = (e: MouseEvent | TouchEvent): void => {
    // Ignore if not ready
    if (!this.isReady) {
      e.preventDefault()
      e.stopPropagation()
      return
    }

    const target = e.target as Node
    // Only close if clicking directly on the overlay (not the picker content)
    if (target === this.overlayEl) {
      this.handleCancel()
    }
  }

  private handleSave = (): void => {
    if (!this.options) return

    // Sync current scroll position to get the latest values
    // This ensures we capture the value even if the debounce hasn't fired yet
    this.syncWheelValues()

    // Validate time
    const value = `${String(this.selectedHour).padStart(2, '0')}:${String(this.selectedMinute).padStart(2, '0')}`

    const isSameDay = (a: Date, b: Date): boolean =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()

    const validationBase = this.options.validationDate ?? this.options.viewDate
    const isValidationDateToday = isSameDay(validationBase, new Date())

    if (isValidationDateToday) {
      const now = new Date()
      const nowMinutes = now.getHours() * 60 + now.getMinutes()
      const selectedMinutes = this.selectedHour * 60 + this.selectedMinute
      if (selectedMinutes > nowMinutes) {
        const message = this.options.tv
          ? this.options.tv('forms.timeNotFuture', '未来の時刻は設定できません')
          : '未来の時刻は設定できません'
        new Notice(message)
        return
      }
    }

    this.options.onSave(value)
    this.close()
  }

  private handleCancel = (): void => {
    if (!this.options) return
    this.options.onCancel()
    this.close()
  }

  private handleReset = (): void => {
    if (!this.options) return
    this.options.onSave('')
    this.close()
  }
}
