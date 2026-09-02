/**
 * Persistence for license state, split across two stores on purpose.
 *
 * The activation code lives in settings (data.json) so that a synced vault
 * carries the entitlement to a new machine, which then activates itself.
 *
 * Everything device-bound — the device id, the token signed against it, and the
 * last known server time — lives in device-local storage. This is a deliberate
 * deviation from the API's SPEC 11-1, which assumes both go in data.json: with
 * Obsidian Sync that file is shared, so a synced token would arrive on a second
 * machine bound to the first machine's device id and fail verification with
 * `device-mismatch` forever.
 *
 * The storage is the raw `window.localStorage`, *not* Obsidian's
 * `App#saveLocalStorage`. The latter prefixes every key with the vault's app
 * id, which would make each vault on one machine present a different device id
 * and consume a seat of its own. The raw store is shared by every vault of one
 * Obsidian install, which is as close to "one machine" as the plugin sandbox
 * gets — the same approach DeviceIdentityService already takes for the
 * execution log. Older installs kept their state in the vault-scoped store, so
 * a legacy bridge can be passed in and is read once to adopt its device id
 * (see `read`).
 */
import type { LicenseSummary } from './LicenseApiClient'

/** Device-local, never synced. */
export const LICENSE_DEVICE_STATE_STORAGE_KEY = 'taskchute-plus.license-device-state'

export interface LicenseDeviceState {
  /** Opaque, generated once per device. The API constrains it to 8–64 chars. */
  deviceId: string
  /** The signed auth token, or undefined before the first activation. */
  token?: string
  /** Token expiry in unix seconds, as reported by the server. */
  expiresAt?: number
  /**
   * The most recent server-reported time we have seen. Compared against the
   * local clock to detect a deliberate rollback (SPEC 11-5).
   */
  lastServerTimeSec?: number
  /** Last known seat/expiry figures, for display while offline. */
  license?: LicenseSummary
  /**
   * When this device gave up its seat, in unix seconds — whether the user
   * released it from here or another device released it for them.
   *
   * The activation code itself cannot be thrown away: it lives in data.json,
   * which Obsidian Sync shares, so deleting it would strip the license from
   * every other machine too. This is the device-local half of throwing it away.
   * While it is set the stored code is treated as absent — no refresh, no
   * device check, and an empty field in settings — so nothing on this machine
   * quietly retakes the seat. Only an explicit activation lifts it.
   */
  seatReleasedAt?: number
}

/**
 * Key/value storage for the device state. Shaped after Obsidian's
 * `App#loadLocalStorage` / `App#saveLocalStorage` so the App object itself can
 * still be passed as the legacy bridge.
 */
export interface LicenseStorageBridge {
  loadLocalStorage?: (key: string) => unknown
  saveLocalStorage?: (key: string, value: unknown) => void
}

/** Written and removed only to find out whether the store accepts writes. */
const STORAGE_PROBE_KEY = 'taskchute-plus.license-storage-probe'

/**
 * The vault-independent store, or undefined where it cannot be used.
 *
 * Undefined has to stay distinguishable from "empty": a bridge that silently
 * drops writes would hand out a fresh device id on every launch and burn a seat
 * each time, so the caller falls back to the vault-scoped store instead.
 */
export function createDeviceLocalStorageBridge(): LicenseStorageBridge | undefined {
  try {
    const storage = window.localStorage
    if (!storage) return undefined

    // Presence is not permission: private modes and hardened setups expose the
    // object and throw on write.
    storage.setItem(STORAGE_PROBE_KEY, '1')
    storage.removeItem(STORAGE_PROBE_KEY)

    return {
      loadLocalStorage: (key) => storage.getItem(key) ?? undefined,
      saveLocalStorage: (key, value) => {
        storage.setItem(key, JSON.stringify(value))
      },
    }
  } catch {
    return undefined
  }
}

const DEVICE_ID_PREFIX = 'DEVICE-'
/** 20 hex characters keeps the whole id at 27 chars, inside the API's 8–64. */
const DEVICE_ID_RANDOM_BYTES = 10

export function generateDeviceId(): string {
  const bytes = new Uint8Array(DEVICE_ID_RANDOM_BYTES)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    // Obsidian always provides Web Crypto; this only guards exotic hosts, where
    // a weaker id costs nothing (it identifies a seat, it does not authorize).
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

  return `${DEVICE_ID_PREFIX}${hex.toUpperCase()}`
}

function isValidDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 64
}

function readLicenseSummary(value: unknown): LicenseSummary | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record['license_id'] !== 'string') return undefined
  if (typeof record['max_devices'] !== 'number') return undefined
  if (typeof record['devices_used'] !== 'number') return undefined

  const expiresAt = record['expires_at']

  return {
    license_id: record['license_id'],
    max_devices: record['max_devices'],
    devices_used: record['devices_used'],
    expires_at: typeof expiresAt === 'number' ? expiresAt : null,
  }
}

function readPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * One store's state, or undefined when it holds nothing usable.
 *
 * A record without a valid device id is treated as absent in full: whatever
 * token sits beside it is signed against an id this device can no longer
 * present, so it could never verify.
 */
