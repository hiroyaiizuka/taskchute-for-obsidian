/**
 * The rules that matter here are the ones that decide whether a paying user
 * keeps working: a failed request must never revoke access, and a refused one
 * must never be mistaken for a failed one.
 */
import { GOLDEN_PUBLIC_KEY } from '../../../src/features/license/token/goldenVector'

jest.mock('../../../src/features/license/config', () => ({
  ...jest.requireActual<Record<string, unknown>>('../../../src/features/license/config'),
  LICENSE_PUBLIC_KEY: GOLDEN_PUBLIC_KEY,
}))

import type {
  IssueTokenResponse,
  LicenseApiClient,
  LicenseApiResult,
} from '../../../src/features/license/services/LicenseApiClient'
import { LicenseManager } from '../../../src/features/license/services/LicenseManager'
import { LicenseStore, type LicenseStorageBridge } from '../../../src/features/license/services/LicenseStore'
import { signTestToken } from './signTestToken'

const NOW = 1_787_000_000
const DAY = 24 * 60 * 60
const SUMMARY = { license_id: 'TESTLICENSE00001', max_devices: 3, devices_used: 1, expires_at: null }

function createBridge(): LicenseStorageBridge {
  const store = new Map<string, unknown>()
  return {
    loadLocalStorage: (key) => store.get(key),
    saveLocalStorage: (key, value) => {
      store.set(key, value)
    },
  }
}

interface Harness {
  manager: LicenseManager
  store: LicenseStore
  client: {
    issueToken: jest.Mock
    listDevices: jest.Mock
    deactivateDevice: jest.Mock
  }
  code: { value: string | undefined }
}

function createHarness(
  options: { code?: string; now?: number; failSetCode?: boolean } = {},
): Harness {
  const store = new LicenseStore(createBridge())
  const client = {
    issueToken: jest.fn(),
    listDevices: jest.fn(),
    deactivateDevice: jest.fn(),
  }
  const code = { value: options.code }

  const manager = new LicenseManager({
    client: client as unknown as LicenseApiClient,
    store,
    getCode: () => code.value,
    setCode: async (next) => {
      if (options.failSetCode) throw new Error('saveSettings failed')
      code.value = next
    },
    now: () => options.now ?? NOW,
  })

  return { manager, store, client, code }
}

function tokenFor(store: LicenseStore, overrides: { issuedAt?: number; expiresAt?: number } = {}) {
  return signTestToken({
    deviceId: store.getDeviceId(),
    issuedAt: overrides.issuedAt ?? NOW - DAY,
    expiresAt: overrides.expiresAt ?? NOW + 7 * DAY,
  })
}

function issued(token: string, expiresAt: number): LicenseApiResult<IssueTokenResponse> {
  return { ok: true, data: { token, expires_at: expiresAt, license: SUMMARY } }
}

describe('initialize', () => {
  test('is unlicensed with nothing stored', () => {
    const { manager } = createHarness()
    expect(manager.initialize()).toEqual({ status: 'unlicensed' })
    expect(manager.isActive()).toBe(false)
  })

  test('activates from a stored token without any network call', () => {
    const { manager, store, client } = createHarness()
    store.saveToken(tokenFor(store), NOW + 7 * DAY, SUMMARY, NOW)

    const state = manager.initialize()

    expect(state.status).toBe('active')
    expect(client.issueToken).not.toHaveBeenCalled()
  })

  test('rejects an expired stored token', () => {
    const { manager, store } = createHarness()
    store.saveToken(tokenFor(store, { expiresAt: NOW - DAY }), NOW - DAY, SUMMARY, NOW)

    expect(manager.initialize()).toEqual({ status: 'unlicensed' })
  })

  test('rejects a token bound to a different device', () => {
    const { manager, store } = createHarness()
    const foreign = signTestToken({
      deviceId: 'DEVICE-SOMEONEELSE',
      issuedAt: NOW - DAY,
      expiresAt: NOW + 7 * DAY,
    })
    store.saveToken(foreign, NOW + 7 * DAY, SUMMARY, NOW)

    // This is what a data.json synced from another machine would look like.
    expect(manager.initialize()).toEqual({ status: 'unlicensed' })
  })

  test('refuses a valid token when the local clock has been wound back', () => {
    const store = new LicenseStore(createBridge())
    // Saved 30 days "ago" by the server's reckoning, then the clock moved back.
    store.saveToken(
      tokenFor(store, { expiresAt: NOW + 40 * DAY }),
      NOW + 40 * DAY,
      SUMMARY,
      NOW + 30 * DAY,
    )

    const manager = new LicenseManager({
      client: {} as unknown as LicenseApiClient,
      store,
      getCode: () => undefined,
      setCode: async () => undefined,
      now: () => NOW,
    })

    expect(manager.initialize()).toEqual({ status: 'unlicensed' })
  })
})

