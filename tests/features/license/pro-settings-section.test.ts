/**
 * The Pro section is the only place a buyer can enter their code, and the only
 * place the AI settings live. Getting its two shapes wrong either strands a
 * paying user with nowhere to activate, or shows AI settings for a feature the
 * gate will refuse to start.
 */
import { Setting, mockApp } from 'obsidian'

import { TaskChuteSettingTab } from '../../../src/settings/SettingsTab'
import type { LicenseManager } from '../../../src/features/license/services/LicenseManager'

jest.mock('../../../src/features/license/ui/DeviceListView', () => ({
  DeviceListView: jest.fn().mockImplementation(() => ({ dispose: jest.fn() })),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DeviceListView } = require('../../../src/features/license/ui/DeviceListView') as {
  DeviceListView: jest.Mock
}

interface SettingStub {
  name?: string
  desc?: string
  heading: boolean
  setName: jest.Mock
  setDesc: jest.Mock
  setHeading: jest.Mock
  addToggle: jest.Mock
  addText: jest.Mock
  addButton: jest.Mock
  addDropdown: jest.Mock
  controlEl: HTMLElement
}

const SettingMock = Setting as unknown as jest.Mock
const originalSettingImpl = SettingMock.getMockImplementation()

let settings: SettingStub[]

function installSettingStub(): void {
  SettingMock.mockImplementation(() => {
    const instance: SettingStub = {
      heading: false,
      setName: jest.fn((name: string) => {
        instance.name = name
        return instance
      }),
      setDesc: jest.fn((desc: string) => {
        instance.desc = desc
        return instance
      }),
      setHeading: jest.fn(() => {
        instance.heading = true
        return instance
      }),
      addToggle: jest.fn(() => instance),
      addText: jest.fn(() => instance),
      addButton: jest.fn(() => instance),
      addDropdown: jest.fn(() => instance),
      controlEl: document.createElement('div'),
    }
    settings.push(instance)
    return instance
  })
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

// Intersecting the class itself would collapse to `never`: renderProSection is
// private on TaskChuteSettingTab, so it would exist in both constituents with
// incompatible declarations. Omit strips it and lets the test re-declare it.
type MutableSettingTab = Omit<
  TaskChuteSettingTab,
  'app' | 'plugin' | 'renderProSection'
> & {
  app: unknown
  plugin: unknown
  renderProSection: (container: HTMLElement) => void
}

function renderPro(manager: LicenseManager | undefined): HTMLElement {
  const tab = Object.create(TaskChuteSettingTab.prototype) as MutableSettingTab
  tab.app = { ...mockApp, plugins: { plugins: {} } }
  tab.plugin = {
    manifest: { id: 'taskchute-plus', version: '2.0.1' },
    settings: { aiTaskEnabled: false, aiTaskRunMode: 'terminal', aiTaskLogRetentionDays: 30 },
    saveSettings: jest.fn().mockResolvedValue(undefined),
    licenseManager: manager,
    aiTaskManagersPendingDisposal: new Set(),
  }

  const container = document.createElement('div')
  tab.renderProSection(container)
  return container
}

const names = () => settings.map((setting) => setting.name).filter(Boolean)

describe('Pro settings section', () => {
  beforeEach(() => {
    settings = []
    DeviceListView.mockClear()
    installSettingStub()
  })

  afterEach(() => {
    SettingMock.mockImplementation(originalSettingImpl)
    jest.clearAllMocks()
  })

  test('is a collapsed section headed "Pro settings"', () => {
    const container = renderPro(fakeManager())

    const details = container.querySelector('details.taskchute-collapsible-section')
    expect(details).not.toBeNull()
    // Closed by default: the license is set once and then left alone.
    expect((details as HTMLDetailsElement).open).toBe(false)
    expect(details?.querySelector('summary')?.textContent).toBe('Pro settings')
  })

  test('renders its settings inside the collapsible content, not beside it', () => {
    const container = renderPro(fakeManager())

    // Anything appended to the container itself would stay visible while
    // the section is collapsed.
    expect(container.children).toHaveLength(1)
    expect(
      container.querySelector('.taskchute-collapsible-content')?.children.length,
    ).toBeGreaterThan(0)
  })

  describe('when not activated', () => {
    test('offers the activation code field', () => {
      renderPro(fakeManager())

      expect(names()).toContain('Activation code')
    })

    test('does not render the device list or the AI settings', () => {
      renderPro(fakeManager())

      // Both need a license: the list needs the code to query, and the AI
      // settings would configure a runtime the gate refuses to start.
      expect(DeviceListView).not.toHaveBeenCalled()
      expect(names()).not.toContain('AI task')
      expect(names()).not.toContain('Enable AI tasks')
    })

    test('explains a blocked license above the form', () => {
      const container = renderPro(
        fakeManager({ getState: () => ({ status: 'blocked', reason: 'license_revoked' }) }),
      )

      const descriptions = settings.map((setting) => setting.desc).filter(Boolean)
      expect(descriptions.some((desc) => desc?.includes('revoked'))).toBe(true)
      // Still activatable: a replacement code has to be enterable.
      expect(names()).toContain('Activation code')
      expect(container).toBeDefined()
    })
  })

  describe('when activated', () => {
    test('shows the license details', () => {
      renderPro(activeManager())

      expect(names()).toEqual(
        expect.arrayContaining(['Status', 'License ID', 'Expires', 'Devices']),
      )
      const licenseId = settings.find((setting) => setting.name === 'License ID')
      expect(licenseId?.desc).toBe('8F3K-2M9Q-X7RD-4WPZ')
    })

    test('renders the device list inline', () => {
      renderPro(activeManager())

      expect(DeviceListView).toHaveBeenCalledTimes(1)
    })

    test('renders the AI task settings', () => {
      renderPro(activeManager())

      expect(names()).toContain('AI task')
      expect(names()).toContain('Enable AI tasks')
    })

    test('does not offer the activation field again', () => {
      renderPro(activeManager())

      expect(names()).not.toContain('Activation code')
    })

    test('has no separate sign-out control', () => {
      renderPro(activeManager())

      // Releasing this device is done from the list like any other seat; a
      // second control that only cleared local state would just be confusing.
      expect(names()).not.toContain('Deactivate on this device')
    })
  })

  describe('visibility', () => {
    interface VisibilityTab {
      plugin: unknown
      proSectionUnlocked: boolean
      isProSectionVisible: () => boolean
    }

    function visibility(
      manager: LicenseManager | undefined,
      unlocked = false,
    ): { tab: VisibilityTab; visible: boolean } {
      const tab = Object.create(TaskChuteSettingTab.prototype) as VisibilityTab
      tab.plugin = { licenseManager: manager }
      tab.proSectionUnlocked = unlocked

      return { tab, visible: tab.isProSectionVisible() }
    }

    test('stays hidden without a license until the click unlock', () => {
      expect(visibility(fakeManager()).visible).toBe(false)
      expect(visibility(fakeManager(), true).visible).toBe(true)
      expect(visibility(undefined).visible).toBe(false)
    })

    test('shows for an active license without any unlock clicks', () => {
      // Otherwise a paying user loses the AI settings and the seat list on
      // every reload, with no way back except rediscovering the click unlock.
      expect(visibility(activeManager()).visible).toBe(true)
    })

    test('hides again when the license goes away mid-session', () => {
      // Releasing this device redraws with an unlicensed manager. Nothing is
      // latched, so the section goes back into hiding with it.
      const { tab } = visibility(activeManager())
      expect(tab.proSectionUnlocked).toBe(false)

      tab.plugin = { licenseManager: fakeManager() }
      expect(tab.isProSectionVisible()).toBe(false)
    })
  })

  test('degrades to an error when the manager failed to start', () => {
    renderPro(undefined)

    expect(DeviceListView).not.toHaveBeenCalled()
    expect(names()).not.toContain('Activation code')
    expect(names()).not.toContain('Enable AI tasks')
  })
})
