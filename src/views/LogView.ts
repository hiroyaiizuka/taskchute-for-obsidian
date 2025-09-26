import { App, Notice, TFile, WorkspaceLeaf } from 'obsidian';

import { HeatmapDayStats, HeatmapYearData } from '../types';
import { HeatmapService } from '../services/HeatmapService';

interface LogPathManager {
  getLogDataPath(): string;
  getLogYearPath(year: number | string): string;
  ensureYearFolder(year: number | string): Promise<string>;
}

interface LogPlugin {
  app: App;
  pathManager: LogPathManager;
}

interface TaskChuteViewLike {
  currentDate?: Date;
  containerEl?: HTMLElement;
  loadTasks(): Promise<void>;
  updateDateLabel?(element: Element): void;
}

interface TooltipPosition {
  left: number;
  top: number;
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];
const MAX_WEEKS = 53;
const DAYS_PER_WEEK = 7;
const HEATMAP_BATCH_SIZE = 50;

export class LogView {
  private readonly plugin: LogPlugin;
  private readonly container: HTMLElement;
  private readonly heatmapService: HeatmapService;
  private readonly dataCache = new Map<number, HeatmapYearData>();

  private currentYear: number;
  private heatmapData: HeatmapYearData | null = null;
  private currentTooltip: HTMLElement | null = null;

  constructor(plugin: LogPlugin, container: HTMLElement) {
    this.plugin = plugin;
    this.container = container;
    this.currentYear = new Date().getFullYear();
    this.heatmapService = new HeatmapService(plugin);
  }

  async render(): Promise<void> {
    this.container.empty();
    this.createHeader();

    const loading = this.container.createEl('div', {
      cls: 'heatmap-loading',
      text: 'データを読み込み中...',
    });

    try {
      if (this.currentYear === new Date().getFullYear()) {
        this.dataCache.delete(this.currentYear);
        await this.removeCachedYearFile(this.currentYear);
      }

      this.heatmapData = await this.loadYearlyData(this.currentYear);
      loading.remove();
      this.renderHeatmap();
    } catch (error) {
      console.error('Failed to render heatmap', error);
      loading.remove();
      new Notice(`${this.currentYear}年のデータ読み込みに失敗しました`);
      this.renderEmptyHeatmap(this.currentYear);
    }
  }

  private createHeader(): void {
    const header = this.container.createEl('div', { cls: 'taskchute-log-header' });
    header.createEl('h2', { text: 'タスク実行ログ', cls: 'log-title' });

    const controls = header.createEl('div', { cls: 'log-controls' });
    const yearSelector = controls.createEl('select', { cls: 'year-selector' }) as HTMLSelectElement;
    const currentYear = new Date().getFullYear();

    for (let year = currentYear + 1; year >= 2020; year--) {
      const option = yearSelector.createEl('option', { value: String(year), text: `${year}年` });
      if (year === this.currentYear) {
        option.selected = true;
      }
    }

    const refreshButton = controls.createEl('button', {
      cls: 'refresh-button',
      text: '🔄 データ更新',
      attr: { title: 'キャッシュをクリアして再計算' },
    });

    refreshButton.addEventListener('click', async () => {
      this.dataCache.delete(this.currentYear);
      await this.removeCachedYearFile(this.currentYear);
      await this.reloadCurrentYear('データを再計算中...', true);
    });

    yearSelector.addEventListener('change', async (event) => {
      const target = event.currentTarget as HTMLSelectElement;
      this.currentYear = Number.parseInt(target.value, 10);
      await this.reloadCurrentYear('データを読み込み中...', false);
    });
  }

  private async removeCachedYearFile(year: number): Promise<void> {
    try {
      const yearPath = this.plugin.pathManager.getLogYearPath(year);
      const file = this.plugin.app.vault.getAbstractFileByPath(`${yearPath}/yearly-heatmap.json`);
      if (file && file instanceof TFile) {
        await this.plugin.app.fileManager.trashFile(file, true);
      }
    } catch (error) {
      console.warn('Failed to delete cached heatmap file', error);
    }
  }

  private async reloadCurrentYear(loadingText: string, showSuccessNotice: boolean): Promise<void> {
    const existing = this.container.querySelector('.heatmap-container');
    if (existing) existing.remove();

    const loading = this.container.createEl('div', { cls: 'heatmap-loading', text: loadingText });
    try {
      this.heatmapData = await this.loadYearlyData(this.currentYear);
      loading.remove();
      this.renderHeatmap();
      if (showSuccessNotice) {
        new Notice(`${this.currentYear}年のデータを更新しました`);
      }
    } catch (error) {
      console.error('Failed to reload heatmap', error);
      loading.remove();
      new Notice(`${this.currentYear}年のデータ読み込みに失敗しました`);
      this.renderEmptyHeatmap(this.currentYear);
    }
  }

