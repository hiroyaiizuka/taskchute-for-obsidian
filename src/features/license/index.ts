/**
 * License feature entry point.
 *
 * Wires the API client, the two-tier store and the state machine, and decides
 * entitlement from disk before anything else runs. The manager is always
 * created — unlike the AI task feature there is nothing to gate it on, and the
 * settings tab needs it in order to offer activation.
 */
import { Platform } from 'obsidian'
import type { App } from 'obsidian'

import type { TaskChuteSettings } from '../../types'
import { LicenseApiClient } from './services/LicenseApiClient'
import { LicenseManager } from './services/LicenseManager'
import { createDeviceLocalStorageBridge, LicenseStore } from './services/LicenseStore'

/** Electron's CommonJS require, available in Obsidian desktop only. */
declare function require(moduleId: string): unknown

export interface LicensePluginLike {
  app: App
  settings: TaskChuteSettings
  saveSettings: () => Promise<void>
  manifest?: { version?: string }
  _log?: (level?: string, ...args: unknown[]) => void
}

/** Best-effort platform hint, shown to the user in the device list. */
function describePlatform(): string | undefined {
  if (!Platform) return undefined
  if (Platform.isMacOS) return 'macos'
  if (Platform.isWin) return 'windows'
  if (Platform.isLinux) return 'linux'
  if (Platform.isIosApp) return 'ios'
  if (Platform.isAndroidApp) return 'android'
  return undefined
}

/**
 * The machine's hostname, or undefined off desktop (mobile has no Node runtime,
 * so the label falls back to the platform name). A label only helps the user
 * pick a seat to release, so every failure path degrades quietly.
 */
function readHostname(): string | undefined {
  // Written without optional chaining on purpose: the plugin review rule only
  // recognises `Platform.isDesktop` as a guard, and Platform is always present
  // in Obsidian. describePlatform above keeps its `?.` because it has no
  // builtin to guard.
  if (!Platform.isDesktop) return undefined

  try {
    // eslint-disable-next-line import/no-nodejs-modules -- guarded by Platform.isDesktop above; the hostname comes from Node os
    const os = require('os') as { hostname?: () => string }
    return os.hostname?.()
  } catch {
    return undefined
  }
}

/** Longest label the API accepts before rejecting the request. */
const DEVICE_LABEL_MAX_LENGTH = 100

function cleanPart(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined

  // macOS reports names like "MacBook-Pro.local"; the suffix is noise here.
  const trimmed = value.trim().replace(/\.local$/i, '')

  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * The machine's name as a seat label.
 *
 * A seat is one machine, so the machine name is the whole label. The vault name
 * used to be appended, but every vault now shares one seat, which left whichever
 * refreshed last naming it for all of them. Kept pure so it can be tested.
 */
export function formatDeviceLabel(host: unknown): string | undefined {
  const cleaned = cleanPart(host)
  if (cleaned === undefined) return undefined

  // Truncated rather than dropped: a clipped label still identifies the seat.
  return cleaned.slice(0, DEVICE_LABEL_MAX_LENGTH)
}

/** Human-readable name for this seat, as "<hostname>" or the platform name. */
export function describeDeviceLabel(): string | undefined {
  return formatDeviceLabel(readHostname() ?? describePlatform())
}

export function createLicenseManager(plugin: LicensePluginLike): LicenseManager {
  const log = (level: string, ...args: unknown[]) => plugin._log?.(level, ...args)

  // The device state is kept out of the vault-scoped store so every vault on
  // one machine shares a seat; plugin.app is passed only to migrate installs
  // written by an older version. Where the raw store is unusable the
  // vault-scoped one still beats no persistence: it costs extra seats, while
  // losing the id costs one on every launch.
  const deviceStorage = createDeviceLocalStorageBridge()
  const store = deviceStorage
    ? new LicenseStore(deviceStorage, plugin.app)
    : new LicenseStore(plugin.app)
  const client = new LicenseApiClient({ log })

  const platform = describePlatform()
  const pluginVersion = plugin.manifest?.version
  const deviceLabel = describeDeviceLabel()

  const manager = new LicenseManager({
    client,
    store,
    getCode: () => plugin.settings.licenseCode,
    setCode: async (code) => {
      plugin.settings.licenseCode = code
      await plugin.saveSettings()
    },
    ...(platform !== undefined ? { platform } : {}),
    ...(pluginVersion !== undefined ? { pluginVersion } : {}),
    ...(deviceLabel !== undefined ? { deviceLabel } : {}),
    log,
  })

  manager.initialize()

  return manager
}

export { LicenseManager } from './services/LicenseManager'
export type { LicenseState } from './services/LicenseManager'
