/**
 * The seat list is mounted into a container the settings framework owns and
 * reuses across renders, so tearing it down has to leave that container as it
 * was found. A view that only stops writing would pile one dead list per pass.
 */
import { DeviceListView } from '../../../src/features/license/ui/DeviceListView'
import type { LicenseManager } from '../../../src/features/license/services/LicenseManager'

function fakeManager(): LicenseManager {
  return {
    getDeviceId: () => 'DEVICE-0001',
    listDevices: jest.fn().mockResolvedValue({ ok: true, devices: [], maxDevices: 3 }),
    deactivateDevice: jest.fn().mockResolvedValue({ ok: true, devicesUsed: 0 }),
  } as unknown as LicenseManager
}

describe('DeviceListView', () => {
  test('removes its own tree on dispose', () => {
    const host = document.createElement('div')
    const view = new DeviceListView(host, fakeManager(), { initialDevices: [] })

    expect(host.querySelector('.taskchute-license-devices')).not.toBeNull()

    view.dispose()

    expect(host.querySelector('.taskchute-license-devices')).toBeNull()
    expect(host.childElementCount).toBe(0)
  })

  test('shows a failed load as an error, with its code', async () => {
    // The status line otherwise reads as a seat count in muted grey, which is
    // the wrong thing for a request that never returned a list.
    const manager = {
      getDeviceId: () => 'DEVICE-0001',
      listDevices: jest
        .fn()
        .mockResolvedValue({ ok: false, failure: { ok: false, kind: 'network' } }),
      deactivateDevice: jest.fn(),
    } as unknown as LicenseManager
    const host = document.createElement('div')

    new DeviceListView(host, manager)
    await Promise.resolve()
    await Promise.resolve()

    const status = host.querySelector('.taskchute-license-devices__status')
    expect(status?.classList.contains('taskchute-license-devices__status--error')).toBe(true)
    expect(status?.textContent).toContain('network_unreachable')
  })

  test('releases with the code it was given, before that code is stored', async () => {
    // The 409 that sends the user here stored nothing, so the view is the only
    // place the typed code still exists.
    const manager = fakeManager()
    const host = document.createElement('div')

    new DeviceListView(host, manager, {
      initialDevices: [{ device_id: 'DEVICE-OTHER', last_seen_at: 0 }],
      code: 'TCP-0000-0000-0000-0001',
    })
    host.querySelector<HTMLButtonElement>('.taskchute-license-devices__row button')?.click()
    await Promise.resolve()

    expect(manager.deactivateDevice).toHaveBeenCalledWith(
      'DEVICE-OTHER',
      'TCP-0000-0000-0000-0001',
    )
  })

  test('mounting again after a dispose leaves a single list', () => {
    const host = document.createElement('div')

    const first = new DeviceListView(host, fakeManager(), { initialDevices: [] })
    first.dispose()
    new DeviceListView(host, fakeManager(), { initialDevices: [] })

    expect(host.querySelectorAll('.taskchute-license-devices')).toHaveLength(1)
  })
})
