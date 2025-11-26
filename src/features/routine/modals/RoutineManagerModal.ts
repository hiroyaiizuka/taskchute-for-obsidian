import { App, Modal, Notice, TFile, WorkspaceLeaf } from 'obsidian';

import { getCurrentLocale, t } from '../../../i18n';

import {
  RoutineFrontmatter,
  RoutineType,
  RoutineWeek,
  TaskChutePluginLike,
} from '../../../types';
import { getScheduledTime } from '../../../utils/fieldMigration';
import RoutineEditModal from './RoutineEditModal';

interface RoutineRow {
  file: TFile;
  fm: RoutineFrontmatter;
}

interface TaskChuteViewLike {
  reloadTasksAndRestore?(options?: { runBoundaryCheck?: boolean }): unknown;
}

const DEFAULT_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

class RoutineConfirmModal extends Modal {
  private readonly message: string;
  private resolver: ((result: boolean) => void) | null = null;

  constructor(app: App, message: string) {
    super(app);
    this.message = message;
  }

  openAndWait(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('routine-confirm');

    contentEl.createEl('h3', {
      text: t('routineManager.confirm.heading', 'Confirm'),
    });
    contentEl.createEl('p', { text: this.message });

    const buttonRow = contentEl.createEl('div', { cls: 'routine-confirm__buttons' });
    const confirmBtn = buttonRow.createEl('button', {
      text: t('routineManager.confirm.removeButton', 'Remove'),
      cls: 'routine-confirm__button mod-danger',
    });
    const cancelBtn = buttonRow.createEl('button', {
      text: t('routineManager.confirm.cancelButton', 'Cancel'),
      cls: 'routine-confirm__button',
    });

    confirmBtn.addEventListener('click', () => {
      this.closeWith(true);
    });

    cancelBtn.addEventListener('click', () => {
      this.closeWith(false);
    });
  }

  onClose(): void {
    if (!this.resolver) return;
    const resolve = this.resolver;
    this.resolver = null;
    resolve(false);
  }

  private closeWith(result: boolean): void {
    if (this.resolver) {
      const resolve = this.resolver;
      this.resolver = null;
      resolve(result);
    }
    this.close();
  }
}

export class RoutineManagerModal extends Modal {
  private readonly plugin: TaskChutePluginLike;
  private rows: RoutineRow[] = [];
  private filtered: RoutineRow[] = [];
  private searchInput!: HTMLInputElement;
  private tableBody!: HTMLElement;
  private pendingRemovalPaths: Set<string> = new Set();

  constructor(app: App, plugin: TaskChutePluginLike) {
    super(app);
    this.plugin = plugin;
  }

  private tv(
    key: string,
    fallback: string,
    vars?: Record<string, string | number>,
  ): string {
    return t(`routineManager.${key}`, fallback, vars);
  }

  private getWeekdayLabel(index: number): string {
    const keys = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
    const key = keys[index] ?? 'sunday';
    return this.tv(`weekdays.${key}`, DEFAULT_DAY_NAMES[index] ?? DEFAULT_DAY_NAMES[0]);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('routine-manager');
    this.modalEl?.classList.add('routine-manager-modal');

    const header = contentEl.createEl('div', { cls: 'routine-manager__header' });
    header.createEl('h3', {
      text: this.tv('dialog.title', 'Routine manager'),
    });

    const controls = header.createEl('div', { cls: 'routine-manager__controls' });
    this.searchInput = controls.createEl('input', {
      type: 'search',
      attr: {
        placeholder: this.tv('dialog.searchPlaceholder', 'Search (title / path)'),
      },
    });
    this.searchInput.addEventListener('input', () => this.applyFilters());

    const body = contentEl.createEl('div', { cls: 'routine-manager__body' });
    const tableWrapper = body.createEl('div', { cls: 'routine-table__wrapper' });

    const table = tableWrapper.createEl('div', { cls: 'routine-table' });
    const headRow = table.createEl('div', { cls: 'routine-table__row routine-table__row--head' });
    const headerLabels = [
      this.tv('dialog.columns.title', 'Title'),
      this.tv('dialog.columns.type', 'Type'),
      this.tv('dialog.columns.interval', 'Interval'),
      this.tv('dialog.columns.weekdays', 'Weekdays'),
      this.tv('dialog.columns.week', 'Week'),
      this.tv('dialog.columns.startTime', 'Scheduled time'),
      this.tv('dialog.columns.startDate', 'Start date'),
      this.tv('dialog.columns.endDate', 'End date'),
      this.tv('dialog.columns.enabled', 'Enabled'),
    ];
    headerLabels.forEach((label) => {
      headRow.createEl('div', { cls: 'routine-table__cell', text: label });
    });

    const actionsHeaderCell = headRow.createEl('div', {
      cls: 'routine-table__cell routine-table__cell--actions routine-table__cell--actions-header',
    });
    actionsHeaderCell.setAttr(
      'aria-label',
      this.tv('dialog.columns.actions', 'Actions'),
    );

    this.tableBody = table.createEl('div', { cls: 'routine-table__body' });

    this.loadRows();
    this.applyFilters();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private loadRows(): void {
    const taskFolderPath = this.plugin.pathManager.getTaskFolderPath();
    const locale = getCurrentLocale() === 'ja' ? 'ja' : 'en';
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path.startsWith(`${taskFolderPath}/`))
      .sort((a, b) => a.basename.localeCompare(b.basename, locale));

    this.rows = files
      .map((file) => {
        const frontmatter = this.toRoutineFrontmatter(
          this.app.metadataCache.getFileCache(file)?.frontmatter,
        );

        if (this.pendingRemovalPaths.has(file.path)) {
          if (!frontmatter || frontmatter.isRoutine !== true) {
            this.pendingRemovalPaths.delete(file.path);
          } else {
            return null;
          }
        }

        return frontmatter?.isRoutine === true ? { file, fm: frontmatter } : null;
      })
      .filter((row): row is RoutineRow => row !== null);
  }

