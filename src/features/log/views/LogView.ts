import { App, Notice, TFile, WorkspaceLeaf, normalizePath } from 'obsidian'

import { getCurrentLocale, t } from '../../../i18n'

import type { HeatmapDayDetail, HeatmapDayStats, HeatmapYearData } from '../../../types'
import { HeatmapService } from '../services/HeatmapService'
import { LOG_HEATMAP_FOLDER, LOG_HEATMAP_LEGACY_FOLDER } from '../constants'

interface LogPathManager {
  getLogDataPath(): string;
  getLogYearPath(year: number | string): string;
  ensureYearFolder(year: number | string): Promise<string>;
  ensureFolderExists(path: string): Promise<void>;
  getReviewDataPath(): string;
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

type TooltipPosition = {
  left: number
  top: number
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_KEY_MAP = {
  sunday: 'Sun',
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
  saturday: 'Sat',
} as const;
const MAX_WEEKS = 53;
const DAYS_PER_WEEK = 7;
const HEATMAP_BATCH_SIZE = 50;

type DayDetailRenderState =
  | { status: 'placeholder' }
  | { status: 'loading'; dateKey: string }
  | { status: 'future'; dateKey: string }
  | { status: 'error'; dateKey: string }
  | { status: 'success'; detail: HeatmapDayDetail };

export class LogView {
  private readonly plugin: LogPlugin
  private readonly container: HTMLElement
  private readonly heatmapService: HeatmapService
  private readonly dataCache = new Map<number, HeatmapYearData>()

  private currentYear: number
  private heatmapData: HeatmapYearData | null = null
  private currentTooltip: HTMLElement | null = null
  private dayDetailCache = new Map<string, HeatmapDayDetail>()
  private dayDetailContainer: HTMLElement | null = null
  private selectedDateKey: string | null = null

  constructor(plugin: LogPlugin, container: HTMLElement) {
    this.plugin = plugin
    this.container = container
    this.currentYear = new Date().getFullYear()
    this.heatmapService = new HeatmapService(plugin)
  }

  private tv(
    key: string,
    fallback: string,
    vars?: Record<string, string | number>,
  ): string {
    return t(`logView.${key}`, fallback, vars)
  }

  private getWeekdayLabel(index: number): string {
    const keys: Array<keyof typeof WEEKDAY_KEY_MAP> = [
      'sunday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
    ];
    const key = keys[index] ?? 'sunday';
    return this.tv(`weekdays.${key}`, WEEKDAY_KEY_MAP[key]);
  }

  private getWeekdayLabels(): string[] {
    return Array.from({ length: 7 }, (_, idx) => this.getWeekdayLabel(idx));
  }

  async render(): Promise<void> {
    this.container.empty()
    this.createHeader()

    this.dayDetailCache.clear()
    this.selectedDateKey = null
    this.dayDetailContainer = null

    const loading = this.container.createEl('div', {
      cls: 'heatmap-loading',
      text: this.tv('header.loading', 'データを読み込み中...'),
    })

    try {
      if (this.currentYear === new Date().getFullYear()) {
        this.dataCache.delete(this.currentYear)
        await this.removeCachedYearFile(this.currentYear)
      }

      this.heatmapData = await this.loadYearlyData(this.currentYear)
      loading.remove()
      this.renderHeatmap()
    } catch (error) {
      console.error('Failed to render heatmap', error)
      loading.remove()
      new Notice(
        this.tv('notices.loadFailure', `${this.currentYear}年のデータ読み込みに失敗しました`, {
          year: this.currentYear,
        }),
      )
      this.renderEmptyHeatmap(this.currentYear)
    }
  }

  private createHeader(): void {
    const header = this.container.createEl('div', { cls: 'taskchute-log-header' })
    header.createEl('h2', {
      text: this.tv('header.title', 'タスク実行ログ'),
      cls: 'log-title',
    });

    const controls = header.createEl('div', { cls: 'log-controls' })
    const yearSelector = controls.createEl('select', { cls: 'year-selector' })
    const currentYear = new Date().getFullYear()

    for (let year = currentYear + 1; year >= 2020; year -= 1) {
      const option = yearSelector.createEl('option', {
        value: String(year),
        text: this.tv('labels.yearOption', `${year}年`, { year }),
      })
      if (year === this.currentYear) {
        option.selected = true
      }
    }

    const refreshButton = controls.createEl('button', {
      cls: 'refresh-button',
      text: this.tv('header.reloadButton', '🔄 データ更新'),
      attr: {
        title: this.tv('header.reloadTooltip', 'キャッシュをクリアして再計算'),
      },
    })

    refreshButton.addEventListener('click', () => {
      void (async () => {
        this.dataCache.delete(this.currentYear)
        await this.removeCachedYearFile(this.currentYear)
        await this.reloadCurrentYear(
          this.tv('header.recalculating', 'データを再計算中...'),
          true,
        )
      })()
    })

    yearSelector.addEventListener('change', (event) => {
      void (async () => {
        const target = event.currentTarget as HTMLSelectElement
        this.currentYear = Number.parseInt(target.value, 10)
        await this.reloadCurrentYear(
          this.tv('header.loading', 'データを読み込み中...'),
          false,
        )
      })()
    })
  }

  private async removeCachedYearFile(year: number): Promise<void> {
    try {
      const logBase = this.plugin.pathManager.getLogDataPath()
      const visiblePath = normalizePath(`${logBase}/${LOG_HEATMAP_FOLDER}/${year}/yearly-heatmap.json`)
      const hiddenPath = normalizePath(`${logBase}/${LOG_HEATMAP_LEGACY_FOLDER}/${year}/yearly-heatmap.json`)
      const legacyPath = normalizePath(`${this.plugin.pathManager.getLogYearPath(year)}/yearly-heatmap.json`)
      for (const targetPath of [visiblePath, hiddenPath, legacyPath]) {
        const file = this.plugin.app.vault.getAbstractFileByPath(targetPath)
        if (file instanceof TFile) {
          await this.plugin.app.fileManager.trashFile(file)
        }
      }
    } catch (error) {
      console.warn('Failed to delete cached heatmap file', error)
    }
  }

  private async reloadCurrentYear(loadingText: string, showSuccessNotice: boolean): Promise<void> {
    const existing = this.container.querySelector('.heatmap-container')
    existing?.remove()

    this.dayDetailCache.clear()
    this.selectedDateKey = null
    this.dayDetailContainer = null

    const loading = this.container.createEl('div', {
      cls: 'heatmap-loading',
      text: loadingText,
    })
    try {
      this.heatmapData = await this.loadYearlyData(this.currentYear)
      loading.remove()
      this.renderHeatmap()
      if (showSuccessNotice) {
        new Notice(
          this.tv('notices.reloadSuccess', `${this.currentYear}年のデータを更新しました`, {
            year: this.currentYear,
          }),
        )
      }
    } catch (error) {
      console.error('Failed to reload heatmap', error)
      loading.remove()
      new Notice(
        this.tv('notices.reloadFailure', `${this.currentYear}年のデータ読み込みに失敗しました`, {
          year: this.currentYear,
        }),
      )
      this.renderEmptyHeatmap(this.currentYear)
    }
  }

  private async loadYearlyData(year: number): Promise<HeatmapYearData> {
    const cached = this.dataCache.get(year);
    if (cached) return cached;

    const data = await this.heatmapService.loadYearlyData(year);
    this.dataCache.set(year, data);
    return data;
  }

  private renderHeatmap(): void {
    if (!this.heatmapData) return;

    const existing = this.container.querySelector('.heatmap-container');
    if (existing) existing.remove();

    const heatmapContainer = this.container.createEl('div', { cls: 'heatmap-container' });
    const layout = heatmapContainer.createEl('div', {
      cls: 'heatmap-modal-body',
    });

    const gridSection = layout.createEl('div', { cls: 'heatmap-grid-section' });
    const grid = this.createHeatmapGrid(this.heatmapData.year);
    gridSection.appendChild(grid);

    this.dayDetailContainer = layout.createEl('div', {
      cls: 'heatmap-detail-section',
    });

    if (this.selectedDateKey) {
      this.renderDayDetail({ status: 'loading', dateKey: this.selectedDateKey });
    } else {
      this.renderDayDetail({ status: 'placeholder' });
    }

    this.applyDataToGrid(this.heatmapData);
    window.requestAnimationFrame(() => {
      void this.initializeDefaultSelection();
    });
  }

  private renderEmptyHeatmap(year: number): void {
    const existing = this.container.querySelector('.heatmap-container');
    if (existing) existing.remove();

    const heatmapContainer = this.container.createEl('div', { cls: 'heatmap-container' });
    const layout = heatmapContainer.createEl('div', {
      cls: 'heatmap-modal-body',
    });

    const gridSection = layout.createEl('div', { cls: 'heatmap-grid-section' });
    gridSection.createEl('div', {
      cls: 'heatmap-error',
      text: this.tv('notices.yearUnavailable', `${year}年のデータは利用できません`, {
        year,
      }),
    });
    const grid = this.createHeatmapGrid(year);
    gridSection.appendChild(grid);

    grid.querySelectorAll<HTMLElement>('.heatmap-cell').forEach((cell) => {
      delete cell.dataset.level;
      cell.dataset.tooltip = this.tv('labels.tooltipNoData', 'データなし');
    });

    this.dayDetailContainer = layout.createEl('div', {
      cls: 'heatmap-detail-section',
    });
    this.renderDayDetail({ status: 'placeholder' });
  }

  private createHeatmapGrid(year: number): HTMLElement {
    const container = document.createElement('div');
    container.className = 'heatmap-grid-container';

    const monthLabels = container.createEl('div', { cls: 'heatmap-months' });
    const weekdayWrapper = container.createEl('div', { cls: 'heatmap-weekdays-container' });
    const weekdayColumn = weekdayWrapper.createEl('div', { cls: 'heatmap-weekdays' });

    const weekdayLabels = this.getWeekdayLabels();
    weekdayLabels.forEach((labelText, index) => {
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
        attr: { 'data-date': dateString },
      });

      if (inYear) {
        cell.setAttr('role', 'button');
        cell.setAttr('tabindex', '0');
        cell.setAttr(
          'aria-label',
          this.tv(
            'labels.openTaskListAria',
            `${this.getAccessibleLabel(dateString)}を表示`,
            { date: this.getAccessibleLabel(dateString) },
          ),
        );
        cell.dataset.selected = 'false';
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
          delete cell.dataset.level;
          delete cell.dataset.tooltip;
          continue;
        }
        const level = this.calculateLevel(stats);
        if (level === null) {
          delete cell.dataset.level;
        } else {
          cell.dataset.level = String(level);
        }
        cell.dataset.tooltip = this.createTooltipText(dateKey, stats);
      }
      if (index < entries.length) {
        requestAnimationFrame(processBatch);
      }
    };

    requestAnimationFrame(processBatch);
  }

