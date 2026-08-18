import type { App, TFile } from 'obsidian'
import type { CreateTaskFileAiTaskOptions } from '../../core/services/TaskCreationService'
import { getScheduledTime } from '../../../utils/fieldMigration'
import type { AiTaskHost } from '../types'
import { readAiTaskConfig } from './AiTaskFrontmatterReader'
import {
  EXACT_PROMPT_END_MARKER,
  EXACT_PROMPT_START_MARKER,
  extractPromptSection,
} from './PromptExtractor'
import { normalizeRecipeReference } from '../../recipe/services/RecipeService'
import {
  TaskRecipeAssignmentService,
  createRecipeReferenceLink,
} from '../../recipe/services/TaskRecipeAssignmentService'

export interface AiTaskEditValue {
  file: TFile
  taskName: string
  host: AiTaskHost
  args: string[]
  cwd?: string
  prompt: string
  scheduledTime?: string
  recipePath?: string
}

const FRONTMATTER_FENCE = /^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/u
const HASH_LEADING_PROMPT_LINE = /^ {0,3}\\*#/
const MANAGED_KEYS = new Set([
  'ai_task',
  'ai_task_host',
  'ai_task_args',
  'ai_task_cwd',
  'scheduled_time',
  '開始時刻',
])

/** Error used to avoid a destructive write when marker structure is corrupt. */
export class AiTaskPromptMarkersError extends Error {
  constructor(filePath: string) {
    super(`Cannot update AI task prompt because its markers are incomplete: ${filePath}`)
    this.name = 'AiTaskPromptMarkersError'
  }
}

function toYamlQuoted(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007F-\u009F\u2028\u2029]/gu,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

/** Symmetric counterpart of PromptExtractor's one-backslash unescape. */
function escapePromptLine(line: string): string {
  return HASH_LEADING_PROMPT_LINE.test(line)
    ? line.replace(/^( {0,3})/, '$1\\')
    : line
}

function lineEndingOf(content: string): '\r\n' | '\n' {
  return content.includes('\r\n') ? '\r\n' : '\n'
}