  private async loadYearlyData(year: number): Promise<HeatmapYearData> {
    const cached = this.dataCache.get(year);
    if (cached) return cached;

    await this.plugin.pathManager.ensureYearFolder(year);
    const data = await this.heatmapService.loadYearlyData(year);
    this.dataCache.set(year, data);
    return data;
  }

  private renderHeatmap(): void {
    if (!this.heatmapData) return;

    const existing = this.container.querySelector('.heatmap-container');
    if (existing) existing.remove();

    const heatmapContainer = this.container.createEl('div', { cls: 'heatmap-container' });
    const grid = this.createHeatmapGrid(this.heatmapData.year);
    heatmapContainer.appendChild(grid);
    this.applyDataToGrid(this.heatmapData);
  }

  private renderEmptyHeatmap(year: number): void {
    const existing = this.container.querySelector('.heatmap-container');
    if (existing) existing.remove();

    const heatmapContainer = this.container.createEl('div', { cls: 'heatmap-container' });
    heatmapContainer.createEl('div', { cls: 'heatmap-error', text: `${year}年のデータは利用できません` });
    const grid = this.createHeatmapGrid(year);
    heatmapContainer.appendChild(grid);

    grid.querySelectorAll<HTMLElement>('.heatmap-cell').forEach((cell) => {
      cell.dataset.level = '0';
      cell.dataset.tooltip = 'データなし';
    });
  }

  private createHeatmapGrid(year: number): HTMLElement {
    const container = document.createElement('div');
    container.className = 'heatmap-grid-container';

    const monthLabels = container.createEl('div', { cls: 'heatmap-months' });
    const weekdayWrapper = container.createEl('div', { cls: 'heatmap-weekdays-container' });
    const weekdayColumn = weekdayWrapper.createEl('div', { cls: 'heatmap-weekdays' });

    WEEKDAY_LABELS.forEach((labelText, index) => {
      const label = weekdayColumn.createEl('span', { cls: 'weekday-label' });
      if (index % 2 !== 0) {
        label.textContent = labelText;
      }
    });

    const grid = weekdayWrapper.createEl('div', { cls: 'heatmap-grid' });

    const firstDay = new Date(year, 0, 1);
    const firstSunday = new Date(firstDay);
    firstSunday.setDate(firstSunday.getDate() - firstDay.getDay());

    let currentDate = new Date(firstSunday);
    let weekIndex = 0;
    let lastMonthIndex = -1;

    for (let index = 0; index < MAX_WEEKS * DAYS_PER_WEEK; index++) {
      const dateString = this.formatDate(currentDate);
      const inYear = currentDate.getFullYear() === year;

      const cell = grid.createEl('div', {
        cls: inYear ? 'heatmap-cell' : 'heatmap-cell empty',
        attr: { 'data-date': dateString, 'data-level': '0' },
      });

      if (inYear) {
        this.addCellEventListeners(cell, dateString);
        const monthIndex = currentDate.getMonth();
        if (monthIndex !== lastMonthIndex) {
          const monthLabel = monthLabels.createEl('span', {
            cls: 'month-label',
            text: MONTH_LABELS[monthIndex],
          });
          monthLabel.style.setProperty('--heatmap-month-index', String(weekIndex));
          lastMonthIndex = monthIndex;
        }
      }

      currentDate = new Date(
        currentDate.getFullYear(),
        currentDate.getMonth(),
        currentDate.getDate() + 1,
      );
      if ((index + 1) % DAYS_PER_WEEK === 0) {
        weekIndex += 1;
      }
    }

    const legend = container.createEl('div', { cls: 'heatmap-legend' });
    legend.createEl('span', { cls: 'legend-label', text: 'Less' });
    const legendScale = legend.createEl('div', { cls: 'legend-scale' });
    for (let level = 0; level <= 4; level++) {
      legendScale.createEl('div', { cls: 'legend-cell', attr: { 'data-level': String(level) } });
    }
    legend.createEl('span', { cls: 'legend-label', text: 'More' });

    return container;
  }