  private async initializeDefaultSelection(): Promise<void> {
    if (!this.heatmapData) return;

    const currentYearPrefix = `${this.currentYear}-`;
    if (this.selectedDateKey && this.selectedDateKey.startsWith(currentYearPrefix)) {
      const existingCell = this.container.querySelector<HTMLElement>(
        `.heatmap-cell[data-date="${this.selectedDateKey}"]`,
      );
      if (existingCell && !existingCell.classList.contains('empty')) {
        await this.selectDate(this.selectedDateKey, { focusCell: false });
        return;
      }
    }

    const today = new Date();
    if (today.getFullYear() === this.currentYear) {
      const todayKey = this.formatDate(today);
      const todayCell = this.container.querySelector<HTMLElement>(
        `.heatmap-cell[data-date="${todayKey}"]`,
      );
      if (todayCell && !todayCell.classList.contains('empty')) {
        await this.selectDate(todayKey, { focusCell: false });
        return;
      }
    }

    this.selectedDateKey = null;
    this.renderDayDetail({ status: 'placeholder' });
  }

  private async selectDate(
    dateKey: string,
    options: { focusCell?: boolean } = {},
  ): Promise<void> {
    const cell = this.container.querySelector<HTMLElement>(
      `.heatmap-cell[data-date="${dateKey}"]`,
    );
    if (!cell || cell.classList.contains('empty')) {
      this.renderDayDetail({ status: 'placeholder' });
      return;
    }

    const previous = this.container.querySelector<HTMLElement>(
      '.heatmap-cell[data-selected="true"]',
    );
    if (previous && previous !== cell) {
      previous.dataset.selected = 'false';
    }
    cell.dataset.selected = 'true';
    if (options.focusCell) {
      cell.focus({ preventScroll: false });
    }

    this.selectedDateKey = dateKey;
    this.hideTooltip();

    if (this.isFutureDate(dateKey)) {
      this.renderDayDetail({ status: 'future', dateKey });
      return;
    }

    const cached = this.dayDetailCache.get(dateKey);
    if (cached) {
      this.renderDayDetail({ status: 'success', detail: cached });
      return;
    }

    this.renderDayDetail({ status: 'loading', dateKey });

    try {
      const detail = await this.heatmapService.loadDayDetail(dateKey);
      if (this.selectedDateKey !== dateKey) {
        return;
      }
      if (!detail) {
        this.renderDayDetail({ status: 'error', dateKey });
        return;
      }
      this.dayDetailCache.set(dateKey, detail);
      this.renderDayDetail({ status: 'success', detail });
    } catch (error) {
      console.error('Failed to load day detail', error);
      if (this.selectedDateKey === dateKey) {
        this.renderDayDetail({ status: 'error', dateKey });
      }
    }
  }

