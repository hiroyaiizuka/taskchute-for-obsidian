import { Setting, mockApp } from 'obsidian'
import { DEFAULT_SETTINGS } from '../../src/settings'
import { TaskChuteSettingTab } from '../../src/settings/SettingsTab'

type ToggleStub = {
  setValue: jest.Mock<ToggleStub, [boolean]>
  onChange: jest.Mock<ToggleStub, [(value: boolean) => Promise<void> | void]>
  trigger: (value: boolean) => Promise<void>
}

type MutableSettingTab = TaskChuteSettingTab & {
  app: typeof mockApp
  plugin: {
    settings: {
      recipeFeatureEnabled?: boolean
      slotKeys: Record<string, string>
    }
    saveSettings: jest.Mock<Promise<void>, []>
  }
  renderRecipeFeatureSection: (container: HTMLElement) => void
}

function createTab(): MutableSettingTab {
  const tab = Object.create(TaskChuteSettingTab.prototype) as MutableSettingTab
  tab.app = mockApp
  tab.plugin = {
    settings: {
      slotKeys: {},
    },
    saveSettings: jest.fn().mockResolvedValue(undefined),
  }
  return tab
}

function createToggleStub(): ToggleStub {
  let changeHandler: ((value: boolean) => Promise<void> | void) | null = null
  const toggle = {
    setValue: jest.fn(() => toggle),
    onChange: jest.fn((handler) => {
      changeHandler = handler
      return toggle
    }),
    trigger: async (value: boolean) => {
      await changeHandler?.(value)
    },
  } as ToggleStub
  return toggle
}

describe('TaskChute recipe feature setting', () => {
  const SettingMock = Setting as unknown as jest.Mock
  const originalSettingImpl = SettingMock.getMockImplementation()

  afterEach(() => {
    SettingMock.mockImplementation(originalSettingImpl)
    jest.clearAllMocks()
    mockApp.workspace.getLeavesOfType.mockReturnValue([])
  })

  test('is disabled by default', () => {
    expect(DEFAULT_SETTINGS.recipeFeatureEnabled).toBe(false)
  })

  test('renders recipe toggle above advanced section settings and notifies open views', async () => {
    const toggle = createToggleStub()
    const createdSettings: Array<{
      setName: jest.Mock
      setDesc: jest.Mock
      addToggle: jest.Mock
      setHeading: jest.Mock
    }> = []
    SettingMock.mockImplementation(() => {
      const instance = {
        setName: jest.fn().mockReturnThis(),
        setDesc: jest.fn().mockReturnThis(),
        setHeading: jest.fn().mockReturnThis(),
        addToggle: jest.fn((callback: (toggle: ToggleStub) => void) => {
          callback(toggle)
          return instance
        }),
      }
      createdSettings.push(instance)
      return instance
    })

    const tab = createTab()
    const view = { onRecipeFeatureSettingsChanged: jest.fn() }
    mockApp.workspace.getLeavesOfType.mockReturnValue([{ view }])

    tab.renderRecipeFeatureSection(document.createElement('div'))

    expect(createdSettings[0]?.setName).toHaveBeenCalledWith('Recipes')
    expect(createdSettings[1]?.setName).toHaveBeenCalledWith('Enable recipe feature')
    expect(toggle.setValue).toHaveBeenCalledWith(false)

    await toggle.trigger(true)

    expect(tab.plugin.settings.recipeFeatureEnabled).toBe(true)
    expect(tab.plugin.saveSettings).toHaveBeenCalledTimes(1)
    expect(view.onRecipeFeatureSettingsChanged).toHaveBeenCalledTimes(1)
  })
})
