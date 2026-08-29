import {
  ElectronDirectoryPicker,
  type ElectronModuleLoader,
} from '../../../src/features/ai-task/services/ElectronDirectoryPicker'

interface DialogHarness {
  picker: ElectronDirectoryPicker
  loader: jest.MockedFunction<ElectronModuleLoader>
  showOpenDialog: jest.Mock
  getPath: jest.Mock
}

function createHarness(options: {
  result?: unknown
  packageAvailable?: boolean
  electronRemoteAvailable?: boolean
} = {}): DialogHarness {
  const showOpenDialog = jest.fn().mockResolvedValue(
    Object.prototype.hasOwnProperty.call(options, 'result')
      ? options.result
      : { canceled: false, filePaths: ['/Users/me/project'] },
  )
  const getPath = jest.fn(() => '/Users/me')
  const remote = {
    app: { getPath },
    dialog: { showOpenDialog },
  }
  const packageAvailable = options.packageAvailable ?? true
  const electronRemoteAvailable = options.electronRemoteAvailable ?? true
  const loader = jest.fn((moduleId: string): unknown => {
    if (moduleId === '@electron/remote') {
      if (!packageAvailable) throw new Error('module unavailable')
      return remote
    }
    if (moduleId === 'electron') {
      return electronRemoteAvailable ? { remote } : {}
    }
    throw new Error(`unexpected module: ${moduleId}`)
  })

  return {
    picker: new ElectronDirectoryPicker(loader),
    loader,
    showOpenDialog,
    getPath,
  }
}

describe('ElectronDirectoryPicker', () => {
  test('opens the native directory/create-directory dialog at the requested path', async () => {
    const harness = createHarness()

    await expect(harness.picker.selectDirectory('/Users/me/current')).resolves.toBe(
      '/Users/me/project',
    )
    expect(harness.showOpenDialog).toHaveBeenCalledWith({
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: '/Users/me/current',
      title: 'Select working directory',
    })
    expect(harness.getPath).not.toHaveBeenCalled()
  })

  test('uses the Electron home directory when no usable default path is provided', async () => {
    const harness = createHarness()

    await harness.picker.selectDirectory('   ')

    expect(harness.getPath).toHaveBeenCalledWith('home')
    expect(harness.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: '/Users/me' }),
    )
  })

  test('falls back from @electron/remote to electron.remote', async () => {
    const harness = createHarness({ packageAvailable: false })

    await expect(harness.picker.selectDirectory('/workspace')).resolves.toBe(
      '/Users/me/project',
    )
    expect(harness.loader).toHaveBeenNthCalledWith(1, '@electron/remote')
    expect(harness.loader).toHaveBeenNthCalledWith(2, 'electron')
  })

  test.each([
    [{ canceled: true, filePaths: ['/ignored'] }],
    [{ canceled: false, filePaths: [] }],
    [{ canceled: false, filePaths: [7, '', null] }],
    [null],
  ])('returns null for cancellation or a malformed result %#', async (result) => {
    const harness = createHarness({ result })

    await expect(harness.picker.selectDirectory('/workspace')).resolves.toBeNull()
  })

  test('returns null without throwing when neither remote bridge is available', async () => {
    const harness = createHarness({
      packageAvailable: false,
      electronRemoteAvailable: false,
    })

    await expect(harness.picker.selectDirectory('/workspace')).resolves.toBeNull()
    expect(harness.showOpenDialog).not.toHaveBeenCalled()
  })

  test('contains native-dialog failures and never tries to open a second dialog', async () => {
    const harness = createHarness()
    harness.showOpenDialog.mockRejectedValueOnce(new Error('dialog failed'))

    await expect(harness.picker.selectDirectory('/workspace')).resolves.toBeNull()
    expect(harness.showOpenDialog).toHaveBeenCalledTimes(1)
    expect(harness.loader).toHaveBeenCalledTimes(1)
  })
})
