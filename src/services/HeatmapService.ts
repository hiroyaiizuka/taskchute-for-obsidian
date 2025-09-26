import { App, TFile, normalizePath } from 'obsidian'
import { HeatmapDayStats, HeatmapYearData } from '../types'
import { computeExecutionInstanceKey } from '../utils/logKeys'

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
  }
}

export class HeatmapService {
  private plugin: HeatmapServicePluginLike

  constructor(plugin: HeatmapServicePluginLike) {
    this.plugin = plugin
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
    const yearPath = this.plugin.pathManager.getLogYearPath(year)
    const heatmapPath = normalizePath(`${yearPath}/yearly-heatmap.json`)

    const file = this.plugin.app.vault.getAbstractFileByPath(heatmapPath)
    if (file && file instanceof TFile) {
      try {
        const content = await this.plugin.app.vault.read(file)
        const data: HeatmapYearData = JSON.parse(content)
        if (!data || typeof data !== 'object' || !data.year || !data.days) {
          throw new Error('Invalid yearly heatmap data')
        }
        return data
      } catch {
        // fallthrough to regeneration
      }
    }

    // Generate if not present
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
              ? (existingSummarySource as Record<string, unknown>)
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
      const yearPath = await this.plugin.pathManager.ensureYearFolder(String(year))
      const heatmapPath = normalizePath(`${yearPath}/yearly-heatmap.json`)
      const file = this.plugin.app.vault.getAbstractFileByPath(heatmapPath)
      const content = JSON.stringify(yearlyData, null, 2)
      if (file && file instanceof TFile) {
        await this.plugin.app.vault.modify(file, content)
      } else {
        await this.plugin.app.vault.create(heatmapPath, content)
      }
    } catch {
      // ignore generation errors; return current yearlyData (may be partial)
    }

    return yearlyData
  }

  calculateDailyStats(dayTasks: Array<Record<string, unknown>>): HeatmapDayStats {
    const map = new Map<string, boolean>()
    const readStringField = (task: Record<string, unknown>, field: string): string | null => {
      const value = task[field]
      if (typeof value === 'string' && value.trim().length > 0) {
        return value
      }
      return null
    }

    const hasPositive = (task: Record<string, unknown>, field: string): boolean =>
      this.toNumber(task[field]) > 0

    const isCompleted = (task: Record<string, unknown>): boolean => {
      const explicit = task['isCompleted']
      if (typeof explicit === 'boolean') return explicit
      if (readStringField(task, 'stopTime')) return true
      if (hasPositive(task, 'durationSec')) return true
      if (hasPositive(task, 'duration')) return true
      return true
    }

    for (const task of dayTasks) {
      const key = computeExecutionInstanceKey(task)
      if (!map.has(key)) map.set(key, false)
      if (isCompleted(task)) map.set(key, true)
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

  private async loadMonthlyData(dateString: string): Promise<MonthlyLogData> {
    try {
      const [year, month] = dateString.split('-')
      const monthString = `${year}-${month}`
      const logDataPath = this.plugin.pathManager.getLogDataPath()
      const logFilePath = normalizePath(`${logDataPath}/${monthString}-tasks.json`)
      const file = this.plugin.app.vault.getAbstractFileByPath(logFilePath)
      if (!file || !(file instanceof TFile)) return createEmptyMonthlyLog()
      const content = await this.plugin.app.vault.read(file)
      return this.normalizeMonthlyLog(JSON.parse(content))
    } catch {
      return createEmptyMonthlyLog()
    }
  }

  private async updateYearlyData(dateString: string, stats: HeatmapDayStats): Promise<void> {
    try {
      const [year] = dateString.split('-')
      const yearPath = await this.plugin.pathManager.ensureYearFolder(year)
      const heatmapPath = normalizePath(`${yearPath}/yearly-heatmap.json`)
      const file = this.plugin.app.vault.getAbstractFileByPath(heatmapPath)
      let yearly: HeatmapYearData
      if (file && file instanceof TFile) {
        const content = await this.plugin.app.vault.read(file)
        yearly = JSON.parse(content)
      } else {
        yearly = { year: parseInt(year, 10), days: {}, metadata: { version: '1.0' } }
      }

      yearly.days[dateString] = stats
      if (!yearly.metadata) yearly.metadata = { version: '1.0' }
      yearly.metadata.lastUpdated = new Date().toISOString()

      const out = JSON.stringify(yearly, null, 2)
      if (file && file instanceof TFile) {
        await this.plugin.app.vault.modify(file, out)
      } else {
        await this.plugin.app.vault.create(heatmapPath, out)
      }
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
      const yearPath = this.plugin.pathManager.getLogYearPath(year)
      const heatmapPath = normalizePath(`${yearPath}/yearly-heatmap.json`)
      const file = this.plugin.app.vault.getAbstractFileByPath(heatmapPath)
      if (!file || !(file instanceof TFile)) return

      const content = await this.plugin.app.vault.read(file)
      if (!content) return

      const yearly = JSON.parse(content) as HeatmapYearData
      if (!yearly.days || !yearly.days[dateString]) return

      delete yearly.days[dateString]
      yearly.metadata = yearly.metadata ?? { version: '1.0' }
      yearly.metadata.lastUpdated = new Date().toISOString()

      await this.plugin.app.vault.modify(file, JSON.stringify(yearly, null, 2))
    } catch {
      // ignore removal errors
    }
  }
}
