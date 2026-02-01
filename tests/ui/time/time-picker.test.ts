/**
 * @jest-environment jsdom
 */

import { describe, it, expect, beforeEach, jest, afterEach } from '@jest/globals'

// Mock obsidian module
jest.mock('obsidian', () => ({
  Notice: jest.fn(),
  Platform: {
    isMobile: false,
  },
}))

import TimeEditPopup from '../../../src/ui/time/TimeEditPopup'
import { MobileTimePicker } from '../../../src/ui/time/MobileTimePicker'

describe('TimeEditPopup', () => {
  let popup: TimeEditPopup
  let anchor: HTMLElement
  let onSave: jest.Mock
  let onCancel: jest.Mock

  beforeEach(() => {
    // Clean up any leftover popup elements
    document.querySelectorAll('.taskchute-time-popup').forEach((el) => el.remove())

    popup = new TimeEditPopup()
    anchor = document.createElement('span')
    anchor.getBoundingClientRect = jest.fn().mockReturnValue({
      left: 100,
      bottom: 50,
    })
    document.body.appendChild(anchor)

    onSave = jest.fn()
    onCancel = jest.fn()
  })

  afterEach(() => {
    popup.close()
    document.querySelectorAll('.taskchute-time-popup').forEach((el) => el.remove())
    anchor.remove()
    jest.clearAllMocks()
  })

  describe('desktop behavior (non-touch)', () => {
    beforeEach(() => {
      // Mock matchMedia for pointer: fine (desktop)
      window.matchMedia = jest.fn().mockImplementation((query) => ({
        matches: query === '(pointer: fine)',
        media: query,
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
      }))
    })

    it('should save on outside click for desktop (pointer: fine)', async () => {
      const pastDate = new Date()
      pastDate.setDate(pastDate.getDate() - 1) // yesterday

      popup.show({
        anchor,
        currentValue: '10:30',
        viewDate: pastDate,
        onSave,
        onCancel,
      })

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 200))

      // Simulate outside click
      const outsideClick = new MouseEvent('click', { bubbles: true })
      document.body.dispatchEvent(outsideClick)

      expect(onSave).toHaveBeenCalledWith('10:30')
      expect(onCancel).not.toHaveBeenCalled()
    })

    it('should NOT trigger on immediate outside click (debounce)', () => {
      const pastDate = new Date()
      pastDate.setDate(pastDate.getDate() - 1)

      popup.show({
        anchor,
        currentValue: '10:30',
        viewDate: pastDate,
        onSave,
        onCancel,
      })

      // Immediate outside click (should be ignored due to debounce)
      const outsideClick = new MouseEvent('click', { bubbles: true })
      document.body.dispatchEvent(outsideClick)

      expect(onSave).not.toHaveBeenCalled()
      expect(onCancel).not.toHaveBeenCalled()
    })

    it('should allow retry after validation failure', async () => {
      // Use today's date so validation applies
      const today = new Date()

      popup.show({
        anchor,
        currentValue: '10:30',
        viewDate: today,
        onSave,
        onCancel,
      })

      // Get the input and set a future time
      const input = document.querySelector('.taskchute-time-popup-input') as HTMLInputElement
      expect(input).not.toBeNull()

      // Set future time (23:59 should always be future during test hours)
      input.value = '23:59'

      // Try to save with Enter key - should fail validation
      const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      input.dispatchEvent(enterEvent)

      // onSave should NOT have been called due to validation failure
      expect(onSave).not.toHaveBeenCalled()

      // Now change to a valid past time
      const now = new Date()
      const pastHour = Math.max(0, now.getHours() - 1)
      input.value = `${String(pastHour).padStart(2, '0')}:00`

      // Try to save again - should succeed
      const enterEvent2 = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      input.dispatchEvent(enterEvent2)

      // Now onSave should have been called
      expect(onSave).toHaveBeenCalledWith(`${String(pastHour).padStart(2, '0')}:00`)
    })
  })

  describe('touch/mobile behavior', () => {
    beforeEach(() => {
      // Mock matchMedia for pointer: coarse (touch/mobile)
      window.matchMedia = jest.fn().mockImplementation((query) => ({
        matches: query === '(pointer: coarse)',
        media: query,
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
      }))
    })

    it('should cancel on outside click for touch devices (pointer: coarse)', async () => {
      const pastDate = new Date()
      pastDate.setDate(pastDate.getDate() - 1)

      popup.show({
        anchor,
        currentValue: '10:30',
        viewDate: pastDate,
        onSave,
        onCancel,
      })

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 200))

      // Simulate outside click
      const outsideClick = new MouseEvent('click', { bubbles: true })
      document.body.dispatchEvent(outsideClick)

      expect(onCancel).toHaveBeenCalled()
      expect(onSave).not.toHaveBeenCalled()
    })
  })
})

