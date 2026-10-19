import { mockApp } from 'obsidian'
import { TaskChuteSettingTab } from '@/settings/SettingsTab'
import { formatVersion, versionSection } from '@/settings/sections/version'
import type { SectionContext } from '@/settings/types'
import { t } from '@/i18n'
import { setObsidianLanguage } from '@tests/utils/locale'
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
    setObsidianLanguage('en')
  })

  afterEach(() => {
    setObsidianLanguage('en')
    jest.clearAllMocks()
  })

  test('shows the version from manifest.json with the build number', () => {
    const ctx = createContext('1.7.10')

    const row = findByName(versionSection().items(ctx), 'Version')

    expect(row?.desc).toBe('1.7.10 (614)')
  })

  test('uses the localized label', () => {
    setObsidianLanguage('ja')
    const ctx = createContext('1.7.11')

    const items = versionSection().items(ctx)

    expect(findByName(items, 'バージョン')?.desc).toBe('1.7.11 (614)')
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

    expect(findByName(tab.getSettingDefinitions(), 'Version')?.desc).toBe('2.2.0 (614)')
  })

  describe('the build number after the version', () => {
    test('shows it as "2.2.16 (614)"', () => {
      const ctx = createContext('2.2.16')
      expect(findByName(versionSection({ number: 614 }).items(ctx), 'Version')?.desc).toBe('2.2.16 (614)')
    })

    test('built without git (number 0), only the version', () => {
      expect(formatVersion('2.2.16', { number: 0 })).toBe('2.2.16')
    })

    test('the tab shows it with the stub build of the test run', () => {
      const plugin = { app: mockApp, manifest: { version: '2.2.16' }, settings: {}, saveSettings: jest.fn() }
      const tab = new TaskChuteSettingTab(mockApp, plugin as never)
      expect(findByName(tab.getSettingDefinitions(), 'Version')?.desc).toBe('2.2.16 (614)')
    })
  })
})
