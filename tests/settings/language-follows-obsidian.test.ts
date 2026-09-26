import { prepareSettings } from '../../src/app/bootstrap'
import { getCurrentLocale } from '../../src/i18n'
import type { TaskChutePlugin } from '../../src/types'
import { setObsidianLanguage } from '../utils/locale'

function makePlugin(loaded: Record<string, unknown> | undefined): TaskChutePlugin {
  return {
    loadData: jest.fn(async () => loaded),
  } as unknown as TaskChutePlugin
}

describe('plugin language follows Obsidian', () => {
  afterEach(() => {
    setObsidianLanguage('en')
  })

  test.each(['en', 'ja'] as const)('uses Obsidian language %s', (locale) => {
    setObsidianLanguage(locale)
    expect(getCurrentLocale()).toBe(locale)
  })

  test('drops the retired languageOverride setting from saved data', async () => {
    const settings = await prepareSettings(makePlugin({ languageOverride: 'ja' }))
    expect('languageOverride' in settings).toBe(false)
  })
})
