import { Notice } from 'obsidian'
import TimeEditPopup from '../../../src/ui/time/TimeEditPopup'
import type { TimeEditPopupOptions } from '../../../src/ui/time/TimeEditPopup'

jest.mock('obsidian', () => ({
  Notice: jest.fn(),
}))

const createAnchor = (): HTMLElement => {
  const anchor = document.createElement('div')
  anchor.getBoundingClientRect = () =>
    ({
      left: 0,
      bottom: 0,
      right: 0,
      top: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => '',
    }) as DOMRect
  return anchor
}

describe('TimeEditPopup', () => {
  beforeEach(() => {
    ;(Notice as unknown as jest.Mock).mockClear()
    document.body.innerHTML = ''
  })

  test('blocks future time when validation date is today', () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2025-10-09T10:00:00Z'))

    try {
      const popup = new TimeEditPopup()
      const onSave = jest.fn()
      const options: TimeEditPopupOptions = {
        anchor: createAnchor(),
        currentValue: '',
        viewDate: new Date('2025-10-09T00:00:00Z'),
        onSave,
        onCancel: jest.fn(),
      }

      popup.show(options)

      const input = document.querySelector('.taskchute-time-popup-input') as HTMLInputElement

      input.value = '23:00'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))

      expect(onSave).not.toHaveBeenCalled()
      expect(Notice).toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  test('allows future-looking time when validation date is not today', () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2025-10-09T10:00:00Z'))

    try {
      const popup = new TimeEditPopup()
      const onSave = jest.fn()
      const options: TimeEditPopupOptions & { validationDate: Date } = {
        anchor: createAnchor(),
        currentValue: '',
        viewDate: new Date('2025-10-09T00:00:00Z'),
        validationDate: new Date('2025-10-08T00:00:00Z'),
        onSave,
        onCancel: jest.fn(),
      }

      popup.show(options)

      const input = document.querySelector('.taskchute-time-popup-input') as HTMLInputElement

      input.value = '23:00'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))

      expect(onSave).toHaveBeenCalledWith('23:00')
      expect(Notice).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })
})
