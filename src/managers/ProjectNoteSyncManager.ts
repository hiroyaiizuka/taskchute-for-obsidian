import { App, TFile } from 'obsidian'
import { PathManager } from './PathManager'
import type { TaskInstance } from '../types'

/**
 * Syncs task comments to related project notes' log section.
 * Behavior mirrors the runtime logic in compiled main.js.
 */
export class ProjectNoteSyncManager {
  private app: App
  private pathManager: PathManager

  constructor(app: App, pathManager: PathManager) {
    this.app = app
    this.pathManager = pathManager
  }

  // プロジェクトノートパスを取得
  async getProjectNotePath(inst: TaskInstance): Promise<string | null> {
    if (!inst?.task?.projectPath && !inst?.task?.projectTitle) return null

    if (inst.task.projectPath) {
      return inst.task.projectPath
    }

    const projectFolderPath = this.pathManager.getProjectFolderPath()
    const projectPath = `${projectFolderPath}/${inst.task.projectTitle}.md`
    const file = this.app.vault.getAbstractFileByPath(projectPath)
    return file ? projectPath : null
  }

  // ログセクションを検出または作成
  async ensureLogSection(content: string): Promise<{ exists: boolean; position: number; content: string }> {
    // #ログ、##ログ、# Log、## Log などのバリエーションに対応
    const logSectionRegex = /^#{1,2}\s+(ログ|log|Log|LOG)\s*$/im
    const match = content.match(logSectionRegex)

    if (match && typeof match.index === 'number') {
      return {
        exists: true,
        position: match.index + match[0].length,
        content,
      }
    }

    const newContent = content.trimEnd() + "\n\n## ログ\n"
    return {
      exists: false,
      position: newContent.length,
      content: newContent,
    }
  }

  formatDateString(date: Date) {
    const y = date.getFullYear()
    const m = (date.getMonth() + 1).toString().padStart(2, '0')
    const d = date.getDate().toString().padStart(2, '0')
    return `${y}-${m}-${d}`
  }

  private resolveTaskDisplayTitle(inst: TaskInstance): string {
    const candidates = [inst.task.displayTitle, inst.executedTitle, inst.task.name]
    for (const candidate of candidates) {
      if (typeof candidate === 'string') {
        const trimmed = candidate.trim()
        if (trimmed.length > 0) {
          return trimmed
        }
      }
    }
    return 'Untitled Task'
  }

