import { Platform } from 'obsidian'
import TimeEditPopup from './TimeEditPopup'
import { MobileTimePicker } from './MobileTimePicker'

/**
 * Common options for time pickers
 */
export interface TimePickerOptions {
  anchor: HTMLElement
  currentValue: string
  viewDate: Date
  validationDate?: Date
  tv?: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  onSave: (value: string) => void
  onCancel: () => void
}

/**
 * Common interface for time pickers (desktop and mobile)
 */
export interface TimePicker {
  show(options: TimePickerOptions): void
  close(): void
}

/**
 * Determines if the current platform is mobile
 */
export function isMobilePlatform(): boolean {
  return Platform?.isMobile ?? false
}

/**
 * Factory function to create the appropriate time picker based on platform
 */
export function createTimePicker(): TimePicker {
  if (isMobilePlatform()) {
    return new MobileTimePicker()
  } else {
    return new TimeEditPopup()
  }
}
