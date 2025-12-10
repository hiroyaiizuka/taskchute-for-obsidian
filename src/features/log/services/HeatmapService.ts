import { App, TFile, normalizePath, parseYaml } from 'obsidian'
import { t } from '../../../i18n'
import { LOG_HEATMAP_FOLDER, LOG_HEATMAP_LEGACY_FOLDER } from '../constants'
import {
  HeatmapDayDetail,
  HeatmapDayStats,
  HeatmapExecutionDetail,
  HeatmapYearData,
} from '../../../types'
import { computeExecutionInstanceKey } from '../../../utils/logKeys'

type NormalizedSummary = { totalTasks: number; completedTasks: number }
type DailySummaryMap = Record<string, NormalizedSummary>
type TaskExecutionsMap = Record<string, Record<string, unknown>[]>

interface MonthlyLogData {
  dailySummary: DailySummaryMap
  taskExecutions: TaskExecutionsMap
}

type RawMonthlyLog = {
  dailySummary?: Record<string, unknown>
  taskExecutions?: Record<string, unknown[]>
  [key: string]: unknown
}

const createEmptyMonthlyLog = (): MonthlyLogData => ({
  dailySummary: {},
  taskExecutions: {},
})

export interface HeatmapServicePluginLike {
  app: App
  pathManager: {
    getLogDataPath(): string
    getLogYearPath(year: number | string): string
    ensureYearFolder(year: number | string): Promise<string>
    ensureFolderExists(path: string): Promise<void>
    getReviewDataPath(): string
  }
  settings?: {
    reviewFileNamePattern?: string
  }
}

function replaceDateTokens(template: string, dateStr: string): string {
  const [year = '', month = '', day = ''] = dateStr.split('-')
  return template
    .replaceAll('{{date}}', dateStr)
    .replaceAll('{{year}}', year)
    .replaceAll('{{month}}', month)
    .replaceAll('{{day}}', day)
}

export class HeatmapService {
  private plugin: HeatmapServicePluginLike

  constructor(plugin: HeatmapServicePluginLike) {
    this.plugin = plugin
  }

  private getHeatmapBaseFolder(): string {
    const logBase = this.plugin.pathManager.getLogDataPath()
    return normalizePath(`${logBase}/${LOG_HEATMAP_FOLDER}`)
  }

  private getModernHeatmapFolder(year: number | string): string {
    return normalizePath(`${this.getHeatmapBaseFolder()}/${year}`)
  }

  private getModernHeatmapFile(year: number | string): string {
    return normalizePath(`${this.getModernHeatmapFolder(year)}/yearly-heatmap.json`)
  }

  private getHiddenLegacyHeatmapFile(year: number | string): string {
    const logBase = this.plugin.pathManager.getLogDataPath()
    return normalizePath(`${logBase}/${LOG_HEATMAP_LEGACY_FOLDER}/${year}/yearly-heatmap.json`)
  }

  private getLegacyHeatmapFile(year: number | string): string {
    const yearPath = this.plugin.pathManager.getLogYearPath(year)
    return normalizePath(`${yearPath}/yearly-heatmap.json`)
  }

  private async ensureModernHeatmapFolder(year: number | string): Promise<string> {
    const base = this.getHeatmapBaseFolder()
    await this.plugin.pathManager.ensureFolderExists(base)
    const folder = this.getModernHeatmapFolder(year)
    await this.plugin.pathManager.ensureFolderExists(folder)
    return folder
  }

  private async readHeatmapFile(path: string): Promise<HeatmapYearData | null> {
    if (!path) return null
    const file = this.plugin.app.vault.getAbstractFileByPath(path)
    if (!file || !(file instanceof TFile)) {
      return null
    }
    try {
      const content = await this.plugin.app.vault.read(file)
      const data = JSON.parse(content) as HeatmapYearData
      if (!data || typeof data !== 'object' || typeof data.year !== 'number' || !data.days) {
        return null
      }
      return data
    } catch {
      return null
    }
  }

  private async loadExistingYearlyData(year: number): Promise<HeatmapYearData | null> {
    const modern = await this.readHeatmapFile(this.getModernHeatmapFile(year))
    if (modern) {
      return modern
    }
    const hiddenLegacy = await this.readHeatmapFile(this.getHiddenLegacyHeatmapFile(year))
    if (hiddenLegacy) {
      await this.persistYearlyData(year, hiddenLegacy)
      return hiddenLegacy
    }
    const legacy = await this.readHeatmapFile(this.getLegacyHeatmapFile(year))
    if (legacy) {
      await this.persistYearlyData(year, legacy)
      return legacy
    }
    return null
  }

