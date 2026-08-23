import { requestUrl } from 'obsidian'

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
      license: { license_id: 'L', max_devices: 3, devices_used: 1, expires_at: null },
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
        license: { license_id: 'L', max_devices: 3, devices_used: 1, expires_at: null },
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
    })
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

describe('isTransientFailure', () => {
  const api = (status: number): LicenseApiFailure => ({
    ok: false,
    kind: 'api',
    code: 'internal',
    status,
  })

  test.each([
    ['network', { ok: false, kind: 'network' } as LicenseApiFailure, true],
    ['rate limited', api(429), true],
    ['server error', api(500), true],
    ['bad gateway', api(502), true],
    ['forbidden', api(403), false],
    ['conflict', api(409), false],
    ['malformed request', { ok: false, kind: 'malformed', status: 400 } as LicenseApiFailure, false],
  ])('%s -> %s', (_label, failure, expected) => {
    expect(isTransientFailure(failure)).toBe(expected)
  })
})
