jest.mock('obsidian')

import { FilePathFieldController } from '../../src/settings/filePathFieldController'

describe('FilePathFieldController', () => {
  const createTextStub = () => {
    let value = ''
    const text = {
      setValue: jest.fn((next: string) => {
        value = next
        return text
      }),
      getValue: jest.fn(() => value),
    }
    return text as unknown as {
      setValue(value: string): unknown
      getValue(): string
    }
  }

  let textStub: ReturnType<typeof createTextStub>
  let storedValue: string | null | undefined

  const reset = () => {
    textStub = createTextStub()
    storedValue = null
  }

  beforeEach(() => {
    reset()
  })

  const createController = (overrides: Partial<ConstructorParameters<typeof FilePathFieldController>[0]> = {}) => {
    const options = {
      text: textStub,
      getStoredValue: () => storedValue,
      setStoredValue: (next: string | null | undefined) => {
        storedValue = next
      },
      saveSettings: jest.fn().mockResolvedValue(undefined),
      validatePath: jest.fn().mockReturnValue({ valid: true }),
      fileExists: jest.fn().mockReturnValue(true),
      makeMissingNotice: (path: string) => `Missing: ${path}`,
      notice: jest.fn(),
      emptyValue: null,
      ...overrides,
    }

    const controller = new FilePathFieldController(options)

    return { controller, ...options }
  }

  test('saves trimmed value on change without touching file check', async () => {
    const { controller, saveSettings, validatePath, fileExists } = createController()

    await controller.handleInputChange('  Foo/Bar.md  ')

    expect(validatePath).toHaveBeenCalledWith('Foo/Bar.md')
    expect(saveSettings).toHaveBeenCalled()
    expect(storedValue).toBe('Foo/Bar.md')
    expect(fileExists).not.toHaveBeenCalled()
  })

  test('invalid path shows notice and keeps previous value', async () => {
    storedValue = 'Existing.md'
    const { controller, saveSettings, validatePath, notice } = createController({
      validatePath: jest.fn(() => ({ valid: false, error: 'Invalid path' })),
    })

    textStub.setValue('Existing.md')

    await controller.handleInputChange('bad//path.md')

    expect(validatePath).toHaveBeenCalledWith('bad//path.md')
    expect(notice).toHaveBeenCalledWith('Invalid path')
    expect(saveSettings).not.toHaveBeenCalled()
    expect(storedValue).toBe('Existing.md')
    expect(textStub.setValue).toHaveBeenCalledWith('Existing.md')
  })

  test('empty value clears stored value using emptyValue sentinel', async () => {
    const { controller, saveSettings } = createController({ emptyValue: undefined })

    await controller.handleInputChange('    ')

    expect(storedValue).toBeUndefined()
    expect(saveSettings).toHaveBeenCalled()
  })

  test('blur warns when file is missing', async () => {
    storedValue = 'Missing.md'
    const notice = jest.fn()
    const { controller, fileExists } = createController({
      fileExists: jest.fn(() => false),
      notice,
    })

    await controller.handleBlur()

    expect(fileExists).toHaveBeenCalledWith('Missing.md')
    expect(notice).toHaveBeenCalledWith('Missing: Missing.md')
  })
})

