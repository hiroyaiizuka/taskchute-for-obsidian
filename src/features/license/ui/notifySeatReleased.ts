/**
 * The user-facing half of settling entitlement against the server.
 *
 * Losing the seat is not something the user did on this machine, so it cannot
 * pass as a Notice that scrolls away: the AI task UI simply disappears, and the
 * only way to get it back is to activate the code again. A dialog states that.
 */
import type { App } from 'obsidian'

import { t } from '../../../i18n'
import { showInfoModal } from '../../../ui/modals/ConfirmModal'
import type { LicenseManager, LicenseState } from '../services/LicenseManager'

export interface SeatCheckHost {
  app: App
  licenseManager?: LicenseManager
  _log?: (level?: string, ...args: unknown[]) => void
}

export interface SeatCheckResult {
  /** Entitlement afterwards, or undefined where there was no manager to ask. */
  state?: LicenseState
  /**
   * Whether the sync moved entitlement. Narrower than "the seat was released",
   * which is only one of the ways the answer can change.
   */
  changed: boolean
}

/**
 * Settle this device's entitlement against the server, telling the user if it
 * lost its seat, and report whether anything moved so a caller can redraw.
 *
 * Never throws: it runs on startup, on a timer and whenever the settings screen
 * is built, none of which may be derailed by the license server.
 *
 * @param force Skip the throttle, for the settings screen being opened.
 */
export async function checkSeatRegistration(
  host: SeatCheckHost,
  options: { force?: boolean } = {},
): Promise<SeatCheckResult> {
  const manager = host.licenseManager
  if (!manager) return { changed: false }

  const before = manager.getState()

  let state: LicenseState
  try {
    state = await manager.syncFromServer(options)
  } catch (error) {
    host._log?.('warn', '[License] License sync failed', error)
    return { state: before, changed: false }
  }

  // Reached once per release: the sync leaves the state unlicensed, and the
  // latch keeps every later one from asking again until the user re-activates.
  if (before.status === 'active' && state.status !== 'active' && manager.isSeatReleased()) {
    void showInfoModal(host.app, {
      title: t('license.seatReleased.title', 'This device was released'),
      message: t(
        'license.seatReleased.message',
        'This device is no longer registered to your license, so AI tasks have been turned off here.\nTo use them on this device again, open the plugin settings and activate your license code.',
      ),
      confirmText: t('license.seatReleased.close', 'OK'),
    })
  }

  return { state, changed: before.status !== state.status }
}