describe('activate', () => {
  test('rejects a malformed code before making a request', async () => {
    const { manager, client } = createHarness()

    const result = await manager.activate('nope')

    expect(result).toEqual({ ok: false, failure: { kind: 'invalid-input' } })
    expect(client.issueToken).not.toHaveBeenCalled()
  })

  test('stores the token and the code on success', async () => {
    const { manager, store, client, code } = createHarness()
    manager.initialize()
    client.issueToken.mockResolvedValue(issued(tokenFor(store), NOW + 7 * DAY))

    const result = await manager.activate('  tcp-0000-0000-0000-0001  ')

    expect(result.ok).toBe(true)
    expect(manager.isActive()).toBe(true)
    expect(code.value).toBe('tcp-0000-0000-0000-0001')
    expect(store.getState().token).toBeDefined()
  })

  test('sends the code raw, letting the server normalize it', async () => {
    const { manager, store, client } = createHarness()
    client.issueToken.mockResolvedValue(issued(tokenFor(store), NOW + 7 * DAY))

    await manager.activate('tcp-0000-0000-0000-000i')

    expect(client.issueToken.mock.calls[0][0].code).toBe('tcp-0000-0000-0000-000i')
  })

  test('surfaces the device list from a 409 so the user can free a seat', async () => {
    const { manager, client } = createHarness()
    const devices = [{ device_id: 'DEVICE-OTHER', last_seen_at: NOW }]
    client.issueToken.mockResolvedValue({
      ok: false,
      kind: 'api',
      code: 'device_limit_reached',
      status: 409,
      details: { devices },
    })

    const result = await manager.activate('TCP-0000-0000-0000-0001')

    expect(result).toEqual({ ok: false, failure: { kind: 'device-limit', devices } })
    expect(manager.getState()).toEqual({ status: 'unlicensed' })
  })

  test('refuses a token it cannot verify rather than storing it', async () => {
    const { manager, store, client } = createHarness()
    // What a public/private key mismatch on the server would look like.
    client.issueToken.mockResolvedValue(
      issued('TCPT1.eyJ2IjoxfQ.AAAA', NOW + 7 * DAY),
    )

    const result = await manager.activate('TCP-0000-0000-0000-0001')

    expect(result.ok).toBe(false)
    expect(store.getState().token).toBeUndefined()
    expect(manager.isActive()).toBe(false)
  })

  test.each(['license_revoked', 'license_expired', 'license_suspended'] as const)(
    'blocks and clears the token on %s',
    async (code) => {
      const { manager, store, client } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
      store.saveToken(tokenFor(store), NOW + 7 * DAY, SUMMARY, NOW)
      manager.initialize()
      expect(manager.isActive()).toBe(true)

      client.issueToken.mockResolvedValue({ ok: false, kind: 'api', code, status: 403 })
      await manager.refreshIfNeeded(true)

      expect(manager.getState()).toEqual({ status: 'blocked', reason: code })
      expect(store.getState().token).toBeUndefined()
    },
  )
})

