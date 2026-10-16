import { prepareSettings } from '@/app/bootstrap'
import { DEFAULT_SETTINGS } from '@/settings'
import type { TaskChutePlugin } from '@/types'

function makePlugin(loaded: Record<string, unknown> | undefined): TaskChutePlugin {
  return {
    loadData: jest.fn(async () => loaded),
  } as unknown as TaskChutePlugin
}

// LEV-320: there is no run-mode setting. Runs use the terminal where it can
// run and fall back to conversation mode elsewhere.
describe('run mode is not a setting', () => {
  test('has no default', () => {
    expect(DEFAULT_SETTINGS.aiTaskRunMode).toBeUndefined()
  })

  test.each([undefined, 'headless', 'terminal', 'tui', 42])('prepareSettings drops a stored value (%p)', async (stored) => {
    const settings = await prepareSettings(makePlugin(stored === undefined ? {} : { aiTaskRunMode: stored }))
    expect(settings.aiTaskRunMode).toBeUndefined()
  })
})
