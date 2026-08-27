/**
 * License state machine.
 *
 * Entitlement is decided offline by verifying the stored token against the
 * embedded public key. The network is only used to obtain or renew that token,
 * and a failed network call never revokes access: the distinction between
 * "the server said no" and "we could not ask" is the whole point (SPEC 11-4).
 */
import {
  LICENSE_CLOCK_ROLLBACK_TOLERANCE_SEC,
  LICENSE_DEVICE_CHECK_MIN_INTERVAL_SEC,
  LICENSE_PRODUCT_ID,
  LICENSE_PUBLIC_KEY,
  LICENSE_REFRESH_THRESHOLD_SEC,
} from '../config'
import { normalizeCode } from '../token/code'
import type { TokenPayload } from '../token/token'
import { verifyToken } from '../token/token'
import type {
  DeviceView,
  LicenseApiClient,
  LicenseApiFailure,
  LicenseErrorCode,
  LicenseSummary,
} from './LicenseApiClient'
import { isTransientFailure } from './LicenseApiClient'
import type { LicenseStore } from './LicenseStore'
import { nowSec } from './LicenseStore'

/** Server-side rejections that mean the license itself is not usable. */
const BLOCKING_ERROR_CODES: readonly LicenseErrorCode[] = [
  'license_revoked',
  'license_expired',
  'license_suspended',
]

export type LicenseState =
  /** No code entered, or the stored token no longer verifies. */
  | { status: 'unlicensed' }
  /** A verified, unexpired token bound to this device. */
  | { status: 'active'; token: TokenPayload; license?: LicenseSummary }
  /** The server explicitly refused. Only reachable from a real response. */
  | { status: 'blocked'; reason: LicenseErrorCode }

export type LicenseChangeListener = (state: LicenseState) => void

/**
 * Outcome of asking the server whether this device still holds a seat.
 *
 * `unknown` covers both "there was nothing to check" and "we could not ask":
 * offline is never a reason to revoke.
 */
export type DeviceRegistrationCheck = 'registered' | 'released' | 'unknown'

/** Why an activation attempt did not produce a token. */
export type ActivationFailure =
  | { kind: 'invalid-input' }
  | { kind: 'device-limit'; devices: DeviceView[] }
  | LicenseApiFailure
  /** The token was issued but did not verify against the embedded public key. */
  | { kind: 'untrusted-token'; reason: string }

export type ActivationResult =
  | { ok: true; state: LicenseState }
  | { ok: false; failure: ActivationFailure }

export interface LicenseManagerDeps {
  client: LicenseApiClient
  store: LicenseStore
  /** Reads and writes settings.licenseCode, which is synced via data.json. */
  getCode: () => string | undefined
  setCode: (code: string | undefined) => Promise<void>
  platform?: string
  pluginVersion?: string
  deviceLabel?: string
  log?: (level: string, ...args: unknown[]) => void
  now?: () => number
}

export class LicenseManager {
  private state: LicenseState = { status: 'unlicensed' }
  private readonly listeners = new Set<LicenseChangeListener>()
  private refreshInFlight?: Promise<void>
  private deviceCheckInFlight?: Promise<DeviceRegistrationCheck>
  private lastDeviceCheckSec?: number

  constructor(private readonly deps: LicenseManagerDeps) {}

  /**
   * Decide entitlement from what is already on disk. Never touches the network,
   * so plugin startup is not gated on connectivity.
   */
  initialize(): LicenseState {
    this.setState(this.evaluateStoredToken())
    return this.state
  }

  getState(): LicenseState {
    return this.state
  }

  isActive(): boolean {
    return this.state.status === 'active'
  }

  getDeviceId(): string {
    return this.deps.store.getDeviceId()
  }

  /** Last known seat figures, available even while offline. */
  getLicenseSummary(): LicenseSummary | undefined {
    return this.deps.store.getState().license
  }

  onChange(listener: LicenseChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Exchange an activation code for a token and store the result. */
  async activate(rawCode: string): Promise<ActivationResult> {
    // The server normalizes identically, so this only saves a round trip on a
    // typo. The raw code is still what gets sent.
    if (normalizeCode(rawCode) === null) {
      return { ok: false, failure: { kind: 'invalid-input' } }
    }

    const result = await this.requestToken(rawCode.trim())
    if (result.ok) {
      await this.deps.setCode(rawCode.trim())
    }
    return result
  }

  /**
   * Renew the token when it is close to expiry. Silent by design: a failure
   * leaves an unexpired token in place, and there will be another attempt.
   */
  async refreshIfNeeded(force = false): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight

    const run = this.doRefresh(force).finally(() => {
      this.refreshInFlight = undefined
    })
    this.refreshInFlight = run
    return run
  }