describe('refreshIfNeeded', () => {
  test('does nothing while the token has plenty of life left', async () => {
    const { manager, store, client } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    store.saveToken(tokenFor(store, { expiresAt: NOW + 7 * DAY }), NOW + 7 * DAY, SUMMARY, NOW)
    manager.initialize()

    await manager.refreshIfNeeded()

    expect(client.issueToken).not.toHaveBeenCalled()
  })

  test('renews once the token is inside the refresh window', async () => {
    const { manager, store, client } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    store.saveToken(tokenFor(store, { expiresAt: NOW + 3600 }), NOW + 3600, SUMMARY, NOW)
    manager.initialize()
    client.issueToken.mockResolvedValue(issued(tokenFor(store), NOW + 7 * DAY))

    await manager.refreshIfNeeded()

    expect(client.issueToken).toHaveBeenCalledTimes(1)
    expect(store.getState().expiresAt).toBe(NOW + 7 * DAY)
  })

  test('does nothing when no code is stored', async () => {
    const { manager, client } = createHarness()

    await manager.refreshIfNeeded(true)

    expect(client.issueToken).not.toHaveBeenCalled()
  })

  test('coalesces concurrent refreshes into one request', async () => {
    const { manager, store, client } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    manager.initialize()
    client.issueToken.mockResolvedValue(issued(tokenFor(store), NOW + 7 * DAY))

    await Promise.all([manager.refreshIfNeeded(), manager.refreshIfNeeded()])

    expect(client.issueToken).toHaveBeenCalledTimes(1)
  })

  test.each([
    ['an unreachable server', { ok: false, kind: 'network' }],
    ['a rate limit', { ok: false, kind: 'api', code: 'rate_limited', status: 429 }],
    ['a server error', { ok: false, kind: 'api', code: 'internal', status: 500 }],
    ['an upstream outage', { ok: false, kind: 'api', code: 'upstream_unavailable', status: 502 }],
  ])('keeps working through %s', async (_label, failure) => {
    const { manager, store, client } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    store.saveToken(tokenFor(store, { expiresAt: NOW + 3600 }), NOW + 3600, SUMMARY, NOW)
    manager.initialize()
    client.issueToken.mockResolvedValue(failure)

    await manager.refreshIfNeeded()

    // Nothing was refused, so an unexpired token must keep the feature alive.
    expect(manager.isActive()).toBe(true)
    expect(store.getState().token).toBeDefined()
  })

  test('clears a code the server does not recognize', async () => {
    const { manager, store, client } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    store.saveToken(tokenFor(store), NOW + 7 * DAY, SUMMARY, NOW)
    manager.initialize()
    client.issueToken.mockResolvedValue({
      ok: false,
      kind: 'api',
      code: 'invalid_code',
      status: 404,
    })

    await manager.refreshIfNeeded(true)

    expect(manager.getState()).toEqual({ status: 'unlicensed' })
    expect(store.getState().token).toBeUndefined()
  })
})