  private renderDayDetail(state: DayDetailRenderState): void {
    if (!this.dayDetailContainer) {
      return;
    }
    this.dayDetailContainer.empty();

    switch (state.status) {
      case 'placeholder':
        this.dayDetailContainer.createEl('div', {
          cls: 'heatmap-detail-placeholder',
          text: this.tv('labels.selectDate', '日付を選択してください'),
        });
        break;
      case 'loading':
        this.dayDetailContainer.createEl('div', {
          cls: 'heatmap-detail-loading',
          text: this.tv('labels.loadingDate', `${state.dateKey} のデータを読み込み中...`, {
            date: state.dateKey,
          }),
        });
        break;
      case 'future':
        this.dayDetailContainer.createEl('div', {
          cls: 'heatmap-detail-placeholder',
          text: this.tv('labels.futureDate', '未来の日付です。記録はまだありません。'),
        });
        break;
      case 'error':
        this.dayDetailContainer.createEl('div', {
          cls: 'heatmap-detail-error',
          text: this.tv('notices.loadFailedGeneric', 'データの読み込みに失敗しました。'),
        });
        break;
      case 'success':
        this.renderDayDetailContent(state.detail);
        break;
      default:
        this.dayDetailContainer.createEl('div', {
          cls: 'heatmap-detail-placeholder',
          text: this.tv('labels.selectDatePrompt', '日付を選択してください'),
        });
    }
  }

