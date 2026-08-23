import { mergeRecipeProgress } from '../../src/services/dayState/conflictResolver'

describe('mergeRecipeProgress', () => {
  test('keeps newer progress for same task recipe key', () => {
    const result = mergeRecipeProgress(
      {
        'inst::recipe': {
          recipePath: 'Recipes/A.md',
          checkedStepIds: ['step-1'],
          updatedAt: 10,
        },
      },
      {
        'inst::recipe': {
          recipePath: 'Recipes/A.md',
          checkedStepIds: ['step-1', 'step-2'],
          stepOrder: ['step-2', 'step-1'],
          updatedAt: 20,
        },
      },
    )

    expect(result.merged['inst::recipe'].checkedStepIds).toEqual(['step-1', 'step-2'])
    expect(result.merged['inst::recipe'].stepOrder).toEqual(['step-2', 'step-1'])
    expect(result.hasConflicts).toBe(true)
  })

  test('keeps different dates separated by caller-provided day state', () => {
    const today = mergeRecipeProgress(
      { 'routine::recipe': { recipePath: 'Recipes/A.md', checkedStepIds: ['step-1'], updatedAt: 10 } },
      {},
    )
    const tomorrow = mergeRecipeProgress({}, {})

    expect(today.merged['routine::recipe'].checkedStepIds).toEqual(['step-1'])
    expect(tomorrow.merged['routine::recipe']).toBeUndefined()
  })

  test('treats quality checklist changes as progress conflicts', () => {
    const result = mergeRecipeProgress(
      {
        'inst::recipe': {
          recipePath: 'Recipes/A.md',
          checkedStepIds: [],
          checkedQualityCheckIds: ['quality-a'],
          qualityCheckOrder: ['quality-a', 'quality-b'],
          completedAtByQualityCheckId: { 'quality-a': '2026-07-17T00:00:00.000Z' },
          updatedAt: 10,
        },
      },
      {
        'inst::recipe': {
          recipePath: 'Recipes/A.md',
          checkedStepIds: [],
          checkedQualityCheckIds: ['quality-b'],
          qualityCheckOrder: ['quality-b', 'quality-a'],
          completedAtByQualityCheckId: { 'quality-b': '2026-07-17T00:01:00.000Z' },
          updatedAt: 20,
        },
      },
    )

    expect(result.hasConflicts).toBe(true)
    expect(result.merged['inst::recipe'].checkedQualityCheckIds).toEqual(['quality-b'])
    expect(result.merged['inst::recipe'].completedAtByQualityCheckId).toEqual({
      'quality-b': '2026-07-17T00:01:00.000Z',
    })
  })

  test('merges independently updated procedure and quality channels', () => {
    const result = mergeRecipeProgress(
      {
        'inst::recipe': {
          recipePath: 'Recipes/A.md',
          checkedStepIds: ['step-new'],
          stepOrder: ['step-new', 'step-old'],
          completedAtByStepId: { 'step-new': '2026-07-17T01:00:00.000Z' },
          stepsUpdatedAt: 30,
          checkedQualityCheckIds: [],
          qualityCheckOrder: ['quality-old'],
          qualityChecksUpdatedAt: 10,
          updatedAt: 30,
        },
      },
      {
        'inst::recipe': {
          recipePath: 'Recipes/A.md',
          checkedStepIds: [],
          stepOrder: ['step-old', 'step-new'],
          stepsUpdatedAt: 20,
          checkedQualityCheckIds: ['quality-new'],
          qualityCheckOrder: ['quality-new', 'quality-old'],
          completedAtByQualityCheckId: {
            'quality-new': '2026-07-17T02:00:00.000Z',
          },
          qualityChecksUpdatedAt: 40,
          updatedAt: 40,
        },
      },
    )

    expect(result.merged['inst::recipe']).toEqual({
      recipePath: 'Recipes/A.md',
      checkedStepIds: ['step-new'],
      stepOrder: ['step-new', 'step-old'],
      completedAtByStepId: { 'step-new': '2026-07-17T01:00:00.000Z' },
      stepsUpdatedAt: 30,
      checkedQualityCheckIds: ['quality-new'],
      qualityCheckOrder: ['quality-new', 'quality-old'],
      completedAtByQualityCheckId: {
        'quality-new': '2026-07-17T02:00:00.000Z',
      },
      qualityChecksUpdatedAt: 40,
      updatedAt: 40,
    })
  })
})