  private applyFilters(): void {
    const query = (this.searchInput?.value || '').toLowerCase();
    this.filtered = this.rows.filter(({ file }) => {
      if (!query) return true;
      const haystack = `${file.basename} ${file.path}`.toLowerCase();
      return haystack.includes(query);
    });
    this.renderTable();
  }

  private renderTable(): void {
    this.tableBody.empty();

    if (this.filtered.length === 0) {
      this.tableBody.createEl('div', {
        cls: 'routine-empty',
        text: this.tv('status.noneFound', 'No routines found'),
      });
      return;
    }

    this.filtered.forEach((row, index) => {
      this.tableBody.appendChild(this.renderRow(row, index));
    });
  }

  private renderRow(row: RoutineRow, index: number): HTMLElement {
    const { file, fm } = row;
    const rowEl = document.createElement('div');
    rowEl.classList.add('routine-table__row');

    const titleCell = rowEl.createEl('div', { cls: 'routine-table__cell' });
    const link = titleCell.createEl('a', {
      text: file.basename,
      attr: { href: '#' },
      cls: 'routine-table__link',
    });
    link.addEventListener('click', async (evt) => {
      evt.preventDefault();
      await this.openRoutineFile(file);
    });

    rowEl.createEl('div', {
      cls: 'routine-table__cell',
      text: this.typeLabel(fm.routine_type),
    });

    rowEl.createEl('div', {
      cls: 'routine-table__cell',
      text: String(Math.max(1, Number(fm.routine_interval ?? 1))),
    });

    rowEl.createEl('div', {
      cls: 'routine-table__cell',
      text: this.weekdayLabel(fm),
    });

    rowEl.createEl('div', {
      cls: 'routine-table__cell',
      text: this.weekLabel(fm),
    });

    rowEl.createEl('div', {
      cls: 'routine-table__cell',
      text: this.scheduledTimeLabel(fm),
    });

    rowEl.createEl('div', {
      cls: 'routine-table__cell',
      text: fm.routine_start || '-',
    });

    rowEl.createEl('div', {
      cls: 'routine-table__cell',
      text: fm.routine_end || '-',
    });

    const enabledCell = rowEl.createEl('div', { cls: 'routine-table__cell' });
    const isEnabled = fm.routine_enabled !== false;
    const toggle = enabledCell.createEl('button', {
      text: isEnabled ? '✓' : '×',
      cls: 'routine-table__toggle',
      attr: { title: this.tv('tooltips.toggleEnable', 'Toggle enabled state') },
    });

    toggle.addEventListener('click', async (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      const newValue = !this.getRowEnabled(file.path);
      this.updateCachedEnabledState(file.path, newValue);
      this.renderTable();
      await this.updateRoutineEnabled(file, newValue);
      window.setTimeout(() => void this.refreshRow(file, newValue), 200);
      this.refreshActiveView();
    });

    const actionsCell = rowEl.createEl('div', {
      cls: 'routine-table__cell routine-table__cell--actions',
    });
    const editBtn = actionsCell.createEl('button', {
      text: this.tv('tooltips.editRoutine', 'Edit'),
      cls: 'routine-table__action-button',
    });
    const deleteBtn = actionsCell.createEl('button', {
      text: '🗑️',
      cls: 'routine-table__action-button routine-table__action-button--danger',
      attr: { title: this.tv('tooltips.removeRoutine', 'Remove from routine') },
    });

    editBtn.addEventListener('click', () => {
      const { file: currentFile } = this.filtered[index];
      new RoutineEditModal(this.app, this.plugin, currentFile, (updatedFm) => {
        void this.refreshRow(currentFile, undefined, updatedFm);
      }).open();
    });

    deleteBtn.addEventListener('click', async () => {
      const message = this.tv(
        'confirm.removeMessage',
        this.tv('confirm.removeMessage', 'Remove "{name}" from routines?', {
          name: file.basename,
        }),
        { name: file.basename },
      );
      const confirmed = await new RoutineConfirmModal(this.app, message).openAndWait();
      if (!confirmed) return;
      const removed = await this.removeRoutine(file);
      if (removed) {
        this.pendingRemovalPaths.add(file.path);
        this.removeRowFromCaches(file.path);
        this.renderTable();
        window.setTimeout(() => void this.reloadAll(), 250);
      }
    });

    return rowEl;
  }

