/**
 * HTTP client for the license API's plugin endpoints.
 *
 * Uses Obsidian's requestUrl rather than fetch: it bypasses CORS and works on
 * every platform. Nothing here throws — every outcome is a value, because the
 * caller must distinguish "the server rejected us" (stop the feature) from
 * "we never reached the server" (keep working until the token expires).
 */
import { requestUrl } from 'obsidian'

import { LICENSE_API_BASE } from '../config'

/**
 * Stable error identifiers from the API (its PublicErrorCode union). Branch on
 * these, never on `message`, which is Japanese prose the server may reword.
 *
 * `internal` is returned by the API's onError but is absent from its exported
 * TS union; it is included here because clients do see it.
 */
export type LicenseErrorCode =
  | 'malformed_code'
  | 'invalid_code'
  | 'license_revoked'
  | 'license_expired'
  | 'license_suspended'
  /**
   * The refresh secret we presented is no longer the current generation:
   * another machine claiming this seat renewed first. Not a network failure —
   * the server said no — so it may revoke entitlement here.
   */
  | 'stale_secret'
  /** Too many code re-activations over a live secret. A seat being fought over. */
  | 'reset_limit_reached'
  | 'device_limit_reached'
  | 'device_not_found'
  | 'deactivation_limit_reached'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'internal'

const LICENSE_ERROR_CODES: readonly string[] = [
  'malformed_code',
  'invalid_code',
  'license_revoked',
  'license_expired',
  'license_suspended',
  'stale_secret',
  'reset_limit_reached',
  'device_limit_reached',
  'device_not_found',
  'deactivation_limit_reached',
  'rate_limited',
  'upstream_unavailable',
  'internal',
]

/** A device holding one of the license's seats. */
export interface DeviceView {
  device_id: string
  label?: string
  platform?: string
  last_seen_at: number
}

export interface LicenseSummary {
  license_id: string
  max_devices: number
  devices_used: number
  /** Unix seconds, or null for a perpetual license. */
  expires_at: number | null
}

export interface IssueTokenResponse {
  token: string
  /** Unix seconds. Also used as the last known server time. */
  expires_at: number
  /**
   * The secret that buys the next token. Null from a server that predates
   * rotation, or when this client said it cannot store one.
   */
  refresh_secret?: string | null
  license: LicenseSummary
}

export interface ListDevicesResponse {
  devices: DeviceView[]
  max_devices: number
}

export interface DeactivateDeviceResponse {
  devices_used: number
}

export interface IssueTokenRequest {
  /**
   * Only needed to activate or to take a seat back. A renewal presents the
   * refresh secret instead, which is what keeps the code off the wire on the
   * roughly weekly request every licensed device makes.
   */
  code?: string
  /** The current generation, when this device holds one. */
  refreshSecret?: string
  deviceId: string
  label?: string
  platform?: string
  pluginVersion?: string
}

export type LicenseApiFailure =
  /** The server answered with a stable error code. Never retry a 4xx. */
  | { ok: false; kind: 'api'; code: LicenseErrorCode; status: number; message?: string; details?: LicenseErrorDetails }
  /** A 400 without `ok`: the request shape was wrong, i.e. a bug in this plugin. */
  | { ok: false; kind: 'malformed'; status: number }
  /** No activation code to send, so no request was made. The user has to enter one. */
  | { ok: false; kind: 'no-code' }
  /** The request never got an answer. Not an entitlement signal. */
  | { ok: false; kind: 'network' }

export type LicenseApiResult<T> = { ok: true; data: T } | LicenseApiFailure

export interface LicenseErrorDetails {
  /** Present on device_limit_reached; identical in shape to ListDevicesResponse.devices. */
  devices?: DeviceView[]
  /** Present on deactivation_limit_reached, in unix seconds. */
  retry_after_at?: number
}

/** Whether the failure is transient, i.e. worth retrying later without alarming the user. */
export function isTransientFailure(failure: LicenseApiFailure): boolean {
  if (failure.kind === 'network') return true
  if (failure.kind === 'malformed') return false
  // Retrying changes nothing: only the user typing a code does.
  if (failure.kind === 'no-code') return false

  return failure.status === 429 || failure.status >= 500
}

