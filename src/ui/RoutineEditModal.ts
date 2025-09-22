import { App, Modal, Notice, TFile } from 'obsidian';

import { TaskChutePluginLike } from '../types';

export default class RoutineEditModal extends Modal {
  private plugin: TaskChutePluginLike;
  private file: TFile;
  private onSaved?: () => void;

  constructor(app: App, plugin: TaskChutePluginLike, file: TFile, onSaved?: () => void) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    this.onSaved = onSaved;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    try { (this.modalEl as HTMLElement).setAttr('style', 'width:600px;'); } catch (_) {}

    const fm = this.app.metadataCache.getFileCache(this.file)?.frontmatter || {};
    const dayNames = ['日', '月', '火', '水', '木', '金', '土'];

    contentEl.createEl('h4', { text: `「${this.file.basename}」のルーチン設定` });

    const form = contentEl.createEl('div', { cls: 'routine-form' });

    // Type
    const typeGroup = form.createEl('div', { cls: 'form-group' });
    typeGroup.createEl('label', { text: 'タイプ:' });
    const typeSelect = typeGroup.createEl('select') as HTMLSelectElement;
    ;[
      ['daily', '日ごと'],
      ['weekly', '週ごと（曜日）'],
      ['monthly', '月ごと（第n x曜日）'],
    ].forEach(([v, t]) => typeSelect.add(new Option(t, v)));
    typeSelect.value = (fm.routine_type || 'daily') as string;

    // Start time
    const timeGroup = form.createEl('div', { cls: 'form-group' });
    timeGroup.createEl('label', { text: '開始予定時刻:' });
    const timeInput = timeGroup.createEl('input', { type: 'time' }) as HTMLInputElement;
    timeInput.value = (fm['開始時刻'] || '');

    // Interval
    const intervalGroup = form.createEl('div', { cls: 'form-group' });
    intervalGroup.createEl('label', { text: '間隔:' });
    const intervalInput = intervalGroup.createEl('input', { type: 'number', attr: { min: '1', step: '1' } }) as HTMLInputElement;
    intervalInput.value = String(Math.max(1, Number(fm.routine_interval || 1)));

    // Enabled
    const enabledGroup = form.createEl('div', { cls: 'form-group' });
    const enabledLabel = enabledGroup.createEl('label', { text: '有効:' });
    const enabledToggle = enabledGroup.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
    enabledToggle.checked = fm.routine_enabled !== false;
    enabledLabel.setAttr('style', 'margin-right: 6px;');

    // Start / End dates
    const datesGroup = form.createEl('div', { cls: 'form-group' });
    datesGroup.createEl('label', { text: '開始日:' });
    const startInput = datesGroup.createEl('input', { type: 'date' }) as HTMLInputElement;
    startInput.value = fm.routine_start || '';
    datesGroup.createEl('label', { text: '終了日:', attr: { style: 'margin-left:8px;' } });
    const endInput = datesGroup.createEl('input', { type: 'date' }) as HTMLInputElement;
    endInput.value = fm.routine_end || '';

    // Weekly group
    const weeklyGroup = form.createEl('div', { cls: 'form-group', attr: { 'data-kind': 'weekly' } });
    weeklyGroup.createEl('div', { text: '曜日（複数選択可）:' });
    const weekdayCbs: HTMLInputElement[] = [];
    for (let i = 0; i < 7; i++) {
      const label = weeklyGroup.createEl('label', { attr: { style: 'margin-right:8px;' } });
      const cb = label.createEl('input', { type: 'checkbox', attr: { value: String(i) } }) as HTMLInputElement;
      label.appendText(' ' + dayNames[i]);
      weekdayCbs.push(cb);
    }
    if (typeSelect.value === 'weekly') {
      const set: number[] | null = Array.isArray((fm as any).weekdays) ? (fm as any).weekdays : null;
      if (set) set.forEach((n) => { if (weekdayCbs[n]) weekdayCbs[n].checked = true; });
      else {
        const single = (fm.routine_weekday ?? fm.weekday) as number | undefined;
        if (typeof single === 'number' && weekdayCbs[single]) weekdayCbs[single].checked = true;
      }
    }

    // Monthly group
    const monthlyGroup = form.createEl('div', { cls: 'form-group', attr: { 'data-kind': 'monthly' } });
    monthlyGroup.createEl('label', { text: '第:' });
    const weekSelect = monthlyGroup.createEl('select') as HTMLSelectElement;
    ;['1', '2', '3', '4', '5', 'last'].forEach((v) => weekSelect.add(new Option(v === 'last' ? '最終' : `第${v}`, v)));
    monthlyGroup.createEl('label', { text: ' の ' });
    const monthWeekdaySelect = monthlyGroup.createEl('select') as HTMLSelectElement;
    for (let i = 0; i < 7; i++) monthWeekdaySelect.add(new Option(dayNames[i] + '曜', String(i)));
    if (typeSelect.value === 'monthly') {
      const w = fm.routine_week ?? (typeof fm.monthly_week === 'number' ? fm.monthly_week + 1 : fm.monthly_week);
      weekSelect.value = (w === 'last' ? 'last' : String(w || '1'));
      const wd = (fm.routine_weekday ?? fm.monthly_weekday) as number | undefined;
      monthWeekdaySelect.value = String(typeof wd === 'number' ? wd : 1);
    }

