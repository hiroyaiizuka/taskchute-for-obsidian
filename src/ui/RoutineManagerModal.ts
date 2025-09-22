import { App, Modal, Notice, TFile } from 'obsidian';
import { TaskChutePluginLike } from '../types';
import RoutineEditModal from './RoutineEditModal';

type RoutineRow = {
  file: TFile;
  fm: any;
};

export class RoutineManagerModal extends Modal {
  private plugin: TaskChutePluginLike;
  private rows: RoutineRow[] = [];
  private filtered: RoutineRow[] = [];
  private searchInput!: HTMLInputElement;
  // filters were simplified: only text search
  private tableBody!: HTMLElement;

  constructor(app: App, plugin: TaskChutePluginLike) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('routine-manager');
    // widen modal
    try {
      (this.modalEl as HTMLElement).setAttr('style', 'width:90vw; max-width: 1400px; height:80vh;');
    } catch (_) {}

    // Header
    const header = contentEl.createEl('div', { cls: 'routine-manager__header' });
    header.createEl('h3', { text: 'ルーチン管理' });

    const controls = header.createEl('div', { cls: 'routine-manager__controls' });
    this.searchInput = controls.createEl('input', { type: 'search', attr: { placeholder: '検索（タイトル/パス）' } }) as HTMLInputElement;
    this.searchInput.addEventListener('input', () => this.applyFilters());
    // simplified: type/status filters removed from UI

    // Body (2 columns)
    const body = contentEl.createEl('div', { cls: 'routine-manager__body' });
    body.setAttr('style', 'max-height:70vh;');
    const left = body.createEl('div', { cls: 'routine-manager__list' });
    left.setAttr('style', 'overflow:auto; border:1px solid var(--background-modifier-border); border-radius:6px;');

    // Table
    const table = left.createEl('div', { cls: 'routine-table' });
    const thead = table.createEl('div', { cls: 'routine-table__head' });
    const headRow = thead.createEl('div', { cls: 'routine-table__row routine-table__row--head' });
    headRow.setAttr('style', 'display:grid; grid-template-columns: 1.2fr 0.6fr 0.4fr 0.8fr 0.4fr 0.9fr 0.9fr 0.4fr 0.6fr; gap:8px; padding:6px 8px; border-bottom:1px solid var(--background-modifier-border); position:sticky; top:0; background:var(--background-primary); z-index:1;');
    ;[
      'タイトル',
      'タイプ',
      '間隔',
      '曜日',
      '週',
      '開始日',
      '終了日',
      '有効',
      '操作',
    ].forEach((label) => headRow.createEl('div', { cls: 'routine-table__cell', text: label }));

    this.tableBody = table.createEl('div', { cls: 'routine-table__body' });