  private renderDayDetailContent(detail: HeatmapDayDetail): void {
    if (!this.dayDetailContainer) return;

    const header = this.dayDetailContainer.createEl('div', {
      cls: 'heatmap-detail-header',
    });

    const heading = header.createEl('div', { cls: 'heatmap-detail-heading' });
    heading.createEl('h3', {
      cls: 'heatmap-detail-date',
      text: this.formatHeaderDate(detail.date),
    });

    const satisfactionBadge = this.createSatisfactionElement(detail.satisfaction);
    heading.appendChild(satisfactionBadge);

    const actions = header.createEl('div', { cls: 'heatmap-detail-actions' });
    const openButton = actions.createEl('button', {
      cls: 'heatmap-detail-open-button',
      text: this.tv('labels.openTaskList', 'タスク一覧を開く'),
      attr: {
        'aria-label': this.tv(
          'labels.openTaskListAria',
          `${this.getAccessibleLabel(detail.date)}のタスク一覧を開く`,
          { date: this.getAccessibleLabel(detail.date) },
        ),
      },
    });
    openButton.addEventListener('click', () => {
      void this.navigateToDate(detail.date);
    });

    const summary = this.dayDetailContainer.createEl('div', {
      cls: 'heatmap-detail-summary',
    });

    this.createSummaryItem(
      summary,
      this.tv('labels.totalTasks', '総タスク'),
      String(detail.summary.totalTasks),
    );
    this.createSummaryItem(
      summary,
      this.tv('labels.completedTasks', '完了'),
      String(detail.summary.completedTasks),
    );
    this.createSummaryItem(
      summary,
      this.tv('labels.postponedTasks', '先送り'),
      String(detail.summary.procrastinatedTasks),
    );
    this.createSummaryItem(
      summary,
      this.tv('labels.totalTime', '合計時間'),
      this.formatMinutesValue(detail.summary.totalMinutes),
    );
    this.createSummaryItem(
      summary,
      this.tv('labels.completionRate', '完了率'),
      this.formatCompletionRate(detail.summary.completionRate),
    );
    if (detail.executions.length === 0) {
      this.dayDetailContainer.createEl('div', {
        cls: 'heatmap-detail-empty',
        text: this.tv('labels.noEntries', 'この日に記録された実行ログはありません。'),
      });
      return;
    }

    const table = this.dayDetailContainer.createEl('table', {
      cls: 'heatmap-detail-table',
    });
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    const columns = [
      this.tv('labels.tableHeaders.taskNameWithCount', `タスク名 (${detail.executions.length})`, {
        count: detail.executions.length,
      }),
      this.tv('labels.tableHeaders.executionTime', '実行時間'),
      this.tv('labels.tableHeaders.duration', '所要時間'),
      this.tv('labels.tableHeaders.focus', '集中度'),
      this.tv('labels.tableHeaders.energy', '元気度'),
      this.tv('labels.tableHeaders.comment', 'コメント'),
    ];
    columns.forEach((label) => {
      headerRow.createEl('th', { text: label, attr: { scope: 'col' } });
    });

    const tbody = table.createEl('tbody');
    detail.executions.forEach((entry) => {
      const row = tbody.createEl('tr');

      const nameCell = row.createEl('td', { cls: 'heatmap-detail-name' });
      const titleRow = nameCell.createEl('div', {
        cls: 'heatmap-detail-title-row',
      });
      titleRow.createEl('span', {
        cls: 'heatmap-detail-status',
        text: entry.isCompleted ? '✅' : '⬜️',
      });
      titleRow.createEl('span', {
        cls: 'heatmap-detail-title',
        text: entry.title,
      });

      row.createEl('td', {
        cls: 'heatmap-detail-time',
        text: this.formatExecutionTime(entry.startTime, entry.stopTime),
      });

      row.createEl('td', {
        cls: 'heatmap-detail-duration',
        text: this.formatDuration(entry.durationSec),
      });

      row.createEl('td', {
        cls: 'heatmap-detail-rating',
        text: this.formatRating(entry.focusLevel, 'focus'),
      });

      row.createEl('td', {
        cls: 'heatmap-detail-rating',
        text: this.formatRating(entry.energyLevel, 'energy'),
      });

      const commentCell = row.createEl('td', { cls: 'heatmap-detail-comment' });
      if (entry.executionComment) {
        commentCell.textContent = entry.executionComment;
      } else {
        commentCell.textContent = '-';
      }
    });
  }