describe('device management', () => {
  test('releasing another device leaves this one licensed', async () => {
    const { manager, store, client } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    store.saveToken(tokenFor(store), NOW + 7 * DAY, SUMMARY, NOW)
    manager.initialize()
    client.deactivateDevice.mockResolvedValue({ ok: true, data: { devices_used: 1 } })

    const result = await manager.deactivateDevice('DEVICE-OTHER')

    expect(result).toEqual({ ok: true, devicesUsed: 1 })
    expect(manager.isActive()).toBe(true)
  })

  test('releasing this device drops the local token and stops using the code', async () => {
    const { manager, store, client, code } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    store.saveToken(tokenFor(store), NOW + 7 * DAY, SUMMARY, NOW)
    manager.initialize()
    client.deactivateDevice.mockResolvedValue({ ok: true, data: { devices_used: 0 } })

    await manager.deactivateDevice(manager.getDeviceId())

    // The token still verifies, but the seat is gone and no refresh can work.
    expect(manager.isActive()).toBe(false)
    expect(store.getState().token).toBeUndefined()

    // The code is thrown away device-locally rather than deleted: data.json is
    // synced, so deleting it would take the license off every other machine.
    expect(manager.getStoredCode()).toBeUndefined()
    expect(manager.isSeatReleased()).toBe(true)
    expect(code.value).toBe('TCP-0000-0000-0000-0001')
  })

  test('a seat released from another machine drops the code the same way', async () => {
    // Whichever end the release came from, this device must stop acting on the
    // code and must not show it as something the user can still use here.
    const { manager, store, client, code } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    store.saveToken(tokenFor(store), NOW + 7 * DAY, SUMMARY, NOW)
    manager.initialize()
    client.listDevices.mockResolvedValue({
      ok: true,
      data: { devices: [{ device_id: 'DEVICE-OTHER' }], max_devices: 3 },
    })

    expect(await manager.verifyDeviceRegistration()).toBe('released')

    expect(manager.isActive()).toBe(false)
    expect(manager.getStoredCode()).toBeUndefined()
    expect(code.value).toBe('TCP-0000-0000-0000-0001')
  })

  test('a released device makes no further requests with the code', async () => {
    // The latch has to reach every path that reads the stored code, or the
    // seat list would keep loading and a refresh would retake the seat.
    const { manager, store, client } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    store.saveToken(tokenFor(store), NOW + 7 * DAY, SUMMARY, NOW)
    manager.initialize()
    client.deactivateDevice.mockResolvedValue({ ok: true, data: { devices_used: 0 } })

    await manager.deactivateDevice(manager.getDeviceId())
    client.deactivateDevice.mockClear()

    expect(await manager.listDevices()).toEqual({
      ok: false,
      failure: { ok: false, kind: 'no-code' },
    })
    expect(await manager.deactivateDevice('DEVICE-OTHER')).toEqual({
      ok: false,
      failure: { ok: false, kind: 'no-code' },
    })
    await manager.refreshIfNeeded(true)

    expect(client.listDevices).not.toHaveBeenCalled()
    expect(client.deactivateDevice).not.toHaveBeenCalled()
    expect(client.issueToken).not.toHaveBeenCalled()
  })

  test('a release is not undone by the next refresh', async () => {
    const { manager, store, client } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    store.saveToken(tokenFor(store), NOW + 7 * DAY, SUMMARY, NOW)
    manager.initialize()
    client.deactivateDevice.mockResolvedValue({ ok: true, data: { devices_used: 0 } })
    client.issueToken.mockResolvedValue(issued(tokenFor(store), NOW + 7 * DAY))

    await manager.deactivateDevice(manager.getDeviceId())
    await manager.refreshIfNeeded(true)

    // Keeping the code would retake the seat the user just gave up, every
    // refresh, forever.
    expect(client.issueToken).not.toHaveBeenCalled()
    expect(manager.isActive()).toBe(false)
  })

  test('releasing this device never touches data.json', async () => {
    // Nothing is written to settings, so there is no data.json failure that
    // could turn a seat the server has already freed into "release failed".
    const { manager, store, client, code } = createHarness({
      code: 'TCP-0000-0000-0000-0001',
      failSetCode: true,
    })
    store.saveToken(tokenFor(store), NOW + 7 * DAY, SUMMARY, NOW)
    manager.initialize()
    client.deactivateDevice.mockResolvedValue({ ok: true, data: { devices_used: 0 } })

    const result = await manager.deactivateDevice(manager.getDeviceId())

    expect(result).toEqual({ ok: true, devicesUsed: 0 })
    expect(manager.isActive()).toBe(false)
    expect(code.value).toBe('TCP-0000-0000-0000-0001')
  })

  test('does not call the API without a stored code', async () => {
    const { manager, client } = createHarness()

    const result = await manager.listDevices()

    expect(result).toEqual({ ok: false, failure: { ok: false, kind: 'no-code' } })
    expect(client.listDevices).not.toHaveBeenCalled()
    expect(await manager.deactivateDevice('DEVICE-OTHER')).toEqual({
      ok: false,
      failure: { ok: false, kind: 'no-code' },
    })
    expect(client.deactivateDevice).not.toHaveBeenCalled()
  })

  test('releases a seat with a code that is not stored yet', async () => {
    // Activation only stores the code on success, so the seat list a 409 puts
    // on screen has to carry the typed code or it cannot free anything.
    const { manager, client } = createHarness()
    client.deactivateDevice.mockResolvedValue({ ok: true, data: { devices_used: 2 } })

    const result = await manager.deactivateDevice('DEVICE-OTHER', 'TCP-0000-0000-0000-0001')

    expect(result).toEqual({ ok: true, devicesUsed: 2 })
    expect(client.deactivateDevice).toHaveBeenCalledWith(
      'TCP-0000-0000-0000-0001',
      'DEVICE-OTHER',
    )
  })

  test('lists devices with a code that is not stored yet', async () => {
    const { manager, client } = createHarness()
    client.listDevices.mockResolvedValue({
      ok: true,
      data: { devices: [], max_devices: 3 },
    })

    const result = await manager.listDevices('TCP-0000-0000-0000-0001')

    expect(result).toEqual({ ok: true, devices: [], maxDevices: 3 })
    expect(client.listDevices).toHaveBeenCalledWith('TCP-0000-0000-0000-0001')
  })
})

