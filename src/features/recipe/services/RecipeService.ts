import { Notice, TFile, normalizePath } from 'obsidian'
import type { TaskChutePluginLike, TaskInstance } from '../../../types'
import { t } from '../../../i18n'

export interface RecipeStep {
  id: string
  text: string
}

export interface Recipe {
  path: string
  title: string
  steps: RecipeStep[]
  file: TFile
}

export interface RecipeSaveInput {
  path?: string
  title: string
  steps: string[]
}

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

function quoteYamlString(value: string): string {
  return JSON.stringify(value)
}

function extractTitleFromRawFrontmatter(markdown: string): string | undefined {
  const frontmatterMatch = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)
  if (!frontmatterMatch) return undefined
  const frontmatter = frontmatterMatch[1]
  for (const line of frontmatter.split(/\r?\n/u)) {
    const titleMatch = line.match(/^\s*title\s*:\s*(.*?)\s*$/u)
    if (!titleMatch) continue
    const rawTitle = titleMatch[1].trim()
    if (!rawTitle) return undefined
    if (rawTitle.startsWith('"')) {
      try {
        const parsed = JSON.parse(rawTitle) as unknown
        return typeof parsed === 'string' && parsed.trim().length > 0 ? parsed.trim() : undefined
      } catch {
        return rawTitle.replace(/^"|"$/gu, '').trim() || undefined
      }
    }
    if (rawTitle.startsWith("'") && rawTitle.endsWith("'")) {
      return rawTitle.slice(1, -1).replace(/''/gu, "'").trim() || undefined
    }
    return rawTitle.trim()
  }
  return undefined
}

export function normalizeRecipeReference(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  if (!raw) return undefined
  const wikilink = raw.match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/u)
  const path = wikilink ? wikilink[1].trim() : raw
  if (!path) return undefined
  return normalizePath(path.endsWith('.md') ? path : `${path}.md`)
}

export function createRecipeProgressKey(instanceId: string, recipePath: string): string {
  return `${instanceId}::${recipePath}`
}

function createRecipeReferenceLink(recipePath: string): string {
  return `[[${recipePath}]]`
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

function createRecipeStepIdForOccurrence(text: string, occurrenceIndex: number): string {
  const baseId = createRecipeStepId(0, text)
  return occurrenceIndex === 0 ? baseId : `${baseId}-${occurrenceIndex + 1}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

export class RecipeService {
  constructor(private readonly plugin: TaskChutePluginLike) {}

  getRecipeFolderPath(): string {
    return this.plugin.pathManager.getRecipeFolderPath?.() ?? normalizePath('TaskChute/Recipes')
  }

  async loadRecipes(): Promise<Recipe[]> {
    const folderPath = this.getRecipeFolderPath()
    const files = this.plugin.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(`${folderPath}/`))
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
    const normalizedPath = normalizeRecipeReference(path) ?? normalizePath(path)
    const file = this.plugin.app.vault.getAbstractFileByPath(normalizedPath)
    if (!(file instanceof TFile)) {
      throw new Error(`Recipe not found: ${normalizedPath}`)
    }

    const raw = await this.plugin.app.vault.read(file)
    const frontmatter = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined
    const rawTitle = extractTitleFromRawFrontmatter(raw)
    const title = rawTitle
      ?? (typeof frontmatter?.title === 'string' && frontmatter.title.trim().length > 0
      ? frontmatter.title.trim()
      : file.basename)

    return {
      path: file.path,
      title,
      steps: this.parseSteps(raw),
      file,
    }
  }

  parseSteps(markdown: string): RecipeStep[] {
    const steps: RecipeStep[] = []
    const occurrenceByText = new Map<string, number>()
    const lines = markdown.split(/\r?\n/u)
    for (const line of lines) {
      const match = line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/u)
      if (!match) continue
      const text = match[1].trim()
      if (!text) continue
      const occurrenceIndex = occurrenceByText.get(text) ?? 0
      occurrenceByText.set(text, occurrenceIndex + 1)
      steps.push({
        id: createRecipeStepIdForOccurrence(text, occurrenceIndex),
        text,
      })
    }
    return steps
  }

  async saveRecipe(input: RecipeSaveInput): Promise<Recipe> {
    const title = input.title.trim()
    if (!title) {
      throw new Error('Recipe title is required')
    }
    const steps = input.steps.map((step) => step.trim()).filter((step) => step.length > 0)
    if (steps.length === 0) {
      throw new Error('Recipe requires at least one step')
    }

    await this.plugin.pathManager.ensureFolderExists(this.getRecipeFolderPath())
    const path = input.path ? normalizePath(input.path) : this.createUniqueRecipePath(title)
    const content = [
      '---',
      'taskchute_recipe: true',
      `title: ${quoteYamlString(title)}`,
      '---',
      '',
      ...steps.map((step) => `- [ ] ${step}`),
      '',
    ].join('\n')

    const existing = this.plugin.app.vault.getAbstractFileByPath(path)
    if (existing instanceof TFile) {
      await this.plugin.app.vault.modify(existing, content)
    } else {
      await this.plugin.app.vault.create(path, content)
    }
    return this.loadRecipe(path)
  }

  async deleteRecipe(path: string): Promise<void> {
    const normalizedPath = normalizeRecipeReference(path) ?? normalizePath(path)
    const file = this.plugin.app.vault.getAbstractFileByPath(normalizedPath)
    if (!(file instanceof TFile)) {
      throw new Error(`Recipe not found: ${normalizedPath}`)
    }
    await this.plugin.app.fileManager.trashFile(file)
    await this.unlinkRecipeFromTasks(normalizedPath)
  }

  hasRecipe(path: string | undefined): boolean {
    if (!path) return false
    const normalizedPath = normalizeRecipeReference(path) ?? normalizePath(path)
    return this.plugin.app.vault.getAbstractFileByPath(normalizedPath) instanceof TFile
  }

  findUsages(recipePath: string): Array<{ path: string; title: string }> {
    const normalizedRecipePath = normalizeRecipeReference(recipePath)
    if (!normalizedRecipePath) return []
    const taskFolderPath = this.plugin.pathManager.getTaskFolderPath()
    return this.plugin.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(`${taskFolderPath}/`))
      .reduce<Array<{ path: string; title: string }>>((usages, file) => {
        const frontmatter = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined
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
    const normalizedRecipePath = normalizeRecipeReference(recipePath)
    if (!normalizedRecipePath) {
      throw new Error('Recipe path is required')
    }
    await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      frontmatter.recipe = createRecipeReferenceLink(normalizedRecipePath)
      return frontmatter
    })
    new Notice(t('recipes.select.notices.assigned', 'レシピを設定しました'))
  }

  private async unlinkRecipeFromTasks(recipePath: string): Promise<void> {
    const normalizedRecipePath = normalizeRecipeReference(recipePath)
    if (!normalizedRecipePath) return
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
