import { Setting, mockApp } from 'obsidian'
import { TaskChuteSettingTab } from '../../src/settings/SettingsTab'
import { initializeLocaleManager, setLocaleOverride, t } from '../../src/i18n'

/** Private members of TaskChuteSettingTab driven directly by this suite. */
type MutableSettingTab = {
  app: typeof mockApp
  plugin: {
    manifest: { version: string }
  }
  proSectionUnlocked: boolean
  versionClickCount: number
  renderSettings: () => void
  renderVersionSection: (container: HTMLElement) => void
}

function createTab(version: string): MutableSettingTab {
  const tab = Object.create(TaskChuteSettingTab.prototype) as unknown as MutableSettingTab
  tab.app = mockApp
  tab.plugin = { manifest: { version } }
  tab.proSectionUnlocked = false
  tab.versionClickCount = 0
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

  test('unlocks the Pro section only after ten clicks', () => {
    const tab = createTab('1.7.12')
    // The redraw entry point, not display(): Obsidian deprecated display() in
    // 1.13 and the tab must not call it internally.
    tab.renderSettings = jest.fn()

    tab.renderVersionSection({} as HTMLElement)

    const setting = SettingMock.mock.results[0].value as {
      settingEl: { dispatchEvent: (event: Event) => void }
    }
    const click = () => setting.settingEl.dispatchEvent(new Event('click'))

    for (let i = 0; i < 9; i += 1) click()
    expect(tab.proSectionUnlocked).toBe(false)
    expect(tab.renderSettings).not.toHaveBeenCalled()

    click()
    expect(tab.proSectionUnlocked).toBe(true)
    expect(tab.renderSettings).toHaveBeenCalledTimes(1)

    // Further clicks are inert once the section is already visible.
    click()
    expect(tab.renderSettings).toHaveBeenCalledTimes(1)
  })
})
