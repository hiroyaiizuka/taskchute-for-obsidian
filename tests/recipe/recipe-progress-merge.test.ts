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
})
