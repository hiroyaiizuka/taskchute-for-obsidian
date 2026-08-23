import {
  RecipeContextError,
  RecipeContextProvider,
} from '../../src/features/recipe/services/RecipeContextProvider'
import type { Recipe } from '../../src/features/recipe/types'

function recipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    path: 'TaskChute/Recipes/Publish.md',
    title: 'Publish\r\nArticle',
    schemaVersion: 2,
    goal: 'URL exists\r\nwithout errors',
    steps: [{ id: 'step-1', text: 'Draft' }],
    qualityChecks: [{ id: 'quality-1', text: 'Links work' }],
    constraints: [{ id: 'constraint-1', text: 'No secrets' }],
    file: {} as Recipe['file'],
    ...overrides,
  }
}

describe('RecipeContextProvider', () => {
  test('returns null without reading when the feature is disabled', async () => {
    const loadRecipe = jest.fn(async () => recipe())
    const provider = new RecipeContextProvider({
      isFeatureEnabled: () => false,
      getRecipeFolderPath: () => 'TaskChute/Recipes',
      loadRecipe,
      sha256: async () => 'unused',
    })

    await expect(
      provider.getSnapshot({ recipe: '[[TaskChute/Recipes/Publish]]' }),
    ).resolves.toBeNull()
    expect(loadRecipe).not.toHaveBeenCalled()
  })

  test('normalizes line endings and hashes the canonical payload without path', async () => {
    let canonical = ''
    const provider = new RecipeContextProvider({
      isFeatureEnabled: () => true,
      getRecipeFolderPath: () => 'TaskChute/Recipes',
      loadRecipe: async () => recipe(),
      sha256: async (value) => {
        canonical = value
        return 'abc123'
      },
    })

    const result = await provider.getSnapshot({
      recipe: '[[TaskChute/Recipes/Publish]]',
    })

    expect(result).toMatchObject({
      recipePath: 'TaskChute/Recipes/Publish.md',
      recipeVersion: 2,
      recipeContentHash: 'abc123',
    })
    expect(result?.payload.goal).toBe('URL exists\nwithout errors')
    expect(canonical).not.toContain('TaskChute/Recipes/Publish.md')
    expect(Object.isFrozen(result?.payload)).toBe(true)
  })

  test('fails closed for links outside the configured folder', async () => {
    const provider = new RecipeContextProvider({
      isFeatureEnabled: () => true,
      getRecipeFolderPath: () => 'TaskChute/Recipes',
      loadRecipe: async () => recipe(),
      sha256: async () => 'unused',
    })

    await expect(
      provider.getSnapshot({ recipe: '[[Other/Publish]]' }),
    ).rejects.toBeInstanceOf(RecipeContextError)
    await expect(
      provider.getSnapshot({ recipe: '[[TaskChute/Recipes-Archive/Publish]]' }),
    ).rejects.toBeInstanceOf(RecipeContextError)
  })

  test('wraps missing or corrupt recipe failures as a typed preflight error', async () => {
    const provider = new RecipeContextProvider({
      isFeatureEnabled: () => true,
      getRecipeFolderPath: () => 'TaskChute/Recipes',
      loadRecipe: async () => {
        throw new Error('bad markers')
      },
      sha256: async () => 'unused',
    })

    await expect(
      provider.getSnapshot({ recipe: '[[TaskChute/Recipes/Publish]]' }),
    ).rejects.toMatchObject({
      name: 'RecipeContextError',
      recipePath: 'TaskChute/Recipes/Publish.md',
    })
  })
})
