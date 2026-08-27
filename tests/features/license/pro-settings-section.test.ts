/**
 * The Pro section is the only place a buyer can enter their code, and the only
 * place the AI settings live. Getting its two shapes wrong either strands a
 * paying user with nowhere to activate, or shows AI settings for a feature the
 * gate will refuse to start.
 */
import type {
  SettingDefinitionItem,
  SettingDefinitionRender,
} from 'obsidian'
import { Setting, SettingGroup, mockApp } from 'obsidian'

import { TaskChuteSettingTab } from '../../../src/settings/SettingsTab'
import {
  PRO_SECTION_UNLOCK_CLICKS,
  ProUnlockState,
  isProSectionVisible,
} from '../../../src/settings/proUnlockState'
import type { SectionContext } from '../../../src/settings/types'
import { setLocaleOverride, t } from '../../../src/i18n'
import type { LicenseManager } from '../../../src/features/license/services/LicenseManager'
import { flatten, isVisible, pageNamed } from '../../settings/definitionHelpers'

jest.mock('../../../src/features/license/ui/DeviceListView', () => ({
  DeviceListView: jest.fn().mockImplementation(() => ({ dispose: jest.fn() })),
}))

const { DeviceListView } = require('../../../src/features/license/ui/DeviceListView') as {
  DeviceListView: jest.Mock
}

function fakeManager(
  overrides: Partial<Record<keyof LicenseManager, unknown>> = {},
): LicenseManager {
  return {
    getState: () => ({ status: 'unlicensed' }),
    isActive: () => false,
    getDeviceId: () => 'DEVICE-0001',
    getLicenseSummary: () => undefined,
    activate: jest.fn(),
    listDevices: jest.fn(),
    deactivateDevice: jest.fn(),
    refreshIfNeeded: jest.fn().mockResolvedValue(undefined),
    onChange: jest.fn(() => () => undefined),
    ...overrides,
  } as unknown as LicenseManager
}

const ACTIVE_SUMMARY = {
  license_id: '8F3K2M9QX7RD4WPZ',
  max_devices: 3,
  devices_used: 2,
  expires_at: null,
}

function activeManager(): LicenseManager {
  return fakeManager({
    getState: () => ({ status: 'active', token: {}, license: ACTIVE_SUMMARY }),
    isActive: () => true,
    getLicenseSummary: () => ACTIVE_SUMMARY,
  })
}

function createTab(manager: LicenseManager | undefined): TaskChuteSettingTab {
  const app = { ...mockApp, plugins: { plugins: {} } }
  const plugin = {
    app,
    manifest: { id: 'taskchute-plus', version: '2.2.0' },
    settings: {
      slotKeys: {},
      aiTaskEnabled: false,
      aiTaskRunMode: 'terminal',
      aiTaskLogRetentionDays: 30,
    },
    pathManager: { validatePath: () => ({ valid: true }) },
    saveSettings: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    licenseManager: manager,
    aiTaskManagersPendingDisposal: new Set(),
  }
  return new TaskChuteSettingTab(app as never, plugin as never)
}

/** The rows on the Pro page, with the page's own visibility ignored. */
function proItems(manager: LicenseManager | undefined): SettingDefinitionItem[] {
  const page = pageNamed(
    createTab(manager).getSettingDefinitions(),
    t('settings.pro.heading', 'Pro settings'),
  )
  if (!page) throw new Error('Pro page not found')
  return flatten(page.items ?? [])
}

function names(items: SettingDefinitionItem[]): string[] {
  return items
    .filter((item) => isVisible(item as { visible?: boolean | (() => boolean) }))
    .map((item) => ('name' in item ? item.name : undefined))
    .filter((name): name is string => Boolean(name))
}

function descs(items: SettingDefinitionItem[]): string[] {
  return items
    .map((item) => ('desc' in item ? item.desc : undefined))
    .map((desc) =>
      typeof desc === 'string' ? desc : (desc?.textContent ?? ''),
    )
    .filter(Boolean)
}

/** Runs a row's render callback against a throwaway group. */
function invokeRender(item: SettingDefinitionItem): (() => void) | void {
  const render = (item as SettingDefinitionRender).render
  const group = new (SettingGroup as unknown as new (
    el: HTMLElement,
  ) => { listEl: HTMLElement })(document.createElement('div'))
  return render(
    new (Setting as unknown as new (el: HTMLElement) => never)(
      document.createElement('div'),
    ),
    group as never,
  )
}