describe('verifyDeviceRegistration', () => {
  function deviceList(...deviceIds: string[]) {
    return {
      ok: true,
      data: {
        devices: deviceIds.map((device_id) => ({ device_id, last_seen_at: NOW })),
        max_devices: 3,
      },
    }
  }

  function activeHarness(): Harness {
    const harness = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    harness.store.saveToken(tokenFor(harness.store), NOW + 7 * DAY, SUMMARY, NOW)
    harness.manager.initialize()
    return harness
  }

  test('leaves an entitled device alone when the server still lists it', async () => {
    const { manager, client, store } = activeHarness()
    client.listDevices.mockResolvedValue(deviceList(manager.getDeviceId(), 'DEVICE-OTHER'))

    await expect(manager.verifyDeviceRegistration()).resolves.toBe('registered')

    expect(manager.isActive()).toBe(true)
    expect(store.getState().token).toBeDefined()
  })

  test('drops the token when this device is gone from the license', async () => {
    const { manager, client, store, code } = activeHarness()
    const listener = jest.fn()
    manager.onChange(listener)
    client.listDevices.mockResolvedValue(deviceList('DEVICE-OTHER'))

    await expect(manager.verifyDeviceRegistration()).resolves.toBe('released')

    expect(manager.isActive()).toBe(false)
    expect(store.getState().token).toBeUndefined()
    expect(listener).toHaveBeenCalledWith({ status: 'unlicensed' })
    // data.json is synced: clearing the code here would strip the license from
    // every other vault that shares it.
    expect(code.value).toBe('TCP-0000-0000-0000-0001')
  })

  test('does not retake the seat on the next refresh', async () => {
    const { manager, client, store } = activeHarness()
    client.listDevices.mockResolvedValue(deviceList('DEVICE-OTHER'))
    client.issueToken.mockResolvedValue(issued(tokenFor(store), NOW + 7 * DAY))

    await manager.verifyDeviceRegistration()
    await manager.refreshIfNeeded(true)

    expect(client.issueToken).not.toHaveBeenCalled()
    expect(manager.isActive()).toBe(false)
  })

  test('re-activating lifts the latch', async () => {
    const { manager, client, store } = activeHarness()
    client.listDevices.mockResolvedValue(deviceList('DEVICE-OTHER'))
    await manager.verifyDeviceRegistration()

    client.issueToken.mockResolvedValue(issued(tokenFor(store), NOW + 7 * DAY))
    const result = await manager.activate('TCP-0000-0000-0000-0001')

    // Entering the code is the user asking for the seat back, which is the one
    // thing that may claim it.
    expect(result.ok).toBe(true)
    expect(manager.isActive()).toBe(true)
    expect(store.isSeatReleased()).toBe(false)
  })

  test('an unreachable server never revokes', async () => {
    const { manager, client, store } = activeHarness()
    client.listDevices.mockResolvedValue({ ok: false, kind: 'network', status: 0 })

    await expect(manager.verifyDeviceRegistration()).resolves.toBe('unknown')

    expect(manager.isActive()).toBe(true)
    expect(store.getState().token).toBeDefined()
    expect(store.isSeatReleased()).toBe(false)
  })

  test('skips the request when there is nothing to protect', async () => {
    const { manager, client } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    manager.initialize()

    await expect(manager.verifyDeviceRegistration()).resolves.toBe('unknown')
    expect(client.listDevices).not.toHaveBeenCalled()
  })

  test('throttles repeat checks', async () => {
    const { manager, client } = activeHarness()
    client.listDevices.mockResolvedValue(deviceList(manager.getDeviceId()))

    await manager.verifyDeviceRegistration()
    // The settings tab rebuilds its definitions after every control change; one
    // request per rebuild would be a burst.
    await expect(manager.verifyDeviceRegistration()).resolves.toBe('unknown')

    expect(client.listDevices).toHaveBeenCalledTimes(1)
  })
})