function readState(bridge: LicenseStorageBridge): LicenseDeviceState | undefined {
  let raw: unknown
  try {
    raw = bridge.loadLocalStorage?.(LICENSE_DEVICE_STATE_STORAGE_KEY)
  } catch {
    return undefined
  }

  // The raw store hands back the JSON text; Obsidian's App parses it for us.
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown
    } catch {
      return undefined
    }
  }

  if (typeof raw !== 'object' || raw === null) return undefined

  const record = raw as Record<string, unknown>
  if (!isValidDeviceId(record['deviceId'])) return undefined

  const token = typeof record['token'] === 'string' ? record['token'] : undefined
  const expiresAt = readPositiveInt(record['expiresAt'])
  const lastServerTimeSec = readPositiveInt(record['lastServerTimeSec'])
  const license = readLicenseSummary(record['license'])
  const seatReleasedAt = readPositiveInt(record['seatReleasedAt'])

  return {
    deviceId: record['deviceId'],
    ...(token !== undefined ? { token } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(lastServerTimeSec !== undefined ? { lastServerTimeSec } : {}),
    ...(license !== undefined ? { license } : {}),
    ...(seatReleasedAt !== undefined ? { seatReleasedAt } : {}),
  }
}

export class LicenseStore {
  private state: LicenseDeviceState

  /**
   * `legacy` is the store an older version of the plugin wrote to (the
   * vault-scoped one). It is only ever read, and only when `bridge` holds
   * nothing usable.
   */
  constructor(
    private readonly bridge: LicenseStorageBridge,
    private readonly legacy?: LicenseStorageBridge,
  ) {
    this.state = this.read()
    // Persist immediately so a freshly generated device id survives a crash
    // before the first activation; otherwise a seat could be claimed under an
    // id this device would never present again.
    this.write()
  }

  /** Stable for the lifetime of this device, created on first access. */
  getDeviceId(): string {
    return this.state.deviceId
  }

  getState(): Readonly<LicenseDeviceState> {
    return this.state
  }

  /**
   * Record a successful token issue or refresh. `now` is passed in rather than
   * read from the clock here, so the rollback watermark and the manager's
   * expiry checks can never disagree about what time it is.
   */
  saveToken(token: string, expiresAt: number, license: LicenseSummary, now: number): void {
    this.state = {
      ...this.state,
      token,
      expiresAt,
      license,
      // Any successful response proves the clock was at least this far along,
      // which is what the rollback check compares against. Never moves back.
      lastServerTimeSec: Math.max(this.state.lastServerTimeSec ?? 0, now),
    }
    this.write()
  }

  /** Update the cached seat figures without touching the token. */
  saveLicenseSummary(license: LicenseSummary): void {
    this.state = { ...this.state, license }
    this.write()
  }

  /** Drop the token but keep the device id, so re-activation reuses the seat. */
  clearToken(): void {
    const { deviceId, lastServerTimeSec, seatReleasedAt } = this.state
    this.state = {
      deviceId,
      ...(lastServerTimeSec !== undefined ? { lastServerTimeSec } : {}),
      ...(seatReleasedAt !== undefined ? { seatReleasedAt } : {}),
    }
    this.write()
  }

  /**
   * Record that this device no longer holds a seat. Drops the token like
   * clearToken(), and latches the fact so nothing on this machine claims the
   * seat back — only an explicit activation may do that.
   */
  markSeatReleased(now: number): void {
    this.clearToken()
    this.state = { ...this.state, seatReleasedAt: now }
    this.write()
  }

  /** Lift the latch. Only a successful token request has the right to do this. */
  clearSeatReleased(): void {
    if (this.state.seatReleasedAt === undefined) return
    const { seatReleasedAt: _removed, ...rest } = this.state
    this.state = rest
    this.write()
  }

  isSeatReleased(): boolean {
    return this.state.seatReleasedAt !== undefined
  }

  /**
   * Whether the local clock has rewound far enough behind the last server-
   * confirmed time to make offline expiry meaningless.
   */
  isClockRolledBack(now: number, toleranceSec: number): boolean {
    const lastSeen = this.state.lastServerTimeSec
    if (lastSeen === undefined) return false

    return now < lastSeen - toleranceSec
  }

  /**
   * The stored state, migrating from the legacy store when this one is empty.
   *
   * Adopting the legacy device id rather than minting a new one keeps the seat
   * this vault already holds. Where several vaults on one machine each hold a
   * seat, whichever launches first wins the machine's id and the others fall in
   * behind it; their old seats stay until the user releases them from the
   * device list. The legacy entry is left in place — it is never written again,
   * and it costs nothing to leave a way back if this store is ever wiped.
   */
  private read(): LicenseDeviceState {
    const current = readState(this.bridge)
    if (current) return current

    const migrated = this.legacy ? readState(this.legacy) : undefined
    if (migrated) return migrated

    return { deviceId: generateDeviceId() }
  }

  private write(): void {
    try {
      this.bridge.saveLocalStorage?.(LICENSE_DEVICE_STATE_STORAGE_KEY, this.state)
    } catch {
      // Storage is best-effort: losing it costs one re-activation, not access.
    }
  }
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}