export interface LicenseApiClientOptions {
  /** Override for local development against `wrangler dev` on :8787. */
  baseUrl?: string
  log?: (level: string, ...args: unknown[]) => void
}

export class LicenseApiClient {
  private readonly baseUrl: string
  private readonly log?: (level: string, ...args: unknown[]) => void

  constructor(options: LicenseApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? LICENSE_API_BASE).replace(/\/+$/, '')
    this.log = options.log
  }

  /**
   * Issue or refresh an auth token. The API deliberately has one endpoint for
   * both: the inputs are identical, and there is no refresh token.
   */
  async issueToken(request: IssueTokenRequest): Promise<LicenseApiResult<IssueTokenResponse>> {
    return this.send<IssueTokenResponse>('POST', '/v1/token', {
      ...(request.code !== undefined ? { code: request.code } : {}),
      ...(request.refreshSecret !== undefined ? { refresh_secret: request.refreshSecret } : {}),
      device_id: request.deviceId,
      // Declared rather than inferred: the server must not hand a secret to a
      // client that would drop it, because the next code-based renewal would
      // then look like someone taking the seat back and spend a reset.
      refresh_secret_supported: true,
      ...(request.label !== undefined ? { label: request.label } : {}),
      ...(request.platform !== undefined ? { platform: request.platform } : {}),
      ...(request.pluginVersion !== undefined ? { plugin_version: request.pluginVersion } : {}),
    })
  }

  /**
   * List the devices holding seats. Works even for a revoked or expired
   * license — deliberately, so a locked-out user can still free a seat.
   */
  async listDevices(code: string): Promise<LicenseApiResult<ListDevicesResponse>> {
    return this.send<ListDevicesResponse>('POST', '/v1/devices', { code })
  }

  /**
   * Release a seat. The code travels in the body, never in the URL, so it does
   * not end up in request logs.
   */
  async deactivateDevice(
    code: string,
    deviceId: string,
  ): Promise<LicenseApiResult<DeactivateDeviceResponse>> {
    return this.send<DeactivateDeviceResponse>(
      'DELETE',
      `/v1/devices/${encodeURIComponent(deviceId)}`,
      { code },
    )
  }

  private async send<T>(
    method: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<LicenseApiResult<T>> {
    let status: number
    let text: string

    try {
      const response = await requestUrl({
        url: `${this.baseUrl}${path}`,
        method,
        contentType: 'application/json',
        // A DELETE with a body is required by this API; requestUrl forwards it.
        body: JSON.stringify(body),
        // Read the status ourselves so a 4xx stays a value, not an exception.
        throw: false,
      })
      status = response.status
      text = response.text
    } catch (error) {
      // Never reached the server: DNS, offline, TLS, proxy.
      this.log?.('warn', '[License] Request failed', method, path, error)
      return { ok: false, kind: 'network' }
    }

    const payload = parseJson(text)

    if (status >= 200 && status < 300) {
      if (payload === undefined) {
        this.log?.('warn', '[License] Unparseable success body', method, path)
        return { ok: false, kind: 'network' }
      }
      return { ok: true, data: payload as T }
    }

    return toFailure(status, payload)
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function toFailure(status: number, payload: unknown): LicenseApiFailure {
  const record =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}

  // zod validation failures come back as { success: false, error: ZodError }
  // with no `ok` and no stable code. That only happens on a client bug, so the
  // API deliberately promises nothing about the shape.
  if (record['ok'] !== false) {
    return { ok: false, kind: 'malformed', status }
  }

  const code = record['error']
  if (typeof code !== 'string' || !LICENSE_ERROR_CODES.includes(code)) {
    // An `ok: false` envelope with an unfamiliar code: treat as internal so a
    // future server-side addition degrades to "temporary" rather than crashing.
    return { ok: false, kind: 'api', code: 'internal', status }
  }

  const message = record['message']
  const details = record['details']

  return {
    ok: false,
    kind: 'api',
    code: code as LicenseErrorCode,
    status,
    ...(typeof message === 'string' ? { message } : {}),
    ...(typeof details === 'object' && details !== null
      ? { details: details }
      : {}),
  }
}
