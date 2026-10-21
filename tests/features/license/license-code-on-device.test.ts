import { moveLicenseCodeToDevice, type LicensePluginLike } from '@/features/license'
import {
  LICENSE_CODE_STORAGE_KEY,
  LicenseStore,
  type LicenseStorageBridge,
} from '@/features/license/services/LicenseStore'

// LEV-389: the activation code is kept on this device, beside the token, and
// no longer in the plugin settings, which a vault syncs.

function objectBridge(): LicenseStorageBridge & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>()
  return {
    values,
    loadLocalStorage: (key) => values.get(key),
    saveLocalStorage: (key, value) => {
      values.set(key, value)
    },
  }
}

/** window.localStorage as createDeviceLocalStorageBridge wraps it: JSON text. */
function textBridge(): LicenseStorageBridge & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    loadLocalStorage: (key) => values.get(key),
    saveLocalStorage: (key, value) => {
      values.set(key, JSON.stringify(value))
    },
  }
}

function pluginWith(licenseCode: string | undefined): LicensePluginLike & {
  saveSettings: jest.Mock
} {
  return {
    app: {} as LicensePluginLike['app'],
    settings: { licenseCode } as LicensePluginLike['settings'],
    saveSettings: jest.fn(() => Promise.resolve()),
  }
}

describe('LicenseStore code', () => {
  test.each([
    ['Obsidian storage (parsed values)', objectBridge],
    ['raw localStorage (JSON text)', textBridge],
  ])('%s: keeps, reads back, and forgets the code', (_label, makeBridge) => {
    const store = new LicenseStore(makeBridge())
    expect(store.getCode()).toBeUndefined()

    store.setCode('  ABCD-EFGH-1234  ')
    expect(store.getCode()).toBe('ABCD-EFGH-1234')

    store.setCode(undefined)
    expect(store.getCode()).toBeUndefined()
  })

  test('a code that looks like a number survives a JSON round trip', () => {
    const store = new LicenseStore(textBridge())
    store.setCode('12345678')
    expect(store.getCode()).toBe('12345678')
  })

  test('anything else stored under the key reads as no code', () => {
    const bridge = objectBridge()
    const store = new LicenseStore(bridge)
    bridge.values.set(LICENSE_CODE_STORAGE_KEY, 'not an object')
    expect(store.getCode()).toBeUndefined()
    bridge.values.set(LICENSE_CODE_STORAGE_KEY, { code: 42 })
    expect(store.getCode()).toBeUndefined()
  })
})

describe('moveLicenseCodeToDevice', () => {
  test('moves a synced code onto this device and out of the settings', async () => {
    const store = new LicenseStore(objectBridge())
    const plugin = pluginWith('ABCD-EFGH-1234')

    moveLicenseCodeToDevice(plugin, store)
    await Promise.resolve()

    expect(store.getCode()).toBe('ABCD-EFGH-1234')
    expect('licenseCode' in plugin.settings).toBe(false)
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1)
  })

  test("keeps this device's own code, and still drops the synced one", () => {
    const store = new LicenseStore(objectBridge())
    store.setCode('MINE-0000-0000')
    const plugin = pluginWith('THEIRS-1111-1111')

    moveLicenseCodeToDevice(plugin, store)

    expect(store.getCode()).toBe('MINE-0000-0000')
    expect(plugin.settings.licenseCode).toBeUndefined()
  })

  test('says so when the synced code differs from the one on this device', () => {
    const store = new LicenseStore(objectBridge())
    store.setCode('MINE-0000-0000')
    const log = jest.fn()

    moveLicenseCodeToDevice(pluginWith('THEIRS-1111-1111'), store, log)
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('differs'))

    log.mockClear()
    moveLicenseCodeToDevice(pluginWith('MINE-0000-0000'), store, log)
    expect(log).not.toHaveBeenCalled()
  })

  test('leaves the synced code alone when this device cannot keep one', () => {
    const store = new LicenseStore({
      loadLocalStorage: () => undefined,
      saveLocalStorage: () => {
        throw new Error('storage unavailable')
      },
    })
    const plugin = pluginWith('ABCD-EFGH-1234')

    moveLicenseCodeToDevice(plugin, store)

    expect(plugin.settings.licenseCode).toBe('ABCD-EFGH-1234')
    expect(plugin.saveSettings).not.toHaveBeenCalled()
  })

  test('does nothing without a synced code', () => {
    const store = new LicenseStore(objectBridge())
    const plugin = pluginWith(undefined)

    moveLicenseCodeToDevice(plugin, store)

    expect(plugin.saveSettings).not.toHaveBeenCalled()
    expect(store.getCode()).toBeUndefined()
  })
})
