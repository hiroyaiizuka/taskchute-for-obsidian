import { App, Notice, TFile } from 'obsidian'

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
   * - Keeps H1 heading as original taskName (basename may include suffix)
   * Returns the created TFile.
   */
  async createTaskFile(taskName: string, dateStr: string): Promise<TFile> {
    const taskFolderPath = this.plugin.pathManager.getTaskFolderPath()
    // Ensure folder exists if the API is available
    if (typeof this.plugin.pathManager.ensureFolderExists === 'function') {
      await this.plugin.pathManager.ensureFolderExists(taskFolderPath)
    }

    const uniqueBase = this.ensureUniqueBasename(taskName)
    const filePath = `${taskFolderPath}/${uniqueBase}.md`

    const content = [
      '---',
      `target_date: "${dateStr}"`,
      '---',
      '',
      '#task',
      '',
      `# ${taskName}`,
      '',
    ].join('\n')

    const file = await this.plugin.app.vault.create(filePath, content)
    new Notice(`タスク「${taskName}」を作成しました`)
    return file
  }
}

