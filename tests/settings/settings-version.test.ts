import { mockApp } from 'obsidian'
import { TaskChuteSettingTab } from '../../src/settings/SettingsTab'
import { versionSection } from '../../src/settings/sections/version'
import type { SectionContext } from '../../src/settings/types'
import { initializeLocaleManager, setLocaleOverride, t } from '../../src/i18n'
import { findByName } from './definitionHelpers'

function createContext(version: string): SectionContext & {
  refreshDomState: jest.Mock
  update: jest.Mock
} {
  return {
    app: mockApp,
    plugin: {
      app: mockApp,
      manifest: { version },
      settings: {},
      licenseManager: undefined,
    },
    update: jest.fn(),
    refreshDomState: jest.fn(),
  } as unknown as SectionContext & {
    refreshDomState: jest.Mock
    update: jest.Mock
  }
}

describe('TaskChute settings version display', () => {
  beforeAll(() => {
    initializeLocaleManager('en')
  })

  afterEach(() => {
    setLocaleOverride('en')
    jest.clearAllMocks()
  })

  test('shows the version from manifest.json', () => {
    const ctx = createContext('1.7.10')

    const row = findByName(versionSection().items(ctx), 'Version')

    expect(row?.desc).toBe('1.7.10')
  })

  test('uses the localized label', () => {
    setLocaleOverride('ja')
    const ctx = createContext('1.7.11')

    const items = versionSection().items(ctx)

    expect(findByName(items, 'バージョン')?.desc).toBe('1.7.11')
    expect(t('settings.version.name', '__missing__')).not.toBe('__missing__')
  })

  test('the tab exposes the version row through its definitions', () => {
    const plugin = {
      app: mockApp,
      manifest: { version: '2.2.0' },
      settings: {},
      saveSettings: jest.fn(),
    }
    const tab = new TaskChuteSettingTab(
      mockApp,
      plugin as never,
    )

    expect(findByName(tab.getSettingDefinitions(), 'Version')?.desc).toBe('2.2.0')
  })
})