  private async persistYearlyData(year: number, yearlyData: HeatmapYearData): Promise<void> {
    const folder = await this.ensureModernHeatmapFolder(year)
    const targetPath = normalizePath(`${folder}/yearly-heatmap.json`)
    const file = this.plugin.app.vault.getAbstractFileByPath(targetPath)
    const content = JSON.stringify(yearlyData, null, 2)
    if (file && file instanceof TFile) {
      await this.plugin.app.vault.modify(file, content)
    } else {
      await this.plugin.app.vault.create(targetPath, content)
    }
  }

  private toNumber(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    if (typeof value === 'string') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
    return 0
  }

  private normalizeTaskExecutions(value: unknown): Record<string, unknown>[] {
    if (!Array.isArray(value)) {
      return []
    }
    return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
  }

  private normalizeMonthlyLog(raw: unknown): MonthlyLogData {
    const output: MonthlyLogData = createEmptyMonthlyLog()
    if (!raw || typeof raw !== 'object') {
      return output
    }

    const record = raw as Record<string, unknown>
    if (record.dailySummary && typeof record.dailySummary === 'object') {
      for (const [date, value] of Object.entries(record.dailySummary as Record<string, unknown>)) {
        const summarySource = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
        output.dailySummary[date] = {
          totalTasks: this.toNumber(summarySource.totalTasks),
          completedTasks: this.toNumber(summarySource.completedTasks),
        }
      }
    }

    if (record.taskExecutions && typeof record.taskExecutions === 'object') {
      for (const [date, value] of Object.entries(record.taskExecutions as Record<string, unknown>)) {
        output.taskExecutions[date] = this.normalizeTaskExecutions(value)
      }
    }

    return output
  }

  async loadYearlyData(year: number): Promise<HeatmapYearData> {
    const existing = await this.loadExistingYearlyData(year)
    if (existing) {
      return existing
    }
    return await this.generateYearlyData(year)
  }

  async generateYearlyData(year: number): Promise<HeatmapYearData> {
    const yearlyData: HeatmapYearData = {
      year,
      days: {},
      metadata: {
        version: '1.0',
        lastUpdated: new Date().toISOString(),
      },
    }

    try {
      for (let month = 1; month <= 12; month++) {
        const monthString = `${year}-${String(month).padStart(2, '0')}`
        const logDataPath = this.plugin.pathManager.getLogDataPath()
        const logFilePath = normalizePath(`${logDataPath}/${monthString}-tasks.json`)

        const file = this.plugin.app.vault.getAbstractFileByPath(logFilePath)
        if (!file || !(file instanceof TFile)) continue

        const content = await this.plugin.app.vault.read(file)
        let raw: RawMonthlyLog
        try {
          raw = JSON.parse(content) as RawMonthlyLog
        } catch {
          continue
        }

        const monthlyData = this.normalizeMonthlyLog(raw)
        const summaryRecord = this.ensureDailySummaryRecord(raw)
        const dateKeys = new Set([
          ...Object.keys(monthlyData.dailySummary),
          ...Object.keys(monthlyData.taskExecutions),
        ])

        let monthlyChanged = false

        for (const dateString of dateKeys) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) continue

          const dayTasks = monthlyData.taskExecutions[dateString] ?? []
          const hasExecutions = dayTasks.length > 0
          const computedStats = hasExecutions
            ? this.calculateDailyStats(dayTasks)
            : null
          const previousSummary = monthlyData.dailySummary[dateString]

          const prevSummaryTotal = previousSummary?.totalTasks ?? 0
          const prevSummaryCompleted = previousSummary?.completedTasks ?? 0

          const executionTotal = computedStats?.totalTasks ?? 0
          const executionCompleted = computedStats?.completedTasks ?? 0

          const completedTasks = hasExecutions
            ? executionCompleted
            : prevSummaryCompleted
          const totalTasks = Math.max(
            prevSummaryTotal,
            hasExecutions ? executionTotal : 0,
            completedTasks,
          )
          const procrastinatedTasks = Math.max(0, totalTasks - completedTasks)
          const completionRate = totalTasks > 0 ? completedTasks / totalTasks : 0

          if (
            !previousSummary ||
            previousSummary.totalTasks !== totalTasks ||
            previousSummary.completedTasks !== completedTasks
          ) {
            monthlyChanged = true
          }
          monthlyData.dailySummary[dateString] = { totalTasks, completedTasks }

          const existingSummarySource = summaryRecord[dateString]
          const summarySource =
            existingSummarySource && typeof existingSummarySource === 'object'
              ? (existingSummarySource)
              : {}

          const prevTotal = this.toNumber(summarySource.totalTasks)
          const prevCompleted = this.toNumber(summarySource.completedTasks)
          const prevProcrastinated = this.toNumber(summarySource.procrastinatedTasks)
          const prevCompletionRate = this.toNumber(summarySource.completionRate)
          const prevMinutes = this.toNumber(summarySource.totalMinutes)

          const computedMinutes = this.calculateMinutesFromTasks(dayTasks)
          const totalMinutes = computedMinutes > 0 ? computedMinutes : prevMinutes

          if (
            prevTotal !== totalTasks ||
            prevCompleted !== completedTasks ||
            prevProcrastinated !== procrastinatedTasks ||
            Math.abs(prevCompletionRate - completionRate) > 1e-6 ||
            (totalMinutes > 0 && prevMinutes !== totalMinutes) ||
            !existingSummarySource
          ) {
            monthlyChanged = true
          }

          summaryRecord[dateString] = {
            ...summarySource,
            totalMinutes,
            totalTasks,
            completedTasks,
            procrastinatedTasks,
            completionRate,
          }

          if (
            dateString.startsWith(`${year}-`) &&
            !this.isFutureDate(dateString)
          ) {
            yearlyData.days[dateString] = {
              totalTasks,
              completedTasks,
              procrastinatedTasks,
              completionRate,
            }
          }
        }

        if (monthlyChanged) {
          await this.plugin.app.vault.modify(file, JSON.stringify(raw, null, 2))
        }
      }

