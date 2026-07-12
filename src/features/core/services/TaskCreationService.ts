import { App, Notice, TFile } from 'obsidian'
import { t } from '../../../i18n'
import { generateTaskId } from '../../../services/TaskIdManager'
import type { AiTaskHost } from '../../ai-task/types'

interface PluginLike {
  app: App
  pathManager: {
    getTaskFolderPath(): string
    ensureFolderExists?: (path: string) => Promise<void>
  }
}

/**
 * AI-task payload of the add-task modal's AI mode (U3). The written note
 * must round-trip through readAiTaskConfig + extractPromptSection exactly as
 * entered: `ai_task: true` (strict boolean), the host verbatim, args as a
 * YAML block list of literal argv tokens, cwd only when non-empty, and the
 * prompt as the body of a "## Prompt" section after the H1 heading (an empty
 * prompt still writes the empty section — terminal runs open a plain REPL).
 */
export interface CreateTaskFileAiTaskOptions {
  host: AiTaskHost
  /** Flattened argv tokens (execution-mode flags + optional --model=<value>) */
  args?: string[]
  cwd?: string
  prompt: string
}

export interface CreateTaskFileOptions {
  taskId?: string
  basename?: string
  reminderTime?: string
  /** Present only when the add-task modal submitted in AI mode */
  aiTask?: CreateTaskFileAiTaskOptions
}

/** Escape a value for a YAML double-quoted scalar */
function toYamlQuoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export class TaskCreationService {
  private plugin: PluginLike

  constructor(plugin: PluginLike) {
    this.plugin = plugin
  }

  /**
   * Generate a unique markdown basename by appending (n) if needed.
   * Does not create files; only computes an available name.
   */
  ensureUniqueBasename(taskName: string): string {
    const taskFolderPath = this.plugin.pathManager.getTaskFolderPath()
    let fileName = taskName
    let counter = 1
    while (this.plugin.app.vault.getAbstractFileByPath(`${taskFolderPath}/${fileName}.md`)) {
      fileName = `${taskName} (${counter})`
      counter++
    }
    return fileName
  }

  /**
   * Create a task file with frontmatter and heading.
   * - Adds target_date frontmatter
   * - Adds scheduled_time if provided
   * - Keeps H1 heading as original taskName (basename may include suffix)
   * Returns the created TFile.
   */
  async createTaskFile(
    taskName: string,
    dateStr: string,
    scheduledTime?: string,
    options?: CreateTaskFileOptions,
  ): Promise<TFile> {
    const taskFolderPath = this.plugin.pathManager.getTaskFolderPath()
    // Ensure folder exists if the API is available
    if (typeof this.plugin.pathManager.ensureFolderExists === 'function') {
      await this.plugin.pathManager.ensureFolderExists(taskFolderPath)
    }

    const preferredBase = options?.basename?.trim()
    const uniqueBase = preferredBase && preferredBase.length > 0 ? preferredBase : this.ensureUniqueBasename(taskName)
    const filePath = `${taskFolderPath}/${uniqueBase}.md`

    const providedTaskId = options?.taskId?.trim()
    const taskId = providedTaskId && providedTaskId.length > 0 ? providedTaskId : generateTaskId()
    const frontmatterLines = [
      '---',
      `target_date: "${dateStr}"`,
      `taskId: "${taskId}"`,
      'tags:',
      '  - task',
    ]

    // Add scheduled_time if provided
    if (scheduledTime) {
      frontmatterLines.push(`scheduled_time: "${scheduledTime}"`)
    }
    if (options?.reminderTime) {
      frontmatterLines.push(`reminder_time: "${options.reminderTime}"`)
    }

    const aiTask = options?.aiTask
    if (aiTask) {
      frontmatterLines.push('ai_task: true')
      frontmatterLines.push(`ai_task_host: ${aiTask.host}`)
      if (aiTask.args && aiTask.args.length > 0) {
        frontmatterLines.push('ai_task_args:')
        for (const arg of aiTask.args) {
          frontmatterLines.push(`  - ${toYamlQuoted(arg)}`)
        }
      }
      const cwd = aiTask.cwd?.trim()
      if (cwd) {
        frontmatterLines.push(`ai_task_cwd: ${toYamlQuoted(cwd)}`)
      }
    }

    frontmatterLines.push('---')

    const bodyLines = ['', `# ${taskName}`, '']
    if (aiTask) {
      bodyLines.push('## Prompt', '')
      if (aiTask.prompt.length > 0) {
        bodyLines.push(aiTask.prompt, '')
      }
    }

    const content = [...frontmatterLines, ...bodyLines].join('\n')

    const file = await this.plugin.app.vault.create(filePath, content)
    new Notice(
      t('notices.taskCreated', 'Created task "{name}"', {
        name: taskName,
      }),
    )
    return file
  }
}
