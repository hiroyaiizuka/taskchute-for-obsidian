import { Notice, Setting, mockApp } from 'obsidian'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { TaskChuteSettingTab } from '../../../src/settings/SettingsTab'
import { createAiTaskManager } from '../../../src/features/ai-task'
import { createFakeLicenseManager } from '../license/fakeLicenseManager'

jest.mock('../../../src/features/ai-task', () => ({
  createAiTaskManager: jest.fn(),
}))

const selectFileMock = jest.fn<Promise<string | null>, [unknown?]>()
jest.mock(
  '../../../src/features/ai-task/services/ElectronDirectoryPicker',
  () => ({
    ElectronDirectoryPicker: jest.fn(() => ({ selectFile: selectFileMock })),
  }),
)

type ToggleStub = {
  setValue: jest.Mock
  onChange: jest.Mock
  trigger: (value: boolean) => Promise<void>
}

type TextStub = {
  inputEl: HTMLInputElement
  setPlaceholder: jest.Mock
  setValue: jest.Mock
  onChange: jest.Mock
  trigger: (value: string) => Promise<void>
}

type ButtonStub = {
  label: string
  setButtonText: jest.Mock
  onClick: jest.Mock
  trigger: () => Promise<void>
}

type DropdownStub = {
  options: Array<{ value: string; label: string }>
  addOption: jest.Mock
  setValue: jest.Mock
  onChange: jest.Mock
  trigger: (value: string) => Promise<void>
}

type SettingStub = {
  setName: jest.Mock
  setDesc: jest.Mock
  setHeading: jest.Mock
  addToggle: jest.Mock
  addText: jest.Mock
  addButton: jest.Mock
  addDropdown: jest.Mock
  controlEl: HTMLElement
  settingEl: HTMLElement
}

type FakeManager = {
  dispose: jest.Mock
  disposeAndWait: jest.Mock<Promise<void>, []>
  invalidateBinaryCache: jest.Mock
}

// Intersecting the class itself would collapse to `never`: `renderAiTaskSection`
// is private on TaskChuteSettingTab, so it exists in both constituents with
// incompatible declarations. Omit strips the private members and keeps the
// public surface the test actually touches.
type MutableSettingTab = Omit<
  TaskChuteSettingTab,
  'app' | 'plugin' | 'renderAiTaskSection'
> & {
  app: typeof mockApp
  plugin: {
    manifest: { id: string }
    settings: Record<string, unknown>
    saveSettings: jest.Mock<Promise<void>, []>
    aiTaskManager?: FakeManager
    aiTaskManagersPendingDisposal?: Set<FakeManager>
    aiTaskLifecycleActive?: boolean
    aiTaskLifecycleGeneration?: number
    licenseManager?: { isActive: () => boolean }
  }
  renderAiTaskSection: (container: HTMLElement) => void
}

function createToggleStub(): ToggleStub {
  let handler: ((value: boolean) => Promise<void> | void) | null = null
  const toggle: ToggleStub = {
    setValue: jest.fn(() => toggle),
    onChange: jest.fn((cb: (value: boolean) => Promise<void> | void) => {
      handler = cb
      return toggle
    }),
    trigger: async (value: boolean) => {
      await handler?.(value)
    },
  }
  return toggle
}

function createTextStub(): TextStub {
  let handler: ((value: string) => Promise<void> | void) | null = null
  const text: TextStub = {
    inputEl: document.createElement('input'),
    setPlaceholder: jest.fn(() => text),
    setValue: jest.fn(() => text),
    onChange: jest.fn((cb: (value: string) => Promise<void> | void) => {
      handler = cb
      return text
    }),
    trigger: async (value: string) => {
      await handler?.(value)
    },
  }
  return text
}

function createButtonStub(): ButtonStub {
  let handler: (() => Promise<void> | void) | null = null
  const button: ButtonStub = {
    label: '',
    setButtonText: jest.fn((label: string) => {
      button.label = label
      return button
    }),
    onClick: jest.fn((cb: () => Promise<void> | void) => {
      handler = cb
      return button
    }),
    trigger: async () => {
      await handler?.()
    },
  }
  return button
}

