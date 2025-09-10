import { TFile, Notice } from 'obsidian'
import { HeatmapDayStats, HeatmapYearData } from '../types'
import { HeatmapService } from '../services/HeatmapService'

interface PluginWithPath {
  app: any
  pathManager: {
    getLogDataPath(): string
    getLogYearPath(year: number): string
    ensureYearFolder(year: number | string): Promise<string>
  }
}

export class LogView {
  private plugin: PluginWithPath
  private container: HTMLElement
  private currentYear: number
  private heatmapData: HeatmapYearData | null = null
  private dataCache: { [year: number]: HeatmapYearData } = {}
  private heatmapService: HeatmapService

  constructor(plugin: PluginWithPath, container: HTMLElement) {
    this.plugin = plugin
    this.container = container
    this.currentYear = new Date().getFullYear()
    this.heatmapService = new HeatmapService(plugin as any)
  }

  async render(): Promise<void> {
    this.container.empty()

    // Header
    this.createHeader()

    // Loading
    const loadingContainer = this.container.createEl('div', {
      cls: 'heatmap-loading',
      text: 'データを読み込み中...'
    })

    try {
      // Force regeneration on initial render for current year
      if (this.currentYear === new Date().getFullYear()) {
        delete this.dataCache[this.currentYear]
        try {
          const yearPath = this.plugin.pathManager.getLogYearPath(this.currentYear)
          const heatmapFile = this.plugin.app.vault.getAbstractFileByPath(`${yearPath}/yearly-heatmap.json`)
          if (heatmapFile && heatmapFile instanceof TFile) {
            await this.plugin.app.vault.delete(heatmapFile)
          }
        } catch (_) {}
      }

      // Load data
      this.heatmapData = await this.loadYearlyData(this.currentYear)
      loadingContainer.remove()
      this.renderHeatmap()
    } catch (error) {
      loadingContainer.remove()
      new Notice(`${this.currentYear}年のデータ読み込みに失敗しました`)
      this.renderEmptyHeatmap(this.currentYear)
    }
  }

  private createHeader(): void {
    const header = this.container.createEl('div', { cls: 'taskchute-log-header' })
    header.createEl('h2', { text: 'タスク実行ログ', cls: 'log-title' })

    const controls = header.createEl('div', { cls: 'log-controls' })
    const yearSelector = controls.createEl('select', { cls: 'year-selector' }) as HTMLSelectElement
    const current = new Date().getFullYear()
    for (let y = current + 1; y >= 2020; y--) {
      const opt = yearSelector.createEl('option', { value: String(y), text: `${y}年` })
      if (y === this.currentYear) opt.selected = true
    }

    const refreshButton = controls.createEl('button', {
      cls: 'refresh-button',
      text: '🔄 データ更新',
      attr: { title: 'キャッシュをクリアして再計算' }
    })

    refreshButton.addEventListener('click', async () => {
      delete this.dataCache[this.currentYear]
      try {
        const yearPath = this.plugin.pathManager.getLogYearPath(this.currentYear)
        const heatmapFile = this.plugin.app.vault.getAbstractFileByPath(`${yearPath}/yearly-heatmap.json`)
        if (heatmapFile && heatmapFile instanceof TFile) {
          await this.plugin.app.vault.delete(heatmapFile)
        }
      } catch (_) {}

      const container = this.container.querySelector('.heatmap-container')
      if (container) container.remove()
      const loading = this.container.createEl('div', { cls: 'heatmap-loading', text: 'データを再計算中...' })
      try {
        this.heatmapData = await this.loadYearlyData(this.currentYear)
        loading.remove()
        this.renderHeatmap()
        new Notice(`${this.currentYear}年のデータを更新しました`)
      } catch (e) {
        loading.remove()
        new Notice(`${this.currentYear}年のデータ更新に失敗しました`)
        this.renderEmptyHeatmap(this.currentYear)
      }
    })

    yearSelector.addEventListener('change', async (e: any) => {
      this.currentYear = parseInt(e.target.value, 10)
      const container = this.container.querySelector('.heatmap-container')
      if (container) container.remove()
      const loading = this.container.createEl('div', { cls: 'heatmap-loading', text: 'データを読み込み中...' })
      try {
        this.heatmapData = await this.loadYearlyData(this.currentYear)
        loading.remove()
        this.renderHeatmap()
      } catch (err) {
        loading.remove()
        new Notice(`${this.currentYear}年のデータ読み込みに失敗しました`)
        this.renderEmptyHeatmap(this.currentYear)
      }
    })
  }

