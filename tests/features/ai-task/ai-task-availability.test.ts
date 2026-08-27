import {
  canStartAiTaskRuntime,
  evaluateAiTaskAvailability,
  isAiTaskFeatureAvailable,
  isAiTaskLicensed,
  isAiTaskSettingEnabled,
  type AiTaskAvailabilityHost,
} from '../../../src/features/ai-task/availability'
import { createFakeLicenseManager } from '../license/fakeLicenseManager'

type AvailabilityModule = typeof import('../../../src/features/ai-task/availability')

function makeHost(
  overrides: Partial<AiTaskAvailabilityHost> = {},
): AiTaskAvailabilityHost {
  return {
    settings: { aiTaskEnabled: true },
    pathManager: {
      getAiLogsPath: () => 'TaskChute/AI/Logs',
      getAiLogsMonthPath: (yearMonth: string) => `TaskChute/AI/Logs/${yearMonth}`,
    },
    licenseManager: createFakeLicenseManager(),
    aiTaskManager: {},
    ...overrides,
  }
}

describe('evaluateAiTaskAvailability', () => {
  test('reports available when every gate passes', () => {
    expect(evaluateAiTaskAvailability(makeHost())).toEqual({ available: true })
    expect(canStartAiTaskRuntime(makeHost())).toBe(true)
  })

  test('reports "disabled" when the settings toggle is off', () => {
    const host = makeHost({ settings: { aiTaskEnabled: false } })
    expect(evaluateAiTaskAvailability(host)).toEqual({
      available: false,
      reason: 'disabled',
    })
  })

  test('reports "not-desktop" on mobile', () => {
    jest.isolateModules(() => {
      jest.doMock('obsidian', () => ({
        ...jest.requireActual<Record<string, unknown>>('obsidian'),
        Platform: { isDesktop: false, isMobile: true },
      }))
      const mod = require('../../../src/features/ai-task/availability') as AvailabilityModule
      expect(mod.evaluateAiTaskAvailability(makeHost())).toEqual({
        available: false,
        reason: 'not-desktop',
      })
    })
  })

  test('reports "not-desktop" when the Platform export is missing entirely', () => {
    jest.isolateModules(() => {
      jest.doMock('obsidian', () => ({
        ...jest.requireActual<Record<string, unknown>>('obsidian'),
        Platform: undefined,
      }))
      const mod = require('../../../src/features/ai-task/availability') as AvailabilityModule
      expect(mod.evaluateAiTaskAvailability(makeHost())).toEqual({
        available: false,
        reason: 'not-desktop',
      })
    })
  })

  test('reports "unlicensed" when the license is inactive', () => {
    const host = makeHost({ licenseManager: createFakeLicenseManager(false) })
    expect(evaluateAiTaskAvailability(host)).toEqual({
      available: false,
      reason: 'unlicensed',
    })
  })

  test('reports "unlicensed" when no license manager exists at all', () => {
    // Fails closed: a bootstrap failure must not hand out the paid feature.
    const host = makeHost({ licenseManager: undefined })
    expect(evaluateAiTaskAvailability(host)).toEqual({
      available: false,
      reason: 'unlicensed',
    })
  })

  test('reports "unsupported-paths" when the path manager lacks AI log paths', () => {
    expect(evaluateAiTaskAvailability(makeHost({ pathManager: {} }))).toEqual({
      available: false,
      reason: 'unsupported-paths',
    })
    expect(
      evaluateAiTaskAvailability(
        makeHost({ pathManager: { getAiLogsPath: () => 'TaskChute/AI/Logs' } }),
      ),
    ).toEqual({ available: false, reason: 'unsupported-paths' })
    expect(evaluateAiTaskAvailability(makeHost({ pathManager: undefined }))).toEqual({
      available: false,
      reason: 'unsupported-paths',
    })
  })
})

describe('the individual questions stay independent', () => {
  test('a licensed vault with the toggle off is licensed but not enabled', () => {
    const host = makeHost({ settings: { aiTaskEnabled: false } })
    expect(isAiTaskSettingEnabled(host)).toBe(false)
    expect(isAiTaskLicensed(host)).toBe(true)
  })

  test('an unlicensed vault with the toggle on is enabled but not licensed', () => {
    const host = makeHost({ licenseManager: createFakeLicenseManager(false) })
    expect(isAiTaskSettingEnabled(host)).toBe(true)
    expect(isAiTaskLicensed(host)).toBe(false)
  })
})

describe('isAiTaskFeatureAvailable', () => {
  test('is false while no runtime exists, even with every gate open', () => {
    expect(isAiTaskFeatureAvailable(makeHost({ aiTaskManager: undefined }))).toBe(false)
  })

  test('is false as soon as a gate closes, before the runtime is torn down', () => {
    // Revocation hides the UI on the next render rather than waiting for the
    // asynchronous dispose to clear plugin.aiTaskManager.
    const host = makeHost({ licenseManager: createFakeLicenseManager(false) })
    expect(host.aiTaskManager).toBeDefined()
    expect(isAiTaskFeatureAvailable(host)).toBe(false)
  })

  test('is true when the gates are open and the runtime exists', () => {
    expect(isAiTaskFeatureAvailable(makeHost())).toBe(true)
  })
})
