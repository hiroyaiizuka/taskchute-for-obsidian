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
    deactivateDevice: jest.fn(),
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

  test('mounting again after a dispose leaves a single list', () => {
    const host = document.createElement('div')

    const first = new DeviceListView(host, fakeManager(), { initialDevices: [] })
    first.dispose()
    new DeviceListView(host, fakeManager(), { initialDevices: [] })

    expect(host.querySelectorAll('.taskchute-license-devices')).toHaveLength(1)
  })
})
