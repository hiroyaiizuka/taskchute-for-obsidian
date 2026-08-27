import { mockApp } from 'obsidian'
import { DEFAULT_SETTINGS } from '../../src/settings'
import { TaskChuteSettingTab } from '../../src/settings/SettingsTab'
import { findByKey, headings, pageNamed } from './definitionHelpers'

function createTab() {
  const plugin = {
    app: mockApp,
    manifest: { id: 'taskchute-plus', version: '2.2.0' },
    settings: { slotKeys: {} } as Record<string, unknown>,
    pathManager: { validatePath: () => ({ valid: true }) },
    saveSettings: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
  }
  const tab = new TaskChuteSettingTab(mockApp as never, plugin as never)
  return { tab, plugin }
}

describe('TaskChute task creation advanced setting', () => {
  afterEach(() => {
    jest.clearAllMocks()
    mockApp.workspace.getLeavesOfType.mockReturnValue([])
  })

  test('is disabled by default', () => {
    expect(DEFAULT_SETTINGS.showTaskCreationAdvancedSettings).toBe(false)
  })

  test('declares the advanced toggle, reminder minutes and calendar toggle', () => {
    const { tab } = createTab()
    const items = tab.getSettingDefinitions()

    expect(findByKey(items, 'showTaskCreationAdvancedSettings')?.name).toBe(
      'Show advanced settings in the task creation modal',
    )
    expect(findByKey(items, 'defaultReminderMinutes')?.name).toBe(
      'Default reminder time (minutes)',
    )
    expect(findByKey(items, 'googleCalendar.enabled')?.name).toBe(
      'Enable Google Calendar registration',
    )

    expect(tab.getControlValue('showTaskCreationAdvancedSettings')).toBe(false)
    expect(tab.getControlValue('googleCalendar.enabled')).toBe(false)
    expect(tab.getControlValue('defaultReminderMinutes')).toBe(5)
  })

  test('persists each of the three settings', async () => {
    const { tab, plugin } = createTab()

    await tab.setControlValue('showTaskCreationAdvancedSettings', true)
    await tab.setControlValue('defaultReminderMinutes', 10)
    await tab.setControlValue('googleCalendar.enabled', true)

    expect(plugin.settings.showTaskCreationAdvancedSettings).toBe(true)
    expect(plugin.settings.defaultReminderMinutes).toBe(10)
    // Enabling the export also turns on note content, which the event body
    // is built from.
    expect(plugin.settings.googleCalendar).toEqual({
      enabled: true,
      includeNoteContent: true,
    })
    expect(plugin.saveSettings).toHaveBeenCalledTimes(3)
  })

  test('clamps the reminder minutes rather than rejecting the value', async () => {
    const { tab, plugin } = createTab()

    await tab.setControlValue('defaultReminderMinutes', -3)
    expect(plugin.settings.defaultReminderMinutes).toBe(0)

    await tab.setControlValue('defaultReminderMinutes', Number.NaN)
    expect(plugin.settings.defaultReminderMinutes).toBe(5)
  })

  test('places task creation first in the advanced page, before recipes and sections', () => {
    const { tab } = createTab()

    const page = pageNamed(tab.getSettingDefinitions(), 'Advanced settings')
    expect(page).toBeDefined()
    const order = headings(page?.items ?? [])

    expect(order).toEqual([
      'Task creation',
      'Recipes',
      'Section',
      'External tools',
    ])
  })
})