  /** Whether a device check found this device gone and latched the token off. */
  isSeatReleased(): boolean {
    return this.deps.store.isSeatReleased()
  }

  /**
   * Ask the server whether this device still holds a seat.
   *
   * Offline verification cannot notice a seat released from another machine:
   * the stored token stays valid for the rest of its 7-day life, and a refresh
   * would simply claim the seat again under the same device id. So the device
   * list is the only thing that can tell us, and only a real answer counts —
   * every failure returns `unknown` and leaves entitlement alone.
   */
  async verifyDeviceRegistration(): Promise<DeviceRegistrationCheck> {
    if (this.state.status !== 'active') return 'unknown'

    const code = this.deps.getCode()
    if (code === undefined || code.length === 0) return 'unknown'

    if (this.deviceCheckInFlight) return this.deviceCheckInFlight

    const now = this.now()
    if (
      this.lastDeviceCheckSec !== undefined &&
      now - this.lastDeviceCheckSec < LICENSE_DEVICE_CHECK_MIN_INTERVAL_SEC
    ) {
      return 'unknown'
    }
    this.lastDeviceCheckSec = now

    const run = this.doVerifyDeviceRegistration().finally(() => {
      this.deviceCheckInFlight = undefined
    })
    this.deviceCheckInFlight = run

    return run
  }

  private async doVerifyDeviceRegistration(): Promise<DeviceRegistrationCheck> {
    const result = await this.listDevices()
    if (!result.ok) {
      // Unreachable server, rate limit, revoked license: none of these prove
      // the seat is gone, which is the only thing this check may act on.
      this.deps.log?.('warn', '[License] Device check failed', result.failure.kind)
      return 'unknown'
    }

    const deviceId = this.getDeviceId()
    if (result.devices.some((device) => device.device_id === deviceId)) return 'registered'

    // The state can have moved while the request was in flight — a release from
    // this very screen, say. Acting on a stale reading would clobber it.
    if (this.state.status !== 'active') return 'unknown'

    // The code stays in settings on purpose: data.json is synced, so clearing it
    // here would strip the license from every other vault that shares it. The
    // latch is device-local and stops this device alone from renewing.
    this.deps.store.markSeatReleased(this.now())
    this.setState({ status: 'unlicensed' })

    return 'released'
  }

  async listDevices(): Promise<
    { ok: true; devices: DeviceView[]; maxDevices: number } | { ok: false; failure: LicenseApiFailure }
  > {
    const code = this.deps.getCode()
    if (code === undefined || code.length === 0) {
      return { ok: false, failure: { ok: false, kind: 'malformed', status: 0 } }
    }

    const result = await this.deps.client.listDevices(code)
    if (!result.ok) return { ok: false, failure: result }

    return { ok: true, devices: result.data.devices, maxDevices: result.data.max_devices }
  }

  async deactivateDevice(
    deviceId: string,
  ): Promise<{ ok: true; devicesUsed: number } | { ok: false; failure: LicenseApiFailure }> {
    const code = this.deps.getCode()
    if (code === undefined || code.length === 0) {
      return { ok: false, failure: { ok: false, kind: 'malformed', status: 0 } }
    }

    const result = await this.deps.client.deactivateDevice(code, deviceId)
    if (!result.ok) return { ok: false, failure: result }

    // Releasing this very device invalidates the local token: it still verifies
    // cryptographically, but the seat is gone and no refresh will succeed.
    if (deviceId === this.getDeviceId()) {
      this.deps.store.clearToken()
      // The code has to go with it. Left in settings, the next refresh would
      // issue a fresh token under the same device id and silently retake the
      // seat the user just released — on this machine and, via Obsidian Sync,
      // on every other vault that shares data.json.
      try {
        await this.deps.setCode(undefined)
      } catch (error) {
        this.deps.log?.('warn', '[License] Failed to clear the stored code', error)
      }
      this.setState({ status: 'unlicensed' })
    }

    return { ok: true, devicesUsed: result.data.devices_used }
  }

  private async doRefresh(force: boolean): Promise<void> {
    const code = this.deps.getCode()
    if (code === undefined || code.length === 0) return

    // A seat released elsewhere left the code in place so other synced vaults
    // keep working. Refreshing here would hand this device the seat straight
    // back, undoing the release the user made deliberately.
    if (this.deps.store.isSeatReleased()) return

    if (!force && !this.needsRefresh()) return

    await this.requestToken(code)
  }

