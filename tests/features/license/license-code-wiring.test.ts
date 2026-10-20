/**
 * LEV-389: createLicenseManager wires the activation code to this device. An
 * activation must land in the device store and leave the synced settings
 * (data.json) alone; going back to settings.licenseCode would put the code
 * where anyone handed the vault could read it.
 */
import { GOLDEN_PUBLIC_KEY } from '@/features/license/token/goldenVector'

jest.mock('@/features/license/config', () => ({
  ...jest.requireActual<Record<string, unknown>>('../../../src/features/license/config'),
  LICENSE_PUBLIC_KEY: GOLDEN_PUBLIC_KEY,
}))

const issueToken = jest.fn()

jest.mock('@/features/license/services/LicenseApiClient', () => ({
  LicenseApiClient: jest.fn().mockImplementation(() => ({
    issueToken,
    listDevices: jest.fn(),
    deactivateDevice: jest.fn(),
  })),
}))

import { createLicenseManager, type LicensePluginLike } from '@/features/license'
import { LICENSE_CODE_STORAGE_KEY } from '@/features/license/services/LicenseStore'
import { signTestToken } from './signTestToken'

const CODE = 'TCP-0000-0000-0000-0001'
const DAY = 24 * 60 * 60

function plugin(): LicensePluginLike & { saveSettings: jest.Mock } {
  return {
    // The vault-scoped store, read only to migrate an older install.
    app: {
      loadLocalStorage: () => null,
      saveLocalStorage: () => undefined,
    } as unknown as LicensePluginLike['app'],
    settings: {} as LicensePluginLike['settings'],
    saveSettings: jest.fn(() => Promise.resolve()),
  }
}

beforeEach(() => {
  window.localStorage.clear()
  issueToken.mockReset()
  issueToken.mockImplementation((request: { deviceId: string }) => {
    const now = Math.floor(Date.now() / 1000)
    return Promise.resolve({
      ok: true,
      data: {
        token: signTestToken({
          deviceId: request.deviceId,
          issuedAt: now - 60,
          expiresAt: now + 7 * DAY,
        }),
        expires_at: now + 7 * DAY,
        license: { max_devices: 3, devices_used: 1, expires_at: null },
      },
    })
  })
})

test('an activation keeps the code on this device, not in the synced settings', async () => {
  const host = plugin()
  const manager = createLicenseManager(host)

  const result = await manager.activate(CODE)

  expect(result.ok).toBe(true)
  expect(manager.getStoredCode()).toBe(CODE)
  const stored = window.localStorage.getItem(LICENSE_CODE_STORAGE_KEY)
  expect(stored === null ? null : (JSON.parse(stored) as unknown)).toEqual({ code: CODE })
  expect('licenseCode' in host.settings).toBe(false)
  expect(host.saveSettings).not.toHaveBeenCalled()
})

test('a code in the synced settings is not what the manager acts with', () => {
  // Another device's copy, left in data.json while this device keeps its own.
  window.localStorage.setItem(LICENSE_CODE_STORAGE_KEY, JSON.stringify({ code: CODE }))
  const host = plugin()
  host.settings.licenseCode = 'TCP-1111-1111-1111-1111'

  const manager = createLicenseManager(host)

  expect(manager.getStoredCode()).toBe(CODE)
  expect('licenseCode' in host.settings).toBe(false)
})
