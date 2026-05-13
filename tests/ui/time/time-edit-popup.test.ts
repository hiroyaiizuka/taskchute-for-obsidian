import { Notice } from 'obsidian'
import TimeEditPopup from '../../../src/ui/time/TimeEditPopup'
import type { TimeEditPopupOptions } from '../../../src/ui/time/TimeEditPopup'

jest.mock('obsidian', () => ({
  Notice: jest.fn(),
}))

const setActiveDocument = (doc: Document): void => {
  ;(globalThis as typeof globalThis & { activeDocument: Document }).activeDocument = doc
}

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

  test('removes outside listeners from the document that registered them when reopened elsewhere', () => {
    const originalActiveDocument = activeDocument
    const sourceDoc = document.implementation.createHTMLDocument('source')
    const focusedDoc = document.implementation.createHTMLDocument('focused')
    const sourceAdd = jest.spyOn(sourceDoc, 'addEventListener')
    const sourceRemove = jest.spyOn(sourceDoc, 'removeEventListener')
    const focusedRemove = jest.spyOn(focusedDoc, 'removeEventListener')
    const popup = new TimeEditPopup()
    const sourceAnchor = sourceDoc.createElement('div')
    sourceAnchor.getBoundingClientRect = createAnchor().getBoundingClientRect
    sourceDoc.body.appendChild(sourceAnchor)
    const focusedAnchor = focusedDoc.createElement('div')
    focusedAnchor.getBoundingClientRect = createAnchor().getBoundingClientRect
    focusedDoc.body.appendChild(focusedAnchor)

    try {
      setActiveDocument(sourceDoc)
      popup.show({
        anchor: sourceAnchor,
        currentValue: '',
        viewDate: new Date('2025-10-09T00:00:00Z'),
        onSave: jest.fn(),
        onCancel: jest.fn(),
      })

      expect(sourceAdd).toHaveBeenCalledWith('click', expect.any(Function), true)
      expect(sourceAdd).toHaveBeenCalledWith('touchend', expect.any(Function), true)

      setActiveDocument(focusedDoc)
      popup.show({
        anchor: focusedAnchor,
        currentValue: '',
        viewDate: new Date('2025-10-09T00:00:00Z'),
        onSave: jest.fn(),
        onCancel: jest.fn(),
      })

      expect(sourceRemove).toHaveBeenCalledWith('click', expect.any(Function), true)
      expect(sourceRemove).toHaveBeenCalledWith('touchend', expect.any(Function), true)
      expect(focusedRemove).not.toHaveBeenCalledWith('click', expect.any(Function), true)
      expect(focusedRemove).not.toHaveBeenCalledWith('touchend', expect.any(Function), true)
    } finally {
      popup.close()
      setActiveDocument(originalActiveDocument)
      sourceAdd.mockRestore()
      sourceRemove.mockRestore()
      focusedRemove.mockRestore()
    }
  })
})