  private async loadYearlyData(year: number): Promise<HeatmapYearData> {
    if (this.dataCache[year]) return this.dataCache[year]
    await this.plugin.pathManager.ensureYearFolder(year)
    const data = await this.heatmapService.loadYearlyData(year)
    this.dataCache[year] = data
    return data
  }

  private renderHeatmap(): void {
    if (!this.heatmapData) return
    const existed = this.container.querySelector('.heatmap-container')
    if (existed) existed.remove()
    const heatmapContainer = this.container.createEl('div', { cls: 'heatmap-container' })
    const grid = this.createHeatmapGrid(this.heatmapData.year)
    heatmapContainer.appendChild(grid)
    this.applyDataToGrid(this.heatmapData)
  }

  private renderEmptyHeatmap(year: number): void {
    const existed = this.container.querySelector('.heatmap-container')
    if (existed) existed.remove()
    const heatmapContainer = this.container.createEl('div', { cls: 'heatmap-container' })
    heatmapContainer.createEl('div', { cls: 'heatmap-error', text: `${year}年のデータは利用できません` })
    const grid = this.createHeatmapGrid(year)
    heatmapContainer.appendChild(grid)
    const cells = grid.querySelectorAll('.heatmap-cell')
    cells.forEach((cell) => {
      ;(cell as HTMLElement).dataset.level = '0'
      ;(cell as HTMLElement).dataset.tooltip = 'データなし'
    })
  }

  private applyDataToGrid(data: HeatmapYearData): void {
    if (!data.days) return
    const entries = Object.entries(data.days)
    const batchSize = 50
    let currentIndex = 0
    const processBatch = () => {
      const endIndex = Math.min(currentIndex + batchSize, entries.length)
      for (let i = currentIndex; i < endIndex; i++) {
        const [dateString, stats] = entries[i]
        const cell = this.container.querySelector(`[data-date="${dateString}"]`) as HTMLElement | null
        if (cell) {
          const level = this.calculateLevel(stats as HeatmapDayStats)
          cell.dataset.level = String(level)
          cell.dataset.tooltip = this.createTooltipText(dateString, stats as HeatmapDayStats)
        }
      }
      currentIndex = endIndex
      if (currentIndex < entries.length) requestAnimationFrame(processBatch)
    }
    requestAnimationFrame(processBatch)
  }

  private calculateLevel(stats: HeatmapDayStats): number {
    if (!stats || stats.totalTasks === 0) return 0
    if (stats.procrastinatedTasks === 0) return 4
    const rate = stats.completionRate
    if (rate >= 0.8) return 3
    if (rate >= 0.5) return 2
    if (rate >= 0.2) return 1
    return 1
  }

  private createTooltipText(dateString: string, stats: HeatmapDayStats): string {
    const date = new Date(dateString + 'T00:00:00')
    const dateText = date.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
    if (!stats || stats.totalTasks === 0) return `${dateText}\nタスクなし`
    return `${dateText}\n総タスク: ${stats.totalTasks}\n完了: ${stats.completedTasks}\n先送り: ${stats.procrastinatedTasks}\n完了率: ${Math.round(stats.completionRate * 100)}%`
  }

  private addCellEventListeners(cell: HTMLElement, dateString: string): void {
    cell.addEventListener('mouseenter', () => this.showTooltip(cell))
    cell.addEventListener('mouseleave', () => this.hideTooltip())
    cell.addEventListener('click', async (e) => {
      e.stopPropagation()
      await this.navigateToDate(dateString)
    })
  }

  private showTooltip(cell: HTMLElement): void {
    this.hideTooltip()
    const tooltipText = (cell as HTMLElement).dataset.tooltip
    if (!tooltipText) return
    const tooltip = document.createElement('div')
    tooltip.className = 'heatmap-tooltip'
    tooltip.textContent = tooltipText
    const rect = cell.getBoundingClientRect()
    const containerRect = this.container.getBoundingClientRect()
    tooltip.style.position = 'absolute'
    tooltip.style.left = `${rect.left - containerRect.left}px`
    tooltip.style.top = `${rect.bottom - containerRect.top + 5}px`
    tooltip.style.zIndex = '1000'
    this.container.appendChild(tooltip)
    ;(this as any).currentTooltip = tooltip
  }

