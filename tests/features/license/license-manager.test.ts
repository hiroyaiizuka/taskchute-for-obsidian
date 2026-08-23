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

  test('releasing this device drops the local token and the stored code', async () => {
    const { manager, store, client, code } = createHarness({ code: 'TCP-0000-0000-0000-0001' })
    store.saveToken(tokenFor(store), NOW + 7 * DAY, SUMMARY, NOW)
    manager.initialize()
    client.deactivateDevice.mockResolvedValue({ ok: true, data: { devices_used: 0 } })

    await manager.deactivateDevice(manager.getDeviceId())

    // The token still verifies, but the seat is gone and no refresh can work.
    expect(manager.isActive()).toBe(false)
    expect(store.getState().token).toBeUndefined()
    expect(code.value).toBeUndefined()
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

  test('still releases when the settings write fails', async () => {
    const { manager, store, client } = createHarness({
      code: 'TCP-0000-0000-0000-0001',
      failSetCode: true,
    })
    store.saveToken(tokenFor(store), NOW + 7 * DAY, SUMMARY, NOW)
    manager.initialize()
    client.deactivateDevice.mockResolvedValue({ ok: true, data: { devices_used: 0 } })

    const result = await manager.deactivateDevice(manager.getDeviceId())

    // The seat is already gone on the server; a failed data.json write must not
    // turn that into a rejected promise the UI reports as "release failed".
    expect(result).toEqual({ ok: true, devicesUsed: 0 })
    expect(manager.isActive()).toBe(false)
  })

  test('does not call the API without a stored code', async () => {
    const { manager, client } = createHarness()

    expect((await manager.listDevices()).ok).toBe(false)
    expect(client.listDevices).not.toHaveBeenCalled()
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

