import type { ObsidianTaskLinkConfig } from '../../../src/types/TaskFields'
import {
  isObsidianTaskLinkConfig,
  matchesObsidianTaskTitle,
  readObsidianTaskLinkConfig,
} from '../../../src/features/ai-task/services/ObsidianTaskLinkConfig'

describe('ObsidianTaskLinkConfig', () => {
  describe('isObsidianTaskLinkConfig', () => {
    test.each([
      { enabled: true, taskTitle: 'CEO review', matchType: 'exact' },
      { enabled: false, taskTitle: 'CEO review', matchType: 'contains' },
    ])('accepts a structurally valid config: %#', (config) => {
      expect(isObsidianTaskLinkConfig(config)).toBe(true)
    })

    test.each([
      null,
      [],
      {},
      { enabled: 'true', taskTitle: 'CEO review', matchType: 'exact' },
      { enabled: true, taskTitle: '', matchType: 'exact' },
      { enabled: true, taskTitle: '   ', matchType: 'exact' },
      { enabled: true, taskTitle: 'CEO review', matchType: 'prefix' },
    ])('rejects an invalid config: %#', (config) => {
      expect(isObsidianTaskLinkConfig(config)).toBe(false)
    })
  })

  describe('readObsidianTaskLinkConfig', () => {
    test('returns a normalized enabled config from obsidian_sync', () => {
      expect(
        readObsidianTaskLinkConfig({
          obsidian_sync: {
            enabled: true,
            taskTitle: '  CEO review  ',
            matchType: 'contains',
          },
        }),
      ).toEqual({
        enabled: true,
        taskTitle: 'CEO review',
        matchType: 'contains',
      })
    })

    test.each([
      null,
      undefined,
      {},
      { obsidian_sync: { enabled: false, taskTitle: 'CEO review', matchType: 'exact' } },
      { obsidian_sync: { enabled: true, taskTitle: '', matchType: 'exact' } },
      { obsidian_sync: { enabled: true, taskTitle: 'CEO review', matchType: 'invalid' } },
    ])('returns null for missing, disabled, or invalid active config: %#', (frontmatter) => {
      expect(readObsidianTaskLinkConfig(frontmatter)).toBeNull()
    })
  })

  describe('matchesObsidianTaskTitle', () => {
    const exact: ObsidianTaskLinkConfig = {
      enabled: true,
      taskTitle: 'CEO review',
      matchType: 'exact',
    }
    const contains: ObsidianTaskLinkConfig = {
      enabled: true,
      taskTitle: 'CEO review',
      matchType: 'contains',
    }

    test('uses strict case-sensitive equality for exact matching', () => {
      expect(matchesObsidianTaskTitle('CEO review', exact)).toBe(true)
      expect(matchesObsidianTaskTitle('Daily CEO review', exact)).toBe(false)
      expect(matchesObsidianTaskTitle('ceo review', exact)).toBe(false)
      expect(matchesObsidianTaskTitle(' CEO review ', exact)).toBe(false)
    })

    test('uses one-way source-title contains configured-title matching', () => {
      expect(matchesObsidianTaskTitle('Daily CEO review', contains)).toBe(true)
      expect(matchesObsidianTaskTitle('CEO', contains)).toBe(false)
      expect(
        matchesObsidianTaskTitle('CEO', {
          ...contains,
          taskTitle: 'Daily CEO review',
        }),
      ).toBe(false)
    })

    test('does not match a disabled config', () => {
      expect(
        matchesObsidianTaskTitle('CEO review', { ...exact, enabled: false }),
      ).toBe(false)
    })
  })
})
