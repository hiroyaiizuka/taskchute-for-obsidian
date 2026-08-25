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
import type { LicenseStorageBridge } from './services/LicenseStore'
import { LicenseStore } from './services/LicenseStore'

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
 * The machine's hostname, or undefined off desktop.
 *
 * Mobile has no Node runtime, so the label falls back to the platform name.
 * A label only helps the user pick a seat to release; being wrong about it is
 * cosmetic, so every failure path degrades quietly.
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
 * Join the machine and vault names into one seat label.
 *
 * Both halves matter: one person often runs several vaults on one machine, and
 * the same vault name can exist on several machines. Kept pure and separate
 * from the platform lookups so the formatting can be tested directly.
 */
export function formatDeviceLabel(host: unknown, vault: unknown): string | undefined {
  const parts = [cleanPart(host), cleanPart(vault)].filter(
    (part): part is string => part !== undefined,
  )
  if (parts.length === 0) return undefined

  // Truncated rather than dropped: a clipped label still identifies the seat.
  return parts.join(' / ').slice(0, DEVICE_LABEL_MAX_LENGTH)
}

/** Human-readable name for this seat, as "<hostname> / <vault>". */
export function describeDeviceLabel(app: App): string | undefined {
  let vault: unknown
  try {
    vault = app.vault?.getName?.()
  } catch {
    // A label only helps the user pick a seat to release; losing it is cosmetic.
    vault = undefined
  }

  return formatDeviceLabel(readHostname() ?? describePlatform(), vault)
}

export function createLicenseManager(plugin: LicensePluginLike): LicenseManager {
  const log = (level: string, ...args: unknown[]) => plugin._log?.(level, ...args)

  // App exposes loadLocalStorage/saveLocalStorage but does not declare them in
  // the public typings; the same cast is used by AiCustomModelStore's callers.
  const store = new LicenseStore(plugin.app as unknown as LicenseStorageBridge)
  const client = new LicenseApiClient({ log })

  const platform = describePlatform()
  const pluginVersion = plugin.manifest?.version
  const deviceLabel = describeDeviceLabel(plugin.app)

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
