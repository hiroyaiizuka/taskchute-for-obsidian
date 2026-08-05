import { Setting, mockApp } from 'obsidian'
import { TaskChuteSettingTab } from '../../src/settings/SettingsTab'
import { initializeLocaleManager, setLocaleOverride, t } from '../../src/i18n'

/** Private members of TaskChuteSettingTab driven directly by this suite. */
type MutableSettingTab = {
  app: typeof mockApp
  plugin: {
    manifest: { version: string }
  }
  renderVersionSection: (container: HTMLElement) => void
}

function createTab(version: string): MutableSettingTab {
  const tab = Object.create(TaskChuteSettingTab.prototype) as unknown as MutableSettingTab
  tab.app = mockApp
  tab.plugin = { manifest: { version } }
  return tab
}

describe('TaskChute settings version display', () => {
  const SettingMock = Setting as unknown as jest.Mock

  beforeAll(() => {
    initializeLocaleManager('en')
  })

  afterEach(() => {
    setLocaleOverride('en')
    jest.clearAllMocks()
  })

  test('shows the version from manifest.json', () => {
    const tab = createTab('1.7.10')

    tab.renderVersionSection({} as HTMLElement)

    const setting = SettingMock.mock.results[0].value as {
      setName: jest.Mock
      setDesc: jest.Mock
    }
    expect(setting.setName).toHaveBeenCalledWith('Version')
    expect(setting.setDesc).toHaveBeenCalledWith('1.7.10')
  })

  test('uses the localized label', () => {
    setLocaleOverride('ja')
    const tab = createTab('1.7.11')

    tab.renderVersionSection({} as HTMLElement)

    const setting = SettingMock.mock.results[0].value as { setName: jest.Mock }
    expect(setting.setName).toHaveBeenCalledWith('バージョン')
    expect(t('settings.version.name', '__missing__')).not.toBe('__missing__')
  })
})
