/**
 * Device seat list, rendered inline into a settings container.
 *
 * Without this, a user who hits the seat limit has no way back: rebuilding a
 * vault changes the device id, leaving the old device holding a seat forever
 * (SPEC 11-3).
 *
 * One renderer serves both entry points: a 409 device_limit_reached carries
 * `details.devices` in exactly the shape of the list endpoint, so an activation
 * failure seeds the same view without a second request.
 */
import { Notice } from 'obsidian'

import { t } from '../../../i18n'
import type { DeviceView } from '../services/LicenseApiClient'
import type { LicenseManager } from '../services/LicenseManager'
import { describeApiFailure } from './licenseMessages'

export interface DeviceListViewOptions {
  /**
   * Devices already known from a 409 response. Skips the initial fetch.
   * Omit to load the list from the server when the view mounts.
   */
  initialDevices?: DeviceView[]
  initialMaxDevices?: number
  /**
   * The activation code to act with, for a list shown before the code is stored.
   * Activation stores it only on success, so the 409 that sends the user here
   * leaves nothing behind. Omit when active: the stored code is used.
   */
  code?: string
  /** Called after a successful release, so callers can refresh their own UI. */
  onChanged?: () => void
}

function formatLastSeen(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString()
}

export class DeviceListView {
  private devices?: DeviceView[]
  private maxDevices?: number
  private readonly rootEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly listEl: HTMLElement
  private busyDeviceId?: string
  private disposed = false
  private refreshing = false
  private refreshEl!: HTMLButtonElement
  private readonly unsubscribe?: () => void

  constructor(
    container: HTMLElement,
    private readonly manager: LicenseManager,
    private readonly options: DeviceListViewOptions = {},
  ) {
    this.devices = options.initialDevices
    this.maxDevices = options.initialMaxDevices

    // The last seats the manager saw, so the list has something to draw while
    // the request behind it is still out. Skipped for a list seeded from a 409:
    // that one belongs to the code being typed, which may be a different
    // license than the snapshot was taken from.
    if (this.devices === undefined && options.code === undefined) {
      const snapshot = manager.getDeviceSnapshot()
      if (snapshot) {
        this.devices = snapshot.devices
        this.maxDevices = snapshot.maxDevices
      }

      // Opening the Pro screen settles entitlement and the seat list from one
      // fetch — whichever of the two started it, both hear the answer.
      this.unsubscribe = manager.onDevicesChange((next) => {
        if (this.disposed) return
        // Mid-release the list is showing a pending row; the release writes its
        // own result when it lands.
        if (this.busyDeviceId !== undefined) return
        this.devices = next.devices
        this.maxDevices = next.maxDevices
        this.render()
      })
    }

    const root = container.createDiv({ cls: 'taskchute-license-devices' })
    this.rootEl = root

    const header = root.createDiv({ cls: 'taskchute-license-devices__header' })
    header.createDiv({
      cls: 'taskchute-license-devices__description',
      text: t(
        'license.devices.description',
        'This license can be used on a limited number of devices. Release a device you no longer use to make room for another one.',
      ),
    })
    // Both answers come from the server and both can go stale while this screen
    // is open — a seat taken on another machine, a license renewed. Neither is
    // something the user can make happen from here, so there has to be a way to
    // ask again without closing the settings and coming back.
    this.refreshEl = header.createEl('button', {
      cls: ['form-button', 'taskchute-license-devices__refresh'],
      text: t('license.devices.refresh', 'Refresh'),
    })
    this.refreshEl.type = 'button'
    this.refreshEl.addEventListener('click', () => {
      void this.refresh()
    })

    this.listEl = root.createDiv({ cls: 'taskchute-license-devices__list' })
    // Under the list: the seat count is a summary of what is above it, and a
    // load or failure message reads as the state of the list it follows.
    this.statusEl = root.createDiv({ cls: 'taskchute-license-devices__status' })

    // Nothing to draw yet leaves the container empty for load() to fill, rather
    // than flashing "no devices" at someone whose seats are on their way.
    if (this.devices !== undefined) this.render()

    // Always re-asked, even with a snapshot on screen: what is drawn may be a
    // visit old. The manager coalesces this with the sync's own fetch, so the
    // screen still costs one request.
    if (options.initialDevices === undefined) {
      void this.load()
    }
  }

  /**
   * Stop touching the DOM. The settings tab rebuilds its container on every
   * display(), so an in-flight request must not write into the old tree, and
   * the tree this view owns goes with it rather than accumulating per pass.
   */
  dispose(): void {
    this.disposed = true
    this.unsubscribe?.()
    this.rootEl.remove()
  }

