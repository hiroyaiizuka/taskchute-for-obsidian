import {
  normalizeRecipeReference,
  RecipeReferencePolicyError,
  resolveRecipeReferenceInFolder,
} from './RecipeReferencePolicy'
import type { Recipe } from '../types'
import type {
  RecipeContextSnapshot,
  RecipeDelegationPayload,
} from './RecipeDelegationContextBuilder'

export class RecipeContextError extends Error {
  readonly cause?: unknown

  constructor(
    message: string,
    readonly recipePath?: string,
    cause?: unknown,
  ) {
    super(message)
    this.name = 'RecipeContextError'
    this.cause = cause
  }
}

export interface RecipeContextProviderDeps {
  isFeatureEnabled(): boolean
  getRecipeFolderPath(): string
  loadRecipe(path: string): Promise<Recipe>
  sha256?: (canonicalJson: string) => Promise<string>
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/gu, '\n')
}

function toPayload(recipe: Recipe): RecipeDelegationPayload {
  return {
    schemaVersion: recipe.schemaVersion,
    title: normalizeLineEndings(recipe.title),
    goal: normalizeLineEndings(recipe.goal),
    procedureChecklist: recipe.steps.map((item) => ({
      id: item.id,
      text: normalizeLineEndings(item.text),
    })),
    qualityChecklist: recipe.qualityChecks.map((item) => ({
      id: item.id,
      text: normalizeLineEndings(item.text),
    })),
    constraints: recipe.constraints.map((item) =>
      normalizeLineEndings(item.text),
    ),
  }
}

async function defaultSha256(value: string): Promise<string> {
  const subtle = activeWindow.crypto?.subtle
  if (!subtle) {
    throw new RecipeContextError('SHA-256 is unavailable in this runtime')
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

function freezePayload(payload: RecipeDelegationPayload): RecipeDelegationPayload {
  for (const item of payload.procedureChecklist) Object.freeze(item)
  for (const item of payload.qualityChecklist) Object.freeze(item)
  Object.freeze(payload.procedureChecklist)
  Object.freeze(payload.qualityChecklist)
  Object.freeze(payload.constraints)
  return Object.freeze(payload)
}

/** Resolves one immutable recipe snapshot during AI-run preflight. */
export class RecipeContextProvider {
  constructor(private readonly deps: RecipeContextProviderDeps) {}

  async getSnapshot(
    frontmatter: Record<string, unknown> | undefined,
  ): Promise<RecipeContextSnapshot | null> {
    if (!this.deps.isFeatureEnabled()) return null

    const recipePath = normalizeRecipeReference(frontmatter?.recipe)
    if (!recipePath) return null
    try {
      resolveRecipeReferenceInFolder(recipePath, this.deps.getRecipeFolderPath())
    } catch (error) {
      if (!(error instanceof RecipeReferencePolicyError)) throw error
      throw new RecipeContextError(
        error.message,
        error.recipePath ?? recipePath,
        error,
      )
    }

    let recipe: Recipe
    try {
      recipe = await this.deps.loadRecipe(recipePath)
    } catch (error) {
      throw new RecipeContextError(
        `Recipe could not be loaded: ${recipePath}`,
        recipePath,
        error,
      )
    }

    const payload = freezePayload(toPayload(recipe))
    // Object insertion order is fixed by toPayload and is the canonical key
    // order for Recipe v2. The path is intentionally excluded from the hash.
    const canonicalJson = JSON.stringify(payload)
    const recipeContentHash = await (this.deps.sha256 ?? defaultSha256)(canonicalJson)
    return Object.freeze({
      recipePath: recipe.path,
      recipeVersion: recipe.schemaVersion,
      recipeContentHash,
      payload,
    })
  }
}
