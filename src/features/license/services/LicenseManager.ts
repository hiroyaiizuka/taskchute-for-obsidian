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

/** The seat list as the server last reported it. */
export interface DeviceListSnapshot {
  devices: DeviceView[]
  maxDevices: number
  /** Unix seconds, so a view can tell a fresh answer from a stale one. */
  fetchedAt: number
}

export type DeviceListListener = (snapshot: DeviceListSnapshot) => void

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
  private syncInFlight?: Promise<LicenseState>
  private lastSyncSec?: number
  /** A code the server called invalid, so the sync stops re-asking about it. */
  private rejectedCode?: string
  private deviceSnapshot?: DeviceListSnapshot
  private deviceListInFlight?: Promise<
    { ok: true; devices: DeviceView[]; maxDevices: number } | { ok: false; failure: LicenseApiFailure }
  >
  private readonly deviceListeners = new Set<DeviceListListener>()

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

  /**
   * The activation code this device may act with, or undefined once it has
   * given up its seat.
   *
   * The code cannot simply be deleted: it lives in data.json, which Obsidian
   * Sync shares, so removing it would take the license away from every other
   * machine as well. Hiding it behind the device-local latch throws it away
   * where it has to be thrown away — on this machine — and leaves the others
   * untouched. Everything downstream then follows for free: no refresh, no
   * device check, an empty field in settings, and no way back except the user
   * entering the code again.
   */
  getStoredCode(): string | undefined {
    return this.usableCode()
  }

  private usableCode(): string | undefined {
    if (this.deps.store.isSeatReleased()) return undefined

    const code = this.deps.getCode()
    return code !== undefined && code.length > 0 ? code : undefined
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

  /** Whether this device has given up its seat and latched the code off. */
  isSeatReleased(): boolean {
    return this.deps.store.isSeatReleased()
  }

  /**
   * Settle this device's entitlement against the server and report the result.
   *
   * The single entry point for "am I still Pro?", used on startup, on the
   * background timer, and when the settings screen is opened. Returns the state
   * afterwards so a caller that drew the old one can compare and redraw.
   *
   * Never throws and never rejects: every failure inside leaves entitlement
   * exactly as it was, because being unable to ask is not an answer.
   *
   * @param options.force Skip the throttle. For the settings screen being
   * opened, which is a deliberate act by someone waiting to see the answer.
   */
  async syncFromServer(options: { force?: boolean } = {}): Promise<LicenseState> {
    if (this.syncInFlight) return this.syncInFlight

    const now = this.now()
    if (
      options.force !== true &&
      this.lastSyncSec !== undefined &&
      now - this.lastSyncSec < LICENSE_DEVICE_CHECK_MIN_INTERVAL_SEC
    ) {
      return this.state
    }
    this.lastSyncSec = now

    const run = this.doSync().finally(() => {
      this.syncInFlight = undefined
    })
    this.syncInFlight = run

    return run
  }

  private async doSync(): Promise<LicenseState> {
    try {
      return await this.settleAgainstServer()
    } catch (error) {
      // The API client turns every outcome into a value, so this is a bug or a
      // broken environment rather than an unreachable server. It still must not
      // reach the callers: they are plugin startup, a background timer and the
      // settings screen, none of which may be derailed by the license server.
      this.deps.log?.('warn', '[License] License sync failed', error)
      return this.state
    }
  }

  private async settleAgainstServer(): Promise<LicenseState> {
    // The seat question comes first. Issuing a token re-registers this device
    // id, so a refresh that ran ahead of the check would hand the seat straight
    // back and the list would then honestly report the device present — a
    // release made from another machine would vanish without a trace.
    //
    // Forced because this method's own throttle already decided the call was
    // due; letting the check's floor veto it again is how a sync a minute after
    // startup came to do nothing at all.
    if ((await this.verifyDeviceRegistration({ force: true })) === 'released') {
      return this.state
    }

    if (this.state.status === 'active') {
      // Not forced: an unexpired token needs nothing, and the check above has
      // already confirmed the seat.
      await this.refreshIfNeeded()
      return this.state
    }

    // Not active, which offline evidence alone cannot undo — the token may have
    // simply expired while the machine was away, or the license may have been
    // un-suspended since. Only the server can say. A device that gave up its
    // seat has no usable code, so this can never retake one.
    const code = this.usableCode()
    if (code === undefined || code === this.rejectedCode) return this.state

    await this.requestToken(code)

    return this.state
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
  async verifyDeviceRegistration(
    options: { force?: boolean } = {},
  ): Promise<DeviceRegistrationCheck> {
    // Only an entitlement that is currently granted can be taken away, and a
    // device that already gave up its seat has no code to ask with.
    if (this.state.status !== 'active') return 'unknown'
    if (this.usableCode() === undefined) return 'unknown'

    if (this.deviceCheckInFlight) return this.deviceCheckInFlight

    const now = this.now()
    if (
      options.force !== true &&
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

    // Drops the token and, with it, the code — device-locally. The value in
    // settings is left alone because data.json is synced and clearing it would
    // strip the license from every other machine that shares it; the latch
    // makes it unreadable here, which is what "throw the code away" means on
    // the one device that lost its seat.
    this.deps.store.markSeatReleased(this.now())
    this.setState({ status: 'unlicensed' })

    return 'released'
  }

  /** The seats as of the last successful fetch, for a list that has to paint now. */
  getDeviceSnapshot(): DeviceListSnapshot | undefined {
    return this.deviceSnapshot
  }

  /**
   * Watch the seat list. The settings screen settles entitlement and the seat
   * list from the same fetch, so the list has to hear about a result it did not
   * ask for itself.
   */
  onDevicesChange(listener: DeviceListListener): () => void {
    this.deviceListeners.add(listener)
    return () => {
      this.deviceListeners.delete(listener)
    }
  }

  /**
   * @param explicitCode A code that is not (yet) stored, e.g. the one the user
   * just typed and that the API rejected with device_limit_reached. Without it
   * the seat list is unreachable from the very screen that has to free a seat.
   */
  async listDevices(
    explicitCode?: string,
  ): Promise<
    { ok: true; devices: DeviceView[]; maxDevices: number } | { ok: false; failure: LicenseApiFailure }
  > {
    const code = explicitCode ?? this.usableCode()
    if (code === undefined || code.length === 0) {
      return { ok: false, failure: { ok: false, kind: 'no-code' } }
    }

    // Opening the Pro screen asks this question twice at once — the sync, to
    // find out whether this device still holds a seat, and the list the screen
    // draws. One request answers both, and answers them identically, which a
    // second request would not guarantee. Only for the stored code: an explicit
    // one belongs to a different license than the one being coalesced.
    if (explicitCode === undefined && this.deviceListInFlight) {
      return this.deviceListInFlight
    }

    const run = this.fetchDevices(code).finally(() => {
      if (explicitCode === undefined) this.deviceListInFlight = undefined
    })
    if (explicitCode === undefined) this.deviceListInFlight = run

    return run
  }

  private async fetchDevices(
    code: string,
  ): Promise<
    { ok: true; devices: DeviceView[]; maxDevices: number } | { ok: false; failure: LicenseApiFailure }
  > {
    const result = await this.deps.client.listDevices(code)
    if (!result.ok) return { ok: false, failure: result }

    this.setDeviceSnapshot({
      devices: result.data.devices,
      maxDevices: result.data.max_devices,
      fetchedAt: this.now(),
    })

    return { ok: true, devices: result.data.devices, maxDevices: result.data.max_devices }
  }

  private setDeviceSnapshot(snapshot: DeviceListSnapshot): void {
    this.deviceSnapshot = snapshot

    for (const listener of this.deviceListeners) {
      try {
        listener(snapshot)
      } catch (error) {
        this.deps.log?.('warn', '[License] Device list listener failed', error)
      }
    }
  }

  /** @param explicitCode See listDevices: the code behind a 409 is not stored. */
  async deactivateDevice(
    deviceId: string,
    explicitCode?: string,
  ): Promise<{ ok: true; devicesUsed: number } | { ok: false; failure: LicenseApiFailure }> {
    const code = explicitCode ?? this.usableCode()
    if (code === undefined || code.length === 0) {
      return { ok: false, failure: { ok: false, kind: 'no-code' } }
    }

    const result = await this.deps.client.deactivateDevice(code, deviceId)
    if (!result.ok) return { ok: false, failure: result }

    // Drop the seat from the snapshot rather than re-fetching: the server has
    // just told us it is gone, and every list watching stays in step without a
    // second request.
    if (this.deviceSnapshot) {
      this.setDeviceSnapshot({
        ...this.deviceSnapshot,
        devices: this.deviceSnapshot.devices.filter((device) => device.device_id !== deviceId),
      })
    }

    // Releasing this very device invalidates the local token: it still verifies
    // cryptographically, but the seat is gone and no refresh will succeed.
    //
    // The same latch as a release from another machine, and for the same
    // reason: the code has to stop working here — otherwise the next refresh
    // would issue a fresh token under the same device id and silently retake
    // the seat the user just gave up — while staying readable on every other
    // machine that shares data.json through Obsidian Sync.
    if (deviceId === this.getDeviceId()) {
      this.deps.store.markSeatReleased(this.now())
      this.setState({ status: 'unlicensed' })
    }

    return { ok: true, devicesUsed: result.data.devices_used }
  }

  /**
   * Give this device's licence up locally, without asking the server.
   *
   * The way out of the one state the seat list cannot fix: an active token
   * with no code behind it. The token lives in device-local storage and the
   * code in the synced vault settings, so a vault whose data.json never
   * carried the code — activated in another vault on this machine, or restored
   * from elsewhere — is licensed but unable to act: every request needs the
   * code, and the active screen has no field to enter one. Dropping the token
   * returns the screen to the activation form, which is the field.
   *
   * Not a seat release: nothing is sent, so the server still counts this
   * device. That is deliberate — the device id is kept, so re-entering the code
   * here reuses the very same seat rather than spending another one. A user who
   * does not come back can release the seat from any other machine's list.
   */
  signOutLocally(): void {
    this.deps.store.clearToken()
    // A list drawn from this belongs to a licence this device no longer holds.
    this.deviceSnapshot = undefined
    this.setState({ status: 'unlicensed' })
  }

  private async doRefresh(force: boolean): Promise<void> {
    // Undefined once this device gave up its seat, which is what stops a
    // refresh from handing it straight back.
    const code = this.usableCode()
    if (code === undefined) return

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
      return { ok: false, failure: this.handleFailure(code, result) }
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

    // Only activate() gets this far while the latch is on — every other path
    // reads the code through usableCode(), which returns nothing — so a new
    // token here is always the user deliberately asking for the seat back.
    this.rejectedCode = undefined
    this.deps.store.clearSeatReleased()
    this.deps.store.saveToken(token, expiresAt, license, this.now())
    this.setState({ status: 'active', token: verification.token, license })

    return { ok: true, state: this.state }
  }

  private handleFailure(code: string, failure: LicenseApiFailure): ActivationFailure {
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
      // Remembered so the periodic sync stops asking: a revoked or suspended
      // license may be reinstated, but a string that is not a code never
      // becomes one, and every settings visit would otherwise spend a request
      // re-learning that.
      this.rejectedCode = code
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
