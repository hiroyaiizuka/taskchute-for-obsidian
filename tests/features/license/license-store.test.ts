import {
  createDeviceLocalStorageBridge,
  generateDeviceId,
  LICENSE_DEVICE_STATE_STORAGE_KEY,
  LicenseStore,
  type LicenseStorageBridge,
} from '../../../src/features/license/services/LicenseStore'

function createBridge(initial?: unknown): LicenseStorageBridge & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  if (initial !== undefined) store.set(LICENSE_DEVICE_STATE_STORAGE_KEY, initial)

  return {
    store,
    loadLocalStorage: (key: string) => store.get(key),
    saveLocalStorage: (key: string, value: unknown) => {
      store.set(key, value)
    },
  }
}

const SUMMARY = { license_id: 'L1', max_devices: 3, devices_used: 1, expires_at: null }

/**
 * A freshly minted id is a v4 UUID. Ids already stored by older versions keep
 * whatever shape they had — the `DEVICE-…` fixtures below cover that, and it
 * matters: a new id is a new seat.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('generateDeviceId', () => {
  test('produces an id inside the API length constraint', () => {
    const id = generateDeviceId()
    expect(id.length).toBeGreaterThanOrEqual(8)
    expect(id.length).toBeLessThanOrEqual(64)
    expect(id).toMatch(UUID_V4)
  })

  test('does not repeat', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateDeviceId()))
    expect(ids.size).toBe(50)
  })
})

describe('LicenseStore', () => {
  test('generates and immediately persists a device id on first use', () => {
    const bridge = createBridge()
    const store = new LicenseStore(bridge)

    const persisted = bridge.store.get(LICENSE_DEVICE_STATE_STORAGE_KEY) as { deviceId: string }
    expect(persisted.deviceId).toBe(store.getDeviceId())
  })

  test('keeps the same device id across instances', () => {
    const bridge = createBridge()
    const first = new LicenseStore(bridge).getDeviceId()

    expect(new LicenseStore(bridge).getDeviceId()).toBe(first)
  })

  test('saves and reloads a token', () => {
    const bridge = createBridge()
    new LicenseStore(bridge).saveToken('TCPT1.a.b', 1787604800, SUMMARY, 1787000000)

    const reloaded = new LicenseStore(bridge).getState()
    expect(reloaded.token).toBe('TCPT1.a.b')
    expect(reloaded.expiresAt).toBe(1787604800)
    expect(reloaded.license).toEqual(SUMMARY)
  })

  test('parses a legacy JSON string payload', () => {
    const bridge = createBridge(JSON.stringify({ deviceId: 'DEVICE-LEGACY01', token: 't' }))

    expect(new LicenseStore(bridge).getState()).toMatchObject({
      deviceId: 'DEVICE-LEGACY01',
      token: 't',
    })
  })

  test.each([
    ['a corrupt blob', 'not json'],
    ['a non-object', 42],
    ['a device id that is too short', { deviceId: 'short' }],
  ])('replaces %s with a fresh device id', (_label, stored) => {
    const store = new LicenseStore(createBridge(stored))

    expect(store.getDeviceId()).toMatch(UUID_V4)
    expect(store.getState().token).toBeUndefined()
  })

  test('drops fields with the wrong type instead of trusting them', () => {
    const bridge = createBridge({
      deviceId: 'DEVICE-00000001',
      token: 123,
      expiresAt: 'soon',
      license: { license_id: 'L1' },
    })

    const state = new LicenseStore(bridge).getState()
    expect(state.token).toBeUndefined()
    expect(state.expiresAt).toBeUndefined()
    expect(state.license).toBeUndefined()
  })

  describe('refresh secret', () => {
    test('round-trips beside the token', () => {
      const bridge = createBridge()
      new LicenseStore(bridge).saveToken(
        'TCPT1.a.b',
        1787604800,
        SUMMARY,
        1787000000,
        'generation-1',
      )

      expect(new LicenseStore(bridge).getState().refreshSecret).toBe('generation-1')
    })

    test('is kept when a response carries none', () => {
      // A server that has not rolled rotation out yet. Dropping the secret would
      // force a code re-entry for no reason.
      const store = new LicenseStore(createBridge())
      store.saveToken('TCPT1.a.b', 1, SUMMARY, 1787000000, 'generation-1')

      store.saveToken('TCPT1.c.d', 2, SUMMARY, 1787000001)

      expect(store.getState().refreshSecret).toBe('generation-1')
    })

    test('goes away with the token', () => {
      // It is what lets this machine renew unattended, so a device that has just
      // been told it is unlicensed must not keep one.
      const store = new LicenseStore(createBridge())
      store.saveToken('TCPT1.a.b', 1, SUMMARY, 1787000000, 'generation-1')

      store.clearToken()

      expect(store.getState().refreshSecret).toBeUndefined()
    })

    test('goes away when the seat is released', () => {
      const store = new LicenseStore(createBridge())
      store.saveToken('TCPT1.a.b', 1, SUMMARY, 1787000000, 'generation-1')

      store.markSeatReleased(1787100000)

      expect(store.getState().refreshSecret).toBeUndefined()
    })

    test('ignores a stored value with the wrong type', () => {
      const bridge = createBridge({ deviceId: 'DEVICE-00000001', refreshSecret: 42 })

      expect(new LicenseStore(bridge).getState().refreshSecret).toBeUndefined()
    })
  })

  test('clearToken keeps the device id so re-activation reuses the seat', () => {
    const bridge = createBridge()
    const store = new LicenseStore(bridge)
    const deviceId = store.getDeviceId()
    store.saveToken('TCPT1.a.b', 1787604800, SUMMARY, 1787000000)

    store.clearToken()

    expect(store.getDeviceId()).toBe(deviceId)
    expect(store.getState().token).toBeUndefined()
    expect(new LicenseStore(bridge).getDeviceId()).toBe(deviceId)
  })

  describe('seat release latch', () => {
    test('markSeatReleased drops the token and survives a reload', () => {
      const bridge = createBridge()
      const store = new LicenseStore(bridge)
      const deviceId = store.getDeviceId()
      store.saveToken('TCPT1.a.b', 1787604800, SUMMARY, 1787000000)

      store.markSeatReleased(1787100000)

      expect(store.getState().token).toBeUndefined()
      expect(store.isSeatReleased()).toBe(true)

      // The latch has to outlive a restart, or the next launch would renew the
      // token and take the released seat straight back.
      const reloaded = new LicenseStore(bridge)
      expect(reloaded.isSeatReleased()).toBe(true)
      expect(reloaded.getState().seatReleasedAt).toBe(1787100000)
      // Same seat on re-activation, and the rollback watermark is untouched.
      expect(reloaded.getDeviceId()).toBe(deviceId)
      expect(reloaded.getState().lastServerTimeSec).toBe(1787000000)
    })

    test('clearToken alone leaves an existing latch in place', () => {
      const store = new LicenseStore(createBridge())
      store.markSeatReleased(1787100000)

      store.clearToken()

      expect(store.isSeatReleased()).toBe(true)
    })

    test('clearSeatReleased lifts it', () => {
      const bridge = createBridge()
      const store = new LicenseStore(bridge)
      store.markSeatReleased(1787100000)

      store.clearSeatReleased()

      expect(store.isSeatReleased()).toBe(false)
      expect(new LicenseStore(bridge).isSeatReleased()).toBe(false)
    })
  })

  test('survives a storage bridge that throws', () => {
    const bridge: LicenseStorageBridge = {
      loadLocalStorage: () => {
        throw new Error('unavailable')
      },
      saveLocalStorage: () => {
        throw new Error('unavailable')
      },
    }

    const store = new LicenseStore(bridge)
    expect(() => store.saveToken('TCPT1.a.b', 1, SUMMARY, 1787000000)).not.toThrow()
    expect(store.getDeviceId()).toMatch(UUID_V4)
  })

  describe('clock rollback detection', () => {
    const TOLERANCE = 24 * 60 * 60

    test('reports nothing before the first successful response', () => {
      const store = new LicenseStore(createBridge())
      expect(store.isClockRolledBack(0, TOLERANCE)).toBe(false)
    })

    test('flags a clock wound back past the tolerance', () => {
      const lastServerTime = 1_787_000_000
      const store = new LicenseStore(createBridge())
      store.saveToken('TCPT1.a.b', 1787604800, SUMMARY, lastServerTime)

      expect(store.isClockRolledBack(lastServerTime - TOLERANCE - 1, TOLERANCE)).toBe(true)
      expect(store.isClockRolledBack(lastServerTime - TOLERANCE + 1, TOLERANCE)).toBe(false)
      // Ordinary forward drift is not a rollback.
      expect(store.isClockRolledBack(lastServerTime + 10_000, TOLERANCE)).toBe(false)
    })

    test('never lets the last known server time move backwards', () => {
      const store = new LicenseStore(createBridge())
      store.saveToken('TCPT1.a.b', 1, SUMMARY, 2_000_000_000)

      // A device whose clock is now wrong must not erase the earlier evidence.
      store.saveToken('TCPT1.c.d', 2, SUMMARY, 1_000_000_000)

      expect(store.getState().lastServerTimeSec).toBe(2_000_000_000)
    })
  })
})

describe('createDeviceLocalStorageBridge', () => {
  const realStorage = window.localStorage

  afterEach(() => {
    Object.defineProperty(window, 'localStorage', {
      value: realStorage,
      configurable: true,
    })
    realStorage.clear()
  })

  test('stores the state under an unprefixed key', () => {
    const bridge = createDeviceLocalStorageBridge()
    const store = new LicenseStore(bridge!)

    // Unprefixed is the whole point: Obsidian's App#saveLocalStorage would put
    // the vault's app id in front of it and give each vault its own seat.
    const raw = window.localStorage.getItem(LICENSE_DEVICE_STATE_STORAGE_KEY)
    expect(JSON.parse(raw ?? '{}')).toMatchObject({ deviceId: store.getDeviceId() })
  })

  test('gives every vault on the machine the same device id', () => {
    // Two vaults are two LicenseStore instances over one browser storage.
    const first = new LicenseStore(createDeviceLocalStorageBridge()!)
    const second = new LicenseStore(createDeviceLocalStorageBridge()!)

    expect(second.getDeviceId()).toBe(first.getDeviceId())
  })

  test('reports storage that refuses writes as unusable', () => {
    // Handing back a bridge that drops writes would mint a new device id — and
    // burn a seat — on every launch, so it has to be distinguishable.
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error('denied')
        },
        removeItem: () => undefined,
      },
      configurable: true,
    })

    expect(createDeviceLocalStorageBridge()).toBeUndefined()
  })

  test('reports a missing storage as unusable', () => {
    Object.defineProperty(window, 'localStorage', { value: undefined, configurable: true })

    expect(createDeviceLocalStorageBridge()).toBeUndefined()
  })
})

describe('LicenseStore migration from the vault-scoped store', () => {
  test('adopts the legacy device id so the seat is kept', () => {
    const legacy = createBridge({ deviceId: 'DEVICE-LEGACY01', token: 't', expiresAt: 99 })
    const bridge = createBridge()

    const store = new LicenseStore(bridge, legacy)

    expect(store.getDeviceId()).toBe('DEVICE-LEGACY01')
    expect(store.getState().token).toBe('t')
    // Copied across on construction, so the next launch reads it from the
    // shared store whether or not the legacy entry still exists.
    expect(bridge.store.get(LICENSE_DEVICE_STATE_STORAGE_KEY)).toMatchObject({
      deviceId: 'DEVICE-LEGACY01',
      token: 't',
    })
  })

  test('leaves the legacy entry alone once migrated', () => {
    const legacy = createBridge({ deviceId: 'DEVICE-LEGACY01' })
    const store = new LicenseStore(createBridge(), legacy)

    store.saveToken('TCPT1.a.b', 1787604800, SUMMARY, 1787000000)

    expect(legacy.store.get(LICENSE_DEVICE_STATE_STORAGE_KEY)).toEqual({
      deviceId: 'DEVICE-LEGACY01',
    })
  })

  test('ignores the legacy store once this machine has an id', () => {
    // The second vault to launch finds the machine id already set and falls in
    // behind it rather than dragging its own seat across.
    const bridge = createBridge({ deviceId: 'DEVICE-MACHINE01' })
    const legacy = createBridge({ deviceId: 'DEVICE-LEGACY01' })

    expect(new LicenseStore(bridge, legacy).getDeviceId()).toBe('DEVICE-MACHINE01')
  })

  test('falls through to a fresh id when neither store has one', () => {
    const store = new LicenseStore(createBridge(), createBridge('not json'))

    expect(store.getDeviceId()).toMatch(UUID_V4)
  })

  test('drops a token whose device id did not survive', () => {
    // The token is signed against an id this device can no longer present, so
    // keeping it would only produce a device-mismatch on the next call.
    const store = new LicenseStore(createBridge({ deviceId: 'short', token: 't' }))

    expect(store.getState().token).toBeUndefined()
  })
})
