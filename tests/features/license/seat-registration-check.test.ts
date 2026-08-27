/**
 * Losing the seat happens on another machine, so this dialog is the only thing
 * that tells the user why the AI task UI vanished here. It must fire on a real
 * release and never on a failed check.
 */
import type { App } from 'obsidian'

import { checkSeatRegistration } from '../../../src/features/license/ui/notifySeatReleased'
import type { LicenseManager } from '../../../src/features/license/services/LicenseManager'

jest.mock('../../../src/ui/modals/ConfirmModal', () => ({
  showInfoModal: jest.fn(() => Promise.resolve()),
}))

const { showInfoModal } = require('../../../src/ui/modals/ConfirmModal') as {
  showInfoModal: jest.Mock
}

function createHost(manager?: Partial<LicenseManager>) {
  return {
    app: {} as App,
    licenseManager: manager as LicenseManager | undefined,
    _log: jest.fn(),
  }
}

beforeEach(() => {
  showInfoModal.mockClear()
})

test('tells the user when the seat is gone', async () => {
  const host = createHost({
    verifyDeviceRegistration: jest.fn().mockResolvedValue('released'),
  })

  await expect(checkSeatRegistration(host)).resolves.toBe('released')

  expect(showInfoModal).toHaveBeenCalledTimes(1)
  const options = showInfoModal.mock.calls[0][1] as { title: string; message: string }
  expect(options.title).toBe('This device was released')
  expect(options.message).toContain('activate your license code')
})

test('stays quiet while the device is still registered', async () => {
  const host = createHost({
    verifyDeviceRegistration: jest.fn().mockResolvedValue('registered'),
  })

  await expect(checkSeatRegistration(host)).resolves.toBe('registered')
  expect(showInfoModal).not.toHaveBeenCalled()
})

test('stays quiet when the check could not run', async () => {
  const host = createHost({
    verifyDeviceRegistration: jest.fn().mockResolvedValue('unknown'),
  })

  await expect(checkSeatRegistration(host)).resolves.toBe('unknown')
  expect(showInfoModal).not.toHaveBeenCalled()
})

test('swallows a thrown check so startup is never derailed', async () => {
  const host = createHost({
    verifyDeviceRegistration: jest.fn().mockRejectedValue(new Error('boom')),
  })

  await expect(checkSeatRegistration(host)).resolves.toBe('unknown')

  expect(showInfoModal).not.toHaveBeenCalled()
  expect(host._log).toHaveBeenCalled()
})

test('does nothing without a license manager', async () => {
  await expect(checkSeatRegistration(createHost(undefined))).resolves.toBe('unknown')
  expect(showInfoModal).not.toHaveBeenCalled()
})