  private getRowEnabled(path: string): boolean {
    return this.rows.find((row) => row.file.path === path)?.fm.routine_enabled !== false;
  }

  private updateCachedEnabledState(path: string, enabled: boolean): void {
    this.rows = this.rows.map((row) =>
      row.file.path === path ? { ...row, fm: { ...row.fm, routine_enabled: enabled } } : row,
    );
    this.filtered = this.filtered.map((row) =>
      row.file.path === path ? { ...row, fm: { ...row.fm, routine_enabled: enabled } } : row,
    );
  }

  private typeLabel(type: RoutineType | undefined): string {
    switch (type) {
      case 'daily':
        return this.tv('types.daily', 'Daily');
      case 'weekly':
        return this.tv('types.weekly', 'Weekly');
      case 'monthly':
        return this.tv('types.monthly', 'Monthly');
      default:
        return type ?? '-';
    }
  }

  private scheduledTimeLabel(fm: RoutineFrontmatter): string {
    const value = getScheduledTime(fm);
    if (!value) return '-';
    return value;
  }

  private weekdayLabel(fm: RoutineFrontmatter): string {
    if (fm.routine_type === 'weekly') {
      if (Array.isArray(fm.weekdays) && fm.weekdays.length > 0) {
        return fm.weekdays
          .filter((day) => Number.isInteger(day))
          .map((day) => `${this.getWeekdayLabel(Number(day))}${this.tv('labels.weekdaySuffix', ' weekday')}`)
          .join(', ');
      }
      if (typeof fm.routine_weekday === 'number') {
        return `${this.getWeekdayLabel(fm.routine_weekday)}${this.tv('labels.weekdaySuffix', ' weekday')}`;
      }
      if (typeof fm.weekday === 'number') {
        return `${this.getWeekdayLabel(fm.weekday)}${this.tv('labels.weekdaySuffix', ' weekday')}`;
      }
    }

    if (fm.routine_type === 'monthly') {
      const weekdaySet = this.getMonthlyWeekdaySet(fm);
      if (weekdaySet.length > 0) {
        return weekdaySet
          .map((weekday) => `${this.getWeekdayLabel(weekday)}${this.tv('labels.weekdaySuffix', ' weekday')}`)
          .join(', ');
      }
    }

    return '-';
  }

  private weekLabel(fm: RoutineFrontmatter): string {
    if (fm.routine_type !== 'monthly') return '-';
    const weekSet = this.getMonthlyWeekSet(fm);
    if (weekSet.length > 0) {
      return weekSet
        .map((week) =>
          week === 'last'
            ? this.tv('labels.weekLast', 'Last')
            : this.tv('labels.weekNth', `Week ${week}`, { week }),
        )
        .join(', ');
    }
    return '-';
  }

  private getMonthlyWeek(fm: RoutineFrontmatter): RoutineWeek | undefined {
    if (fm.routine_week === 'last' || typeof fm.routine_week === 'number') {
      return fm.routine_week;
    }
    if (fm.monthly_week === 'last') {
      return 'last';
    }
    if (typeof fm.monthly_week === 'number') {
      return (fm.monthly_week + 1) as RoutineWeek;
    }
    return undefined;
  }

  private getMonthlyWeekday(fm: RoutineFrontmatter): number | undefined {
    if (typeof fm.routine_weekday === 'number') {
      return fm.routine_weekday;
    }
    if (typeof fm.monthly_weekday === 'number') {
      return fm.monthly_weekday;
    }
    return undefined;
  }

