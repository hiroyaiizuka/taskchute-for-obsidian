/**
 * Persistence for license state, split across two stores on purpose.
 *
 * The activation code lives in settings (data.json) so a synced vault carries
 * the entitlement to a new machine. Everything device-bound — device id, token,
 * last known server time — lives in device-local storage instead. This departs
 * from the API's SPEC 11-1, which puts both in data.json: Obsidian Sync shares
 * that file, so a synced token would reach a second machine bound to the first
 * machine's device id and fail with `device-mismatch` forever.
 *
 * The store is raw `window.localStorage`, not Obsidian's `App#saveLocalStorage`
 * — the latter prefixes keys with the vault's app id, so each vault on one
 * machine would present its own device id and take a seat of its own. A legacy
 * bridge for that vault-scoped store can be passed in, and is read once at
 * construction.
 *
 * Every vault of one install therefore shares one record, so nothing here
 * caches it: each operation re-reads, applies its change, and writes back. A
 * cached copy would restore a refresh secret the server has already replaced
 * and strand the whole machine on `stale_secret`.
 */
import type { LicenseSummary } from './LicenseApiClient'

/** Device-local, never synced. */
export const LICENSE_DEVICE_STATE_STORAGE_KEY = 'taskchute-plus.license-device-state'

export interface LicenseDeviceState {
  /** Opaque, generated once per device. The API constrains it to 8–64 chars. */
  deviceId: string
  /** The signed auth token, or undefined before the first activation. */
  token?: string
  /**
   * The one-shot secret that buys the next token, or undefined before the first
   * activation.
   *
   * Every issue replaces it server-side, which is what makes a copied device
   * state stop working: whoever refreshes first keeps the seat and the other is
   * told `stale_secret`. Device-local rather than in the synced data.json,
   * because a seat is per device.
   */
  refreshSecret?: string
  /**
   * Where `refreshSecret` sits in the server's order of issues. Absent before
   * the first activation, and from a server that predates the number.
   *
   * Two vaults of one install share this record, and inside the server's grace
   * window both can spend the same generation and succeed. The response that
   * arrives second is not necessarily the one the server treats as current, and
   * the secrets are indistinguishable — so the record keeps the highest
   * generation rather than the latest write.
   */
  secretGeneration?: number
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
   * When this device gave up its seat, in unix seconds — released from here or
   * by another device. The canonical explanation of the latch; other code that
   * sets or reads it points back here.
   *
   * The activation code itself cannot be thrown away: data.json is shared by
   * Obsidian Sync, so deleting it would strip the license from every other
   * machine. This is the device-local half of throwing it away. While it is set
   * the stored code reads as absent — no refresh, no device check, an empty
   * field in settings — so nothing here quietly retakes the seat. Only an
   * explicit activation lifts it.
   */
  seatReleasedAt?: number
}

/** A token the server just issued, and what the record needs to file it. */
export interface SaveTokenInput {
  token: string
  expiresAt: number
  license: LicenseSummary
  /**
   * Server-confirmed time, passed in so the rollback watermark and the
   * manager's expiry checks cannot disagree about the clock.
   */
  now: number
  /** The generation that buys the next token. Absent from an older server. */
  refreshSecret?: string
  /** Where that secret sits in the server's order. Absent from an older server. */
  secretGeneration?: number
  /**
   * Whether this response outranks the record whatever its generation says.
   *
   * True only for an activation: the user asked for it, only one can be in
   * flight, and a seat rebuilt from scratch starts counting again, so refusing
   * it as "older" would strand the machine on a discarded secret. A renewal is
   * never authoritative — that is what the generation orders.
   */
  authoritative?: boolean
}

/**
 * Whether a response should be written, or has already been overtaken.
 *
 * The comparison is strict: an equal generation is the same issue arriving
 * twice, and rewriting it would only risk undoing a concurrent one.
 */
function outranksRecord(input: SaveTokenInput, record: LicenseDeviceState): boolean {
  if (input.authoritative === true) return true

  // No order to respect: a server that predates the number, or a record written
  // by a build that did not keep it. Falls back to last-write-wins.
  if (input.secretGeneration === undefined) return true
  if (record.secretGeneration === undefined) return true

  return input.secretGeneration > record.secretGeneration
}