  private createSummaryItem(parent: HTMLElement, label: string, value: string): void {
    const item = parent.createEl('div', { cls: 'heatmap-summary-item' });
    item.createEl('span', { cls: 'heatmap-summary-label', text: label });
    item.createEl('span', { cls: 'heatmap-summary-value', text: value });
  }

  private createSatisfactionElement(value: number | null): HTMLElement {
    const span = document.createElement('span');
    span.className = 'heatmap-detail-satisfaction';
    if (value === null) {
      span.textContent = this.tv('labels.satisfactionEmpty', '1日の満足度: -');
      return span;
    }
    const clamped = Math.min(5, Math.max(1, Math.round(value)));
    span.textContent = this.tv(
      'labels.satisfactionValue',
      `1日の満足度: ${clamped}/5`,
      { value: clamped },
    );
    return span;
  }

  private formatHeaderDate(dateKey: string): string {
    const date = new Date(`${dateKey}T00:00:00`);
    if (Number.isNaN(date.getTime())) {
      return dateKey;
    }
    const weekday = this.getWeekdayLabel(date.getDay());
    return `${dateKey} (${weekday})`;
  }

  private getAccessibleLabel(dateKey: string): string {
    const date = new Date(`${dateKey}T00:00:00`);
    if (Number.isNaN(date.getTime())) {
      return dateKey;
    }
    const locale = getCurrentLocale() === 'ja' ? 'ja-JP' : 'en-US';
    return date.toLocaleDateString(locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    });
  }

  private formatMinutesValue(totalMinutes: number): string {
    if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) {
      return this.tv('durations.zeroMinutes', '0分');
    }
    const minutes = Math.round(totalMinutes);
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours > 0) {
      return this.formatHoursMinutes(hours, mins);
    }
    return this.formatMinutesOnly(mins);
  }

  private formatCompletionRate(rate: number): string {
    if (!Number.isFinite(rate) || rate <= 0) {
      return '0%';
    }
    const value = Math.round(rate * 100);
    return `${value}%`;
  }

  private formatRating(level: number | undefined, type: 'focus' | 'energy'): string {
    if (!level || level <= 0) {
      return '-';
    }
    const clamped = Math.min(5, Math.max(1, Math.round(level)));
    const icon = type === 'focus' ? '⭐️' : '⚡️';
    return icon.repeat(clamped);
  }

  private formatDuration(durationSec: number | undefined): string {
    if (!durationSec || durationSec <= 0) {
      return this.tv('durations.lessThanMinute', '1分未満');
    }
    const minutes = Math.max(1, Math.round(durationSec / 60));
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours > 0) {
      return this.formatHoursMinutes(hours, mins);
    }
    return this.formatMinutesOnly(mins);
  }

  private formatExecutionTime(start?: string, stop?: string): string {
    const startText = start?.trim();
    const stopText = stop?.trim();
    if (startText && stopText) {
      return `${startText} - ${stopText}`;
    }
    if (startText) {
      return `${startText} -`;
    }
    if (stopText) {
      return `- ${stopText}`;
    }
    return '-';
  }

  private calculateLevel(stats: HeatmapDayStats): 0 | 1 | 2 | 3 | 4 | null {
    if (!stats || stats.totalTasks === 0) {
      return null;
    }

    if (!stats.completedTasks || stats.completedTasks <= 0) {
      return null;
    }

    const clampedRate = Number.isFinite(stats.completionRate)
      ? Math.min(1, Math.max(0, stats.completionRate))
      : 0;

    if (clampedRate <= 0.25) {
      return 0;
    }
    if (clampedRate < 0.5) {
      return 1;
    }
    if (clampedRate < 0.75) {
      return 2;
    }
    if (clampedRate < 0.95) {
      return 3;
    }
    return 4;
  }

  private createTooltipText(dateKey: string, stats: HeatmapDayStats): string {
    const date = new Date(`${dateKey}T00:00:00`);
    const locale = getCurrentLocale() === 'ja' ? 'ja-JP' : 'en-US';
    const formatted = date.toLocaleDateString(locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    });

    if (!stats || stats.totalTasks === 0) {
      return this.tv('summaries.noTasks', `${formatted}\nタスクなし`, {
        formatted,
      });
    }

    const rate = Math.round((stats.completionRate ?? 0) * 100);
    return this.tv(
      'summaries.stats',
      `${formatted}\n総タスク: ${stats.totalTasks}\n完了: ${stats.completedTasks}\n先送り: ${stats.procrastinatedTasks}\n完了率: ${rate}%`,
      {
        formatted,
        total: stats.totalTasks,
        completed: stats.completedTasks ?? 0,
        deferred: stats.procrastinatedTasks ?? 0,
        rate,
      },
    );
  }

  private formatHoursMinutes(hours: number, minutes: number): string {
    if (minutes > 0) {
      return this.tv('durations.hoursAndMinutes', `${hours}時間${minutes}分`, {
        hours,
        minutes,
      });
    }
    return this.tv('durations.hoursOnly', `${hours}時間`, { hours });
  }

  private formatMinutesOnly(minutes: number): string {
    return this.tv('durations.minutesOnly', `${minutes}分`, { minutes });
  }

  private addCellEventListeners(cell: HTMLElement, dateKey: string): void {
    cell.addEventListener('mouseenter', () => this.showTooltip(cell));
    cell.addEventListener('mouseleave', () => this.hideTooltip());
    cell.addEventListener('click', (event) => {
      void (async () => {
        event.stopPropagation();
        event.preventDefault();
        await this.selectDate(dateKey);
      })()
    });
    cell.addEventListener('keydown', (event) => {
      void (async () => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          await this.selectDate(dateKey, { focusCell: false });
        }
      })()
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
      const [year, month, day] = dateKey.split('-').map((value) => Number.parseInt(value, 10))
      const workspace = this.plugin.app.workspace
      let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType('taskchute-view')[0] ?? null

      if (!leaf) {
        leaf = workspace.getRightLeaf(false)
        if (!leaf) return
        await leaf.setViewState({ type: 'taskchute-view', active: true })
        await new Promise((resolve) => window.setTimeout(resolve, 300))
        leaf = workspace.getLeavesOfType('taskchute-view')[0] ?? leaf
      }

      const view = (leaf.view as unknown) as TaskChuteViewLike | undefined
      if (!view || typeof view.loadTasks !== 'function') return

      view.currentDate = new Date(year, month - 1, day)
      if (view.updateDateLabel && view.containerEl) {
        const dateLabel = view.containerEl.querySelector('.date-nav-label')
        if (dateLabel) {
          view.updateDateLabel(dateLabel)
        }
      }

      await view.loadTasks()
      workspace.setActiveLeaf(leaf)

      const modal = this.container.closest('.taskchute-log-modal-overlay')
      if (modal instanceof HTMLElement) {
        modal.remove()
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
