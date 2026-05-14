import { Setting, mockApp } from 'obsidian'
import { DEFAULT_SETTINGS } from '../../src/settings'
import { TaskChuteSettingTab } from '../../src/settings/SettingsTab'

type ToggleStub = {
  setValue: jest.Mock<ToggleStub, [boolean]>
  onChange: jest.Mock<ToggleStub, [(value: boolean) => Promise<void> | void]>
  trigger: (value: boolean) => Promise<void>
}

type TextStub = {
  inputEl: HTMLInputElement
  setPlaceholder: jest.Mock<TextStub, [string]>
  setValue: jest.Mock<TextStub, [string]>
  onChange: jest.Mock<TextStub, [(value: string) => Promise<void> | void]>
  trigger: (value: string) => Promise<void>
}

type MutableSettingTab = TaskChuteSettingTab & {
  app: typeof mockApp
  plugin: {
    settings: {
      showTaskCreationAdvancedSettings?: boolean
      defaultReminderMinutes?: number
      googleCalendar?: {
        enabled?: boolean
        includeNoteContent?: boolean
      }
      slotKeys: Record<string, string>
    }
    saveSettings: jest.Mock<Promise<void>, []>
  }
  renderTaskCreationSection: (container: HTMLElement) => void
  renderAdvancedSection: (container: HTMLElement) => void
  renderRecipeFeatureSection: jest.Mock
  renderSectionCustomization: jest.Mock
  renderCollapsibleTimeSlotsToggle: jest.Mock
  renderFeaturesSection: jest.Mock
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

function createTextStub(): TextStub {
  let changeHandler: ((value: string) => Promise<void> | void) | null = null
  const text = {
    inputEl: document.createElement('input'),
    setPlaceholder: jest.fn(() => text),
    setValue: jest.fn((value: string) => {
      text.inputEl.value = value
      return text
    }),
    onChange: jest.fn((handler) => {
      changeHandler = handler
      return text
    }),
    trigger: async (value: string) => {
      await changeHandler?.(value)
    },
  } as TextStub
  return text
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

describe('TaskChute task creation advanced setting', () => {
  const SettingMock = Setting as unknown as jest.Mock
  const originalSettingImpl = SettingMock.getMockImplementation()

  afterEach(() => {
    SettingMock.mockImplementation(originalSettingImpl)
    jest.clearAllMocks()
  })

  test('is disabled by default', () => {
    expect(DEFAULT_SETTINGS.showTaskCreationAdvancedSettings).toBe(false)
  })

  test('renders task creation advanced toggle and reminder minutes setting', async () => {
    const advancedToggle = createToggleStub()
    const calendarToggle = createToggleStub()
    const toggleStubs = [advancedToggle, calendarToggle]
    const text = createTextStub()
    const createdSettings: Array<{
      setName: jest.Mock
      setDesc: jest.Mock
      addToggle: jest.Mock
      addText: jest.Mock
      setHeading: jest.Mock
      controlEl?: { addClass: jest.Mock }
    }> = []
    SettingMock.mockImplementation(() => {
      const instance = {
        setName: jest.fn().mockReturnThis(),
        setDesc: jest.fn().mockReturnThis(),
        setHeading: jest.fn().mockReturnThis(),
        addToggle: jest.fn((callback: (next: ToggleStub) => void) => {
          const toggle = toggleStubs.shift() ?? createToggleStub()
          callback(toggle)
          return instance
        }),
        addText: jest.fn((callback: (next: TextStub) => void) => {
          callback(text)
          return instance
        }),
        controlEl: { addClass: jest.fn() },
      }
      createdSettings.push(instance)
      return instance
    })

    const tab = createTab()
    tab.renderTaskCreationSection(document.createElement('div'))

    expect(createdSettings[0]?.setName).toHaveBeenCalledWith('Task creation')
    expect(createdSettings[1]?.setName).toHaveBeenCalledWith('Show advanced settings in the task creation modal')
    expect(createdSettings[2]?.setName).toHaveBeenCalledWith('Default reminder time (minutes)')
    expect(createdSettings[3]?.setName).toHaveBeenCalledWith('Enable google calendar registration')
    expect(advancedToggle.setValue).toHaveBeenCalledWith(false)
    expect(calendarToggle.setValue).toHaveBeenCalledWith(false)
    expect(text.setValue).toHaveBeenCalledWith('5')

    await advancedToggle.trigger(true)
    await text.trigger('10')
    await calendarToggle.trigger(true)

    expect(tab.plugin.settings.showTaskCreationAdvancedSettings).toBe(true)
    expect(tab.plugin.settings.defaultReminderMinutes).toBe(10)
    expect(tab.plugin.settings.googleCalendar).toEqual({
      enabled: true,
      includeNoteContent: true,
    })
    expect(tab.plugin.saveSettings).toHaveBeenCalledTimes(3)
  })

  test('places task creation at the top of advanced settings before recipe and section settings', () => {
    const tab = createTab()
    tab.renderTaskCreationSection = jest.fn()
    tab.renderRecipeFeatureSection = jest.fn()
    tab.renderSectionCustomization = jest.fn()
    tab.renderCollapsibleTimeSlotsToggle = jest.fn()
    tab.renderFeaturesSection = jest.fn()

    tab.renderAdvancedSection(document.createElement('div'))

    expect(tab.renderTaskCreationSection).toHaveBeenCalledTimes(1)
    expect(tab.renderRecipeFeatureSection).toHaveBeenCalledTimes(1)
    expect(tab.renderSectionCustomization).toHaveBeenCalledTimes(1)
    expect(tab.renderFeaturesSection).toHaveBeenCalledTimes(1)
    expect(tab.renderTaskCreationSection.mock.invocationCallOrder[0]).toBeLessThan(
      tab.renderRecipeFeatureSection.mock.invocationCallOrder[0],
    )
    expect(tab.renderRecipeFeatureSection.mock.invocationCallOrder[0]).toBeLessThan(
      tab.renderSectionCustomization.mock.invocationCallOrder[0],
    )
    expect(tab.renderSectionCustomization.mock.invocationCallOrder[0]).toBeLessThan(
      tab.renderFeaturesSection.mock.invocationCallOrder[0],
    )
  })
})
