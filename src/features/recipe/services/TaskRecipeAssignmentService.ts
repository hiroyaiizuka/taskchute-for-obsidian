import { TFile } from 'obsidian'
import {
  createRecipeReferenceLink,
  RecipeReferencePolicyError,
  resolveExistingRecipeReference,
} from './RecipeReferencePolicy'

export interface TaskRecipeAssignmentInput {
  /** undefined: keep unchanged, null: unlink, string: validate and assign. */
  recipePath?: string | null
}

export class TaskRecipeAssignmentError extends Error {
  constructor(message: string, readonly recipePath?: string) {
    super(message)
    this.name = 'TaskRecipeAssignmentError'
  }
}

export interface TaskRecipeAssignmentDeps {
  app: {
    vault: {
      getAbstractFileByPath(path: string): unknown
    }
    fileManager?: {
      processFrontMatter(
        file: TFile,
        callback: (frontmatter: Record<string, unknown>) => void | Record<string, unknown>,
      ): Promise<void>
    }
  }
  getRecipeFolderPath(): string
}

export { createRecipeReferenceLink } from './RecipeReferencePolicy'

export class TaskRecipeAssignmentService {
  constructor(private readonly deps: TaskRecipeAssignmentDeps) {}

  /** Validate and normalize the tri-state assignment without writing. */
  resolve(input: TaskRecipeAssignmentInput): string | null | undefined {
    if (input.recipePath === undefined || input.recipePath === null) {
      return input.recipePath
    }
    try {
      return resolveExistingRecipeReference(
        input.recipePath,
        this.deps.getRecipeFolderPath(),
        this.deps.app.vault,
      ).path
    } catch (error) {
      if (error instanceof RecipeReferencePolicyError) {
        throw new TaskRecipeAssignmentError(error.message, error.recipePath)
      }
      throw error
    }
  }

  applyToFrontmatter(
    frontmatter: Record<string, unknown>,
    input: TaskRecipeAssignmentInput,
  ): void {
    const resolved = this.resolve(input)
    if (resolved === undefined) return
    if (resolved === null) {
      delete frontmatter.recipe
      return
    }
    frontmatter.recipe = createRecipeReferenceLink(resolved)
  }

  async updateTask(file: TFile, input: TaskRecipeAssignmentInput): Promise<void> {
    const fileManager = this.deps.app.fileManager
    if (!fileManager) {
      throw new TaskRecipeAssignmentError('Frontmatter editing is unavailable')
    }
    // Resolve before entering the mutating callback so validation failures are
    // guaranteed to leave the note byte-for-byte unchanged.
    const resolved = this.resolve(input)
    await fileManager.processFrontMatter(file, (frontmatter) => {
      if (resolved === undefined) return
      if (resolved === null) delete frontmatter.recipe
      else frontmatter.recipe = createRecipeReferenceLink(resolved)
    })
  }
}