  private splitLogSection(content: string, sectionPos: number) {
    const before = content.substring(0, sectionPos)
    const rest = content.substring(sectionPos)
    const nextHeadingMatch = rest.match(/^#{1,6}\s+/m)

    if (!nextHeadingMatch || typeof nextHeadingMatch.index !== 'number') {
      return { before, body: rest, after: '' }
    }

    const body = rest.substring(0, nextHeadingMatch.index)
    const after = rest.substring(nextHeadingMatch.index)
    return { before, body, after }
  }

  private buildTaskLine(taskTitle: string) {
    return `    - ${taskTitle}`
  }

  private formatCommentLines(raw: string) {
    const source = typeof raw === 'string' ? raw : ''
    const lines = source.split('\n')
    if (lines.length === 0) {
      return ['        - ']
    }
    return lines.map((line) => `        - ${line}`)
  }

  private isTaskLine(line: string) {
    return /^(?:\t| {4})-\s+/.test(line)
  }

  private isCommentLine(line: string) {
    return /^(?:\t{2}| {8})-\s+/.test(line)
  }

  private extractTaskTitle(line: string) {
    const match = line.match(/^(?:\t| {4})-\s+(.*)$/)
    return match ? match[1] : line.trim()
  }

  private normalizeTaskTitle(title: string) {
    return title.replace(/\s+/g, ' ').trim()
  }

  private updateDateBlock(original: string, taskTitle: string, commentLines: string[]) {
    const lines = original.split('\n')
    const normalizedTarget = this.normalizeTaskTitle(taskTitle)
    const updatedLines: string[] = []
    let index = 0
    let replaced = false

    while (index < lines.length) {
      const line = lines[index]

      if (this.isTaskLine(line)) {
        const currentTitle = this.normalizeTaskTitle(this.extractTaskTitle(line))
        if (!replaced && currentTitle === normalizedTarget) {
          updatedLines.push(this.buildTaskLine(taskTitle))
          index += 1
          while (index < lines.length && this.isCommentLine(lines[index])) {
            index += 1
          }
          updatedLines.push(...commentLines)
          replaced = true
          continue
        }
      }

      updatedLines.push(line)
      index += 1
    }

    if (!replaced) {
      let trailingBlankCount = 0
      for (let i = updatedLines.length - 1; i >= 0; i--) {
        if (updatedLines[i].trim().length === 0) {
          trailingBlankCount += 1
        } else {
          break
        }
      }

      const trailingBlanks = trailingBlankCount > 0
        ? updatedLines.splice(updatedLines.length - trailingBlankCount, trailingBlankCount)
        : []

      updatedLines.push(this.buildTaskLine(taskTitle))
      updatedLines.push(...commentLines)
      updatedLines.push(...trailingBlanks)
    }

    return updatedLines.join('\n').trimEnd()
  }

  private buildDateBlock(dateString: string, taskTitle: string, commentLines: string[]) {
    const lines = [`- [[${dateString}]]`, this.buildTaskLine(taskTitle), ...commentLines]
    return lines.join('\n')
  }

  private upsertLogEntry(logBody: string, dateString: string, taskTitle: string, commentLines: string[]) {
    const leadingWhitespaceMatch = logBody.match(/^\s*/)
    const leadingWhitespace = leadingWhitespaceMatch ? leadingWhitespaceMatch[0] : ''
    const core = logBody.slice(leadingWhitespace.length).trim()

    const blocks: Array<{ date: string; text: string }> = []
    if (core.length > 0) {
      const blockRegex = /- \[\[(\d{4}-\d{2}-\d{2})\]\][\s\S]*?(?=- \[\[\d{4}-\d{2}-\d{2}\]\]|$)/g
      let match: RegExpExecArray | null
      while ((match = blockRegex.exec(core)) !== null) {
        const [text, date] = match
        blocks.push({ date, text: text.trimEnd() })
      }
    }

    if (blocks.length === 0) {
      const newBlock = this.buildDateBlock(dateString, taskTitle, commentLines)
      return `${leadingWhitespace}${newBlock}\n`
    }

    const existingIndex = blocks.findIndex((block) => block.date === dateString)

    if (existingIndex >= 0) {
      const updatedBlock = this.updateDateBlock(blocks[existingIndex].text, taskTitle, commentLines)
      blocks[existingIndex].text = updatedBlock.trimEnd()
    } else {
      const newBlock = this.buildDateBlock(dateString, taskTitle, commentLines)
      let insertIndex = blocks.findIndex((block) => dateString > block.date)
      if (insertIndex < 0) {
        insertIndex = blocks.length
      }
      blocks.splice(insertIndex, 0, { date: dateString, text: newBlock })
    }

    const normalizedBlocks = blocks.map((block) => block.text.trimEnd())
    const joined = normalizedBlocks
      .map((block, index) => {
        const separator = index < normalizedBlocks.length - 1 ? '\n\n' : '\n'
        return `${block}${separator}`
      })
      .join('')

    return `${leadingWhitespace}${joined}`
  }

  // プロジェクトノートを更新
  async updateProjectNote(projectPath: string, inst: TaskInstance, completionData: { executionComment: string }) {
    const file = this.app.vault.getAbstractFileByPath(projectPath)
    if (!file || !(file instanceof TFile)) {
      throw new Error(`プロジェクトノートが見つかりません: ${projectPath}`)
    }

    let content = await this.app.vault.read(file)
    const sectionResult = await this.ensureLogSection(content)
    content = sectionResult.content

    const taskDate = inst.startTime ? new Date(inst.startTime) : new Date()
    const dateString = this.formatDateString(taskDate)
    const taskTitle = this.resolveTaskDisplayTitle(inst)
    const commentLines = this.formatCommentLines(completionData.executionComment)

    const { before, body, after } = this.splitLogSection(content, sectionResult.position)
    const updatedBody = this.upsertLogEntry(body, dateString, taskTitle, commentLines)
    const updatedContent = `${before}${updatedBody}${after}`

    await this.app.vault.modify(file, updatedContent)
    return true
  }
}
