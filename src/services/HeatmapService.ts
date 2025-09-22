import { TFile, normalizePath } from 'obsidian'
import { HeatmapDayStats, HeatmapYearData } from '../types'

interface PluginLike {
  app: any
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
      } catch (_) {
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
        const monthlyLog = JSON.parse(content)
        if (!monthlyLog || typeof monthlyLog !== 'object') continue

        if (monthlyLog.dailySummary && typeof monthlyLog.dailySummary === 'object') {
          for (const [dateString, summary] of Object.entries<any>(monthlyLog.dailySummary)) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) continue
            if (!dateString.startsWith(`${year}-`)) continue

            const totalTasks = Number(summary.totalTasks) || 0
            const completedTasks = Number(summary.completedTasks) || 0
            const stats: HeatmapDayStats = {
              totalTasks,
              completedTasks,
              procrastinatedTasks: Math.max(0, totalTasks - completedTasks),
              completionRate: totalTasks > 0 ? completedTasks / totalTasks : 0,
            }
            yearlyData.days[dateString] = stats
          }
        } else if (monthlyLog.taskExecutions && typeof monthlyLog.taskExecutions === 'object') {
          for (const [dateString, dayTasks] of Object.entries<any>(monthlyLog.taskExecutions)) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) continue
            if (!dateString.startsWith(`${year}-`)) continue
            if (!Array.isArray(dayTasks)) continue

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
    } catch (_) {
      // ignore generation errors; return current yearlyData (may be partial)
    }

    return yearlyData
  }

  calculateDailyStats(dayTasks: any[]): HeatmapDayStats {
    const map = new Map<string, boolean>()
    const toKey = (e: any) => (e?.taskPath && typeof e.taskPath === 'string' && e.taskPath)
      || (e?.taskName && typeof e.taskName === 'string' && e.taskName)
      || (e?.taskTitle && typeof e.taskTitle === 'string' && e.taskTitle)
      || (e?.instanceId && typeof e.instanceId === 'string' && e.instanceId)
      || JSON.stringify(e)
    const isCompleted = (e: any) => {
      if (typeof e?.isCompleted === 'boolean') return e.isCompleted
      if (e?.stopTime && typeof e.stopTime === 'string' && e.stopTime.trim().length > 0) return true
      if (typeof e?.durationSec === 'number' && e.durationSec > 0) return true
      if (typeof e?.duration === 'number' && e.duration > 0) return true
      return true
    }

    for (const task of dayTasks) {
      if (!task || typeof task !== 'object') continue
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
      const dayTasks: any[] = monthly.taskExecutions?.[dateString] || []
      const stats = this.calculateDailyStats(dayTasks)
      await this.updateYearlyData(dateString, stats)
      return stats
    } catch (_) {
      return null
    }
  }

  private async loadMonthlyData(dateString: string): Promise<any> {
    try {
      const [year, month] = dateString.split('-')
      const monthString = `${year}-${month}`
      const logDataPath = this.plugin.pathManager.getLogDataPath()
      const logFilePath = normalizePath(`${logDataPath}/${monthString}-tasks.json`)
      const file = this.plugin.app.vault.getAbstractFileByPath(logFilePath)
      if (!file || !(file instanceof TFile)) return { taskExecutions: {} }
      const content = await this.plugin.app.vault.read(file)
      return JSON.parse(content)
    } catch (_) {
      return { taskExecutions: {} }
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
    } catch (_) {
      // ignore
    }
  }
}
