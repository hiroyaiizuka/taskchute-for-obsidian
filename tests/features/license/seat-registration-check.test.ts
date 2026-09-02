/**
 * Losing the seat happens on another machine, so this dialog is the only thing
 * that tells the user why the AI task UI vanished here. It must fire on a real
 * release and never on a failed sync — and the `changed` it reports is what
 * makes the settings screen redraw, so a sync that moved nothing must say so.
 */
import type { App } from 'obsidian'

import { checkSeatRegistration } from '../../../src/features/license/ui/notifySeatReleased'
import type {
  LicenseManager,
  LicenseState,
} from '../../../src/features/license/services/LicenseManager'

jest.mock('../../../src/ui/modals/ConfirmModal', () => ({
  showInfoModal: jest.fn(() => Promise.resolve()),
}))

const { showInfoModal } = require('../../../src/ui/modals/ConfirmModal') as {
  showInfoModal: jest.Mock
}

const ACTIVE = { status: 'active', token: {} } as unknown as LicenseState
const UNLICENSED = { status: 'unlicensed' } as LicenseState

/**
 * @param before  what the manager reported before the sync
 * @param after   what syncFromServer resolves to, or a rejection
 * @param released whether the latch is set afterwards
 */
function createHost(options: {
  before?: LicenseState
  after?: LicenseState | Error
  released?: boolean
  manager?: false
}) {
  const after = options.after ?? options.before ?? UNLICENSED
  const manager =
    options.manager === false
      ? undefined
      : ({
          getState: jest.fn(() => options.before ?? UNLICENSED),
          isSeatReleased: jest.fn(() => options.released === true),
          syncFromServer: jest.fn(() =>
            after instanceof Error ? Promise.reject(after) : Promise.resolve(after),
          ),
        } as unknown as LicenseManager)

  return {
    app: {} as App,
    licenseManager: manager,
    _log: jest.fn(),
  }
}

beforeEach(() => {
  showInfoModal.mockClear()
})

test('tells the user when the seat is gone', async () => {
  const host = createHost({ before: ACTIVE, after: UNLICENSED, released: true })

  await expect(checkSeatRegistration(host)).resolves.toEqual({
    state: UNLICENSED,
    changed: true,
  })

  expect(showInfoModal).toHaveBeenCalledTimes(1)
  const options = showInfoModal.mock.calls[0][1] as { title: string; message: string }
  expect(options.title).toBe('This device was released')
  expect(options.message).toContain('activate your license code')
})

test('stays quiet while the device is still registered', async () => {
  const host = createHost({ before: ACTIVE, after: ACTIVE })

  await expect(checkSeatRegistration(host)).resolves.toEqual({
    state: ACTIVE,
    changed: false,
  })
  expect(showInfoModal).not.toHaveBeenCalled()
})

test('reports a change when the sync activated this device', async () => {
  // Activated on another machine, or simply recovered from an expired token:
  // the screen drew "not activated" and has to be told to draw it again.
  const host = createHost({ before: UNLICENSED, after: ACTIVE })

  await expect(checkSeatRegistration(host)).resolves.toEqual({
    state: ACTIVE,
    changed: true,
  })
  expect(showInfoModal).not.toHaveBeenCalled()
})

test('does not blame the seat for a license the server blocked', async () => {
  // Revoked or suspended is not a released seat, and pointing the user at the
  // device list would send them somewhere that cannot help.
  const blocked = { status: 'blocked', reason: 'license_revoked' } as LicenseState
  const host = createHost({ before: ACTIVE, after: blocked, released: false })

  await expect(checkSeatRegistration(host)).resolves.toEqual({
    state: blocked,
    changed: true,
  })
  expect(showInfoModal).not.toHaveBeenCalled()
})

test('stays quiet when the sync could not reach the server', async () => {
  const host = createHost({ before: ACTIVE, after: ACTIVE })

  await expect(checkSeatRegistration(host)).resolves.toEqual({
    state: ACTIVE,
    changed: false,
  })
  expect(showInfoModal).not.toHaveBeenCalled()
})

test('swallows a thrown sync so startup is never derailed', async () => {
  const host = createHost({ before: ACTIVE, after: new Error('boom') })

  await expect(checkSeatRegistration(host)).resolves.toEqual({
    state: ACTIVE,
    changed: false,
  })

  expect(showInfoModal).not.toHaveBeenCalled()
  expect(host._log).toHaveBeenCalled()
})

test('passes force through to the manager', async () => {
  const host = createHost({ before: ACTIVE, after: ACTIVE })

  await checkSeatRegistration(host, { force: true })

  expect(host.licenseManager?.syncFromServer).toHaveBeenCalledWith({ force: true })
})

test('does nothing without a license manager', async () => {
  await expect(checkSeatRegistration(createHost({ manager: false }))).resolves.toEqual({
    changed: false,
  })
  expect(showInfoModal).not.toHaveBeenCalled()
})