  private getMonthlyWeekSet(fm: RoutineFrontmatter): RoutineWeek[] {
    if (Array.isArray(fm.routine_weeks) && fm.routine_weeks.length) {
      return fm.routine_weeks.filter((value): value is RoutineWeek => value === 'last' || (typeof value === 'number' && value >= 1 && value <= 5));
    }
    const legacy = (fm as Record<string, unknown>).monthly_weeks;
    if (Array.isArray(legacy)) {
      return legacy
        .map((value) => (value === 'last' ? 'last' : typeof value === 'number' ? (value + 1) as RoutineWeek : undefined))
        .filter((value): value is RoutineWeek => value === 'last' || typeof value === 'number');
    }
    const single = this.getMonthlyWeek(fm);
    return single ? [single] : [];
  }

  private getMonthlyWeekdaySet(fm: RoutineFrontmatter): number[] {
    if (Array.isArray(fm.routine_weekdays) && fm.routine_weekdays.length) {
      return fm.routine_weekdays.filter((value) => Number.isInteger(value));
    }
    const legacy = (fm as Record<string, unknown>).monthly_weekdays;
    if (Array.isArray(legacy)) {
      return legacy.filter((value) => Number.isInteger(value));
    }
    const single = this.getMonthlyWeekday(fm);
    return typeof single === 'number' ? [single] : [];
  }

  private async updateRoutineEnabled(file: TFile, enabled: boolean): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (frontmatter: RoutineFrontmatter) => {
      frontmatter.routine_enabled = enabled;
      return frontmatter;
    });
    new Notice(
      enabled
        ? this.tv('notices.toggledOn', 'Enabled')
        : this.tv('notices.toggledOff', 'Disabled'),
      1200,
    );
  }

  private async removeRoutine(file: TFile): Promise<boolean> {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    let success = false;
    await this.app.fileManager.processFrontMatter(file, (frontmatter: RoutineFrontmatter) => {
      frontmatter.isRoutine = false;
      frontmatter.routine_end = `${yyyy}-${mm}-${dd}`;
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- cleaning up legacy Japanese field name for backwards compatibility
      delete frontmatter['開始時刻'];
      success = true;
      return frontmatter;
    });
    if (success) {
      new Notice(this.tv('notices.removed', 'Removed from routine'), 1200);
      this.refreshActiveView();
    }
    return success;
  }

  private refreshRow(
    file: TFile,
    expectedEnabled?: boolean,
    frontmatterOverride?: RoutineFrontmatter,
  ): void {
    const fresh = frontmatterOverride ?? this.getRoutineFrontmatter(file);
    if (!fresh) return;

    const enabledFromFresh = fresh.routine_enabled !== false;
    const enabled = typeof expectedEnabled === 'boolean' ? expectedEnabled : enabledFromFresh;
    const merged: RoutineFrontmatter = { ...fresh, routine_enabled: enabled };

    this.updateRowCaches(file, merged);
    this.renderTable();
  }

  private updateRowCaches(file: TFile, updated: RoutineFrontmatter): void {
    this.rows = this.rows.map((row) =>
      row.file.path === file.path ? { ...row, fm: updated } : row,
    );
    this.filtered = this.filtered.map((row) =>
      row.file.path === file.path ? { ...row, fm: updated } : row,
    );
  }

  private removeRowFromCaches(path: string): void {
    this.rows = this.rows.filter((row) => row.file.path !== path);
    this.filtered = this.filtered.filter((row) => row.file.path !== path);
  }

  private reloadAll(): void {
    this.loadRows();
    this.applyFilters();
    this.refreshActiveView();
  }

  private async openRoutineFile(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
  }

  private toRoutineFrontmatter(value: unknown): RoutineFrontmatter | null {
    if (!value || typeof value !== 'object') return null;
    return value as RoutineFrontmatter;
  }

  private getRoutineFrontmatter(file: TFile): RoutineFrontmatter | null {
    const cache = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return this.toRoutineFrontmatter(cache);
  }

  private refreshActiveView(): void {
    const leaves = this.app.workspace.getLeavesOfType('taskchute-view');
    const leaf = leaves[0] as WorkspaceLeaf | undefined;
    const view = leaf?.view as TaskChuteViewLike | undefined;
    if (view?.reloadTasksAndRestore) {
      try {
        void Promise.resolve(view.reloadTasksAndRestore({ runBoundaryCheck: true }));
      } catch (error) {
        console.error('RoutineManagerModal view refresh failed', error);
      }
    }
  }
}

export default RoutineManagerModal;
