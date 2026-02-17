import { readFileSync } from 'fs'
import { join } from 'path'

describe('normalizeReminderTime import declarations', () => {
  const targetFiles = [
    'src/features/core/services/TaskLoaderService.ts',
    'src/features/reminder/ui/ReminderIconRenderer.ts',
    'src/ui/task/TaskSettingsTooltipController.ts',
  ] as const

  test.each(targetFiles)('%s should import normalizeReminderTime only once', (relativePath) => {
    const content = readFileSync(join(process.cwd(), relativePath), 'utf8')
    const matches =
      content.match(
        /import\s*\{\s*normalizeReminderTime\s*\}\s*from\s*['"][^'"]*ReminderFrontmatterService['"]/g
      ) ?? []

    expect(matches).toHaveLength(1)
  })
})
