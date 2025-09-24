import { App, TFile, normalizePath } from 'obsidian'
import { HeatmapDayStats, HeatmapYearData } from '../types'

type NormalizedSummary = { totalTasks: number; completedTasks: number }
type DailySummaryMap = Record<string, NormalizedSummary>
type TaskExecutionsMap = Record<string, Record<string, unknown>[]>

interface MonthlyLogData {
  dailySummary: DailySummaryMap
  taskExecutions: TaskExecutionsMap
}

const createEmptyMonthlyLog = (): MonthlyLogData => ({
  dailySummary: {},
  taskExecutions: {},
})

interface PluginLike {
  app: App
  pathManager: {
    getLogDataPath(): string
    getLogYearPath(year: number): string
    ensureYearFolder(year: number): Promise<string>
  }
}

export class HeatmapService {
  private plugin: PluginLike

  constructor(plugin: PluginLike) {
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
        const monthlyData = this.normalizeMonthlyLog(JSON.parse(content))
        const hasSummary = Object.keys(monthlyData.dailySummary).length > 0

        if (hasSummary) {
          for (const [dateString, summary] of Object.entries(monthlyData.dailySummary)) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) continue
            if (!dateString.startsWith(`${year}-`)) continue

            const totalTasks = summary.totalTasks
            const completedTasks = summary.completedTasks
            const stats: HeatmapDayStats = {
              totalTasks,
              completedTasks,
              procrastinatedTasks: Math.max(0, totalTasks - completedTasks),
              completionRate: totalTasks > 0 ? completedTasks / totalTasks : 0,
            }
            yearlyData.days[dateString] = stats
          }
        } else {
          for (const [dateString, dayTasks] of Object.entries(monthlyData.taskExecutions)) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) continue
            if (!dateString.startsWith(`${year}-`)) continue

            const stats = this.calculateDailyStats(dayTasks)
            yearlyData.days[dateString] = stats
          }
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
    const toKey = (task: Record<string, unknown>): string =>
      readStringField(task, 'taskPath') ??
      readStringField(task, 'taskName') ??
      readStringField(task, 'taskTitle') ??
      readStringField(task, 'instanceId') ??
      JSON.stringify(task)

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
      const key = toKey(task)
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
      const monthly = await this.loadMonthlyData(dateString)
      const dayTasks = monthly.taskExecutions[dateString] ?? []
      const stats = this.calculateDailyStats(dayTasks)
      await this.updateYearlyData(dateString, stats)
      return stats
    } catch {
      return null
    }
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
}
