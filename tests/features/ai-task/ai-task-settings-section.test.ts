import { Setting, mockApp } from 'obsidian'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { TaskChuteSettingTab } from '../../../src/settings/SettingsTab'
import { createAiTaskManager } from '../../../src/features/ai-task'

jest.mock('../../../src/features/ai-task', () => ({
  createAiTaskManager: jest.fn(),
}))

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
  addDropdown: jest.Mock
  controlEl: HTMLElement
}

type FakeManager = {
  dispose: jest.Mock
  disposeAndWait: jest.Mock<Promise<void>, []>
  invalidateBinaryCache: jest.Mock
}

type MutableSettingTab = TaskChuteSettingTab & {
  app: typeof mockApp
  plugin: {
    settings: Record<string, unknown>
    saveSettings: jest.Mock<Promise<void>, []>
    aiTaskManager?: FakeManager
    aiTaskManagersPendingDisposal?: Set<FakeManager>
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
  tab.app = mockApp
  tab.plugin = {
    settings: {},
    saveSettings: jest.fn().mockResolvedValue(undefined),
    aiTaskManagersPendingDisposal: new Set(),
  }
  return tab
}

describe('TaskChute AI task settings section', () => {
  const SettingMock = Setting as unknown as jest.Mock
  const originalSettingImpl = SettingMock.getMockImplementation()
  const createAiTaskManagerMock = createAiTaskManager as jest.Mock

  let settings: SettingStub[]
  let toggles: ToggleStub[]
  let texts: TextStub[]
  let dropdowns: DropdownStub[]

  beforeEach(() => {
    settings = []
    toggles = []
    texts = []
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
        addDropdown: jest.fn((cb: (dropdown: DropdownStub) => void) => {
          const dropdown = createDropdownStub()
          dropdowns.push(dropdown)
          cb(dropdown)
          return instance
        }),
        controlEl: document.createElement('div'),
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
