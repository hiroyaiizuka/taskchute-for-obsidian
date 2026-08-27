import { syncAiTaskManagerToLicense } from '../../../src/features/ai-task/licenseGate'
import { createAiTaskManager } from '../../../src/features/ai-task'
import { disposeAiTaskManagerTracked } from '../../../src/features/ai-task/registerProcessCleanup'
import { createFakeLicenseManager } from '../license/fakeLicenseManager'

jest.mock('../../../src/features/ai-task', () => ({
  createAiTaskManager: jest.fn(),
}))
jest.mock('../../../src/features/ai-task/registerProcessCleanup', () => ({
  disposeAiTaskManagerTracked: jest.fn(),
}))

const createAiTaskManagerMock = createAiTaskManager as jest.Mock
const disposeMock = disposeAiTaskManagerTracked as jest.Mock

type Host = Parameters<typeof syncAiTaskManagerToLicense>[0]

function createHost(overrides: Partial<Record<string, unknown>> = {}): Host {
  return {
    app: {},
    settings: { aiTaskEnabled: true },
    // The gate now asks canStartAiTaskRuntime, which includes the AI log paths.
    pathManager: {
      getAiLogsPath: () => 'TaskChute/AI/Logs',
      getAiLogsMonthPath: (yearMonth: string) => `TaskChute/AI/Logs/${yearMonth}`,
    },
    licenseManager: createFakeLicenseManager(),
    aiTaskManagersPendingDisposal: new Set(),
    _log: jest.fn(),
    ...overrides,
  } as unknown as Host
}

describe('syncAiTaskManagerToLicense', () => {
  beforeEach(() => {
    createAiTaskManagerMock.mockReset()
    disposeMock.mockReset()
  })

  test('creates a manager when the license is active and the feature is on', async () => {
    const manager = { id: 'manager' }
    createAiTaskManagerMock.mockReturnValue(manager)
    const host = createHost()

    expect(await syncAiTaskManagerToLicense(host)).toBe(true)
    expect(host.aiTaskManager).toBe(manager)
  })

  test('does nothing when the feature toggle is off', async () => {
    const host = createHost({ settings: { aiTaskEnabled: false } })

    expect(await syncAiTaskManagerToLicense(host)).toBe(false)
    expect(createAiTaskManagerMock).not.toHaveBeenCalled()
  })

  test('leaves an existing manager alone', async () => {
    const existing = { id: 'existing' }
    const host = createHost({ aiTaskManager: existing })

    expect(await syncAiTaskManagerToLicense(host)).toBe(true)
    expect(host.aiTaskManager).toBe(existing)
    expect(createAiTaskManagerMock).not.toHaveBeenCalled()
  })

  test('disposes the runtime as soon as the license stops being active', async () => {
    const existing = { id: 'existing' }
    const host = createHost({
      aiTaskManager: existing,
      licenseManager: createFakeLicenseManager(false),
      aiTaskRuntimeLeaseGeneration: 7,
    })

    expect(await syncAiTaskManagerToLicense(host)).toBe(false)
    expect(disposeMock).toHaveBeenCalledWith(host, existing)
    expect(host.aiTaskManager).toBeUndefined()
    expect(host.aiTaskRuntimeLeaseGeneration).toBeUndefined()
  })

  test('fails closed when no license manager exists', async () => {
    const host = createHost({ licenseManager: undefined })

    expect(await syncAiTaskManagerToLicense(host)).toBe(false)
    expect(createAiTaskManagerMock).not.toHaveBeenCalled()
  })

  test('waits for a pending disposal before starting a new runtime', async () => {
    const order: string[] = []
    const pending = {
      disposeAndWait: jest.fn(async () => {
        order.push('disposed')
      }),
    }
    createAiTaskManagerMock.mockImplementation(() => {
      order.push('created')
      return { id: 'new' }
    })
    const host = createHost({ aiTaskManagersPendingDisposal: new Set([pending]) })

    await syncAiTaskManagerToLicense(host)

    // Both share the vault-scoped broker identity; overlapping would let the
    // old shutdown kill the new run.
    expect(order).toEqual(['disposed', 'created'])
    expect(host.aiTaskManagersPendingDisposal?.size).toBe(0)
  })

  test('does not start a runtime when the previous one failed to stop', async () => {
    const pending = { disposeAndWait: jest.fn().mockRejectedValue(new Error('stuck')) }
    const host = createHost({ aiTaskManagersPendingDisposal: new Set([pending]) })

    expect(await syncAiTaskManagerToLicense(host)).toBe(false)
    expect(createAiTaskManagerMock).not.toHaveBeenCalled()
  })
})
