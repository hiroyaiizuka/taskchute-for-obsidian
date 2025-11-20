import type { TaskChutePluginLike } from '../types'

const DEVICE_ID_LENGTH_LIMIT = 64
export const DEVICE_ID_STORAGE_KEY = 'taskchute-plus.device-id'

type CryptoLike = {
  randomUUID?: () => string
}

function getGlobalCrypto(): CryptoLike | undefined {
  if (typeof globalThis === 'undefined') {
    return undefined
  }
  const candidate = (globalThis as { crypto?: CryptoLike }).crypto
  return candidate
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function generateRandomId(): string {
  const prefix = 'tc-dev-'
  const cryptoApi = getGlobalCrypto()
  if (cryptoApi?.randomUUID) {
    return `${prefix}${cryptoApi.randomUUID()}`
  }
  const random = Math.random().toString(36).slice(2, 10)
  const timestamp = Date.now().toString(36)
  return `${prefix}${timestamp}-${random}`
}

export class DeviceIdentityService {
  private cachedId: string | null = null
  private inflight?: Promise<string>
  private legacyCleared = false

  constructor(private readonly plugin: TaskChutePluginLike) {}

  async getOrCreateDeviceId(): Promise<string> {
    if (this.cachedId) {
      return this.cachedId
    }

    const local = this.readLocalDeviceId()
    if (local) {
      this.cachedId = local
      await this.clearLegacySetting()
      return local
    }

    if (!this.hasLocalStorage()) {
      const legacy = this.normalize(this.plugin.settings.deviceId)
      if (legacy) {
        this.cachedId = legacy
        return legacy
      }
    }

    if (!this.inflight) {
      this.inflight = this.issueNewId()
    }
    return this.inflight
  }

  async rotateDeviceId(): Promise<string> {
    this.cachedId = null
    this.inflight = undefined
    return this.issueNewId()
  }

  private normalize(raw?: string): string | null {
    if (!isNonEmptyString(raw)) {
      return null
    }
    const trimmed = raw.trim()
    if (trimmed.length > DEVICE_ID_LENGTH_LIMIT) {
      return trimmed.slice(0, DEVICE_ID_LENGTH_LIMIT)
    }
    return trimmed
  }

  private hasLocalStorage(): boolean {
    if (typeof window === 'undefined') {
      return false
    }
    try {
      return Boolean(window.localStorage)
    } catch {
      return false
    }
  }

  private readLocalDeviceId(): string | null {
    if (!this.hasLocalStorage()) {
      return null
    }
    try {
      const raw = window.localStorage?.getItem(DEVICE_ID_STORAGE_KEY)
      return this.normalize(raw ?? undefined)
    } catch {
      return null
    }
  }

  private persistLocalDeviceId(id: string): boolean {
    if (!this.hasLocalStorage()) {
      return false
    }
    try {
      window.localStorage?.setItem(DEVICE_ID_STORAGE_KEY, id)
      return true
    } catch (error) {
      console.warn('[DeviceIdentityService] Failed to persist local deviceId', error)
      return false
    }
  }

  private async clearLegacySetting(): Promise<void> {
    if (this.legacyCleared) {
      return
    }
    if (this.plugin.settings.deviceId !== undefined) {
      this.plugin.settings.deviceId = undefined
      try {
        await this.plugin.saveSettings()
      } catch (error) {
        console.warn('[DeviceIdentityService] Failed to clear legacy deviceId', error)
      }
    }
    this.legacyCleared = true
  }

  private async issueNewId(): Promise<string> {
    const freshId = generateRandomId()
    const storedLocally = this.persistLocalDeviceId(freshId)
    if (!storedLocally) {
      this.plugin.settings.deviceId = freshId
      try {
        await this.plugin.saveSettings()
      } catch (error) {
        console.warn('[DeviceIdentityService] Failed to persist fallback deviceId', error)
      }
    } else {
      await this.clearLegacySetting()
    }
    this.cachedId = freshId
    this.inflight = undefined
    return freshId
  }
}