/** How many times a write will re-assert itself against an older one. */
const REPAIR_ATTEMPTS = 2

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
 * drops writes would mint a new device id — a new seat — on every launch, so
 * the caller falls back to the vault-scoped store instead.
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

/**
 * A fresh device id: a v4 UUID, 36 characters, inside the API's 8–64.
 *
 * A new id is a new seat, so this runs once per device and never again — an
 * existing id is read back verbatim, and `isValidDeviceId` checks length rather
 * than format so the shape can change without disturbing installs holding one.
 * The id only names a seat; entitlement rests on the token and the refresh
 * secret, so the weaker fallback below costs nothing but collision odds.
 */
export function generateDeviceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return uuidV4FromBytes(randomBytes(16))
}

/** 16 random bytes, degrading to Math.random only where Web Crypto is absent. */
function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
    return bytes
  }

  // Obsidian always provides Web Crypto; this only guards exotic hosts.
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)

  return bytes
}

/** Format 16 bytes as a v4 UUID, for hosts without `crypto.randomUUID`. */
function uuidV4FromBytes(bytes: Uint8Array): string {
  // Version and variant bits, per RFC 4122 section 4.4
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

function isValidDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 64
}

/**
 * Reads only the fields still in use. A record written by an older build also
 * carries `license_id`; it is left where it is rather than required, so an
 * install that predates its removal keeps its cached seat figures.
 */
