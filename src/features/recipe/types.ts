import type { TFile } from 'obsidian'

export type RecipeSchemaVersion = 1 | 2

export interface RecipeStep {
  id: string
  text: string
}

export interface RecipeQualityCheck {
  id: string
  text: string
}

export interface RecipeConstraint {
  id: string
  text: string
}

export interface Recipe {
  path: string
  title: string
  schemaVersion: RecipeSchemaVersion
  goal: string
  steps: RecipeStep[]
  qualityChecks: RecipeQualityCheck[]
  constraints: RecipeConstraint[]
  file: TFile
}

export interface RecipeStepInput {
  id?: string
  text: string
}

export interface RecipeQualityCheckInput {
  id?: string
  text: string
}

export interface RecipeSaveInput {
  path?: string
  title: string
  /** Existing callers may omit the goal while migrating from Recipe v1. */
  goal?: string
  /** String entries remain supported for backwards compatibility. */
  steps: Array<string | RecipeStepInput>
  qualityChecks?: Array<string | RecipeQualityCheckInput>
  constraints?: string[]
}

export interface RecipeDocumentData {
  schemaVersion: RecipeSchemaVersion
  title?: string
  goal: string
  steps: RecipeStep[]
  qualityChecks: RecipeQualityCheck[]
  constraints: RecipeConstraint[]
}

export interface RecipeDocumentWriteInput {
  title: string
  goal: string
  steps: RecipeStep[]
  qualityChecks: RecipeQualityCheck[]
  constraints: string[]
}