function parseTopLevelKey(line: string): string | null {
  if (/^[ \t#]/u.test(line)) return null
  const match = /^(?:"([^"]+)"|'([^']+)'|([^:#][^:]*?))[ \t]*:/u.exec(line)
  return (match?.[1] ?? match?.[2] ?? match?.[3])?.trim() ?? null
}

function findFrontmatterEnd(lines: string[]): number {
  if (lines.length === 0 || !FRONTMATTER_FENCE.test(lines[0])) return -1
  for (let index = 1; index < lines.length; index += 1) {
    if (/^---[ \t]*$/u.test(lines[index])) return index
  }
  return -1
}

/**
 * Remove managed root-level YAML entries while leaving every unrelated line
 * byte-for-byte intact. Indented continuation lines belong to the preceding
 * managed value (notably the ai_task_args block list) and are removed too.
 */
function stripManagedFrontmatterLines(
  lines: string[],
  managedKeys: ReadonlySet<string> = MANAGED_KEYS,
): {
  lines: string[]
  insertionIndex: number
} {
  const retained: string[] = []
  let insertionIndex = -1

  for (let index = 0; index < lines.length;) {
    const key = parseTopLevelKey(lines[index])
    if (!key || !managedKeys.has(key)) {
      retained.push(lines[index])
      index += 1
      continue
    }

    if (insertionIndex < 0) insertionIndex = retained.length
    index += 1
    while (index < lines.length) {
      const line = lines[index]
      if (/^[ \t]+\S/u.test(line)) {
        index += 1
        continue
      }
      if (/^[ \t]*$/u.test(line)) {
        let nextContent = index + 1
        while (nextContent < lines.length && /^[ \t]*$/u.test(lines[nextContent])) {
          nextContent += 1
        }
        if (nextContent < lines.length && /^[ \t]+\S/u.test(lines[nextContent])) {
          index = nextContent
          continue
        }
      }
      break
    }
  }

  return {
    lines: retained,
    insertionIndex: insertionIndex < 0 ? retained.length : insertionIndex,
  }
}

function buildManagedFrontmatterLines(
  scheduledTime: string | undefined,
  aiTask: CreateTaskFileAiTaskOptions,
  resolvedRecipePath: string | null | undefined,
): string[] {
  const lines = [
    'ai_task: true',
    `ai_task_host: ${aiTask.host}`,
  ]

  if (aiTask.args && aiTask.args.length > 0) {
    lines.push('ai_task_args:')
    for (const arg of aiTask.args) lines.push(`  - ${toYamlQuoted(arg)}`)
  }

  const cwd = aiTask.cwd?.trim()
  if (cwd) lines.push(`ai_task_cwd: ${toYamlQuoted(cwd)}`)

  const normalizedScheduledTime = scheduledTime?.trim()
  if (normalizedScheduledTime) {
    lines.push(`scheduled_time: ${toYamlQuoted(normalizedScheduledTime)}`)
  }
  if (typeof resolvedRecipePath === 'string') {
    lines.push(
      `recipe: ${toYamlQuoted(createRecipeReferenceLink(resolvedRecipePath))}`,
    )
  }

  return lines
}

function updateFrontmatter(
  content: string,
  scheduledTime: string | undefined,
  aiTask: CreateTaskFileAiTaskOptions,
  resolvedRecipePath: string | null | undefined,
): string {
  const newline = lineEndingOf(content)
  const lines = content.split(/\r?\n/u)
  const endIndex = findFrontmatterEnd(lines)
  const managed = buildManagedFrontmatterLines(
    scheduledTime,
    aiTask,
    resolvedRecipePath,
  )

  if (endIndex < 0) {
    return ['---', ...managed, '---', '', ...lines].join(newline)
  }

  const managedKeys = new Set(MANAGED_KEYS)
  if (resolvedRecipePath !== undefined) managedKeys.add('recipe')
  const frontmatter = stripManagedFrontmatterLines(
    lines.slice(1, endIndex),
    managedKeys,
  )
  frontmatter.lines.splice(frontmatter.insertionIndex, 0, ...managed)
  return [
    lines[0],
    ...frontmatter.lines,
    lines[endIndex],
    ...lines.slice(endIndex + 1),
  ].join(newline)
}

function promptLines(prompt: string): string[] {
  if (prompt.length === 0) return []
  return prompt.split(/\r?\n/u).map(escapePromptLine)
}

function findLine(lines: string[], value: string): number {
  return lines.findIndex((line) => line === value)
}

/**
 * Replace only the exact generated marker body. Legacy notes get a marked
 * block inserted after their Prompt heading while their old body is retained
 * as unknown/custom Markdown. Notes without a Prompt heading get one appended.
 */
function updatePrompt(content: string, prompt: string, filePath: string): string {
  const newline = lineEndingOf(content)
  const lines = content.split(/\r?\n/u)
  const startIndex = findLine(lines, EXACT_PROMPT_START_MARKER)
  const endIndexes = lines
    .map((line, index) => line === EXACT_PROMPT_END_MARKER ? index : -1)
    .filter((index) => index >= 0)
  const endIndex = endIndexes.find((index) => index > startIndex) ?? -1

  if ((startIndex >= 0) !== (endIndex >= 0)) {
    throw new AiTaskPromptMarkersError(filePath)
  }

  const escapedPrompt = promptLines(prompt)
  if (startIndex >= 0) {
    lines.splice(startIndex + 1, endIndex - startIndex - 1, ...escapedPrompt)
    return lines.join(newline)
  }

  const promptHeadingIndex = lines.findIndex((line) =>
    /^##[ \t]+prompt[ \t]*#*[ \t]*$/iu.test(line),
  )
  const markedBlock = [
    EXACT_PROMPT_START_MARKER,
    ...escapedPrompt,
    EXACT_PROMPT_END_MARKER,
  ]

  if (promptHeadingIndex >= 0) {
    lines.splice(promptHeadingIndex + 1, 0, ...markedBlock)
    return lines.join(newline)
  }

  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('')
  lines.push('## Prompt', '', ...markedBlock)
  return lines.join(newline)
}

export class AiTaskEditService {
  constructor(
    private readonly app: App,
    private readonly recipeAssignments?: TaskRecipeAssignmentService,
  ) {}

  async load(
    file: TFile,
    frontmatter: Record<string, unknown>,
    taskName: string,
  ): Promise<AiTaskEditValue | null> {
    const config = readAiTaskConfig(frontmatter)
    if (!config) return null

    let content: string
    try {
      content = await this.app.vault.cachedRead(file)
    } catch {
      content = await this.app.vault.read(file)
    }

    const recipePath = normalizeRecipeReference(frontmatter.recipe)
    return {
      file,
      taskName,
      host: config.host,
      args: [...config.args],
      cwd: config.cwd,
      prompt: extractPromptSection(content) ?? '',
      scheduledTime: getScheduledTime(frontmatter),
      ...(recipePath ? { recipePath } : {}),
    }
  }

  async save(
    file: TFile,
    scheduledTime: string | undefined,
    aiTask: CreateTaskFileAiTaskOptions,
  ): Promise<void> {
    const resolvedRecipePath = aiTask.recipePath === undefined
      ? undefined
      : this.recipeAssignments?.resolve({ recipePath: aiTask.recipePath })
    if (aiTask.recipePath !== undefined && !this.recipeAssignments) {
      throw new Error('Recipe assignment service is unavailable')
    }
    const original = await this.app.vault.read(file)
    const withFrontmatter = updateFrontmatter(
      original,
      scheduledTime,
      aiTask,
      resolvedRecipePath,
    )
    const updated = updatePrompt(withFrontmatter, aiTask.prompt, file.path)
    if (updated === original) return
    await this.app.vault.modify(file, updated)
  }
}