  private needsRefresh(): boolean {
    if (this.state.status !== 'active') return true

    const expiresAt = this.deps.store.getState().expiresAt
    if (expiresAt === undefined) return true

    return expiresAt - this.now() <= LICENSE_REFRESH_THRESHOLD_SEC
  }

  private async requestToken(code: string): Promise<ActivationResult> {
    const result = await this.deps.client.issueToken({
      code,
      deviceId: this.getDeviceId(),
      ...(this.deps.deviceLabel !== undefined ? { label: this.deps.deviceLabel } : {}),
      ...(this.deps.platform !== undefined ? { platform: this.deps.platform } : {}),
      ...(this.deps.pluginVersion !== undefined ? { pluginVersion: this.deps.pluginVersion } : {}),
    })

    if (!result.ok) {
      return { ok: false, failure: this.handleFailure(result) }
    }

    const { token, expires_at: expiresAt, license } = result.data
    const verification = verifyToken(LICENSE_PUBLIC_KEY, token, {
      productId: LICENSE_PRODUCT_ID,
      now: this.now(),
      deviceId: this.getDeviceId(),
    })

    if (!verification.ok) {
      // A token the issuer signed but we cannot verify means the embedded
      // public key does not match the server's private key. Storing it would
      // silently lock the user out; refusing it surfaces the misconfiguration.
      this.deps.log?.('error', '[License] Issued token failed verification', verification.error)
      return { ok: false, failure: { kind: 'untrusted-token', reason: verification.error } }
    }

    // Only activate() gets this far while the latch is on — doRefresh() bails
    // out first — so a new token here is always the user asking for the seat.
    this.deps.store.clearSeatReleased()
    this.deps.store.saveToken(token, expiresAt, license, this.now())
    this.setState({ status: 'active', token: verification.token, license })

    return { ok: true, state: this.state }
  }

  private handleFailure(failure: LicenseApiFailure): ActivationFailure {
    if (failure.kind !== 'api') {
      // Could not reach the server, or sent a malformed request. Neither says
      // anything about entitlement, so an unexpired token keeps working.
      this.deps.log?.('warn', '[License] Token request failed', failure.kind)
      return failure
    }

    if (failure.code === 'device_limit_reached') {
      return { kind: 'device-limit', devices: failure.details?.devices ?? [] }
    }

    if (BLOCKING_ERROR_CODES.includes(failure.code)) {
      this.deps.store.clearToken()
      this.setState({ status: 'blocked', reason: failure.code })
      return failure
    }

    if (failure.code === 'invalid_code' || failure.code === 'malformed_code') {
      // The stored code is not a license at all; the token cannot be renewed.
      this.deps.store.clearToken()
      this.setState({ status: 'unlicensed' })
      return failure
    }

    if (isTransientFailure(failure)) {
      this.deps.log?.('warn', '[License] Temporary server failure', failure.code)
    }

    return failure
  }

  private evaluateStoredToken(): LicenseState {
    const stored = this.deps.store.getState()
    if (stored.token === undefined) return { status: 'unlicensed' }

    const now = this.now()

    // Offline verification trusts the device clock, so a large rollback would
    // otherwise resurrect an expired token indefinitely (SPEC 11-5).
    if (this.deps.store.isClockRolledBack(now, LICENSE_CLOCK_ROLLBACK_TOLERANCE_SEC)) {
      this.deps.log?.('warn', '[License] Local clock is behind the last known server time')
      return { status: 'unlicensed' }
    }

    const verification = verifyToken(LICENSE_PUBLIC_KEY, stored.token, {
      productId: LICENSE_PRODUCT_ID,
      now,
      deviceId: stored.deviceId,
    })

    if (!verification.ok) {
      this.deps.log?.('warn', '[License] Stored token rejected', verification.error)
      return { status: 'unlicensed' }
    }

    return {
      status: 'active',
      token: verification.token,
      ...(stored.license !== undefined ? { license: stored.license } : {}),
    }
  }

  private setState(next: LicenseState): void {
    const previous = this.state
    this.state = next

    // A blocked -> blocked transition still matters when the reason changed:
    // "suspended" and "revoked" send the user to different places.
    const changed =
      previous.status !== next.status ||
      (previous.status === 'blocked' && next.status === 'blocked' && previous.reason !== next.reason)
    if (!changed) return

    for (const listener of this.listeners) {
      try {
        listener(next)
      } catch (error) {
        this.deps.log?.('warn', '[License] Listener failed', error)
      }
    }
  }

  private now(): number {
    return this.deps.now?.() ?? nowSec()
  }
}
