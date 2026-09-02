/**
 * The seat list is mounted into a container the settings framework owns and
 * reuses across renders, so tearing it down has to leave that container as it
 * was found. A view that only stops writing would pile one dead list per pass.
 */
import { DeviceListView } from '../../../src/features/license/ui/DeviceListView'
import type { LicenseManager } from '../../../src/features/license/services/LicenseManager'

function fakeManager(overrides: Record<string, unknown> = {}): LicenseManager {
  return {
    getDeviceId: () => 'DEVICE-0001',
    getState: () => ({ status: 'active' }),
    getDeviceSnapshot: () => undefined,
    onDevicesChange: jest.fn(() => () => undefined),
    syncFromServer: jest.fn().mockResolvedValue({ status: 'active' }),
    listDevices: jest.fn().mockResolvedValue({ ok: true, devices: [], maxDevices: 3 }),
    deactivateDevice: jest.fn().mockResolvedValue({ ok: true, devicesUsed: 0 }),
    ...overrides,
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
    const manager = fakeManager({
      listDevices: jest
        .fn()
        .mockResolvedValue({ ok: false, failure: { ok: false, kind: 'network' } }),
      deactivateDevice: jest.fn(),
    })
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

  describe('the refresh button', () => {
    function clickRefresh(host: HTMLElement): void {
      host.querySelector<HTMLButtonElement>('.taskchute-license-devices__refresh')?.click()
    }

    test('re-asks for the entitlement and the seats together', async () => {
      // Both halves of this screen go stale for reasons the user cannot cause
      // from here, and they have to be re-read as one or they can disagree.
      const manager = fakeManager()
      const host = document.createElement('div')
      new DeviceListView(host, manager, { initialDevices: [] })

      clickRefresh(host)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(manager.syncFromServer).toHaveBeenCalledWith({ force: true })
      expect(manager.listDevices).toHaveBeenCalled()
    })

    test('hands over to the caller when the sync changed the entitlement', async () => {
      // Losing the seat replaces this whole section with the activation form,
      // so reloading a list that is about to be torn down would be pointless —
      // and there would be no code left to load it with.
      const manager = fakeManager({
        syncFromServer: jest.fn().mockResolvedValue({ status: 'unlicensed' }),
      })
      const onChanged = jest.fn()
      const host = document.createElement('div')
      new DeviceListView(host, manager, { initialDevices: [], onChanged })

      clickRefresh(host)
      await Promise.resolve()
      await Promise.resolve()

      expect(onChanged).toHaveBeenCalled()
      expect(manager.listDevices).not.toHaveBeenCalled()
    })

    test('does not run twice at once', async () => {
      const manager = fakeManager()
      const host = document.createElement('div')
      new DeviceListView(host, manager, { initialDevices: [] })

      clickRefresh(host)
      clickRefresh(host)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(manager.syncFromServer).toHaveBeenCalledTimes(1)
    })

    test('survives a sync that threw', async () => {
      // The button must come back enabled: a server that failed once is the
      // whole reason someone would press it again.
      const manager = fakeManager({
        syncFromServer: jest.fn().mockRejectedValue(new Error('offline')),
      })
      const host = document.createElement('div')
      new DeviceListView(host, manager, { initialDevices: [] })

      clickRefresh(host)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      const button = host.querySelector<HTMLButtonElement>(
        '.taskchute-license-devices__refresh',
      )
      expect(button?.disabled).toBe(false)
      expect(manager.listDevices).toHaveBeenCalled()
    })
  })

  test('mounting again after a dispose leaves a single list', () => {
    const host = document.createElement('div')

    const first = new DeviceListView(host, fakeManager(), { initialDevices: [] })
    first.dispose()
    new DeviceListView(host, fakeManager(), { initialDevices: [] })

    expect(host.querySelectorAll('.taskchute-license-devices')).toHaveLength(1)
  })
})