function createDropdownStub(): DropdownStub {
  let handler: ((value: string) => Promise<void> | void) | null = null
  const dropdown: DropdownStub = {
    options: [],
    addOption: jest.fn((value: string, label: string) => {
      dropdown.options.push({ value, label })
      return dropdown
    }),
    setValue: jest.fn(() => dropdown),
    onChange: jest.fn((cb: (value: string) => Promise<void> | void) => {
      handler = cb
      return dropdown
    }),
    trigger: async (value: string) => {
      await handler?.(value)
    },
  }
  return dropdown
}

function createFakeManager(): FakeManager {
  const dispose = jest.fn()
  return {
    dispose,
    disposeAndWait: jest.fn(async () => {
      dispose()
    }),
    invalidateBinaryCache: jest.fn(),
  }
}

function createTab(): MutableSettingTab {
  const tab = Object.create(TaskChuteSettingTab.prototype) as MutableSettingTab
  tab.app = {
    ...mockApp,
    plugins: { plugins: {} },
  } as unknown as typeof mockApp
  tab.plugin = {
    manifest: { id: 'taskchute-plus' },
    settings: {},
    saveSettings: jest.fn().mockResolvedValue(undefined),
    aiTaskManagersPendingDisposal: new Set(),
    aiTaskLifecycleActive: true,
    aiTaskLifecycleGeneration: 1,
    // The AI section renders its controls only for an active license.
    licenseManager: createFakeLicenseManager(),
  }
  ;(tab.app as unknown as {
    plugins: { plugins: Record<string, unknown> }
  }).plugins.plugins['taskchute-plus'] = tab.plugin
  return tab
}