  /**
   * Re-ask the server for both halves of what this screen shows: whether this
   * device is still licensed, and which seats the license holds. The manager
   * coalesces them into one request, so they cannot come back disagreeing.
   */
  private async refresh(): Promise<void> {
    if (this.refreshing || this.busyDeviceId !== undefined) return

    this.refreshing = true
    this.applyRefreshState()

    // Forced: the user pressing this button is exactly the case the throttle
    // must not answer with a cached "nothing to report".
    const before = this.manager.getState().status
    let state = before
    try {
      state = (await this.manager.syncFromServer({ force: true })).status
    } catch {
      // Reported through the list below like any other failure to reach the
      // server; entitlement is left as it was.
    }

    if (this.disposed) return

    // A sync that dropped this device out of the license replaces this whole
    // section with the activation form, so there is no list left to reload —
    // and no code to reload it with.
    if (state !== before) {
      this.refreshing = false
      this.options.onChanged?.()
      return
    }

    await this.load()
    if (this.disposed) return

    this.refreshing = false
    this.applyRefreshState()
  }

  private applyRefreshState(): void {
    this.refreshEl.disabled = this.refreshing || this.busyDeviceId !== undefined
    this.refreshEl.setText(
      this.refreshing
        ? t('license.devices.refreshing', 'Refreshing…')
        : t('license.devices.refresh', 'Refresh'),
    )
  }

  private async load(): Promise<void> {
    // Only when there is nothing to look at. Replacing a drawn list with
    // "Loading…" on every visit hides seats the user can already act on.
    if (this.devices === undefined) {
      this.setStatus(t('license.devices.loading', 'Loading devices…'))
    }

    const result = await this.manager.listDevices(this.options.code)
    if (this.disposed) return

    if (!result.ok) {
      this.setError(describeApiFailure(result.failure))
      return
    }

    this.devices = result.devices
    this.maxDevices = result.maxDevices
    this.render()
  }

  private setStatus(message: string): void {
    this.statusEl.setText(message)
    this.statusEl.classList.remove('taskchute-license-devices__status--error')
  }

  /** A failed request is not a seat count, and must not read like one. */
  private setError(message: string): void {
    this.statusEl.setText(message)
    this.statusEl.classList.add('taskchute-license-devices__status--error')
  }

  private render(): void {
    // Sharing the list's busy state: releasing a seat and re-reading the seats
    // must not run at once, or the answer overwrites the row being removed.
    this.applyRefreshState()

    const devices = this.devices ?? []

    this.setStatus(
      this.maxDevices === undefined
        ? ''
        : t('license.devices.seats', '{used} of {max} devices in use', {
            used: String(devices.length),
            max: String(this.maxDevices),
          }),
    )

    this.listEl.empty()

    if (devices.length === 0) {
      this.listEl.createDiv({
        cls: 'taskchute-license-devices__empty',
        text: t('license.devices.empty', 'No devices are registered yet.'),
      })
      return
    }

    const currentDeviceId = this.manager.getDeviceId()

    for (const device of devices) {
      const row = this.listEl.createDiv({ cls: 'taskchute-license-devices__row' })
      const info = row.createDiv({ cls: 'taskchute-license-devices__info' })

      const label = device.label?.trim()
      const nameEl = info.createDiv({ cls: 'taskchute-license-devices__name' })
      nameEl.createSpan({
        text:
          label !== undefined && label.length > 0
            ? label
            : t('license.devices.unknownLabel', 'Unnamed device'),
      })
      if (device.device_id === currentDeviceId) {
        nameEl.createSpan({
          cls: 'taskchute-license-devices__badge',
          text: t('license.devices.thisDevice', 'This device'),
        })
      }

      const meta = [
        device.platform,
        t('license.devices.lastSeen', 'Last used {when}', {
          when: formatLastSeen(device.last_seen_at),
        }),
        // The full device id is shown deliberately: masking it would make the
        // rows indistinguishable, and knowing an id grants nothing without the
        // activation code (SPEC 11-4).
        device.device_id,
      ].filter((part): part is string => typeof part === 'string' && part.length > 0)

      info.createDiv({ cls: 'taskchute-license-devices__meta', text: meta.join(' · ') })

      const button = row.createEl('button', {
        cls: ['form-button', 'danger'],
        text:
          this.busyDeviceId === device.device_id
            ? t('license.devices.releasing', 'Releasing…')
            : t('license.devices.release', 'Release'),
      })
      button.type = 'button'
      button.disabled = this.busyDeviceId !== undefined
      button.addEventListener('click', () => {
        void this.release(device.device_id)
      })
    }
  }

  private async release(deviceId: string): Promise<void> {
    if (this.busyDeviceId !== undefined) return

    this.busyDeviceId = deviceId
    this.render()

    const result = await this.manager.deactivateDevice(deviceId, this.options.code)
    if (this.disposed) return
    this.busyDeviceId = undefined

    if (!result.ok) {
      // render() rewrites the status line, so the error goes on after it.
      this.render()
      this.setError(describeApiFailure(result.failure))
      return
    }

    this.devices = (this.devices ?? []).filter((device) => device.device_id !== deviceId)
    new Notice(t('license.devices.released', 'Device released.'))
    this.render()
    this.options.onChanged?.()
  }
}
