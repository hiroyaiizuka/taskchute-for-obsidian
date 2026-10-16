import { mockApp, requireApiVersion } from 'obsidian'
import { DEFAULT_SETTINGS } from '@/settings'
import { TaskChuteSettingTab } from '@/settings/SettingsTab'
import { findByKey } from './definitionHelpers'

function createTab(settings: Record<string, unknown> = {}) {
  const plugin = {
    app: mockApp,
    manifest: { id: 'taskchute-plus', version: '2.2.0' },
    settings: { slotKeys: {}, ...settings } as Record<string, unknown>,
    pathManager: { validatePath: () => ({ valid: true }) },
    saveSettings: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
  }
  const tab = new TaskChuteSettingTab(mockApp, plugin as never)
  return { tab, plugin }
}

const version = requireApiVersion as jest.Mock

describe('the project view setting', () => {
  afterEach(() => {
    version.mockReturnValue(true)
  })

  test("is TaskChute's own board by default, including for settings saved before it existed", () => {
    expect(DEFAULT_SETTINGS.projectBoardView).toBe('board')
    expect(createTab().tab.getControlValue('projectBoardView')).toBe('board')
  })

  test('offers both views and saves the choice', async () => {
    const { tab, plugin } = createTab()
    const item = findByKey(tab.getSettingDefinitions(), 'projectBoardView')
    expect(item?.control).toMatchObject({ type: 'dropdown', options: { board: 'TaskChute board', bases: 'Bases kanban' } })
    expect((item?.control as { disabled: () => boolean }).disabled()).toBe(false)

    await tab.setControlValue('projectBoardView', 'bases')
    expect(plugin.settings.projectBoardView).toBe('bases')
    await tab.setControlValue('projectBoardView', 'something else')
    expect(plugin.settings.projectBoardView).toBe('board')
  })

  test('before Obsidian 1.14 it is shown but cannot be changed, and says why', () => {
    version.mockReturnValue(false)
    const item = findByKey(createTab().tab.getSettingDefinitions(), 'projectBoardView')
    expect((item?.control as { disabled: () => boolean }).disabled()).toBe(true)
    expect(item?.desc).toBe('A Bases kanban needs Obsidian 1.14 or later.')
  })
})
