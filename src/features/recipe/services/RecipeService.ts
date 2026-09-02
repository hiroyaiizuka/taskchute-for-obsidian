import { Notice, TFile, normalizePath } from 'obsidian'
import type { TaskChutePluginLike, TaskInstance } from '../../../types'
import { t } from '../../../i18n'
import { listFilesInFolder } from '../../../utils/vaultFiles'
import { RecipeDocumentCodec } from './RecipeDocumentCodec'
import {
  createRecipeReferenceLink,
  normalizeRecipeReference,
  resolveExistingRecipeReference,
  resolveRecipeReferenceInFolder,
} from './RecipeReferencePolicy'
import type {
  Recipe,
  RecipeQualityCheck,
  RecipeQualityCheckInput,
  RecipeSaveInput,
  RecipeStep,
  RecipeStepInput,
} from '../types'

export type {
  Recipe,
  RecipeConstraint,
  RecipeQualityCheck,
  RecipeQualityCheckInput,
  RecipeSaveInput,
  RecipeSchemaVersion,
  RecipeStep,
  RecipeStepInput,
} from '../types'
export { normalizeRecipeReference } from './RecipeReferencePolicy'

function hashText(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  }
  return Math.abs(hash).toString(36)
}

function sanitizeFileName(title: string): string {
  const sanitized = title
    .trim()
    .replace(/[\\/:#^[\]|?*"<>\n\r\t]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return sanitized.length > 0 ? sanitized : 'Untitled recipe'
}

export function createRecipeProgressKey(instanceId: string, recipePath: string): string {
  return `${instanceId}::${recipePath}`
}

export function createRecipeProgressKeyForInstance(instance: TaskInstance, recipePath: string): string {
  const generatedBaseInstancePattern = new RegExp(`^${escapeRegExp(instance.task.path)}_\\d{4}-\\d{2}-\\d{2}_`)
  let subject = instance.instanceId
  if (instance.isDuplicate !== true && generatedBaseInstancePattern.test(instance.instanceId)) {
    subject = `task:${String(instance.task.taskId ?? instance.task.path)}`
  }
  return createRecipeProgressKey(subject, recipePath)
}

export function createRecipeStepId(index: number, text: string): string {
  void index
  return `step-${hashText(text.trim())}`
}

function createPersistentItemId(prefix: 'step' | 'quality'): string {
  const randomUuid = activeWindow.crypto?.randomUUID?.()
  if (randomUuid) return `${prefix}-${randomUuid}`
  const randomPart = Math.random().toString(36).slice(2)
  return `${prefix}-${Date.now().toString(36)}-${randomPart}`
}

function normalizeItemInputs<TInput extends RecipeStepInput | RecipeQualityCheckInput>(
  inputs: Array<string | TInput>,
  existing: Array<{ id: string; text: string }>,
  prefix: 'step' | 'quality',
): Array<{ id: string; text: string }> {
  const normalized: Array<{ id?: string; text: string }> = inputs
    .map((item) => typeof item === 'string' ? { id: undefined, text: item.trim() } : { id: item.id, text: item.text.trim() })
    .filter((item) => item.text.length > 0)
  const result = normalized.map((item) => ({ id: item.id, text: item.text }))
  const usedIds = new Set(result.map((item) => item.id).filter((id): id is string => Boolean(id)))

  for (const item of result) {
    if (item.id) continue
    const matching = existing.find((candidate) => candidate.text === item.text && !usedIds.has(candidate.id))
    if (!matching) continue
    item.id = matching.id
    usedIds.add(matching.id)
  }

  return result.map((item) => ({
    id: item.id ?? createPersistentItemId(prefix),
    text: item.text,
  }))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

export class RecipeService {
  private readonly documentCodec = new RecipeDocumentCodec()

  constructor(private readonly plugin: TaskChutePluginLike) {}

  getRecipeFolderPath(): string {
    return this.plugin.pathManager.getRecipeFolderPath?.() ?? normalizePath('TaskChute/Recipes')
  }

  async loadRecipes(): Promise<Recipe[]> {
    const folderPath = this.getRecipeFolderPath()
    const files = listFilesInFolder(this.plugin.app, folderPath, { markdownOnly: true })
      .sort((a, b) => a.basename.localeCompare(b.basename))

    const recipes: Recipe[] = []
    for (const file of files) {
      try {
        recipes.push(await this.loadRecipe(file.path))
      } catch (error) {
        console.warn('[RecipeService] Failed to load recipe', file.path, error)
      }
    }
    return recipes
  }

  async loadRecipe(path: string): Promise<Recipe> {
    const resolved = resolveExistingRecipeReference(
      path,
      this.getRecipeFolderPath(),
      this.plugin.app.vault,
    )
    const { file } = resolved

    const raw = await this.plugin.app.vault.read(file)
    const parsedRecipe = this.documentCodec.parse(raw)
    const frontmatter = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter
    const title = parsedRecipe.title
      ?? (typeof frontmatter?.title === 'string' && frontmatter.title.trim().length > 0
      ? frontmatter.title.trim()
      : file.basename)

    return {
      path: file.path,
      title,
      schemaVersion: parsedRecipe.schemaVersion,
      goal: parsedRecipe.goal,
      steps: parsedRecipe.steps,
      qualityChecks: parsedRecipe.qualityChecks,
      constraints: parsedRecipe.constraints,
      file,
    }
  }

  parseSteps(markdown: string): RecipeStep[] {
    return this.documentCodec.parse(markdown).steps
  }

  async saveRecipe(input: RecipeSaveInput): Promise<Recipe> {
    const title = input.title.trim()
    if (!title) {
      throw new Error('Recipe title is required')
    }
    const goal = input.goal?.trim() ?? ''
    const constraints = (input.constraints ?? []).map((constraint) => constraint.trim()).filter(Boolean)

    const resolvedExisting = input.path
      ? resolveExistingRecipeReference(input.path, this.getRecipeFolderPath(), this.plugin.app.vault)
      : undefined
    const path = resolvedExisting?.path ?? this.createUniqueRecipePath(title)
    await this.plugin.pathManager.ensureFolderExists(this.getRecipeFolderPath())
    const existing = resolvedExisting?.file ?? this.plugin.app.vault.getAbstractFileByPath(path)
    const existingContent = existing instanceof TFile ? await this.plugin.app.vault.read(existing) : undefined
    const existingDocument = existingContent === undefined ? undefined : this.documentCodec.parse(existingContent)
    const steps = normalizeItemInputs(input.steps, existingDocument?.steps ?? [], 'step') as RecipeStep[]
    const qualityChecks = normalizeItemInputs(
      input.qualityChecks ?? [],
      existingDocument?.qualityChecks ?? [],
      'quality',
    ) as RecipeQualityCheck[]
    if (goal.length === 0 && steps.length === 0 && qualityChecks.length === 0 && constraints.length === 0) {
      throw new Error('Recipe requires at least one content field')
    }

    const content = this.documentCodec.stringify(existingContent, {
      title,
      goal,
      steps,
      qualityChecks,
      constraints,
    })
    if (existing instanceof TFile) {
      await this.plugin.app.vault.modify(existing, content)
    } else {
      await this.plugin.app.vault.create(path, content)
    }
    return this.loadRecipe(path)
  }

  async deleteRecipe(path: string): Promise<void> {
    const { path: normalizedPath, file } = resolveExistingRecipeReference(
      path,
      this.getRecipeFolderPath(),
      this.plugin.app.vault,
    )
    await this.plugin.app.fileManager.trashFile(file)
    await this.unlinkRecipeFromTasks(normalizedPath)
  }

  hasRecipe(path: string | undefined): boolean {
    if (!path) return false
    try {
      resolveExistingRecipeReference(path, this.getRecipeFolderPath(), this.plugin.app.vault)
      return true
    } catch {
      return false
    }
  }

  findUsages(recipePath: string): Array<{ path: string; title: string }> {
    let normalizedRecipePath: string
    try {
      normalizedRecipePath = resolveRecipeReferenceInFolder(recipePath, this.getRecipeFolderPath())
    } catch {
      return []
    }
    const taskFolderPath = this.plugin.pathManager.getTaskFolderPath()
    return listFilesInFolder(this.plugin.app, taskFolderPath, { markdownOnly: true })
      .reduce<Array<{ path: string; title: string }>>((usages, file) => {
        const frontmatter = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter
        const taskRecipePath = normalizeRecipeReference(frontmatter?.recipe)
        if (taskRecipePath !== normalizedRecipePath) return usages
        const title = typeof frontmatter?.title === 'string' && frontmatter.title.trim().length > 0
          ? frontmatter.title.trim()
          : file.basename
        usages.push({ path: file.path, title })
        return usages
      }, [])
  }

  async assignRecipeToTask(taskPath: string, recipePath: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(taskPath)
    if (!(file instanceof TFile)) {
      throw new Error(`Task not found: ${taskPath}`)
    }
    const { path: normalizedRecipePath } = resolveExistingRecipeReference(
      recipePath,
      this.getRecipeFolderPath(),
      this.plugin.app.vault,
    )
    await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      frontmatter.recipe = createRecipeReferenceLink(normalizedRecipePath)
      return frontmatter
    })
    new Notice(t('recipes.select.notices.assigned', 'Recipe set'))
  }

  async unassignRecipeFromTask(taskPath: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(taskPath)
    if (!(file instanceof TFile)) {
      throw new Error(`Task not found: ${taskPath}`)
    }
    await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      delete frontmatter.recipe
    })
    new Notice(t('recipes.select.notices.unassigned', 'Recipe removed'))
  }

  private async unlinkRecipeFromTasks(recipePath: string): Promise<void> {
    let normalizedRecipePath: string
    try {
      normalizedRecipePath = resolveRecipeReferenceInFolder(recipePath, this.getRecipeFolderPath())
    } catch {
      return
    }
    const usages = this.findUsages(normalizedRecipePath)
    for (const usage of usages) {
      const file = this.plugin.app.vault.getAbstractFileByPath(usage.path)
      if (!(file instanceof TFile)) continue
      await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
        const currentRecipePath = normalizeRecipeReference(frontmatter.recipe)
        if (currentRecipePath === normalizedRecipePath) {
          delete frontmatter.recipe
        }
      })
    }
  }

  private createUniqueRecipePath(title: string): string {
    const base = this.getRecipeFolderPath()
    const fileBase = sanitizeFileName(title)
    let candidate = normalizePath(`${base}/${fileBase}.md`)
    let suffix = 2
    while (this.plugin.app.vault.getAbstractFileByPath(candidate)) {
      candidate = normalizePath(`${base}/${fileBase} ${suffix}.md`)
      suffix += 1
    }
    return candidate
  }
}