    // Load data and render
    this.loadRows();
    this.applyFilters();
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }

  private loadRows(): void {
    const taskFolderPath = this.plugin.pathManager.getTaskFolderPath();
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(taskFolderPath + '/'))
      .sort((a, b) => a.basename.localeCompare(b.basename, 'ja'));

    this.rows = files
      .map((file) => {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        return fm?.isRoutine === true ? { file, fm } : null;
      })
      .filter((x): x is RoutineRow => !!x);
  }

  private applyFilters(): void {
    const q = (this.searchInput?.value || '').toLowerCase();

    this.filtered = this.rows.filter(({ file, fm }) => {
      if (q) {
        const hay = (file.basename + ' ' + file.path).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    this.renderTable();
  }

  private renderTable(): void {
    this.tableBody.empty();
    const dayNames = ['日', '月', '火', '水', '木', '金', '土'];

    if (this.filtered.length === 0) {
      const emptyRow = this.tableBody.createEl('div', { cls: 'routine-empty', text: 'ルーチンが見つかりません' });
      emptyRow.setAttr('style', 'padding: 8px; color: var(--text-muted);');
      return;
    }

    this.filtered.forEach(({ file, fm }, idx) => {
      const rowEl = this.tableBody.createEl('div', { cls: 'routine-table__row' });
      const baseRowStyle = 'display:grid; grid-template-columns: 1.2fr 0.6fr 0.4fr 0.8fr 0.4fr 0.9fr 0.9fr 0.4fr 0.6fr; gap:8px; padding:6px 8px; border-bottom:1px solid var(--background-modifier-border); align-items:center;';
      rowEl.setAttr('style', baseRowStyle);

      // Title as wikilink-style clickable
      const titleCell = rowEl.createEl('div', { cls: 'routine-table__cell' });
      const link = titleCell.createEl('a', { text: file.basename, attr: { href: '#' } });
      link.setAttr('style', 'font-size:0.92em; line-height:1.2;');
      link.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
          // open target note
          await this.app.workspace.getLeaf(true).openFile(file);
          this.close();
        } catch (err) {
          new Notice('ノートを開けませんでした');
        }
      });

      // Type
      const type = (fm.routine_type || 'daily') as string;
      rowEl.createEl('div', { cls: 'routine-table__cell', text: this.typeLabel(type) });

      // Interval
      rowEl.createEl('div', { cls: 'routine-table__cell', text: String(Math.max(1, Number(fm.routine_interval || 1))) });

      // Weekday (weekly/monthly)
      let weekdayText = '';
      if (type === 'weekly') {
        if (Array.isArray((fm as any).weekdays) && (fm as any).weekdays.length > 0) {
          weekdayText = (fm as any).weekdays.map((n: number) => dayNames[n] + '曜').join(', ');
        } else if (typeof fm.routine_weekday === 'number' || typeof fm.weekday === 'number') {
          const wd = (fm.routine_weekday ?? fm.weekday) as number;
          weekdayText = dayNames[wd] + '曜';
        } else {
          weekdayText = '-';
        }
      } else if (type === 'monthly') {
        const wd = (fm.routine_weekday ?? fm.monthly_weekday) as number | undefined;
        weekdayText = typeof wd === 'number' ? dayNames[wd] + '曜' : '-';
      } else {
        weekdayText = '-';
      }
      rowEl.createEl('div', { cls: 'routine-table__cell', text: weekdayText });

      // Week (monthly only)
      let weekText = '-';
      if (type === 'monthly') {
        const w = fm.routine_week ?? (typeof fm.monthly_week === 'number' ? fm.monthly_week + 1 : fm.monthly_week);
        weekText = w === 'last' ? '最終' : (w ? `第${w}` : '-');
      }
      rowEl.createEl('div', { cls: 'routine-table__cell', text: String(weekText) });

      // Start / End
      rowEl.createEl('div', { cls: 'routine-table__cell', text: fm.routine_start || '-' });
      rowEl.createEl('div', { cls: 'routine-table__cell', text: fm.routine_end || '-' });

      // Enabled indicator (check / cross)
      const enabledCell = rowEl.createEl('div', { cls: 'routine-table__cell' });
      const isEnabled = fm.routine_enabled !== false;
      const indicator = enabledCell.createEl('button', { text: isEnabled ? '✓' : '×', attr: { title: 'クリックで有効/無効切替' } }) as HTMLButtonElement;
      indicator.setAttr('style', 'width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--background-modifier-border);border-radius:6px;background:transparent;cursor:pointer;');
      indicator.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const current = (this.filtered.find((r) => r.file.path === file.path)?.fm?.routine_enabled !== false);
        const newVal = !current;
        // optimistic visual update
        indicator.textContent = newVal ? '✓' : '×';
        // update caches
        const idxRows = this.rows.findIndex((r) => r.file.path === file.path);
        if (idxRows >= 0) this.rows[idxRows].fm = { ...this.rows[idxRows].fm, routine_enabled: newVal };
        const idxFiltered = this.filtered.findIndex((r) => r.file.path === file.path);
        if (idxFiltered >= 0) this.filtered[idxFiltered].fm = { ...this.filtered[idxFiltered].fm, routine_enabled: newVal };
        // re-render quickly
        this.renderTable();
        // persist
        await this.updateRoutineEnabled(file, newVal);
        // delayed sync from metadata
        setTimeout(() => this.refreshRow(file, newVal), 200);
        this.refreshActiveView();
      });

      // Actions
      const actions = rowEl.createEl('div', { cls: 'routine-table__cell' });
      const editBtn = actions.createEl('button', { text: '編集' });
      const delBtn = actions.createEl('button', { text: '🗑️', attr: { title: 'ルーチンを外す' } });
      editBtn.setAttr('style', 'margin-right:6px;');

      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const { file: f } = this.filtered[idx];
        new RoutineEditModal(this.app, this.plugin, f, () => {
          // callback after save
          this.refreshRow(f);
        }).open();
      });

      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = confirm(`「${file.basename}」をルーチンから外しますか？`);
        if (!ok) return;
        await this.removeRoutine(file);
        await this.reloadAll();
      });

      // no row select behavior
    });
  }


  private typeLabel(type: string): string {
    switch (type) {
      case 'daily': return '日ごと';
      case 'weekly': return '週ごと';
      case 'monthly': return '月ごと';
      default: return type;
    }
  }

  private async updateRoutineEnabled(file: TFile, enabled: boolean): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter.routine_enabled = enabled;
      return frontmatter;
    });
    new Notice(enabled ? '有効化しました' : '無効化しました', 1200);
  }

  private async removeRoutine(file: TFile): Promise<void> {
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter.isRoutine = false;
      frontmatter.routine_end = `${y}-${m}-${d}`;
      delete frontmatter['開始時刻'];
      return frontmatter;
    });
    new Notice('ルーチンを外しました', 1200);
    this.refreshActiveView();
  }

  private async refreshRow(file: TFile, expectedEnabled?: boolean): Promise<void> {
    // Update cached fm from metadataCache, but if cache lags keep optimistic value
    const fresh = this.app.metadataCache.getFileCache(file)?.frontmatter || null;
    if (!fresh) return;
    const apply = (fmOld: any) => {
      const enabledFromFresh = fresh.routine_enabled !== false;
      const enabled = (typeof expectedEnabled === 'boolean') ? expectedEnabled : enabledFromFresh;
      return { ...fresh, routine_enabled: enabled };
    };
    const idx = this.rows.findIndex((r) => r.file.path === file.path);
    if (idx >= 0) this.rows[idx].fm = apply(this.rows[idx].fm);
    const fidx = this.filtered.findIndex((r) => r.file.path === file.path);
    if (fidx >= 0) this.filtered[fidx].fm = apply(this.filtered[fidx].fm);
    this.renderTable();
  }

  private async reloadAll(): Promise<void> {
    this.loadRows();
    this.applyFilters();
    this.refreshActiveView();
  }

  private refreshActiveView(): void {
    try {
      const leaves = this.app.workspace.getLeavesOfType('taskchute-view');
      const view = (leaves && leaves[0] && (leaves[0] as any).view) || null;
      if (view && typeof (view as any).reloadTasksAndRestore === 'function') {
        (view as any).reloadTasksAndRestore({ runBoundaryCheck: true });
      }
    } catch (_) {}
  }
}

export default RoutineManagerModal;