  private hideTooltip(): void {
    const current = (this as any).currentTooltip as HTMLElement | undefined
    if (current) {
      current.remove()
      ;(this as any).currentTooltip = null
    }
  }

  private async navigateToDate(dateString: string): Promise<void> {
    try {
      const [year, month, day] = dateString.split('-').map(Number)
      const leaves = this.plugin.app.workspace.getLeavesOfType('taskchute-view')
      let leaf: any
      if (leaves.length === 0) {
        leaf = this.plugin.app.workspace.getRightLeaf(false)
        await leaf.setViewState({ type: 'taskchute-view', active: true })
        await new Promise((r) => setTimeout(r, 300))
        const newLeaves = this.plugin.app.workspace.getLeavesOfType('taskchute-view')
        if (newLeaves.length > 0) leaf = newLeaves[0]
      } else {
        leaf = leaves[0]
      }
      const view = leaf.view
      if (!view || typeof view.loadTasks !== 'function') return
      view.currentDate = new Date(year, month - 1, day)
      if (view.updateDateLabel && view.containerEl) {
        const dateLabel = view.containerEl.querySelector('.date-nav-label')
        if (dateLabel) view.updateDateLabel(dateLabel)
      }
      await view.loadTasks()
      this.plugin.app.workspace.setActiveLeaf(leaf)
      const modal = this.container.closest('.taskchute-log-modal-overlay')
      if (modal) (modal as HTMLElement).remove()
    } catch (_) {}
  }

  private createHeatmapGrid(year: number): HTMLElement {
    const gridContainer = document.createElement('div')
    gridContainer.className = 'heatmap-grid-container'

    // Month labels & weekday labels
    const monthLabels = gridContainer.createEl('div', { cls: 'heatmap-months' })
    const weekdayContainer = gridContainer.createEl('div', { cls: 'heatmap-weekdays-container' })
    const weekdayLabels = weekdayContainer.createEl('div', { cls: 'heatmap-weekdays' })
    const weekdays = ['日','月','火','水','木','金','土']
    weekdays.forEach((day, idx) => {
      const label = weekdayLabels.createEl('span', { cls: 'weekday-label' })
      if (idx === 1 || idx === 3 || idx === 5) label.textContent = day
    })

    const grid = weekdayContainer.createEl('div', { cls: 'heatmap-grid' })
    grid.style.gridTemplateColumns = `repeat(53, 11px)`

    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    const firstDay = new Date(year, 0, 1)
    const firstSunday = new Date(firstDay)
    firstSunday.setDate(firstSunday.getDate() - firstDay.getDay())

    const currentDate = new Date(firstSunday)
    let weekIndex = 0
    let lastMonthSeen = -1
    for (let i = 0; i < 371; i++) {
      const dateStr = this.formatDate(currentDate)
      const isCurrentYear = currentDate.getFullYear() === year
      const cell = grid.createEl('div', {
        cls: isCurrentYear ? 'heatmap-cell' : 'heatmap-cell empty',
        attr: { 'data-date': dateStr, 'data-level': '0' }
      })
      if (isCurrentYear) {
        this.addCellEventListeners(cell, dateStr)
        const cm = currentDate.getMonth()
        if (cm !== lastMonthSeen) {
          const label = monthLabels.createEl('span', { cls: 'month-label', text: months[cm] })
          label.style.left = `${weekIndex * 13}px`
          lastMonthSeen = cm
        }
      }
      currentDate.setDate(currentDate.getDate() + 1)
      if (i > 0 && (i + 1) % 7 === 0) weekIndex++
    }

    const legend = gridContainer.createEl('div', { cls: 'heatmap-legend' })
    legend.createEl('span', { cls: 'legend-label', text: 'Less' })
    const legendScale = legend.createEl('div', { cls: 'legend-scale' })
    for (let i = 0; i <= 4; i++) legendScale.createEl('div', { cls: 'legend-cell', attr: { 'data-level': String(i) } })
    legend.createEl('span', { cls: 'legend-label', text: 'More' })

    return gridContainer
  }

  private formatDate(d: Date): string {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
}

