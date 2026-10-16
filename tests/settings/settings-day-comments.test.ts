import { mockApp } from 'obsidian'
import { DEFAULT_SETTINGS } from '@/settings'
import { TaskChuteSettingTab } from '@/settings/SettingsTab'
import { findByKey } from './definitionHelpers'

function createTab() {
  const plugin = {
    app: mockApp,
    manifest: { id: 'taskchute-plus', version: '2.2.0' },
    settings: { slotKeys: {} } as Record<string, unknown>,
    pathManager: { validatePath: () => ({ valid: true }) },
    saveSettings: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
  }
  const tab = new TaskChuteSettingTab(mockApp, plugin as never)
  return { tab, plugin }
}

describe("the setting for the day's comments box", () => {
  afterEach(() => {
    jest.clearAllMocks()
    mockApp.workspace.getLeavesOfType.mockReturnValue([])
  })

  test('is off by default, including for settings saved before it existed', () => {
    expect(DEFAULT_SETTINGS.dayCommentsEnabled).toBe(false)
    const { tab } = createTab()
    expect(tab.getControlValue('dayCommentsEnabled')).toBe(false)
  })

  test('is a toggle in the settings', () => {
    const { tab } = createTab()
    const control = findByKey(tab.getSettingDefinitions(), 'dayCommentsEnabled')
    expect(control?.control.type).toBe('toggle')
    expect(control?.name).toBe('Comments for the day')
  })

  test('persists and redraws open task lists when it changes', async () => {
    const { tab, plugin } = createTab()
    const view = { renderTaskList: jest.fn() }
    mockApp.workspace.getLeavesOfType.mockReturnValue([{ view }])

    await tab.setControlValue('dayCommentsEnabled', true)

    expect(plugin.settings.dayCommentsEnabled).toBe(true)
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1)
    expect(view.renderTaskList).toHaveBeenCalled()
  })
})