describe('MobileTimePicker', () => {
  let picker: MobileTimePicker
  let anchor: HTMLElement
  let onSave: jest.Mock
  let onCancel: jest.Mock

  beforeEach(() => {
    // Clean up any leftover picker elements from previous tests
    document.querySelectorAll('.taskchute-mobile-time-picker').forEach((el) => el.remove())
    document.querySelectorAll('.taskchute-mobile-time-picker-overlay').forEach((el) => el.remove())

    picker = new MobileTimePicker()
    anchor = document.createElement('span')
    document.body.appendChild(anchor)

    onSave = jest.fn()
    onCancel = jest.fn()
  })

  afterEach(() => {
    picker.close()
    // Immediately remove DOM elements to avoid timing issues
    document.querySelectorAll('.taskchute-mobile-time-picker').forEach((el) => el.remove())
    document.querySelectorAll('.taskchute-mobile-time-picker-overlay').forEach((el) => el.remove())
    anchor.remove()
    jest.clearAllMocks()
  })

  describe('save with current scroll position', () => {
    it('should read current wheel scroll position on save, not cached value', async () => {
      const pastDate = new Date()
      pastDate.setDate(pastDate.getDate() - 1)

      picker.show({
        anchor,
        currentValue: '10:30',
        viewDate: pastDate,
        onSave,
        onCancel,
      })

      // Get the picker's container and wheels
      const container = document.querySelector('.taskchute-mobile-time-picker')
      expect(container).not.toBeNull()
      const wheels = container!.querySelectorAll('.taskchute-time-wheel')
      expect(wheels.length).toBe(2)
      const hourWheel = wheels[0] as HTMLDivElement
      const minuteWheel = wheels[1] as HTMLDivElement

      // Simulate scrolling to hour 14 and minute 45 (itemHeight = 44)
      // Use scrollTop directly as jsdom allows this
      hourWheel.scrollTop = 14 * 44
      minuteWheel.scrollTop = 45 * 44

      // Click save button immediately (before debounce fires)
      const saveBtn = document.querySelector('.taskchute-mobile-time-picker-btn-save') as HTMLButtonElement
      expect(saveBtn).not.toBeNull()
      saveBtn.click()

      // Should save the current scroll position values, not the cached ones
      expect(onSave).toHaveBeenCalledWith('14:45')
    })

    it('should handle scroll position at boundaries correctly', async () => {
      // Create a fresh picker for this test
      const freshPicker = new MobileTimePicker()
      const freshAnchor = document.createElement('span')
      document.body.appendChild(freshAnchor)
      const freshOnSave = jest.fn()
      const freshOnCancel = jest.fn()

      const pastDate = new Date()
      pastDate.setDate(pastDate.getDate() - 1)

      freshPicker.show({
        anchor: freshAnchor,
        currentValue: '00:00',
        viewDate: pastDate,
        onSave: freshOnSave,
        onCancel: freshOnCancel,
      })

      // Get the picker's own wheels (use the container to scope the query)
      const container = document.querySelector('.taskchute-mobile-time-picker')
      expect(container).not.toBeNull()
      const wheels = container!.querySelectorAll('.taskchute-time-wheel')
      expect(wheels.length).toBe(2)
      const hourWheel = wheels[0] as HTMLDivElement
      const minuteWheel = wheels[1] as HTMLDivElement

      // Scroll to 23:59 (itemHeight = 44)
      hourWheel.scrollTop = 23 * 44
      minuteWheel.scrollTop = 59 * 44

      const saveBtn = container!.querySelector('.taskchute-mobile-time-picker-btn-save') as HTMLButtonElement
      expect(saveBtn).not.toBeNull()
      saveBtn.click()

      expect(freshOnSave).toHaveBeenCalledWith('23:59')

      // Cleanup
      freshPicker.close()
      freshAnchor.remove()
    })
  })
})
