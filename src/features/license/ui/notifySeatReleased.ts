/**
 * The user-facing half of the device-presence check.
 *
 * Losing the seat is not something the user did on this machine, so it cannot
 * pass as a Notice that scrolls away: the AI task UI simply disappears, and the
 * only way to get it back is to activate the code again. A dialog states that.
 */
import type { App } from 'obsidian'

import { t } from '../../../i18n'
import { showInfoModal } from '../../../ui/modals/ConfirmModal'
import type { DeviceRegistrationCheck, LicenseManager } from '../services/LicenseManager'

export interface SeatCheckHost {
  app: App
  licenseManager?: LicenseManager
  _log?: (level?: string, ...args: unknown[]) => void
}

/**
 * Check whether this device still holds a seat and tell the user if it does
 * not. Returns what the check found, so a caller that draws license state can
 * redraw itself.
 *
 * Never throws: it runs on startup and on every settings render, neither of
 * which may be derailed by the license server.
 */
export async function checkSeatRegistration(
  host: SeatCheckHost,
): Promise<DeviceRegistrationCheck> {
  const manager = host.licenseManager
  if (!manager) return 'unknown'

  let result: DeviceRegistrationCheck
  try {
    result = await manager.verifyDeviceRegistration()
  } catch (error) {
    host._log?.('warn', '[License] Device check failed', error)
    return 'unknown'
  }

  if (result !== 'released') return result

  // Only ever reached once per release: the check leaves the state unlicensed,
  // and every later call returns early on that.
  void showInfoModal(host.app, {
    title: t('license.seatReleased.title', 'This device was released'),
    message: t(
      'license.seatReleased.message',
      'This device is no longer registered to your license, so AI tasks have been turned off here.\nTo use them on this device again, open the plugin settings and activate your license code.',
    ),
    confirmText: t('license.seatReleased.close', 'OK'),
  })

  return result
}
