import { App, Notice, TFile } from 'obsidian'
import { t } from '../i18n'

interface PluginLike {
  app: App
  pathManager: {
    getTaskFolderPath(): string
    ensureFolderExists?: (path: string) => Promise<void>
  }
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
  async createTaskFile(taskName: string, dateStr: string, scheduledTime?: string): Promise<TFile> {
    const taskFolderPath = this.plugin.pathManager.getTaskFolderPath()
    // Ensure folder exists if the API is available
    if (typeof this.plugin.pathManager.ensureFolderExists === 'function') {
      await this.plugin.pathManager.ensureFolderExists(taskFolderPath)
    }

    const uniqueBase = this.ensureUniqueBasename(taskName)
    const filePath = `${taskFolderPath}/${uniqueBase}.md`

    const frontmatterLines = [
      '---',
      `target_date: "${dateStr}"`,
    ]

    // Add scheduled_time if provided
    if (scheduledTime) {
      frontmatterLines.push(`scheduled_time: "${scheduledTime}"`)
    }

    frontmatterLines.push('---')

    const content = [
      ...frontmatterLines,
      '',
      '#task',
      '',
      `# ${taskName}`,
      '',
    ].join('\n')

    const file = await this.plugin.app.vault.create(filePath, content)
    new Notice(
      t('taskChuteView.notices.taskCreated', 'Created task "{name}"', {
        name: taskName,
      }),
    )
    return file
  }
}
