import { requestUrl } from 'obsidian'

import { LICENSE_ISSUE_RETRY_BACKOFF_MS } from '../../../src/features/license/config'
import {
  isTransientFailure,
  LicenseApiClient,
  type LicenseApiFailure,
} from '../../../src/features/license/services/LicenseApiClient'

const requestUrlMock = requestUrl as unknown as jest.Mock

function respond(status: number, body: unknown): void {
  requestUrlMock.mockResolvedValueOnce({
    status,
    text: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('LicenseApiClient', () => {
  const client = new LicenseApiClient({ baseUrl: 'https://example.test' })

  beforeEach(() => {
    requestUrlMock.mockReset()
  })

  test('issues a token and returns the parsed body', async () => {
    respond(200, {
      token: 'TCPT1.a.b',
      expires_at: 1787604800,
      license: { max_devices: 3, devices_used: 1, expires_at: null },
    })

    const result = await client.issueToken({
      code: 'TCP-0000-0000-0000-0001',
      deviceId: 'DEVICE-0001',
      platform: 'macos',
      pluginVersion: '2.0.1',
    })

    expect(result).toEqual({
      ok: true,
      data: {
        token: 'TCPT1.a.b',
        expires_at: 1787604800,
        license: { max_devices: 3, devices_used: 1, expires_at: null },
      },
    })

    const call = requestUrlMock.mock.calls[0][0]
    expect(call.url).toBe('https://example.test/v1/token')
    expect(call.method).toBe('POST')
    // A 4xx must be a value, not an exception, so the caller can branch on it.
    expect(call.throw).toBe(false)
    expect(JSON.parse(call.body)).toEqual({
      code: 'TCP-0000-0000-0000-0001',
      device_id: 'DEVICE-0001',
      platform: 'macos',
      plugin_version: '2.0.1',
      // Declared on every request: the server must not hand a refresh secret to
      // a build that would drop it.
      refresh_secret_supported: true,
    })
  })

  test('renews with the refresh secret instead of the code', async () => {
    respond(200, {
      token: 'TCPT1.a.b',
      expires_at: 1787604800,
      refresh_secret: 'next-generation',
      license: { max_devices: 3, devices_used: 1, expires_at: null },
    })

    const result = await client.issueToken({
      refreshSecret: 'this-generation',
      deviceId: 'DEVICE-0001',
    })

    // The code stays off the wire on the request every licensed device repeats.
    expect(JSON.parse(requestUrlMock.mock.calls[0][0].body)).toEqual({
      refresh_secret: 'this-generation',
      device_id: 'DEVICE-0001',
      refresh_secret_supported: true,
    })
    expect(result).toMatchObject({ ok: true, data: { refresh_secret: 'next-generation' } })
  })

  test('reports stale_secret as a stable api failure', async () => {
    respond(401, { ok: false, error: 'stale_secret', message: '登録が最新ではありません' })

    const result = await client.issueToken({
      refreshSecret: 'overtaken',
      deviceId: 'DEVICE-0001',
    })

    expect(result).toMatchObject({ ok: false, kind: 'api', code: 'stale_secret', status: 401 })
  })

  test('omits optional fields the caller did not supply', async () => {
    respond(200, { devices: [], max_devices: 3 })
    await client.listDevices('TCP-0000-0000-0000-0001')

    expect(JSON.parse(requestUrlMock.mock.calls[0][0].body)).toEqual({
      code: 'TCP-0000-0000-0000-0001',
    })
  })

  test('sends the code in the DELETE body, never in the URL', async () => {
    respond(200, { devices_used: 1 })

    await client.deactivateDevice('TCP-0000-0000-0000-0001', 'DEVICE-0002')

    const call = requestUrlMock.mock.calls[0][0]
    expect(call.method).toBe('DELETE')
    expect(call.url).toBe('https://example.test/v1/devices/DEVICE-0002')
    expect(call.url).not.toContain('TCP-')
    expect(JSON.parse(call.body)).toEqual({ code: 'TCP-0000-0000-0000-0001' })
  })

  test('percent-encodes the device id in the path', async () => {
    respond(200, { devices_used: 0 })
    await client.deactivateDevice('CODE', 'a/b c')

    expect(requestUrlMock.mock.calls[0][0].url).toBe('https://example.test/v1/devices/a%2Fb%20c')
  })

  test('maps a stable error envelope to an api failure with its details', async () => {
    respond(409, {
      ok: false,
      error: 'device_limit_reached',
      message: '端末数の上限に達しています',
      details: { devices: [{ device_id: 'DEVICE-0003', last_seen_at: 1787000000 }] },
    })

    const result = await client.issueToken({ code: 'c', deviceId: 'DEVICE-0001' })

    expect(result).toEqual({
      ok: false,
      kind: 'api',
      code: 'device_limit_reached',
      status: 409,
      message: '端末数の上限に達しています',
      details: { devices: [{ device_id: 'DEVICE-0003', last_seen_at: 1787000000 }] },
    })
  })

  test("treats a 400 without `ok` as malformed, not as an entitlement answer", async () => {
    // The API's zod validator returns this shape and promises nothing about it.
    respond(400, { success: false, error: { issues: [] } })

    const result = await client.issueToken({ code: '', deviceId: 'DEVICE-0001' })

    expect(result).toEqual({ ok: false, kind: 'malformed', status: 400 })
  })

  test('maps an unrecognized error code to internal rather than throwing', async () => {
    respond(418, { ok: false, error: 'some_future_code', message: 'x' })

    const result = await client.issueToken({ code: 'c', deviceId: 'DEVICE-0001' })

    expect(result).toEqual({ ok: false, kind: 'api', code: 'internal', status: 418 })
  })

  test('reports an unreachable server as a network failure', async () => {
    requestUrlMock.mockRejectedValueOnce(new Error('ENOTFOUND'))

    const result = await client.listDevices('code')

    expect(result).toEqual({ ok: false, kind: 'network' })
  })

  test('does not treat an unparseable success body as an answer', async () => {
    respond(200, 'not json')

    const result = await client.listDevices('code')

    expect(result).toEqual({ ok: false, kind: 'network' })
  })
})

/**
 * The server commits a rotation before it answers, so a renewal whose answer is
 * lost may still have spent this device's secret. Presenting the same secret
 * again inside the server's grace window is the only way to obtain the
 * replacement, and the next scheduled attempt is twelve hours or a restart
 * away — far outside it.
 */
describe('LicenseApiClient renewal retries', () => {
  const client = new LicenseApiClient({ baseUrl: 'https://example.test' })

  const RENEWAL = { refreshSecret: 'this-generation', deviceId: 'DEVICE-0001' }
  const ISSUED = {
    token: 'TCPT1.a.b',
    expires_at: 1787604800,
    refresh_secret: 'next-generation',
    license: { max_devices: 3, devices_used: 1, expires_at: null },
  }

  beforeEach(() => {
    requestUrlMock.mockReset()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  /** Runs the call to completion, letting every backoff elapse instantly. */
  async function settle<T>(pending: Promise<T>): Promise<T> {
    await jest.advanceTimersByTimeAsync(60_000)
    return pending
  }

  test('retries a request that never reached the server', async () => {
    requestUrlMock.mockRejectedValueOnce(new Error('offline'))
    respond(200, ISSUED)

    const result = await settle(client.issueToken(RENEWAL))

    expect(requestUrlMock).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ ok: true })
  })

  test('retries a server error, which may have followed a committed rotation', async () => {
    respond(500, { ok: false, error: 'internal' })
    respond(200, ISSUED)

    const result = await settle(client.issueToken(RENEWAL))

    expect(requestUrlMock).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ ok: true })
  })

  test('gives up after the configured number of retries', async () => {
    requestUrlMock.mockRejectedValue(new Error('offline'))

    const result = await settle(client.issueToken(RENEWAL))

    expect(requestUrlMock).toHaveBeenCalledTimes(LICENSE_ISSUE_RETRY_BACKOFF_MS.length + 1)
    expect(result).toEqual({ ok: false, kind: 'network' })
  })

  test('presents the same secret every time', async () => {
    // A different one would be a different generation; the point is to ask
    // again for the answer to the request already committed.
    requestUrlMock.mockRejectedValueOnce(new Error('offline'))
    respond(200, ISSUED)

    await settle(client.issueToken(RENEWAL))

    const [first, second] = requestUrlMock.mock.calls
    expect(JSON.parse(second[0].body)).toEqual(JSON.parse(first[0].body))
  })

  test.each([
    ['stale_secret', 401, 'stale_secret'],
    ['a rate limit', 429, 'rate_limited'],
    ['a revoked license', 403, 'license_revoked'],
  ])('does not retry %s', async (_label, status, error) => {
    respond(status, { ok: false, error })

    const result = await settle(client.issueToken(RENEWAL))

    // The server answered. Asking again spends a request to be told the same
    // thing — and for 429 it is being asked for fewer, not more.
    expect(requestUrlMock).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: false, kind: 'api' })
  })

  test('does not retry an activation', async () => {
    // The server counts a code presented over a live secret as a reset, and a
    // license only allows a few of those before it is flagged.
    requestUrlMock.mockRejectedValue(new Error('offline'))

    const result = await settle(
      client.issueToken({ code: 'TCP-0000-0000-0000-0001', deviceId: 'DEVICE-0001' }),
    )

    expect(requestUrlMock).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ ok: false, kind: 'network' })
  })

  test('gives up on an attempt that never answers, and retries', async () => {
    // requestUrl has no timeout of its own, so one hung request would otherwise
    // swallow the whole grace window.
    requestUrlMock.mockReturnValueOnce(new Promise(() => undefined))
    respond(200, ISSUED)

    const result = await settle(client.issueToken(RENEWAL))

    expect(requestUrlMock).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ ok: true })
  })
})

describe('isTransientFailure', () => {
  const api = (status: number): LicenseApiFailure => ({
    ok: false,
    kind: 'api',
    code: 'internal',
    status,
  })

  // Annotated rather than asserted per row: the assertions this replaces read
  // as unnecessary to no-unnecessary-type-assertion, but without them the two
  // object literals widen and stop matching LicenseApiFailure.
  const cases: Array<[string, LicenseApiFailure, boolean]> = [
    ['network', { ok: false, kind: 'network' }, true],
    ['rate limited', api(429), true],
    ['server error', api(500), true],
    ['bad gateway', api(502), true],
    ['forbidden', api(403), false],
    ['conflict', api(409), false],
    ['malformed request', { ok: false, kind: 'malformed', status: 400 }, false],
  ]

  test.each(cases)('%s -> %s', (_label, failure, expected) => {
    expect(isTransientFailure(failure)).toBe(expected)
  })
})
