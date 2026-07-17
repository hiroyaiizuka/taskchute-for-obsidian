import {
  buildRecipeDelegationPrompt,
  type RecipeContextSnapshot,
} from '../../src/features/recipe/services/RecipeDelegationContextBuilder'

function snapshot(): RecipeContextSnapshot {
  return {
    recipePath: 'TaskChute/Recipes/Publish.md',
    recipeVersion: 2,
    recipeContentHash: 'hash',
    payload: {
      schemaVersion: 2,
      title: 'Publish',
      goal: 'A public URL exists',
      procedureChecklist: [{ id: 'step-1', text: 'Draft ``` content' }],
      qualityChecklist: [{ id: 'quality-1', text: 'Links work' }],
      constraints: ['Do not expose secrets'],
    },
  }
}

describe('RecipeDelegationContextBuilder', () => {
  test('leaves the task request byte-identical without a recipe', () => {
    expect(buildRecipeDelegationPrompt('  keep me\n', null)).toBe('  keep me\n')
  })

  test('appends the four-part canonical contract once with a safe fence', () => {
    const result = buildRecipeDelegationPrompt('Do the task', snapshot())

    expect(result.match(/# TaskChute execution contract/gu)).toHaveLength(1)
    expect(result).toContain('"goal": "A public URL exists"')
    expect(result).toContain('"procedureChecklist"')
    expect(result).toContain('"qualityChecklist"')
    expect(result).toContain('"constraints"')
    expect(result).toContain('````json')
    expect(result).toContain('\n````')
  })

  test('supports an empty base prompt when a recipe exists', () => {
    expect(buildRecipeDelegationPrompt('', snapshot())).toMatch(
      /^# TaskChute execution contract/u,
    )
  })
})

