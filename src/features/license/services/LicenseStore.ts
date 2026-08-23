/**
 * Persistence for license state, split across two stores on purpose.
 *
 * The activation code lives in settings (data.json) so that a synced vault
 * carries the entitlement to a new machine, which then activates itself.
 *
 * Everything device-bound — the device id, the token signed against it, and the
 * last known server time — lives in Obsidian's device-local storage. This is a
 * deliberate deviation from the API's SPEC 11-1, which assumes both go in
 * data.json: with Obsidian Sync that file is shared, so a synced token would
 * arrive on a second machine bound to the first machine's device id and fail
 * verification with `device-mismatch` forever.
 *
 * Follows the precedent set by AiCustomModelStore.
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
}

/** Duck-typed App#loadLocalStorage / App#saveLocalStorage bridge. */
export interface LicenseStorageBridge {
  loadLocalStorage?: (key: string) => unknown
  saveLocalStorage?: (key: string, value: unknown) => void
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

export class LicenseStore {
  private state: LicenseDeviceState

  constructor(private readonly bridge: LicenseStorageBridge) {
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
    const { deviceId, lastServerTimeSec } = this.state
    this.state = { deviceId, ...(lastServerTimeSec !== undefined ? { lastServerTimeSec } : {}) }
    this.write()
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

  private read(): LicenseDeviceState {
    let raw: unknown
    try {
      raw = this.bridge.loadLocalStorage?.(LICENSE_DEVICE_STATE_STORAGE_KEY)
    } catch {
      raw = undefined
    }

    // Obsidian returns the parsed value, but older vaults may hold a string.
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw) as unknown
      } catch {
        raw = undefined
      }
    }

    const record =
      typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}

    const deviceId = isValidDeviceId(record['deviceId']) ? record['deviceId'] : generateDeviceId()
    const token = typeof record['token'] === 'string' ? record['token'] : undefined
    const expiresAt = readPositiveInt(record['expiresAt'])
    const lastServerTimeSec = readPositiveInt(record['lastServerTimeSec'])
    const license = readLicenseSummary(record['license'])

    return {
      deviceId,
      ...(token !== undefined ? { token } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(lastServerTimeSec !== undefined ? { lastServerTimeSec } : {}),
      ...(license !== undefined ? { license } : {}),
    }
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