describe('Pro settings section', () => {
  beforeEach(() => {
    DeviceListView.mockClear()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  test('is a page of its own, not part of the everyday settings', () => {
    const page = pageNamed(
      createTab(activeManager()).getSettingDefinitions(),
      'Pro settings',
    )

    expect(page?.type).toBe('page')
    // The entry shows the license state without opening the page.
    expect(page?.displayValue).toBeInstanceOf(Function)
    expect((page?.displayValue as () => string)()).toBe('Active')
  })

  describe('when not activated', () => {
    test('offers the activation code field', () => {
      expect(names(proItems(fakeManager()))).toContain('License code')
    })

    test('links to the purchase page for someone without a code', () => {
      const purchase = proItems(fakeManager()).find(
        (item) => 'desc' in item && typeof item.desc === 'object',
      )
      const desc = (purchase as { desc: DocumentFragment }).desc
      const link = desc.querySelector('a')

      expect(link?.getAttribute('href')).toBe('https://obsidian.levers.co.jp/')
      expect(link?.textContent).toBe('here')
      // The link belongs inside the sentence, with text on both sides of it.
      expect(desc.textContent).toBe('You can buy an activation code here.')
    })

    test('explains where the code comes from on its own row', () => {
      const items = proItems(fakeManager())

      expect(names(items)).toContain('About the license code')
      // The explanation must not also occupy the form as a standing paragraph.
      expect(descs(items).some((desc) => desc.includes('purchase email'))).toBe(
        false,
      )
    })

    test('sends Japanese users to the Japanese purchase page', () => {
      setLocaleOverride('ja')
      try {
        const purchase = proItems(fakeManager()).find(
          (item) => 'desc' in item && typeof item.desc === 'object',
        )
        const desc = (purchase as { desc: DocumentFragment }).desc

        expect(desc.querySelector('a')?.getAttribute('href')).toBe(
          'https://obsidian.levers.co.jp/ja/',
        )
      } finally {
        setLocaleOverride('en')
      }
    })

    test('does not show the device list or the AI settings', () => {
      const items = proItems(fakeManager())

      // Both need a license: the list needs the code to query, and the AI
      // settings would configure a runtime the gate refuses to start.
      expect(names(items)).not.toContain('AI task')
      expect(names(items)).not.toContain('Enable AI tasks')
      // The seat list is declared but hidden until a 409 supplies one.
      expect(names(items)).not.toContain('Devices')
    })

    test('explains a blocked license alongside the form', () => {
      const items = proItems(
        fakeManager({
          getState: () => ({ status: 'blocked', reason: 'license_revoked' }),
        }),
      )

      expect(descs(items).some((desc) => desc.includes('revoked'))).toBe(true)
      // Still activatable: a replacement code has to be enterable.
      expect(names(items)).toContain('License code')
    })
  })

  describe('when activated', () => {
    test('shows the license details', () => {
      const items = proItems(activeManager())

      expect(names(items)).toEqual(
        expect.arrayContaining(['Status', 'License ID', 'Expires', 'Devices']),
      )
      const licenseId = items.find(
        (item) => 'name' in item && item.name === 'License ID',
      )
      expect((licenseId as { desc: string }).desc).toBe('8F3K-2M9Q-X7RD-4WPZ')
    })

    test('mounts the device list and disposes it on teardown', () => {
      const devices = proItems(activeManager()).find(
        (item) => 'name' in item && item.name === 'Devices',
      )

      const cleanup = invokeRender(devices as SettingDefinitionItem)
      expect(DeviceListView).toHaveBeenCalledTimes(1)

      // The framework tears the row down before replacing it, which is what
      // keeps an in-flight request from writing into a container that is gone.
      const view = DeviceListView.mock.results[0].value as { dispose: jest.Mock }
      expect(view.dispose).not.toHaveBeenCalled()
      cleanup?.()
      expect(view.dispose).toHaveBeenCalledTimes(1)
    })

    test('shows the AI task settings', () => {
      const items = proItems(activeManager())

      expect(names(items)).toContain('Enable AI tasks')
    })

    test('does not offer the activation field again', () => {
      expect(names(proItems(activeManager()))).not.toContain('License code')
    })

    test('has no separate sign-out control', () => {
      // Releasing this device is done from the list like any other seat; a
      // second control that only cleared local state would just be confusing.
      expect(names(proItems(activeManager()))).not.toContain(
        'Deactivate on this device',
      )
    })
  })

  describe('visibility', () => {
    function context(manager: LicenseManager | undefined): SectionContext & {
      plugin: { licenseManager: LicenseManager | undefined }
    } {
      return {
        app: mockApp,
        plugin: { licenseManager: manager },
        update: jest.fn(),
        refreshDomState: jest.fn(),
      } as unknown as SectionContext & {
        plugin: { licenseManager: LicenseManager | undefined }
      }
    }

    function unlockedState(): ProUnlockState {
      const unlock = new ProUnlockState()
      for (let i = 0; i < PRO_SECTION_UNLOCK_CLICKS; i += 1) unlock.registerClick()
      return unlock
    }

    test('stays hidden without a license until the click unlock', () => {
      expect(isProSectionVisible(context(fakeManager()), new ProUnlockState())).toBe(false)
      expect(isProSectionVisible(context(fakeManager()), unlockedState())).toBe(true)
      expect(isProSectionVisible(context(undefined), new ProUnlockState())).toBe(false)
    })

    test('shows for an active license without any unlock clicks', () => {
      // Otherwise a paying user loses the AI settings and the seat list on
      // every reload, with no way back except rediscovering the click unlock.
      expect(isProSectionVisible(context(activeManager()), new ProUnlockState())).toBe(true)
    })

    test('hides again when the license goes away mid-session', () => {
      // Releasing this device leaves an unlicensed manager behind. Nothing is
      // latched, so the section goes back into hiding with it.
      const ctx = context(activeManager())
      const unlock = new ProUnlockState()
      expect(isProSectionVisible(ctx, unlock)).toBe(true)

      ctx.plugin.licenseManager = fakeManager()
      expect(isProSectionVisible(ctx, unlock)).toBe(false)
    })

    test('the page itself is hidden while the section is locked', () => {
      const page = pageNamed(
        createTab(fakeManager()).getSettingDefinitions(),
        'Pro settings',
      )

      expect(isVisible(page as { visible?: boolean | (() => boolean) })).toBe(false)
    })
  })

  test('degrades to an error when the manager failed to start', () => {
    const items = proItems(undefined)

    expect(DeviceListView).not.toHaveBeenCalled()
    expect(names(items)).not.toContain('License code')
    expect(names(items)).not.toContain('Enable AI tasks')
    expect(descs(items).some((desc) => desc.includes('unexpected error'))).toBe(
      true,
    )
  })
})
