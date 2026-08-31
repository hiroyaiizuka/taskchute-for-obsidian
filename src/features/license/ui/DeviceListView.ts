/**
 * Device seat list, rendered inline into a settings container.
 *
 * Without this, a user who hits the seat limit has no way back: rebuilding a
 * vault changes the device id, leaving the old device holding a seat forever
 * (SPEC 11-3).
 *
 * One renderer serves both entry points. The API answers a 409
 * device_limit_reached with a `details.devices` array in exactly the shape of
 * the list endpoint, so an activation failure can seed the same view with the
 * devices it already carries — no second request, and the list appears in the
 * same beat as the error that sent the user there.
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

  constructor(
    container: HTMLElement,
    private readonly manager: LicenseManager,
    private readonly options: DeviceListViewOptions = {},
  ) {
    this.devices = options.initialDevices
    this.maxDevices = options.initialMaxDevices

    const root = container.createDiv({ cls: 'taskchute-license-devices' })
    this.rootEl = root
    root.createDiv({
      cls: 'taskchute-license-devices__description',
      text: t(
        'license.devices.description',
        'This license can be used on a limited number of devices. Release a device you no longer use to make room for another one.',
      ),
    })
    this.listEl = root.createDiv({ cls: 'taskchute-license-devices__list' })
    // Under the list: the seat count is a summary of what is above it, and a
    // load or failure message reads as the state of the list it follows.
    this.statusEl = root.createDiv({ cls: 'taskchute-license-devices__status' })

    if (this.devices === undefined) {
      void this.load()
    } else {
      this.render()
    }
  }

  /**
   * Stop touching the DOM. The settings tab rebuilds its whole container on
   * every display(), so an in-flight request must not write into the old tree.
   *
   * The tree this view owns goes with it: a host that is reused across renders
   * would otherwise accumulate one dead list per pass.
   */
  dispose(): void {
    this.disposed = true
    this.rootEl.remove()
  }

  private async load(): Promise<void> {
    this.setStatus(t('license.devices.loading', 'Loading devices…'))

    const result = await this.manager.listDevices()
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

    const result = await this.manager.deactivateDevice(deviceId)
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