  private applyDataToGrid(data: HeatmapYearData): void {
    if (!data.days) return;

    const entries = Object.entries(data.days);
    let index = 0;

    const processBatch = () => {
      const limit = Math.min(index + HEATMAP_BATCH_SIZE, entries.length);
      for (; index < limit; index++) {
        const [dateKey, stats] = entries[index];
        const cell = this.container.querySelector<HTMLElement>(`[data-date="${dateKey}"]`);
        if (!cell) continue;
        if (this.isFutureDate(dateKey)) {
          cell.dataset.level = '0';
          delete cell.dataset.tooltip;
          continue;
        }
        const level = this.calculateLevel(stats);
        cell.dataset.level = String(level);
        cell.dataset.tooltip = this.createTooltipText(dateKey, stats);
      }
      if (index < entries.length) {
        requestAnimationFrame(processBatch);
      }
    };

    requestAnimationFrame(processBatch);
  }

  private calculateLevel(stats: HeatmapDayStats): number {
    if (!stats || stats.totalTasks === 0) return 0;
    if (stats.procrastinatedTasks === 0) return 4;
    const rate = stats.completionRate;
    if (rate >= 0.8) return 3;
    if (rate >= 0.5) return 2;
    if (rate >= 0.2) return 1;
    return 1;
  }

  private createTooltipText(dateKey: string, stats: HeatmapDayStats): string {
    const date = new Date(`${dateKey}T00:00:00`);
    const formatted = date.toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    });

    if (!stats || stats.totalTasks === 0) {
      return `${formatted}\nタスクなし`;
    }

    return `${formatted}\n総タスク: ${stats.totalTasks}\n完了: ${stats.completedTasks}\n先送り: ${stats.procrastinatedTasks}\n完了率: ${Math.round(stats.completionRate * 100)}%`;
  }

  private addCellEventListeners(cell: HTMLElement, dateKey: string): void {
    cell.addEventListener('mouseenter', () => this.showTooltip(cell));
    cell.addEventListener('mouseleave', () => this.hideTooltip());
    cell.addEventListener('click', async (event) => {
      event.stopPropagation();
      await this.navigateToDate(dateKey);
    });
  }

  private isFutureDate(dateKey: string): boolean {
    const date = new Date(`${dateKey}T00:00:00`);
    if (Number.isNaN(date.getTime())) {
      return false;
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    date.setHours(0, 0, 0, 0);
    return date.getTime() > today.getTime();
  }

  private showTooltip(cell: HTMLElement): void {
    this.hideTooltip();
    const tooltipText = cell.dataset.tooltip;
    if (!tooltipText) return;

    const tooltip = document.createElement('div');
    tooltip.classList.add('heatmap-tooltip');
    tooltip.textContent = tooltipText;

    const position = this.computeTooltipPosition(cell);
    tooltip.style.setProperty('--heatmap-tooltip-left', `${position.left}px`);
    tooltip.style.setProperty('--heatmap-tooltip-top', `${position.top}px`);

    this.container.appendChild(tooltip);
    this.currentTooltip = tooltip;
  }

  private computeTooltipPosition(cell: HTMLElement): TooltipPosition {
    const cellRect = cell.getBoundingClientRect();
    const containerRect = this.container.getBoundingClientRect();
    const left = cellRect.left - containerRect.left;
    const top = cellRect.bottom - containerRect.top + 5;
    return { left, top };
  }

  private hideTooltip(): void {
    if (!this.currentTooltip) return;
    this.currentTooltip.remove();
    this.currentTooltip = null;
  }

  private async navigateToDate(dateKey: string): Promise<void> {
    try {
      const [year, month, day] = dateKey.split('-').map((value) => Number.parseInt(value, 10));
      const workspace = this.plugin.app.workspace;
      let leaf = workspace.getLeavesOfType('taskchute-view')[0] ?? null;

      if (!leaf) {
        leaf = workspace.getRightLeaf(false);
        if (!leaf) return;
        await leaf.setViewState({ type: 'taskchute-view', active: true });
        await new Promise((resolve) => window.setTimeout(resolve, 300));
        leaf = workspace.getLeavesOfType('taskchute-view')[0] ?? leaf;
      }

      const view = leaf.view as TaskChuteViewLike | undefined;
      if (!view || typeof view.loadTasks !== 'function') return;

      view.currentDate = new Date(year, month - 1, day);
      if (view.updateDateLabel && view.containerEl) {
        const dateLabel = view.containerEl.querySelector('.date-nav-label');
        if (dateLabel) {
          view.updateDateLabel(dateLabel);
        }
      }

      await view.loadTasks();
      workspace.setActiveLeaf(leaf as WorkspaceLeaf);

      const modal = this.container.closest('.taskchute-log-modal-overlay');
      if (modal instanceof HTMLElement) {
        modal.remove();
      }
    } catch (error) {
      console.error('Failed to navigate to date', error);
    }
  }

  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}

export default LogView;
