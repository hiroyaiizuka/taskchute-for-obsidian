import { TFile } from 'obsidian'
import {
  TaskRecipeAssignmentError,
  TaskRecipeAssignmentService,
} from '../../src/features/recipe/services/TaskRecipeAssignmentService'

function file(path: string): TFile {
  const result = new TFile()
  result.path = path
  result.basename = path.split('/').pop()?.replace(/\.md$/u, '') ?? ''
  result.extension = 'md'
  return result
}

describe('TaskRecipeAssignmentService', () => {
  const recipe = file('TaskChute/Recipes/Publish.md')
  const service = new TaskRecipeAssignmentService({
    app: {
      vault: {
        getAbstractFileByPath: (path) =>
          path === recipe.path ? recipe : null,
      },
    },
    getRecipeFolderPath: () => 'TaskChute/Recipes',
  })

  test('preserves tri-state semantics', () => {
    const current: Record<string, unknown> = { recipe: '[[keep]]' }
    service.applyToFrontmatter(current, {})
    expect(current.recipe).toBe('[[keep]]')

    service.applyToFrontmatter(current, { recipePath: null })
    expect(current).not.toHaveProperty('recipe')

    service.applyToFrontmatter(current, { recipePath: recipe.path })
    expect(current.recipe).toBe('[[TaskChute/Recipes/Publish.md]]')
  })

  test('rejects missing and folder-external recipes before mutation', () => {
    expect(() =>
      service.resolve({ recipePath: 'Other/Publish.md' }),
    ).toThrow(TaskRecipeAssignmentError)
    expect(() =>
      service.resolve({ recipePath: 'TaskChute/Recipes/Missing.md' }),
    ).toThrow(TaskRecipeAssignmentError)
    expect(() =>
      service.resolve({ recipePath: 'TaskChute/Recipes-Archive/Publish.md' }),
    ).toThrow(TaskRecipeAssignmentError)
    expect(() =>
      service.resolve({ recipePath: 'TaskChute/Recipes/../Task/Publish.md' }),
    ).toThrow(TaskRecipeAssignmentError)
  })
})
