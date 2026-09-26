import { getLanguage } from 'obsidian'
import { initializeLocaleManager, type LocaleKey } from '../../src/i18n'

/**
 * Loads the plugin's locale as if Obsidian were running in `locale`.
 * The plugin only ever follows Obsidian's language, so tests switch locale by
 * changing what the mocked `getLanguage()` reports and re-initializing.
 */
export function setObsidianLanguage(locale: LocaleKey): void {
  jest.mocked(getLanguage).mockReturnValue(locale)
  initializeLocaleManager()
}
