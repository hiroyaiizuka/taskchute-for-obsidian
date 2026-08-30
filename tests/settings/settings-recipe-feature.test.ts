import { mockApp } from 'obsidian'
import { DEFAULT_SETTINGS } from '../../src/settings'
import { TaskChuteSettingTab } from '../../src/settings/SettingsTab'
import { findByKey, headings } from './definitionHelpers'

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

describe('TaskChute recipe feature setting', () => {
  afterEach(() => {
    jest.clearAllMocks()
    mockApp.workspace.getLeavesOfType.mockReturnValue([])
  })

  test('is disabled by default', () => {
    expect(DEFAULT_SETTINGS.recipeFeatureEnabled).toBe(false)
  })

  test('is a toggle under the recipes heading, off until set', () => {
    const { tab } = createTab()
    const items = tab.getSettingDefinitions()

    const control = findByKey(items, 'recipeFeatureEnabled')
    expect(control?.control.type).toBe('toggle')
    expect(control?.name).toBe('Enable recipe feature')
    expect(headings(items)).toContain('Recipes')
    expect(tab.getControlValue('recipeFeatureEnabled')).toBe(false)
  })

  test('sits above the section customization settings', () => {
    const { tab } = createTab()

    const order = headings(tab.getSettingDefinitions())

    expect(order.indexOf('Recipes')).toBeLessThan(order.indexOf('Section'))
  })

  test('persists and tells open views when it changes', async () => {
    const { tab, plugin } = createTab()
    const view = { onRecipeFeatureSettingsChanged: jest.fn() }
    mockApp.workspace.getLeavesOfType.mockReturnValue([{ view }])

    await tab.setControlValue('recipeFeatureEnabled', true)

    expect(plugin.settings.recipeFeatureEnabled).toBe(true)
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1)
    expect(view.onRecipeFeatureSettingsChanged).toHaveBeenCalledTimes(1)
  })
})
