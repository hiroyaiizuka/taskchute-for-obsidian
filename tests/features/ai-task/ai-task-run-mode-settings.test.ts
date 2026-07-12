import { prepareSettings } from '../../../src/app/bootstrap'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import type { TaskChutePlugin } from '../../../src/types'

function makePlugin(loaded: Record<string, unknown> | undefined): TaskChutePlugin {
  return {
    loadData: jest.fn(async () => loaded),
  } as unknown as TaskChutePlugin
}

describe('aiTaskRunMode setting', () => {
  test('defaults to terminal', () => {
    expect(DEFAULT_SETTINGS.aiTaskRunMode).toBe('terminal')
  })

  test('prepareSettings fills terminal for fresh installs', async () => {
    const settings = await prepareSettings(makePlugin(undefined))
    expect(settings.aiTaskRunMode).toBe('terminal')
  })

  test('prepareSettings keeps an explicit headless preference', async () => {
    const settings = await prepareSettings(makePlugin({ aiTaskRunMode: 'headless' }))
    expect(settings.aiTaskRunMode).toBe('headless')
  })

  test('prepareSettings keeps an explicit terminal preference', async () => {
    const settings = await prepareSettings(makePlugin({ aiTaskRunMode: 'terminal' }))
    expect(settings.aiTaskRunMode).toBe('terminal')
  })

  test('prepareSettings normalizes invalid values back to terminal', async () => {
    for (const bogus of ['tui', 42, true, null]) {
      const settings = await prepareSettings(makePlugin({ aiTaskRunMode: bogus }))
      expect(settings.aiTaskRunMode).toBe('terminal')
    }
  })
})
