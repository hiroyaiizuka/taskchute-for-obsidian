/**
 * The Pro section is the only place a buyer can enter their code, and the only
 * place the AI settings live. Getting its two shapes wrong either strands a
 * paying user with nowhere to activate, or shows AI settings for a feature the
 * gate will refuse to start.
 */
import type {
  SettingDefinitionAction,
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

jest.mock('../../../src/ui/modals/ConfirmModal', () => ({
  showConfirmModal: jest.fn().mockResolvedValue(true),
  showInfoModal: jest.fn().mockResolvedValue(undefined),
}))

const { DeviceListView } = require('../../../src/features/license/ui/DeviceListView') as {
  DeviceListView: jest.Mock
}

const { showConfirmModal } = require('../../../src/ui/modals/ConfirmModal') as {
  showConfirmModal: jest.Mock
}

function fakeManager(
  overrides: Partial<Record<keyof LicenseManager, unknown>> = {},
): LicenseManager {
  return {
    getState: () => ({ status: 'unlicensed' }),
    isActive: () => false,
    getDeviceId: () => 'DEVICE-0001',
    getLicenseSummary: () => undefined,
    // What the screen may show and act with, which is not simply
    // settings.licenseCode: a device that gave up its seat has none.
    getStoredCode: () => undefined,
    isSeatReleased: () => false,
    activate: jest.fn(),
    listDevices: jest.fn(),
    deactivateDevice: jest.fn(),
    refreshIfNeeded: jest.fn().mockResolvedValue(undefined),
    verifyDeviceRegistration: jest.fn().mockResolvedValue('unknown'),
    syncFromServer: jest.fn().mockResolvedValue({ status: 'unlicensed' }),
    onChange: jest.fn(() => () => undefined),
    ...overrides,
  } as unknown as LicenseManager
}

const CODE = 'TCP-AAAA-BBBB-CCCC-DDDD'

const ACTIVE_SUMMARY = {
  license_id: '8F3K2M9QX7RD4WPZ',
  max_devices: 3,
  devices_used: 2,
  expires_at: null,
}

/**
 * An activated device. Without a stored code it is the state a vault reaches
 * when the token was issued elsewhere — licensed, but unable to make a single
 * request, since every one of them needs the code.
 */
function activeManager(storedCode?: string): LicenseManager {
  return fakeManager({
    getState: () => ({ status: 'active', token: {}, license: ACTIVE_SUMMARY }),
    isActive: () => true,
    getLicenseSummary: () => ACTIVE_SUMMARY,
    getStoredCode: () => storedCode,
    syncFromServer: jest
      .fn()
      .mockResolvedValue({ status: 'active', token: {}, license: ACTIVE_SUMMARY }),
  })
}

function createTab(
  manager: LicenseManager | undefined,
  licenseCode?: string,
): TaskChuteSettingTab {
  const app = { ...mockApp, plugins: { plugins: {} } }
  const plugin = {
    app,
    manifest: { id: 'taskchute-plus', version: '2.2.0' },
    settings: {
      slotKeys: {},
      aiTaskEnabled: false,
      aiTaskRunMode: 'terminal',
      aiTaskLogRetentionDays: 30,
      licenseCode,
    },
    pathManager: { validatePath: () => ({ valid: true }) },
    saveSettings: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    licenseManager: manager,
    aiTaskManagersPendingDisposal: new Set(),
  }
  return new TaskChuteSettingTab(app as never, plugin as never)
}

/** The rows on the Pro page, with the page's own visibility ignored. */
function proItems(
  manager: LicenseManager | undefined,
  licenseCode?: string,
): SettingDefinitionItem[] {
  const page = pageNamed(
    createTab(manager, licenseCode).getSettingDefinitions(),
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

function headings(items: SettingDefinitionItem[]): string[] {
  return items
    .filter((item) => isVisible(item as { visible?: boolean | (() => boolean) }))
    .map((item) => ('heading' in item ? item.heading : undefined))
    .filter((heading): heading is string => Boolean(heading))
}

function descs(items: SettingDefinitionItem[]): string[] {
  return items
    .map((item) => ('desc' in item ? item.desc : undefined))
    .map((desc) =>
      typeof desc === 'string' ? desc : (desc?.textContent ?? ''),
    )
    .filter(Boolean)
}

/** The row that carries the whole activation form. */
function codeItem(manager: LicenseManager): SettingDefinitionItem {
  const item = proItems(manager).find(
    (candidate) => 'name' in candidate && candidate.name === 'License code',
  )
  if (!item) throw new Error('License code row not found')
  return item
}

/**
 * The row that mounts the seat list. Nameless by design — the group heading
 * above it says "Devices" — so it is found by shape.
 */
function deviceItem(manager: LicenseManager): SettingDefinitionItem {
  const item = proItems(manager).find(
    (candidate) =>
      'render' in candidate &&
      candidate.render !== undefined &&
      'name' in candidate &&
      candidate.name === '',
  )
  if (!item) throw new Error('Device list row not found')
  return item
}

/** The row that gives up the licence on this device. */
function signOutItem(manager: LicenseManager): SettingDefinitionItem {
  const item = proItems(manager).find(
    (candidate) =>
      'name' in candidate && candidate.name === 'Sign out on this device',
  )
  if (!item) throw new Error('Sign out row not found')
  return item
}

/** Clicks the purchase row and reports where it tried to send the user. */
function openPurchasePage(manager: LicenseManager): string | URL | undefined {
  // Found by shape rather than by name: the name is localized, and the
  // purchase row is the only one on this page that acts on a click.
  const item = proItems(manager).find(
    (candidate): candidate is SettingDefinitionAction =>
      'action' in candidate && candidate.action !== undefined,
  )
  const action = item?.action
  const open = jest.spyOn(window, 'open').mockReturnValue(null)

  try {
    action?.(document.createElement('div'), 0)
    return open.mock.calls[0]?.[0]
  } finally {
    open.mockRestore()
  }
}

type MockTextComponent = { __triggerChange: (value: string) => Promise<void> }
type MockButtonComponent = { __click: () => Promise<void>; text: string }

type MockSetting = {
  settingEl: HTMLElement
  nameEl: HTMLElement
  controlEl: HTMLElement
  __textComponents: MockTextComponent[]
  __buttons: MockButtonComponent[]
}

type RenderedRow = {
  cleanup: (() => void) | void
  setting: MockSetting
  group: { listEl: HTMLElement }
}

/** Runs a row's render callback against a throwaway row and group. */
function invokeRender(item: SettingDefinitionItem): RenderedRow {
  const render = (item as SettingDefinitionRender).render
  const group = new (SettingGroup as unknown as new (
    el: HTMLElement,
  ) => { listEl: HTMLElement })(document.createElement('div'))
  const setting = new (Setting as unknown as new (
    el: HTMLElement,
  ) => MockSetting)(document.createElement('div'))

  return {
    cleanup: render(setting as never, group as never),
    setting,
    group,
  }
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

    test('opens the purchase page from the row itself', () => {
      // The whole row is the target: an inline link inside a description is
      // both smaller and easy to miss on the screen someone lands on with no
      // code in hand.
      expect(openPurchasePage(fakeManager())).toBe(
        'https://obsidian.levers.co.jp/howto/pro-license',
      )
    })

    test('explains where the code comes from behind the label', () => {
      const items = proItems(fakeManager())

      // A row of its own would separate the note from the field it explains.
      expect(names(items)).not.toContain('About the license code')
      // Nor may it occupy the form as a standing paragraph.
      expect(descs(items).some((desc) => desc.includes('purchase email'))).toBe(
        false,
      )

      const { setting } = invokeRender(codeItem(fakeManager()))
      const help = setting.nameEl.querySelector('.taskchute-license-code__help')

      expect(help?.getAttribute('aria-label')).toBe('About the license code')
    })

    test('sends Japanese users to the Japanese purchase page', () => {
      setLocaleOverride('ja')
      try {
        expect(openPurchasePage(fakeManager())).toBe(
          'https://obsidian.levers.co.jp/ja/howto/pro-license',
        )
      } finally {
        setLocaleOverride('en')
      }
    })

    test('activates with the code typed into the row', async () => {
      const manager = fakeManager({
        activate: jest.fn().mockResolvedValue({ ok: true }),
      })
      const { setting } = invokeRender(codeItem(manager))

      await setting.__textComponents[0].__triggerChange('TCP-AAAA-BBBB-CCCC')
      await setting.__buttons[0].__click()

      expect(manager.activate).toHaveBeenCalledWith('TCP-AAAA-BBBB-CCCC')
    })

    test('reports a failed activation with its message and error code', async () => {
      // Support is asked for the code, so the row has to carry both halves:
      // what the user should do, and what identifies the failure.
      const manager = fakeManager({
        activate: jest.fn().mockResolvedValue({
          ok: false,
          failure: { ok: false, kind: 'api', code: 'invalid_code', status: 404 },
        }),
      })
      const tab = createTab(manager)
      const items = () => {
        const page = pageNamed(
          tab.getSettingDefinitions(),
          t('settings.pro.heading', 'Pro settings'),
        )
        if (!page) throw new Error('Pro page not found')
        return flatten(page.items ?? [])
      }
      const codeRow = () => {
        const item = items().find(
          (candidate) => 'name' in candidate && candidate.name === 'License code',
        )
        if (!item) throw new Error('License code row not found')
        return item
      }
      const { setting } = invokeRender(codeRow())

      await setting.__textComponents[0].__triggerChange('TCP-AAAA-BBBB-CCCC')
      await setting.__buttons[0].__click()

      const desc = descs([codeRow()])[0] ?? ''
      expect(desc).toContain('was not found')
      expect(desc).toContain('invalid_code')
      // And it is marked as an error, not left reading as help text.
      const { setting: failed } = invokeRender(codeRow())
      expect(
        failed.settingEl.classList.contains('taskchute-license-code-item--error'),
      ).toBe(true)
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
      const items = proItems(activeManager(CODE), CODE)

      // Two sections: the licence to read, the seats to act on.
      expect(headings(items)).toEqual(
        expect.arrayContaining(['License', 'Devices']),
      )
    })

    test('shows the code that was entered, not the id derived from it', () => {
      // What the user holds and would re-enter elsewhere is the code; the id
      // means nothing to them.
      const items = proItems(activeManager(CODE), CODE)

      expect(names(items)).toContain('License code')
      expect(names(items)).not.toContain('License ID')
      expect(descs(items)).toContain('TCP-AAAA-BBBB-CCCC-DDDD')
    })

    test('falls back to the license id when there is no usable code', () => {
      // The code may still be in data.json — it has to be, other machines share
      // it — but this device may no longer use it, so showing it here would be
      // offering something that does nothing.
      const items = proItems(activeManager(), CODE)

      expect(names(items)).not.toContain('License code')
      expect(descs(items)).not.toContain('TCP-AAAA-BBBB-CCCC-DDDD')
      expect(names(items)).toContain('License ID')

      const licenseId = items.find(
        (item) => 'name' in item && item.name === 'License ID',
      )
      expect((licenseId as { desc: string }).desc).toBe('8F3K-2M9Q-X7RD-4WPZ')
    })

    test('drops the status and expiry rows', () => {
      // The page header already reads "Active", and neither row is something
      // anyone acts on; the seats below are.
      const shown = names(proItems(activeManager()))

      expect(shown).not.toContain('Status')
      expect(shown).not.toContain('Expires')
    })

    test('mounts the device list and disposes it on teardown', () => {
      const { cleanup } = invokeRender(deviceItem(activeManager(CODE)))
      expect(DeviceListView).toHaveBeenCalledTimes(1)

      // The framework tears the row down before replacing it, which is what
      // keeps an in-flight request from writing into a container that is gone.
      const view = DeviceListView.mock.results[0].value as { dispose: jest.Mock }
      expect(view.dispose).not.toHaveBeenCalled()
      cleanup?.()
      expect(view.dispose).toHaveBeenCalledTimes(1)
    })

    /**
     * Obsidian finishes a group by setting its list to exactly the rows'
     * elements, so a list mounted into the group is removed in the same render
     * pass — the row ends up showing its name and nothing else. Mounting into
     * the row's own control element is what keeps the seats on screen.
     */
    test('mounts the device list into the row, not the group', () => {
      const { setting, group } = invokeRender(deviceItem(activeManager(CODE)))

      const container = DeviceListView.mock.calls[0][0] as HTMLElement
      expect(container).toBe(setting.controlEl)
      expect(container).not.toBe(group.listEl)
      expect(setting.settingEl.className).toContain(
        'taskchute-license-devices-item',
      )
    })

    test('shows the AI task settings', () => {
      const items = proItems(activeManager())

      expect(names(items)).toContain('Enable AI tasks')
    })

    test('does not offer the activation field again', () => {
      // The row named for the code is the licence being displayed, not a form:
      // it carries the code as its value and has nothing to type into.
      const items = proItems(activeManager(CODE), CODE)
      const row = items.find(
        (item) => 'name' in item && item.name === 'License code',
      )

      expect(row).toBeDefined()
      expect('render' in (row ?? {})).toBe(false)
      expect((row as { desc: string }).desc).toBe(CODE)
    })

    /**
     * The token lives in device-local storage and the code in the synced vault
     * settings, so a vault can be licensed while holding no code at all. Every
     * request needs the code, so the seat list can only fail — and the active
     * screen has no field to supply one. Without a way out, the device is stuck
     * there until the token expires.
     */
    describe('and this vault holds no code', () => {
      test('offers a way out instead of a seat list that cannot work', () => {
        const items = proItems(activeManager())

        expect(names(items)).toContain('Sign out on this device')
        // The list needs the code for its every request, so all it could show
        // is a permanent no_activation_code.
        expect(headings(items)).not.toContain('Devices')
      })

      test('signs out on this device once confirmed', async () => {
        const manager = fakeManager({
          getState: () => ({ status: 'active', token: {}, license: ACTIVE_SUMMARY }),
          isActive: () => true,
          getLicenseSummary: () => ACTIVE_SUMMARY,
          getStoredCode: () => undefined,
          signOutLocally: jest.fn(),
        })
        showConfirmModal.mockResolvedValueOnce(true)

        const { setting } = invokeRender(signOutItem(manager))
        await setting.__buttons[0].__click()

        expect(manager.signOutLocally).toHaveBeenCalledTimes(1)
      })

      test('keeps the license when the confirmation is declined', async () => {
        const manager = fakeManager({
          getState: () => ({ status: 'active', token: {}, license: ACTIVE_SUMMARY }),
          isActive: () => true,
          getLicenseSummary: () => ACTIVE_SUMMARY,
          getStoredCode: () => undefined,
          signOutLocally: jest.fn(),
        })
        showConfirmModal.mockResolvedValueOnce(false)

        const { setting } = invokeRender(signOutItem(manager))
        await setting.__buttons[0].__click()

        expect(manager.signOutLocally).not.toHaveBeenCalled()
      })
    })

    test('has no separate sign-out control while the code is usable', () => {
      // Releasing this device is done from the list like any other seat; a
      // second control that only cleared local state would just be confusing.
      expect(names(proItems(activeManager(CODE), CODE))).not.toContain(
        'Sign out on this device',
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

describe('when the Pro page is shown', () => {
  // The page's items are built with the rest of the tab's definitions, long
  // before anyone navigates into it. A row's render callback is the only thing
  // that runs at the moment the page is actually drawn, which makes it the hook
  // for "check whether this device is still licensed".
  test('the activation form re-asks the server', () => {
    const manager = fakeManager()
    const row = codeItem(manager)
    ;(manager.syncFromServer as jest.Mock).mockClear()

    invokeRender(row)

    expect(manager.syncFromServer).toHaveBeenCalled()
  })

  test('the seat list re-asks the server', () => {
    const manager = activeManager(CODE)
    const row = deviceItem(manager)
    ;(manager.syncFromServer as jest.Mock).mockClear()

    invokeRender(row)

    expect(manager.syncFromServer).toHaveBeenCalled()
  })
})