describe('TaskChute AI task settings section', () => {
  const SettingMock = Setting as unknown as jest.Mock
  const originalSettingImpl = SettingMock.getMockImplementation()
  const createAiTaskManagerMock = createAiTaskManager as jest.Mock

  let settings: SettingStub[]
  let toggles: ToggleStub[]
  let texts: TextStub[]
  let buttons: ButtonStub[]
  let dropdowns: DropdownStub[]

  beforeEach(() => {
    settings = []
    toggles = []
    texts = []
    buttons = []
    dropdowns = []
    SettingMock.mockImplementation(() => {
      const instance: SettingStub = {
        setName: jest.fn().mockReturnThis(),
        setDesc: jest.fn().mockReturnThis(),
        setHeading: jest.fn().mockReturnThis(),
        addToggle: jest.fn((cb: (toggle: ToggleStub) => void) => {
          const toggle = createToggleStub()
          toggles.push(toggle)
          cb(toggle)
          return instance
        }),
        addText: jest.fn((cb: (text: TextStub) => void) => {
          const text = createTextStub()
          texts.push(text)
          cb(text)
          return instance
        }),
        addButton: jest.fn((cb: (button: ButtonStub) => void) => {
          const button = createButtonStub()
          buttons.push(button)
          cb(button)
          return instance
        }),
        addDropdown: jest.fn((cb: (dropdown: DropdownStub) => void) => {
          const dropdown = createDropdownStub()
          dropdowns.push(dropdown)
          cb(dropdown)
          return instance
        }),
        controlEl: document.createElement('div'),
        settingEl: document.createElement('div'),
      }
      settings.push(instance)
      return instance
    })
  })

  afterEach(() => {
    SettingMock.mockImplementation(originalSettingImpl)
    jest.clearAllMocks()
    mockApp.workspace.getLeavesOfType.mockReturnValue([])
  })

  test('is disabled by default with a 30-day retention', () => {
    expect(DEFAULT_SETTINGS.aiTaskEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.aiTaskLogRetentionDays).toBe(30)
  })

  test('enabling the toggle creates the manager and notifies open views', async () => {
    const manager = createFakeManager()
    createAiTaskManagerMock.mockReturnValue(manager)
    const tab = createTab()
    const view = { onAiTaskSettingsChanged: jest.fn() }
    mockApp.workspace.getLeavesOfType.mockReturnValue([{ view }])

    tab.renderAiTaskSection(document.createElement('div'))
    expect(settings[0]?.setName).toHaveBeenCalledWith('AI task')

    await toggles[0]?.trigger(true)

    expect(tab.plugin.settings.aiTaskEnabled).toBe(true)
    expect(tab.plugin.saveSettings).toHaveBeenCalled()
    expect(createAiTaskManagerMock).toHaveBeenCalledWith(tab.plugin)
    expect(tab.plugin.aiTaskManager).toBe(manager)
    expect(view.onAiTaskSettingsChanged).toHaveBeenCalledTimes(1)
  })

  test('disabling the toggle disposes the manager and notifies open views', async () => {
    const manager = createFakeManager()
    const tab = createTab()
    tab.plugin.settings.aiTaskEnabled = true
    tab.plugin.aiTaskManager = manager
    const view = { onAiTaskSettingsChanged: jest.fn() }
    mockApp.workspace.getLeavesOfType.mockReturnValue([{ view }])

    tab.renderAiTaskSection(document.createElement('div'))
    await toggles[0]?.trigger(false)

    expect(tab.plugin.settings.aiTaskEnabled).toBe(false)
    expect(manager.dispose).toHaveBeenCalledTimes(1)
    expect(manager.disposeAndWait).toHaveBeenCalledTimes(1)
    expect(tab.plugin.aiTaskManager).toBeUndefined()
    expect(view.onAiTaskSettingsChanged).toHaveBeenCalledTimes(1)
  })

  test('re-enabling waits for the previous broker shutdown before creating a manager', async () => {
    let finishShutdown: (() => void) | undefined
    const shutdown = new Promise<void>((resolve) => {
      finishShutdown = resolve
    })
    const oldManager = createFakeManager()
    oldManager.disposeAndWait.mockImplementation(() => shutdown)
    const replacementManager = createFakeManager()
    createAiTaskManagerMock.mockReturnValue(replacementManager)
    const tab = createTab()
    tab.plugin.settings.aiTaskEnabled = true
    tab.plugin.aiTaskManager = oldManager

    tab.renderAiTaskSection(document.createElement('div'))
    await toggles[0]?.trigger(false)
    const enabling = toggles[0]?.trigger(true)
    await Promise.resolve()
    await Promise.resolve()

    expect(tab.plugin.aiTaskManagersPendingDisposal?.has(oldManager)).toBe(true)
    expect(createAiTaskManagerMock).not.toHaveBeenCalled()

    finishShutdown?.()
    await enabling

    expect(createAiTaskManagerMock).toHaveBeenCalledWith(tab.plugin)
    expect(tab.plugin.aiTaskManager).toBe(replacementManager)
    expect(tab.plugin.aiTaskManagersPendingDisposal?.has(oldManager)).toBe(false)
  })

  test('failed prior broker shutdown keeps AI tasks disabled instead of racing a new manager', async () => {
    const oldManager = createFakeManager()
    oldManager.disposeAndWait.mockRejectedValue(new Error('broker still alive'))
    const tab = createTab()
    tab.plugin.settings.aiTaskEnabled = true
    tab.plugin.aiTaskManager = oldManager

    tab.renderAiTaskSection(document.createElement('div'))
    await toggles[0]?.trigger(false)
    await toggles[0]?.trigger(true)

    expect(createAiTaskManagerMock).not.toHaveBeenCalled()
    expect(tab.plugin.aiTaskManager).toBeUndefined()
    expect(tab.plugin.settings.aiTaskEnabled).toBe(false)
    expect(tab.plugin.aiTaskManagersPendingDisposal?.has(oldManager)).toBe(true)
    expect(Notice).toHaveBeenCalledWith(
      'The previous AI runtime could not be stopped safely. AI tasks remain disabled; please try again.',
    )
  })

  test('a toggle save completed by an old plugin instance cannot mutate the adopted manager', async () => {
    let finishSave: (() => void) | undefined
    const tab = createTab()
    tab.plugin.saveSettings.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve
        }),
    )
    tab.renderAiTaskSection(document.createElement('div'))

    const pendingToggle = toggles[0]?.trigger(true)
    await Promise.resolve()
    tab.app = {
      ...mockApp,
      plugins: {
        plugins: {
          'taskchute-plus': { replacement: true },
        },
      },
    } as unknown as typeof mockApp
    finishSave?.()
    await pendingToggle

    expect(tab.plugin.settings.aiTaskEnabled).toBe(true)
    expect(createAiTaskManagerMock).not.toHaveBeenCalled()
    expect(tab.plugin.aiTaskManager).toBeUndefined()
  })

  test('an old disable callback cannot dispose a manager adopted by the replacement plugin', async () => {
    let finishSave: (() => void) | undefined
    const manager = createFakeManager()
    const tab = createTab()
    tab.plugin.settings.aiTaskEnabled = true
    tab.plugin.aiTaskManager = manager
    tab.plugin.saveSettings.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve
        }),
    )
    tab.renderAiTaskSection(document.createElement('div'))

    const pendingToggle = toggles[0]?.trigger(false)
    await Promise.resolve()
    const replacement = { aiTaskManager: manager }
    ;(tab.app as unknown as {
      plugins: { plugins: Record<string, unknown> }
    }).plugins.plugins['taskchute-plus'] = replacement
    finishSave?.()
    await pendingToggle

    expect(manager.dispose).not.toHaveBeenCalled()
    expect(manager.disposeAndWait).not.toHaveBeenCalled()
    expect(replacement.aiTaskManager).toBe(manager)
  })

  test('an unload-started disable callback cannot dispose the manager while the registry still points to the old plugin', async () => {
    let finishSave: (() => void) | undefined
    const manager = createFakeManager()
    const tab = createTab()
    tab.plugin.settings.aiTaskEnabled = true
    tab.plugin.aiTaskManager = manager
    tab.plugin.saveSettings.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve
        }),
    )
    tab.renderAiTaskSection(document.createElement('div'))

    const pendingToggle = toggles[0]?.trigger(false)
    await Promise.resolve()

    // Hostile event order: onunload has begun, but Obsidian has not replaced
    // the old instance in its plugin registry yet.
    tab.plugin.aiTaskLifecycleActive = false
    tab.plugin.aiTaskLifecycleGeneration = 2
    expect(
      (tab.app as unknown as {
        plugins: { plugins: Record<string, unknown> }
      }).plugins.plugins['taskchute-plus'],
    ).toBe(tab.plugin)

    finishSave?.()
    await pendingToggle

    expect(manager.dispose).not.toHaveBeenCalled()
    expect(manager.disposeAndWait).not.toHaveBeenCalled()
    expect(tab.plugin.aiTaskManager).toBe(manager)
  })

  test('only the newest toggle operation applies when saves complete out of order', async () => {
    const saveResolvers: Array<() => void> = []
    const tab = createTab()
    tab.plugin.saveSettings.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          saveResolvers.push(resolve)
        }),
    )
    tab.renderAiTaskSection(document.createElement('div'))

    const enable = toggles[0]?.trigger(true)
    await Promise.resolve()
    const disable = toggles[0]?.trigger(false)
    await Promise.resolve()
    saveResolvers[1]?.()
    await disable
    saveResolvers[0]?.()
    await enable

    expect(tab.plugin.settings.aiTaskEnabled).toBe(false)
    expect(createAiTaskManagerMock).not.toHaveBeenCalled()
    expect(tab.plugin.aiTaskManager).toBeUndefined()
  })

  test('run mode dropdown lists terminal and headless and reflects the saved setting', () => {
    const tab = createTab()

    tab.renderAiTaskSection(document.createElement('div'))

    expect(dropdowns).toHaveLength(1)
    const dropdown = dropdowns[0]
    expect(dropdown.options.map((option) => option.value)).toEqual([
      'terminal',
      'headless',
    ])
    // No stored preference -> terminal default
    expect(dropdown.setValue).toHaveBeenCalledWith('terminal')
  })

  test('run mode dropdown reflects a stored headless preference', () => {
    const tab = createTab()
    tab.plugin.settings.aiTaskRunMode = 'headless'

    tab.renderAiTaskSection(document.createElement('div'))

    expect(dropdowns[0]?.setValue).toHaveBeenCalledWith('headless')
  })

  test('run mode changes persist through saveSettings', async () => {
    const tab = createTab()

    tab.renderAiTaskSection(document.createElement('div'))
    await dropdowns[0]?.trigger('headless')

    expect(tab.plugin.settings.aiTaskRunMode).toBe('headless')
    expect(tab.plugin.saveSettings).toHaveBeenCalledTimes(1)

    await dropdowns[0]?.trigger('terminal')
    expect(tab.plugin.settings.aiTaskRunMode).toBe('terminal')
  })

  test('run mode dropdown normalizes unknown values back to terminal', async () => {
    const tab = createTab()

    tab.renderAiTaskSection(document.createElement('div'))
    await dropdowns[0]?.trigger('bogus')

    expect(tab.plugin.settings.aiTaskRunMode).toBe('terminal')
  })

  test('binary path changes save trimmed values and invalidate the locator cache', async () => {
    const manager = createFakeManager()
    const tab = createTab()
    tab.plugin.aiTaskManager = manager

    tab.renderAiTaskSection(document.createElement('div'))
    // texts[0] = claude path, texts[1] = codex path, texts[2] = retention days
    await texts[0]?.trigger('  /opt/homebrew/bin/claude  ')
    await texts[1]?.trigger('')

    expect(tab.plugin.settings.aiTaskClaudePath).toBe('/opt/homebrew/bin/claude')
    expect(tab.plugin.settings.aiTaskCodexPath).toBe('')
    expect(tab.plugin.saveSettings).toHaveBeenCalledTimes(2)
    expect(manager.invalidateBinaryCache).toHaveBeenCalledTimes(2)
  })

  test('rejects Windows command shims as manual binary paths with a visible notice', async () => {
    const manager = createFakeManager()
    const tab = createTab()
    tab.plugin.aiTaskManager = manager

    tab.renderAiTaskSection(document.createElement('div'))
    await texts[0]?.trigger('C:\\Users\\tester\\AppData\\Roaming\\npm\\claude.cmd')
    await texts[1]?.trigger('C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.ps1')

    expect(tab.plugin.settings.aiTaskClaudePath).toBe('')
    expect(tab.plugin.settings.aiTaskCodexPath).toBe('')
    expect(texts[0]?.setValue).toHaveBeenLastCalledWith('')
    expect(texts[1]?.setValue).toHaveBeenLastCalledWith('')
    expect(Notice).toHaveBeenCalledTimes(2)
    expect(manager.invalidateBinaryCache).toHaveBeenCalledTimes(2)
  })

  test('browsing for a CLI path writes the picked file into the field', async () => {
    const manager = createFakeManager()
    const tab = createTab()
    tab.plugin.aiTaskManager = manager
    selectFileMock.mockResolvedValue('/opt/homebrew/bin/claude')

    tab.renderAiTaskSection(document.createElement('div'))
    // buttons[0] = claude browse, buttons[1] = codex browse
    await buttons[0]?.trigger()

    expect(texts[0]?.setValue).toHaveBeenLastCalledWith('/opt/homebrew/bin/claude')
    expect(tab.plugin.settings.aiTaskClaudePath).toBe('/opt/homebrew/bin/claude')
    expect(manager.invalidateBinaryCache).toHaveBeenCalledTimes(1)
  })

  test('cancelling the CLI path picker leaves the stored path untouched', async () => {
    const tab = createTab()
    tab.plugin.settings.aiTaskClaudePath = '/existing/claude'
    selectFileMock.mockResolvedValue(null)

    tab.renderAiTaskSection(document.createElement('div'))
    await buttons[0]?.trigger()

    expect(tab.plugin.settings.aiTaskClaudePath).toBe('/existing/claude')
    expect(tab.plugin.saveSettings).not.toHaveBeenCalled()
  })

  test('retention days input normalizes invalid values', async () => {
    const tab = createTab()

    tab.renderAiTaskSection(document.createElement('div'))
    const retention = texts[2]

    await retention?.trigger('0')
    expect(tab.plugin.settings.aiTaskLogRetentionDays).toBe(1)

    await retention?.trigger('45.4')
    expect(tab.plugin.settings.aiTaskLogRetentionDays).toBe(45)

    await retention?.trigger('abc')
    expect(tab.plugin.settings.aiTaskLogRetentionDays).toBe(30)
  })
})
