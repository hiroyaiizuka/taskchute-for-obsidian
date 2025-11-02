jest.mock('obsidian')

import { FolderPathFieldController } from '../../src/settings/folderPathFieldController'

describe('FolderPathFieldController', () => {
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

  const createController = (overrides: Partial<ConstructorParameters<typeof FolderPathFieldController>[0]> = {}) => {
    const options = {
      text: textStub,
      getStoredValue: () => storedValue,
      setStoredValue: (next) => {
        storedValue = next
      },
      saveSettings: jest.fn().mockResolvedValue(undefined),
      validatePath: jest.fn().mockReturnValue({ valid: true }),
      folderExists: jest.fn().mockReturnValue(true),
      makeMissingNotice: (path) => `Missing: ${path}`,
      emptyValue: undefined,
      notice: jest.fn(),
      ...overrides,
    }

    const controller = new FolderPathFieldController(options)

    return { controller, ...options }
  }

  test('saves trimmed value on change without creating folders', async () => {
    const { controller, saveSettings, validatePath, folderExists } = createController()

    await controller.handleInputChange('  AAA  ')

    expect(validatePath).toHaveBeenCalledWith('AAA')
    expect(saveSettings).toHaveBeenCalled()
    expect(storedValue).toBe('AAA')
    expect(folderExists).not.toHaveBeenCalled()
  })

  test('invalid path shows notice and keeps previous value', async () => {
    storedValue = 'Existing'
    const { controller, saveSettings, validatePath, notice } = createController({
      validatePath: jest.fn(() => ({ valid: false, error: 'Invalid path' })),
    })

    textStub.setValue('Existing')

    await controller.handleInputChange('bad//')

    expect(validatePath).toHaveBeenCalledWith('bad//')
    expect(notice).toHaveBeenCalledWith('Invalid path')
    expect(saveSettings).not.toHaveBeenCalled()
    expect(storedValue).toBe('Existing')
    expect(textStub.setValue).toHaveBeenCalledWith('Existing')
  })

  test('empty value clears stored value using emptyValue sentinel', async () => {
    const { controller, saveSettings } = createController({ emptyValue: null })

    await controller.handleInputChange('   ')

    expect(storedValue).toBeNull()
    expect(saveSettings).toHaveBeenCalled()
  })

  test('blur warns when folder is missing', async () => {
    storedValue = 'Missing'
    const notice = jest.fn()
    const { controller, folderExists } = createController({
      folderExists: jest.fn(() => false),
      notice,
    })

    await controller.handleBlur()

    expect(folderExists).toHaveBeenCalledWith('Missing')
    expect(notice).toHaveBeenCalledWith('Missing: Missing')
  })
})
