import { TFile, normalizePath } from 'obsidian'

export type RecipeReferencePolicyErrorCode =
  | 'required'
  | 'outside-folder'
  | 'not-found'

export class RecipeReferencePolicyError extends Error {
  constructor(
    message: string,
    readonly code: RecipeReferencePolicyErrorCode,
    readonly recipePath?: string,
  ) {
    super(message)
    this.name = 'RecipeReferencePolicyError'
  }
}

export interface RecipeReferenceVault {
  getAbstractFileByPath(path: string): unknown
}

/** Normalize plain paths and Obsidian wikilinks to one markdown vault path. */
export function normalizeRecipeReference(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  if (!raw) return undefined
  const wikilink = raw.match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/u)
  const path = wikilink ? wikilink[1].trim() : raw
  if (!path) return undefined
  return normalizePath(path.endsWith('.md') ? path : `${path}.md`)
}

export function createRecipeReferenceLink(recipePath: string): string {
  return `[[${recipePath}]]`
}

/** Exact folder boundary check. Sibling prefixes such as Recipes-Archive fail. */
export function isRecipePathInsideFolder(recipePath: string, recipeFolderPath: string): boolean {
  const normalizedPath = normalizePath(recipePath)
  const normalizedFolder = normalizePath(recipeFolderPath).replace(/\/+$/u, '')
  const containsTraversalSegment = normalizedPath
    .split('/')
    .some((segment) => segment === '.' || segment === '..')
  return !containsTraversalSegment
    && normalizedFolder.length > 0
    && normalizedPath.startsWith(`${normalizedFolder}/`)
}

/** Normalize a reference and enforce the configured Recipe folder boundary. */
export function resolveRecipeReferenceInFolder(
  value: unknown,
  recipeFolderPath: string,
): string {
  const normalizedPath = normalizeRecipeReference(value)
  if (!normalizedPath) {
    throw new RecipeReferencePolicyError('Recipe path is required', 'required')
  }
  if (!isRecipePathInsideFolder(normalizedPath, recipeFolderPath)) {
    throw new RecipeReferencePolicyError(
      `Recipe is outside the configured recipe folder: ${normalizedPath}`,
      'outside-folder',
      normalizedPath,
    )
  }
  return normalizedPath
}

/** Resolve an existing markdown Recipe file after applying the shared boundary policy. */
export function resolveExistingRecipeReference(
  value: unknown,
  recipeFolderPath: string,
  vault: RecipeReferenceVault,
): { path: string; file: TFile } {
  const path = resolveRecipeReferenceInFolder(value, recipeFolderPath)
  const file = vault.getAbstractFileByPath(path)
  if (!(file instanceof TFile)) {
    throw new RecipeReferencePolicyError(`Recipe not found: ${path}`, 'not-found', path)
  }
  return { path, file }
}
