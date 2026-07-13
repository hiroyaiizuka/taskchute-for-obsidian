import { createFileEditorAdapter } from '../../../src/features/ai-task/ui/FileEditorAdapter'

describe('FileEditorAdapter CodeMirror boundary', () => {
  beforeEach(() => document.body.replaceChildren())

  test('mounts a dark line-number editor read-only and supports document/editability updates', () => {
    const container = document.body.createDiv()
    const onChange = jest.fn()
    const onSave = jest.fn()
    const adapter = createFileEditorAdapter()

    adapter.open(container, {
      document: 'first\nsecond',
      editable: false,
      onChange,
      onSave,
    })

    expect(container.querySelector('.cm-editor')).not.toBeNull()
    expect(container.querySelector('.cm-lineNumbers')).not.toBeNull()
    expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe(
      'false',
    )
    expect(adapter.getDocument()).toBe('first\nsecond')

    adapter.setDocument('replacement')
    expect(adapter.getDocument()).toBe('replacement')
    expect(onChange).not.toHaveBeenCalled()

    adapter.setEditable(true)
    expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe(
      'true',
    )
    adapter.focus()
    expect(document.activeElement).toBe(container.querySelector('.cm-content'))
    container.querySelector('.cm-content')?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 's',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(onSave).toHaveBeenCalledTimes(1)

    adapter.dispose()
    adapter.dispose()
    expect(container.querySelector('.cm-editor')).toBeNull()
  })

  test('open is one-shot and pre-open/disposed operations are safe', () => {
    const first = document.body.createDiv()
    const second = document.body.createDiv()
    const adapter = createFileEditorAdapter()

    adapter.setDocument('ignored')
    adapter.setEditable(true)
    adapter.focus()
    expect(adapter.getDocument()).toBe('')

    adapter.open(first, {
      document: 'one',
      editable: false,
      onChange: jest.fn(),
      onSave: jest.fn(),
    })
    adapter.open(second, {
      document: 'two',
      editable: true,
      onChange: jest.fn(),
      onSave: jest.fn(),
    })
    expect(adapter.getDocument()).toBe('one')
    expect(first.querySelector('.cm-editor')).not.toBeNull()
    expect(second.querySelector('.cm-editor')).toBeNull()

    adapter.dispose()
    adapter.open(second, {
      document: 'after dispose',
      editable: true,
      onChange: jest.fn(),
      onSave: jest.fn(),
    })
    expect(second.querySelector('.cm-editor')).toBeNull()
  })
})
