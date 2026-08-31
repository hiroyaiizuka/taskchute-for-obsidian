import type { SettingDefinitionAction } from 'obsidian'
import { Notice, Platform, mockApp } from 'obsidian'
import { TaskChuteSettingTab } from '../../src/settings/SettingsTab'
import { ProUnlockState, isProSectionVisible } from '../../src/settings/proUnlockState'
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

    const row = findByName(versionSection(new ProUnlockState()).items(ctx), 'Version')

    expect(row?.desc).toBe('1.7.10')
  })

  test('uses the localized label', () => {
    setLocaleOverride('ja')
    const ctx = createContext('1.7.11')

    const items = versionSection(new ProUnlockState()).items(ctx)

    expect(findByName(items, 'バージョン')?.desc).toBe('1.7.11')
    expect(t('settings.version.name', '__missing__')).not.toBe('__missing__')
  })

  test('unlocks the Pro section only after ten clicks', () => {
    const ctx = createContext('1.7.12')
    const unlock = new ProUnlockState()
    const row = findByName(
      versionSection(unlock).items(ctx),
      'Version',
    ) as SettingDefinitionAction
    const click = () => row.action({} as HTMLElement, 0)

    for (let i = 0; i < 9; i += 1) click()
    expect(isProSectionVisible(ctx, unlock)).toBe(false)
    // Only a visibility predicate changes, so the tree is never rebuilt.
    expect(ctx.refreshDomState).not.toHaveBeenCalled()
    expect(ctx.update).not.toHaveBeenCalled()

    click()
    expect(isProSectionVisible(ctx, unlock)).toBe(true)
    expect(ctx.refreshDomState).toHaveBeenCalledTimes(1)
    expect(Notice).toHaveBeenCalledTimes(1)

    // Further clicks are inert once the section is already visible.
    click()
    expect(ctx.refreshDomState).toHaveBeenCalledTimes(1)
  })

  /**
   * The section it would reveal is not declared on mobile, so counting the taps
   * would end in a notice announcing settings that are not there.
   */
  test('does not unlock the Pro section on mobile', () => {
    Platform.isDesktop = false
    Platform.isMobile = true
    try {
      const ctx = createContext('1.7.13')
      const unlock = new ProUnlockState()
      const row = findByName(
        versionSection(unlock).items(ctx),
        'Version',
      ) as SettingDefinitionAction

      for (let i = 0; i < 12; i += 1) row.action({} as HTMLElement, 0)

      expect(unlock.isUnlocked).toBe(false)
      expect(isProSectionVisible(ctx, unlock)).toBe(false)
      expect(Notice).not.toHaveBeenCalled()
      expect(ctx.refreshDomState).not.toHaveBeenCalled()
    } finally {
      Platform.isDesktop = true
      Platform.isMobile = false
    }
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
