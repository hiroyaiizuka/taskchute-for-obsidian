import { App, Modal, Notice, TFile, WorkspaceLeaf } from 'obsidian';

import {
  RoutineFrontmatter,
  RoutineType,
  RoutineWeek,
  TaskChutePluginLike,
} from '../types';
import { getScheduledTime } from '../utils/fieldMigration';
import RoutineEditModal from './RoutineEditModal';

interface RoutineRow {
  file: TFile;
  fm: RoutineFrontmatter;
}

interface TaskChuteViewLike {
  reloadTasksAndRestore?(options?: { runBoundaryCheck?: boolean }): unknown;
}

const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

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

    contentEl.createEl('h3', { text: '確認' });
    contentEl.createEl('p', { text: this.message });

    const buttonRow = contentEl.createEl('div', { cls: 'routine-confirm__buttons' });
    const confirmBtn = buttonRow.createEl('button', { text: '削除', cls: 'routine-confirm__button mod-danger' });
    const cancelBtn = buttonRow.createEl('button', { text: 'キャンセル', cls: 'routine-confirm__button' });

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

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('routine-manager');
    this.modalEl?.classList.add('routine-manager-modal');

    const header = contentEl.createEl('div', { cls: 'routine-manager__header' });
    header.createEl('h3', { text: 'ルーチン管理' });

    const controls = header.createEl('div', { cls: 'routine-manager__controls' });
    this.searchInput = controls.createEl('input', {
      type: 'search',
      attr: { placeholder: '検索（タイトル / パス）' },
    }) as HTMLInputElement;
    this.searchInput.addEventListener('input', () => this.applyFilters());

    const body = contentEl.createEl('div', { cls: 'routine-manager__body' });
    const tableWrapper = body.createEl('div', { cls: 'routine-table__wrapper' });

    const table = tableWrapper.createEl('div', { cls: 'routine-table' });
    const headRow = table.createEl('div', { cls: 'routine-table__row routine-table__row--head' });
    const headerLabels = [
      'タイトル',
      'タイプ',
      '間隔',
      '曜日',
      '週',
      '開始予定時刻',
      '開始日',
      '終了日',
      '有効',
    ];
    headerLabels.forEach((label) => {
      headRow.createEl('div', { cls: 'routine-table__cell', text: label });
    });

    const actionsHeaderCell = headRow.createEl('div', {
      cls: 'routine-table__cell routine-table__cell--actions routine-table__cell--actions-header',
    });
    actionsHeaderCell.setAttr('aria-label', '操作');

    this.tableBody = table.createEl('div', { cls: 'routine-table__body' });

    this.loadRows();
    this.applyFilters();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private loadRows(): void {
    const taskFolderPath = this.plugin.pathManager.getTaskFolderPath();
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path.startsWith(`${taskFolderPath}/`))
      .sort((a, b) => a.basename.localeCompare(b.basename, 'ja'));

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
        text: 'ルーチンが見つかりません',
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
      attr: { title: 'クリックで有効/無効を切り替え' },
    }) as HTMLButtonElement;

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
      text: '編集',
      cls: 'routine-table__action-button',
    });
    const deleteBtn = actionsCell.createEl('button', {
      text: '🗑️',
      cls: 'routine-table__action-button routine-table__action-button--danger',
      attr: { title: 'ルーチンを外す' },
    });

    editBtn.addEventListener('click', () => {
      const { file: currentFile } = this.filtered[index];
      new RoutineEditModal(this.app, this.plugin, currentFile, (updatedFm) => {
        void this.refreshRow(currentFile, undefined, updatedFm);
      }).open();
    });

    deleteBtn.addEventListener('click', async () => {
      const message = `「${file.basename}」をルーチンから外しますか？`;
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
        return '日ごと';
      case 'weekly':
        return '週ごと';
      case 'monthly':
        return '月ごと';
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
          .map((day) => DAY_NAMES[Number(day)] + '曜')
          .join(', ');
      }
      if (typeof fm.routine_weekday === 'number') {
        return `${DAY_NAMES[fm.routine_weekday]}曜`;
      }
      if (typeof fm.weekday === 'number') {
        return `${DAY_NAMES[fm.weekday]}曜`;
      }
    }

    if (fm.routine_type === 'monthly') {
      const weekday = this.getMonthlyWeekday(fm);
      if (typeof weekday === 'number') {
        return `${DAY_NAMES[weekday]}曜`;
      }
    }

    return '-';
  }

  private weekLabel(fm: RoutineFrontmatter): string {
    if (fm.routine_type !== 'monthly') return '-';
    const week = this.getMonthlyWeek(fm);
    if (week === 'last') return '最終';
    if (typeof week === 'number') return `第${week}`;
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

  private async updateRoutineEnabled(file: TFile, enabled: boolean): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (frontmatter: RoutineFrontmatter) => {
      frontmatter.routine_enabled = enabled;
      return frontmatter;
    });
    new Notice(enabled ? '有効化しました' : '無効化しました', 1200);
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
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      delete frontmatter['開始時刻'];
      success = true;
      return frontmatter;
    });
    if (success) {
      new Notice('ルーチンを外しました', 1200);
      this.refreshActiveView();
    }
    return success;
  }

  private async refreshRow(
    file: TFile,
    expectedEnabled?: boolean,
    frontmatterOverride?: RoutineFrontmatter,
  ): Promise<void> {
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

  private async reloadAll(): Promise<void> {
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
