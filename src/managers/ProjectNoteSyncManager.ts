import { App, TFile } from 'obsidian'
import { PathManager } from './PathManager'
import type { TaskInstance } from '../types'

type ParsedLogEntry = { lineIndex: number; content: string }
type ParsedLog = { date: string; lineIndex: number; entries: ParsedLogEntry[] }

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

  // コメントエントリをフォーマット
  formatCommentEntry(inst: TaskInstance, completionData: { executionComment: string }, dateString: string) {
    const wikilink = `[[${dateString}]]`
    const comment = completionData.executionComment || ''
    const formattedComment = comment
      .split('\n')
      .map((line) => `    - ${line}`)
      .join('\n')

    return {
      date: dateString,
      entry: `- ${wikilink}\n${formattedComment}`,
      instanceId: inst.instanceId,
    }
  }

  // 既存ログをパースして構造化
  parseExistingLogs(content: string, logSectionPosition: number): ParsedLog[] {
    const lines = content.substring(logSectionPosition).split('\n')
    const logs: ParsedLog[] = []
    let currentDate: string | null = null

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const dateMatch = line.match(/^-\s+\[\[(\d{4}-\d{2}-\d{2})\]\]/)
      if (dateMatch) {
        currentDate = dateMatch[1]
        logs.push({ date: currentDate, lineIndex: i, entries: [] })
        continue
      }

      if (currentDate && line.match(/^(\t| {4})-\s+/)) {
        const log = logs[logs.length - 1]
        log.entries.push({ lineIndex: i, content: line })
      }
    }

    return logs
  }

  // 既存日付の末尾の次の位置を求める
  findInsertPosition(content: string, existingDateLog: ParsedLog, sectionPos: number) {
    const logContent = content.substring(sectionPos)
    const logLines = logContent.split('\n')
    const lastEntryLine = existingDateLog.lineIndex + existingDateLog.entries.length + 1
    let relativePosition = 0
    for (let i = 0; i < lastEntryLine && i < logLines.length; i++) {
      relativePosition += logLines[i].length + 1
    }
    return sectionPos + relativePosition
  }

  // 日付の挿入位置を検出（降順）
  findDateInsertPosition(content: string, logs: ParsedLog[], newDate: string, sectionPos: number) {
    if (logs.length === 0) return sectionPos + 1

    for (let i = 0; i < logs.length; i++) {
      if (newDate > logs[i].date) {
        const logContent = content.substring(sectionPos)
        const logLines = logContent.split('\n')
        let relativePosition = 0
        for (let j = 0; j < logs[i].lineIndex && j < logLines.length; j++) {
          relativePosition += logLines[j].length + 1
        }
        return sectionPos + relativePosition
      }
    }

    // 最も古い日付の直後
    const lastLog = logs[logs.length - 1]
    return this.findInsertPosition(content, lastLog, sectionPos)
  }

  insertAtPosition(content: string, text: string, position: number) {
    return content.substring(0, position) + text + '\n' + content.substring(position)
  }

  formatDateString(date: Date) {
    const y = date.getFullYear()
    const m = (date.getMonth() + 1).toString().padStart(2, '0')
    const d = date.getDate().toString().padStart(2, '0')
    return `${y}-${m}-${d}`
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
    const entry = this.formatCommentEntry(inst, completionData, dateString)

    const logs = this.parseExistingLogs(content, sectionResult.position)
    const existingDateLog = logs.find((l) => l.date === dateString)

    if (existingDateLog) {
      const insertPos = this.findInsertPosition(content, existingDateLog, sectionResult.position)
      const commentOnly = entry.entry.split('\n').slice(1).join('\n')
      content = this.insertAtPosition(content, commentOnly, insertPos)
    } else {
      const insertPos = this.findDateInsertPosition(content, logs, dateString, sectionResult.position)
      const entryWithSpacing = logs.length > 0 ? `${entry.entry}\n` : entry.entry
      content = this.insertAtPosition(content, entryWithSpacing, insertPos)
    }

    await this.app.vault.modify(file, content)
    return true
  }
}