      // Save generated file
      await this.persistYearlyData(year, yearlyData)
    } catch {
      // ignore generation errors; return current yearlyData (may be partial)
    }

    return yearlyData
  }

  async loadDayDetail(dateString: string): Promise<HeatmapDayDetail | null> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
      return null
    }
    if (this.isFutureDate(dateString)) {
      return null
    }

    const raw = await this.readMonthlyLog(dateString)
    const monthlyData = raw ? this.normalizeMonthlyLog(raw) : createEmptyMonthlyLog()
    const dayTasks = monthlyData.taskExecutions[dateString] ?? []
    const normalizedSummary = monthlyData.dailySummary[dateString]

    const summaryRecord = raw
      ? this.ensureDailySummaryRecord(raw)
      : ({} as Record<string, Record<string, unknown>>)
    const summarySource = summaryRecord[dateString]
    const fallbackStats = this.calculateDailyStats(dayTasks)

    let totalTasks = this.readNumeric(summarySource, 'totalTasks')
    if (totalTasks === null && normalizedSummary) {
      totalTasks = normalizedSummary.totalTasks
    }
    if (totalTasks === null) {
      totalTasks = fallbackStats.totalTasks
    }

    let completedTasks = this.readNumeric(summarySource, 'completedTasks')
    if (completedTasks === null && normalizedSummary) {
      completedTasks = normalizedSummary.completedTasks
    }
    if (completedTasks === null) {
      completedTasks = fallbackStats.completedTasks
    }

    let totalMinutes = this.readNumeric(summarySource, 'totalMinutes')
    if (totalMinutes === null || totalMinutes < 0) {
      totalMinutes = this.calculateMinutesFromTasks(dayTasks)
    }

    let procrastinatedTasks = this.readNumeric(summarySource, 'procrastinatedTasks')
    if (procrastinatedTasks === null) {
      procrastinatedTasks = Math.max(0, totalTasks - completedTasks)
    }

    let completionRate = this.readNumeric(summarySource, 'completionRate')
    if (completionRate === null) {
      completionRate = totalTasks > 0 ? completedTasks / totalTasks : 0
    } else {
      completionRate = Math.min(1, Math.max(0, completionRate))
    }

    const avgFocusLevel = this.computeAverageRating(dayTasks, ['focusLevel', 'focus'])
    const avgEnergyLevel = this.computeAverageRating(dayTasks, ['energyLevel', 'energy'])

    const sortedTasks = [...dayTasks].sort((a, b) => this.compareTaskEntries(a, b))
    const executions: HeatmapExecutionDetail[] = sortedTasks.map((task) =>
      this.mapExecutionDetail(task),
    )

    const satisfaction = await this.loadSatisfaction(dateString)

    return {
      date: dateString,
      satisfaction,
      summary: {
        totalTasks,
        completedTasks,
        totalMinutes,
        procrastinatedTasks,
        completionRate,
        avgFocusLevel,
        avgEnergyLevel,
      },
      executions,
    }
  }

  calculateDailyStats(dayTasks: Array<Record<string, unknown>>): HeatmapDayStats {
    const map = new Map<string, boolean>()
    for (const task of dayTasks) {
      const key = computeExecutionInstanceKey(task)
      if (!map.has(key)) map.set(key, false)
      if (this.isTaskCompleted(task)) map.set(key, true)
    }

    const totalTasks = map.size
    const completedTasks = Array.from(map.values()).filter(Boolean).length
    return {
      totalTasks,
      completedTasks,
      procrastinatedTasks: Math.max(0, totalTasks - completedTasks),
      completionRate: totalTasks > 0 ? completedTasks / totalTasks : 0,
    }
  }

  async updateDailyStats(dateString: string): Promise<HeatmapDayStats | null> {
    try {
      if (this.isFutureDate(dateString)) {
        await this.removeYearlyDateEntry(dateString)
        return null
      }
      const monthly = await this.loadMonthlyData(dateString)
      const dayTasks = monthly.taskExecutions[dateString] ?? []
      const stats = this.calculateDailyStats(dayTasks)
      await this.updateYearlyData(dateString, stats)
      return stats
    } catch {
      return null
    }
  }

  private mapExecutionDetail(task: Record<string, unknown>): HeatmapExecutionDetail {
    const duration = this.getDurationSeconds(task)
    const focus = this.readNumeric(task, 'focusLevel') ?? this.readNumeric(task, 'focus')
    const energy = this.readNumeric(task, 'energyLevel') ?? this.readNumeric(task, 'energy')

    return {
      id: computeExecutionInstanceKey(task),
      title: this.getTaskTitle(task),
      taskPath: this.pickString(task, ['taskPath', 'path']) ?? undefined,
      startTime: this.readTimeValue(task['startTime']),
      stopTime: this.readTimeValue(task['stopTime']),
      durationSec: duration,
      focusLevel:
        focus !== null && focus > 0 ? Math.min(5, Math.round(focus)) : undefined,
      energyLevel:
        energy !== null && energy > 0 ? Math.min(5, Math.round(energy)) : undefined,
      executionComment: this.pickString(task, ['executionComment', 'comment']),
      project: this.pickString(task, ['project', 'projectTitle', 'projectName']),
      projectPath: this.pickString(task, ['project_path', 'projectPath']),
      isCompleted: this.isTaskCompleted(task),
    }
  }

  private compareTaskEntries(
    a: Record<string, unknown>,
    b: Record<string, unknown>,
  ): number {
    const startDiff = this.parseTimeToSeconds(a['startTime']) - this.parseTimeToSeconds(b['startTime'])
    if (startDiff !== 0) return startDiff
    const stopDiff = this.parseTimeToSeconds(a['stopTime']) - this.parseTimeToSeconds(b['stopTime'])
    if (stopDiff !== 0) return stopDiff
    return this.getTaskTitle(a).localeCompare(this.getTaskTitle(b), 'ja')
  }

  private computeAverageRating(
    tasks: Array<Record<string, unknown>>,
    fields: string[],
  ): number | null {
    const values: number[] = []
    for (const task of tasks) {
      for (const field of fields) {
        const value = this.readNumeric(task, field)
        if (value !== null && value > 0) {
          values.push(value)
          break
        }
      }
    }
    if (values.length === 0) {
      return null
    }
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length
    return Math.round(avg * 10) / 10
  }

  private async loadSatisfaction(dateString: string): Promise<number | null> {
    try {
      const reviewFilePath = this.getReviewFilePath(dateString)
      const file = this.plugin.app.vault.getAbstractFileByPath(reviewFilePath)
      if (!file || !(file instanceof TFile)) {
        return null
      }
      const content = await this.plugin.app.vault.read(file)
      const fromFrontmatter = this.extractSatisfactionFromFrontmatter(content)
      if (fromFrontmatter !== null) {
        return fromFrontmatter
      }

      const fromInline = this.extractSatisfactionFromInline(content)
      if (fromInline !== null) {
        return fromInline
      }

      return null
    } catch {
      return null
    }
  }

  private getReviewFilePath(dateString: string): string {
    const reviewFolder = this.plugin.pathManager.getReviewDataPath()
    const fileName = this.getReviewFileName(dateString)
    return normalizePath(`${reviewFolder}/${fileName}`)
  }

  private getReviewFileName(dateString: string): string {
    const rawPattern = this.plugin.settings?.reviewFileNamePattern ?? 'Review - {{date}}.md'
    const pattern = rawPattern.trim() || 'Review - {{date}}.md'
    const replaced = replaceDateTokens(pattern, dateString)
    return replaced.endsWith('.md') ? replaced : `${replaced}.md`
  }

  private extractSatisfactionFromFrontmatter(content: string): number | null {
    const frontMatterMatch = /^---\n([\s\S]*?)\n---/u.exec(content)
    if (!frontMatterMatch) {
      return null
    }
    try {
      const frontMatter = parseYaml(frontMatterMatch[1]) as Record<string, unknown> | null
      if (!frontMatter || typeof frontMatter !== 'object') {
        return null
      }
      const candidates: unknown[] = [
        frontMatter['satisfaction'],
        frontMatter['満足度'],
        frontMatter['dailySatisfaction'],
      ]
      for (const candidate of candidates) {
        const parsed = this.normalizeSatisfaction(candidate)
        if (parsed !== null) {
          return parsed
        }
      }
    } catch {
      // ignore parse errors and fall back to inline search
    }
    return null
  }

  private extractSatisfactionFromInline(content: string): number | null {
    const patterns = [
      /satisfaction\s*[:=]\s*([^\n]+)/i,
      /満足度\s*[:=]\s*([^\n]+)/u,
    ]
    for (const pattern of patterns) {
      const match = pattern.exec(content)
      if (match && match[1]) {
        const parsed = this.normalizeSatisfaction(match[1])
        if (parsed !== null) {
          return parsed
        }
      }
    }
    return null
  }

  private normalizeSatisfaction(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return this.clampSatisfaction(value)
    }
    if (typeof value === 'string') {
      const digitMatch = value.match(/([1-5])/)
      if (!digitMatch) return null
      const parsed = Number.parseInt(digitMatch[1], 10)
      if (!Number.isFinite(parsed)) return null
      return this.clampSatisfaction(parsed)
    }
    return null
  }

  private clampSatisfaction(value: number): number | null {
    if (!Number.isFinite(value)) return null
    if (value <= 0) return null
    const rounded = Math.round(value)
    if (rounded < 1) return 1
    if (rounded > 5) return 5
    return rounded
  }

  private getDurationSeconds(task: Record<string, unknown>): number | undefined {
    const primary = this.readNumeric(task, 'durationSec')
    if (primary !== null && primary > 0) return primary
    const fallback = this.readNumeric(task, 'duration')
    if (fallback !== null && fallback > 0) return fallback
    return undefined
  }

  private getTaskTitle(task: Record<string, unknown>): string {
    const title = this.pickString(task, ['taskTitle', 'taskName', 'task_title'])
    if (title) return title
    const path = this.pickString(task, ['taskPath', 'path'])
    if (path) return path
    return t('taskChuteView.status.unassignedTask', 'Unassigned task')
  }

  private pickString(
    source: Record<string, unknown>,
    fields: string[],
  ): string | undefined {
    for (const field of fields) {
      const value = this.readString(source, field)
      if (value) {
        return value
      }
    }
    return undefined
  }

  private readString(
    source: Record<string, unknown> | undefined,
    field: string,
  ): string | null {
    if (!source) return null
    const value = source[field]
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed.length > 0) return trimmed
    }
    return null
  }

  private readNumeric(
    source: Record<string, unknown> | undefined,
    field: string,
  ): number | null {
    if (!source) return null
    const value = source[field]
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    if (typeof value === 'string') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
    return null
  }

  private parseTimeToSeconds(value: unknown): number {
    if (typeof value !== 'string') return Number.POSITIVE_INFINITY
    const trimmed = value.trim()
    if (!trimmed) return Number.POSITIVE_INFINITY
    const parts = trimmed.split(':').map((part) => Number.parseInt(part, 10))
    if (parts.some((part) => Number.isNaN(part))) return Number.POSITIVE_INFINITY
    const [hours = 0, minutes = 0, seconds = 0] = parts
    return hours * 3600 + minutes * 60 + seconds
  }

  private readTimeValue(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }

  private isTaskCompleted(task: Record<string, unknown>): boolean {
    const explicit = task['isCompleted']
    if (typeof explicit === 'boolean') {
      return explicit
    }
    if (typeof explicit === 'string') {
      const normalized = explicit.trim().toLowerCase()
      if (['true', '1', 'yes', 'completed', 'done'].includes(normalized)) {
        return true
      }
      if (['false', '0', 'no', 'pending', 'incomplete', 'todo'].includes(normalized)) {
        return false
      }
    }

    const status = this.readString(task, 'status')?.toLowerCase()
    if (status) {
      if (['done', 'completed', 'finished'].includes(status)) {
        return true
      }
      if (['pending', 'todo', 'incomplete', 'scheduled'].includes(status)) {
        return false
      }
    }

    if (this.readString(task, 'stopTime')) return true
    const durationSec = this.readNumeric(task, 'durationSec')
    if (durationSec !== null && durationSec > 0) return true
    const duration = this.readNumeric(task, 'duration')
    if (duration !== null && duration > 0) return true
    return false
  }

  private calculateMinutesFromTasks(dayTasks: Array<Record<string, unknown>>): number {
    return dayTasks.reduce((sum, task) => {
      const durationSec = this.toNumber(task['durationSec'])
      const durationFallback = this.toNumber(task['duration'])
      const seconds = durationSec > 0 ? durationSec : durationFallback
      if (seconds <= 0) return sum
      return sum + Math.floor(seconds / 60)
    }, 0)
  }

  private ensureDailySummaryRecord(
    raw: RawMonthlyLog,
  ): Record<string, Record<string, unknown>> {
    if (!raw.dailySummary || typeof raw.dailySummary !== 'object') {
      raw.dailySummary = {}
    }
    return raw.dailySummary as Record<string, Record<string, unknown>>
  }

  private async readMonthlyLog(dateString: string): Promise<RawMonthlyLog | null> {
    try {
      const [year, month] = dateString.split('-')
      if (!year || !month) return null
      const monthString = `${year}-${month}`
      const logDataPath = this.plugin.pathManager.getLogDataPath()
      const logFilePath = normalizePath(`${logDataPath}/${monthString}-tasks.json`)
      const file = this.plugin.app.vault.getAbstractFileByPath(logFilePath)
      if (!file || !(file instanceof TFile)) return null
      const content = await this.plugin.app.vault.read(file)
      return JSON.parse(content) as RawMonthlyLog
    } catch {
      return null
    }
  }

  private async loadMonthlyData(dateString: string): Promise<MonthlyLogData> {
    try {
      const raw = await this.readMonthlyLog(dateString)
      if (!raw) return createEmptyMonthlyLog()
      return this.normalizeMonthlyLog(raw)
    } catch {
      return createEmptyMonthlyLog()
    }
  }

  private async updateYearlyData(dateString: string, stats: HeatmapDayStats): Promise<void> {
    try {
      const [yearString] = dateString.split('-')
      const year = Number(yearString)
      if (!Number.isFinite(year)) {
        return
      }
      const yearly: HeatmapYearData =
        (await this.loadExistingYearlyData(year)) ?? {
          year,
          days: {},
          metadata: { version: '1.0' },
        }

      yearly.days[dateString] = stats
      if (!yearly.metadata) yearly.metadata = { version: '1.0' }
      yearly.metadata.lastUpdated = new Date().toISOString()

      await this.persistYearlyData(year, yearly)
    } catch {
      // ignore
    }
  }

  private isFutureDate(dateString: string): boolean {
    const date = new Date(`${dateString}T00:00:00`)
    if (Number.isNaN(date.getTime())) {
      return false
    }
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    date.setHours(0, 0, 0, 0)
    return date.getTime() > today.getTime()
  }

  private async removeYearlyDateEntry(dateString: string): Promise<void> {
    try {
      const [yearString] = dateString.split('-')
      const year = Number(yearString)
      if (!Number.isFinite(year)) {
        return
      }
      const yearly = await this.loadExistingYearlyData(year)
      if (!yearly || !yearly.days || !yearly.days[dateString]) {
        return
      }

      delete yearly.days[dateString]
      yearly.metadata = yearly.metadata ?? { version: '1.0' }
      yearly.metadata.lastUpdated = new Date().toISOString()

      await this.persistYearlyData(year, yearly)
    } catch {
      // ignore removal errors
    }
  }
}