function readLicenseSummary(value: unknown): LicenseSummary | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record['max_devices'] !== 'number') return undefined
  if (typeof record['devices_used'] !== 'number') return undefined

  const expiresAt = record['expires_at']

  return {
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
 * A record without a valid device id is discarded whole: any token beside it is
 * signed against an id this device can no longer present.
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
  const refreshSecret =
    typeof record['refreshSecret'] === 'string' && record['refreshSecret'].length > 0
      ? record['refreshSecret']
      : undefined
  const secretGeneration = readPositiveInt(record['secretGeneration'])
  const expiresAt = readPositiveInt(record['expiresAt'])
  const lastServerTimeSec = readPositiveInt(record['lastServerTimeSec'])
  const license = readLicenseSummary(record['license'])
  const seatReleasedAt = readPositiveInt(record['seatReleasedAt'])

  return {
    deviceId: record['deviceId'],
    ...(token !== undefined ? { token } : {}),
    ...(refreshSecret !== undefined ? { refreshSecret } : {}),
    ...(secretGeneration !== undefined ? { secretGeneration } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(lastServerTimeSec !== undefined ? { lastServerTimeSec } : {}),
    ...(license !== undefined ? { license } : {}),
    ...(seatReleasedAt !== undefined ? { seatReleasedAt } : {}),
  }
}

export class LicenseStore {
  /**
   * The id to present when the record is gone — cleared storage, or a write
   * that never landed. Minted or migrated once, at construction.
   *
   * A fallback, never an override: an id in the record always wins. Minting one
   * mid-session would spend a second seat, and two vaults doing so on a fresh
   * install would disagree forever, holding a seat each.
   */
  private readonly sessionDeviceId: string

  /**
   * `legacy` is the store an older version of the plugin wrote to (the
   * vault-scoped one). It is only ever read, and only when `bridge` holds
   * nothing usable.
   */
  constructor(
    private readonly bridge: LicenseStorageBridge,
    legacy?: LicenseStorageBridge,
  ) {
    const stored = readState(this.bridge)
    const initial = stored ?? (legacy ? readState(legacy) : undefined) ?? {
      deviceId: generateDeviceId(),
    }
    this.sessionDeviceId = initial.deviceId

    // Persist a migrated or fresh id right away, so it survives a crash before
    // the first activation. An id already in the record needs no rewrite —
    // that would clobber whatever a sibling vault wrote in between.
    if (stored === undefined) this.writeRecord(initial)
  }

  /** Stable for the lifetime of this device, created on first access. */
  getDeviceId(): string {
    return this.read().deviceId
  }

  getState(): Readonly<LicenseDeviceState> {
    return this.read()
  }

  /**
   * Record a successful token issue or refresh.
   *
   * `refreshSecret` is the generation that buys the *next* token; storing it in
   * the same pass as the token keeps the pair consistent. A response the record
   * has already moved past is dropped rather than written (see `outranksRecord`);
   * callers need not check, since the value that won is in the record either way.
   */
  saveToken(input: SaveTokenInput): void {
    const current = this.read()
    if (!outranksRecord(input, current)) return

    const next: LicenseDeviceState = {
      ...current,
      token: input.token,
      expiresAt: input.expiresAt,
      license: input.license,
      // Absent from a server that has not rolled the secret out yet, in which
      // case the old one stays: dropping it would force a code re-entry.
      ...(input.refreshSecret !== undefined ? { refreshSecret: input.refreshSecret } : {}),
      ...(input.secretGeneration !== undefined
        ? { secretGeneration: input.secretGeneration }
        : {}),
      // The watermark the rollback check compares against. Never moves back,
      // and the floor is the record's value, not one read hours ago.
      lastServerTimeSec: Math.max(current.lastServerTimeSec ?? 0, input.now),
    }

    this.writeRecord(next)
    this.repairOlderWrite(next)
  }

  /**
   * Put `next` back if a lower generation has since overwritten it.
   *
   * The read-modify-write is not atomic, so sibling vaults can interleave and
   * one can land an older record last. Every writer checking after itself makes
   * them converge, since both aim at the same maximum. Bounded, because a
   * *higher* generation means someone else's answer is the one to keep.
   */
  private repairOlderWrite(next: LicenseDeviceState): void {
    const generation = next.secretGeneration
    // Nothing to order by: a server without the number leaves last-write-wins.
    if (generation === undefined) return

    for (let attempt = 0; attempt < REPAIR_ATTEMPTS; attempt++) {
      const stored = this.read().secretGeneration
      if (stored !== undefined && stored >= generation) return

      this.writeRecord(next)
    }
  }

  /**
   * Drop the token but keep the device id, so re-activation reuses the seat.
   *
   * The refresh secret goes with it: it renews without asking anyone, so
   * leaving it behind would let a device just told it is unlicensed buy itself
   * another week.
   */
  clearToken(): void {
    this.writeRecord(withoutToken(this.read()))
  }

  /**
   * Record that this device no longer holds a seat. Drops the token like
   * clearToken(), and latches `seatReleasedAt` so nothing here claims the seat
   * back until an explicit activation.
   */
  markSeatReleased(now: number): void {
    this.writeRecord({ ...withoutToken(this.read()), seatReleasedAt: now })
  }

  /** Lift the latch. Only a successful token request has the right to do this. */
  clearSeatReleased(): void {
    const { seatReleasedAt, ...rest } = this.read()
    if (seatReleasedAt === undefined) return

    this.writeRecord(rest)
  }

  isSeatReleased(): boolean {
    return this.read().seatReleasedAt !== undefined
  }

  /**
   * Whether the local clock has rewound far enough behind the last server-
   * confirmed time to make offline expiry meaningless.
   */
  isClockRolledBack(now: number, toleranceSec: number): boolean {
    const lastSeen = this.read().lastServerTimeSec
    if (lastSeen === undefined) return false

    return now < lastSeen - toleranceSec
  }

  /**
   * The record as it stands now — the only state this class has.
   *
   * The legacy store is not consulted here: reading it a second time could
   * resurrect a token this device has given up. A missing record falls back to
   * the session id rather than a new one, which would be a new seat.
   */
  private read(): LicenseDeviceState {
    return readState(this.bridge) ?? { deviceId: this.sessionDeviceId }
  }

  private writeRecord(state: LicenseDeviceState): void {
    try {
      this.bridge.saveLocalStorage?.(LICENSE_DEVICE_STATE_STORAGE_KEY, state)
    } catch {
      // Storage is best-effort: losing it costs one re-activation, not access.
    }
  }
}

/** Everything a token was bought with, gone; everything about the seat, kept. */
function withoutToken(state: LicenseDeviceState): LicenseDeviceState {
  const { deviceId, lastServerTimeSec, seatReleasedAt } = state

  return {
    deviceId,
    ...(lastServerTimeSec !== undefined ? { lastServerTimeSec } : {}),
    ...(seatReleasedAt !== undefined ? { seatReleasedAt } : {}),
  }
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}