describe('onChange', () => {
  test('notifies on a real transition and stays quiet otherwise', async () => {
    const { manager, store, client } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    manager.initialize()
    const listener = jest.fn()
    manager.onChange(listener)

    client.issueToken.mockResolvedValue(issued(tokenFor(store), NOW + 7 * DAY))
    await manager.refreshIfNeeded(true)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].status).toBe('active')

    // A second successful refresh is not a state change.
    await manager.refreshIfNeeded(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  test('unsubscribes', async () => {
    const { manager, store, client } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    manager.initialize()
    const listener = jest.fn()
    manager.onChange(listener)()

    client.issueToken.mockResolvedValue(issued(tokenFor(store), NOW + 7 * DAY))
    await manager.refreshIfNeeded(true)

    expect(listener).not.toHaveBeenCalled()
  })
})


describe('syncFromServer', () => {
  test('asks about the seat before renewing the token', async () => {
    // The order is the whole point. Issuing a token re-registers this device
    // id, so renewing first would hand back a seat released on another machine
    // and the list would then honestly report the device present — the release
    // would disappear without a trace.
    const { manager, store, client } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    store.saveToken(tokenFor(store), NOW + 7 * DAY, SUMMARY, NOW)
    manager.initialize()

    const calls: string[] = []
    client.listDevices.mockImplementation(() => {
      calls.push('listDevices')
      return Promise.resolve({
        ok: true,
        data: { devices: [{ device_id: store.getDeviceId() }], max_devices: 3 },
      })
    })
    client.issueToken.mockImplementation(() => {
      calls.push('issueToken')
      return Promise.resolve(issued(tokenFor(store), NOW + 7 * DAY))
    })

    await manager.syncFromServer({ force: true })

    expect(calls[0]).toBe('listDevices')
  })

  test('does not renew a token for a seat that is gone', async () => {
    const { manager, store, client } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    store.saveToken(tokenFor(store), NOW + 7 * DAY, SUMMARY, NOW)
    manager.initialize()
    client.listDevices.mockResolvedValue({
      ok: true,
      data: { devices: [{ device_id: 'DEVICE-OTHER' }], max_devices: 3 },
    })

    const state = await manager.syncFromServer({ force: true })

    expect(state).toEqual({ status: 'unlicensed' })
    expect(client.issueToken).not.toHaveBeenCalled()
  })

  test('recovers an entitlement that only looked gone offline', async () => {
    // The token expired while the machine was away. Nothing on disk can tell
    // that from a revoked license, so the screen would keep saying "not
    // activated" until something asked.
    const { manager, store, client } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    store.saveToken(tokenFor(store, { expiresAt: NOW - DAY }), NOW - DAY, SUMMARY, NOW - 2 * DAY)
    manager.initialize()
    expect(manager.isActive()).toBe(false)

    client.issueToken.mockResolvedValue(issued(tokenFor(store), NOW + 7 * DAY))

    const state = await manager.syncFromServer({ force: true })

    expect(state.status).toBe('active')
    // No seat to check while unlicensed: the token request is the question.
    expect(client.listDevices).not.toHaveBeenCalled()
  })

  test('leaves a released device alone', async () => {
    const { manager, store, client } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    store.saveToken(tokenFor(store), NOW + 7 * DAY, SUMMARY, NOW)
    manager.initialize()
    client.deactivateDevice.mockResolvedValue({ ok: true, data: { devices_used: 0 } })
    await manager.deactivateDevice(manager.getDeviceId())
    client.listDevices.mockClear()

    const state = await manager.syncFromServer({ force: true })

    expect(state).toEqual({ status: 'unlicensed' })
    expect(client.issueToken).not.toHaveBeenCalled()
    expect(client.listDevices).not.toHaveBeenCalled()
  })

  test('stops asking about a code the server called invalid', async () => {
    // Unlike a revoked license, which may be reinstated, a string that is not a
    // code never becomes one — and every settings visit forces a sync.
    const { manager, client } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    manager.initialize()
    client.issueToken.mockResolvedValue({
      ok: false,
      kind: 'api',
      code: 'invalid_code',
      status: 404,
    })

    await manager.syncFromServer({ force: true })
    await manager.syncFromServer({ force: true })

    expect(client.issueToken).toHaveBeenCalledTimes(1)
  })

  test('throttles unless forced', async () => {
    const { manager, store, client } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    store.saveToken(tokenFor(store), NOW + 7 * DAY, SUMMARY, NOW)
    manager.initialize()
    client.listDevices.mockResolvedValue({
      ok: true,
      data: { devices: [{ device_id: store.getDeviceId() }], max_devices: 3 },
    })

    await manager.syncFromServer()
    await manager.syncFromServer()
    expect(client.listDevices).toHaveBeenCalledTimes(1)

    // Someone pressing refresh is exactly the case the throttle must not answer
    // with a cached "nothing to report".
    await manager.syncFromServer({ force: true })
    expect(client.listDevices).toHaveBeenCalledTimes(2)
  })

  test('never rejects, whatever the server does', async () => {
    const { manager, store, client } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    store.saveToken(tokenFor(store), NOW + 7 * DAY, SUMMARY, NOW)
    manager.initialize()
    client.listDevices.mockRejectedValue(new Error('offline'))

    await expect(manager.syncFromServer({ force: true })).resolves.toBeDefined()
    expect(manager.isActive()).toBe(true)
  })
})

describe('the seat list snapshot', () => {
  test('one fetch answers both the seat check and the list', async () => {
    // Opening the Pro screen asks the same question twice at once. Two requests
    // could come back disagreeing; one cannot.
    const { manager, store, client } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    store.saveToken(tokenFor(store), NOW + 7 * DAY, SUMMARY, NOW)
    manager.initialize()

    let resolveList: (value: unknown) => void = () => undefined
    client.listDevices.mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve
      }),
    )

    const sync = manager.syncFromServer({ force: true })
    const list = manager.listDevices()
    resolveList({
      ok: true,
      data: { devices: [{ device_id: store.getDeviceId() }], max_devices: 3 },
    })

    await sync
    expect(await list).toEqual({
      ok: true,
      devices: [{ device_id: store.getDeviceId() }],
      maxDevices: 3,
    })
    expect(client.listDevices).toHaveBeenCalledTimes(1)
  })

  test('tells watchers about a list they did not ask for', async () => {
    const { manager, store, client } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    store.saveToken(tokenFor(store), NOW + 7 * DAY, SUMMARY, NOW)
    manager.initialize()
    client.listDevices.mockResolvedValue({
      ok: true,
      data: { devices: [{ device_id: store.getDeviceId() }], max_devices: 3 },
    })

    const listener = jest.fn()
    manager.onDevicesChange(listener)

    await manager.syncFromServer({ force: true })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].devices).toEqual([{ device_id: store.getDeviceId() }])
    expect(manager.getDeviceSnapshot()?.maxDevices).toBe(3)
  })

  test('drops a released seat without re-fetching', async () => {
    const { manager, store, client } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    store.saveToken(tokenFor(store), NOW + 7 * DAY, SUMMARY, NOW)
    manager.initialize()
    client.listDevices.mockResolvedValue({
      ok: true,
      data: {
        devices: [{ device_id: store.getDeviceId() }, { device_id: 'DEVICE-OTHER' }],
        max_devices: 3,
      },
    })
    client.deactivateDevice.mockResolvedValue({ ok: true, data: { devices_used: 1 } })
    await manager.listDevices()
    client.listDevices.mockClear()

    await manager.deactivateDevice('DEVICE-OTHER')

    expect(manager.getDeviceSnapshot()?.devices).toEqual([{ device_id: store.getDeviceId() }])
    expect(client.listDevices).not.toHaveBeenCalled()
  })

  test('an explicit code is not coalesced with the stored one', async () => {
    // The 409 list belongs to the code being typed, which may be a different
    // license than the one already stored.
    const { manager, client } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    manager.initialize()
    client.listDevices.mockResolvedValue({ ok: true, data: { devices: [], max_devices: 3 } })

    await Promise.all([manager.listDevices(), manager.listDevices('TCP-9999-9999-9999-9999')])

    expect(client.listDevices).toHaveBeenCalledTimes(2)
  })
})