    const updateVisibility = () => {
      weeklyGroup.toggleClass('is-hidden', typeSelect.value !== 'weekly');
      monthlyGroup.toggleClass('is-hidden', typeSelect.value !== 'monthly');
    };
    updateVisibility();
    typeSelect.addEventListener('change', updateVisibility);

    // Buttons
    const btns = contentEl.createEl('div', { cls: 'routine-editor__buttons' });
    const saveBtn = btns.createEl('button', { text: '保存' });
    const cancelBtn = btns.createEl('button', { text: 'キャンセル' });
    saveBtn.setAttr('style', 'margin-right:8px;');

    saveBtn.addEventListener('click', async () => {
      const errors: string[] = [];
      const routineType = typeSelect.value;
      const interval = Math.max(1, Number(intervalInput.value || 1));
      if (!Number.isFinite(interval) || interval < 1) errors.push('間隔は1以上の整数で指定してください');

      const start = (startInput.value || '').trim();
      const end = (endInput.value || '').trim();
      const isDate = (s: string) => !s || /^\d{4}-\d{2}-\d{2}$/.test(s);
      if (!isDate(start)) errors.push('開始日は YYYY-MM-DD 形式で指定してください');
      if (!isDate(end)) errors.push('終了日は YYYY-MM-DD 形式で指定してください');
      if (start && end && start > end) errors.push('終了日は開始日以降で指定してください');

      let weeklyDays: number[] | undefined;
      let monthlyWeek: number | 'last' | undefined;
      let monthlyWeekday: number | undefined;

      if (routineType === 'weekly') {
        weeklyDays = weekdayCbs.filter((cb) => cb.checked).map((cb) => parseInt(cb.value, 10));
        if (!weeklyDays || weeklyDays.length === 0) errors.push('曜日を1つ以上選択してください');
      } else if (routineType === 'monthly') {
        monthlyWeek = (weekSelect.value === 'last') ? 'last' : parseInt(weekSelect.value, 10);
        monthlyWeekday = parseInt(monthWeekdaySelect.value, 10);
        if (!monthlyWeek || (!Number.isFinite(monthlyWeekday))) errors.push('「第n + 曜日」を選択してください');
      }

      if (errors.length > 0) {
        new Notice(errors[0]);
        return;
      }

      await this.app.fileManager.processFrontMatter(this.file, (frontmatter) => {
        frontmatter.routine_type = routineType;
        frontmatter.routine_interval = interval;
        frontmatter.routine_enabled = enabledToggle.checked;

        const t = (timeInput.value || '').trim();
        if (t) frontmatter['開始時刻'] = t; else delete frontmatter['開始時刻'];

        if (start) frontmatter.routine_start = start; else delete frontmatter.routine_start;
        if (end) frontmatter.routine_end = end; else delete frontmatter.routine_end;

        delete frontmatter.routine_week;
        delete frontmatter.routine_weekday;
        delete (frontmatter as any).weekday;
        delete (frontmatter as any).weekdays;
        delete (frontmatter as any).monthly_week;
        delete (frontmatter as any).monthly_weekday;

        if (routineType === 'weekly') {
          if (weeklyDays && weeklyDays.length === 1) {
            frontmatter.routine_weekday = weeklyDays[0];
          } else if (weeklyDays && weeklyDays.length > 1) {
            (frontmatter as any).weekdays = weeklyDays;
          }
        } else if (routineType === 'monthly') {
          if (monthlyWeek) (frontmatter as any).routine_week = monthlyWeek as any;
          if (Number.isFinite(monthlyWeekday)) (frontmatter as any).routine_weekday = monthlyWeekday as any;
        }
        return frontmatter;
      });

      try { this.onSaved?.(); } catch (_) {}
      try {
        const leaves = this.app.workspace.getLeavesOfType('taskchute-view');
        const view = (leaves && leaves[0] && (leaves[0] as any).view) || null;
        if (view && typeof (view as any).reloadTasksAndRestore === 'function') {
          (view as any).reloadTasksAndRestore({ runBoundaryCheck: true });
        }
      } catch (_) {}
      new Notice('保存しました', 1500);
      this.close();
    });

    cancelBtn.addEventListener('click', () => this.close());
  }
}

