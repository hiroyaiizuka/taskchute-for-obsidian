import { App, Modal, Notice, TFile, WorkspaceLeaf } from 'obsidian';

import { t } from '../../i18n';

import { RoutineFrontmatter, RoutineWeek, TaskChutePluginLike, RoutineType } from '../../types';
import { TaskValidator } from '../../services/TaskValidator';
import { getScheduledTime, setScheduledTime } from '../../utils/fieldMigration';
import { applyRoutineFrontmatterMerge } from '../../services/RoutineFrontmatterUtils';

interface TaskChuteViewLike {
  reloadTasksAndRestore?(options?: { runBoundaryCheck?: boolean }): unknown;
}

const ROUTINE_TYPE_DEFAULTS: Array<{ value: RoutineType; label: string }> = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly (weekday)' },
  { value: 'monthly', label: 'Monthly (Nth weekday)' },
];

const WEEK_OPTION_DEFAULTS: Array<{ value: RoutineWeek; label: string }> = [
  { value: 1, label: '1st' },
  { value: 2, label: '2nd' },
  { value: 3, label: '3rd' },
  { value: 4, label: '4th' },
  { value: 5, label: '5th' },
  { value: 'last', label: 'Last' },
];

const DEFAULT_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default class RoutineEditModal extends Modal {
  private readonly plugin: TaskChutePluginLike;
  private readonly file: TFile;
  private readonly onSaved?: (frontmatter: RoutineFrontmatter) => void;

  constructor(
    app: App,
    plugin: TaskChutePluginLike,
    file: TFile,
    onSaved?: (frontmatter: RoutineFrontmatter) => void,
  ) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    this.onSaved = onSaved;
  }

  private tv(
    key: string,
    fallback: string,
    vars?: Record<string, string | number>,
  ): string {
    return t(`routineEdit.${key}`, fallback, vars);
  }

  private getTypeOptions(): Array<{ value: RoutineType; label: string }> {
    return ROUTINE_TYPE_DEFAULTS.map(({ value, label }) => ({
      value,
      label: this.tv(`types.${value}`, label),
    }));
  }

  private getWeekOptions(): Array<{ value: RoutineWeek; label: string }> {
    const keyMap: Record<string, string> = {
      '1': 'weekOptions.first',
      '2': 'weekOptions.second',
      '3': 'weekOptions.third',
      '4': 'weekOptions.fourth',
      '5': 'weekOptions.fifth',
      last: 'weekOptions.last',
    };
    return WEEK_OPTION_DEFAULTS.map(({ value, label }) => {
      const key = keyMap[String(value)] ?? 'weekOptions.first';
      return { value, label: this.tv(key, label) };
    });
  }

  private getWeekdayLabels(): string[] {
    const keys = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
    return keys.map((key, index) =>
      t(`routineManager.weekdays.${key}`, DEFAULT_DAY_NAMES[index] ?? DEFAULT_DAY_NAMES[0]),
    );
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl?.classList.add('routine-edit-modal');

    const frontmatter = this.getFrontmatterSnapshot();
    const initialType = this.normalizeRoutineType(frontmatter.routine_type);

    contentEl.createEl('h4', {
      text: this.tv('title', `Routine settings for "${this.file.basename}"`, {
        name: this.file.basename,
      }),
    });

    const form = contentEl.createEl('div', { cls: 'routine-form' });

    // Type selector
    const typeGroup = form.createEl('div', { cls: 'form-group' });
    typeGroup.createEl('label', {
      text: this.tv('fields.typeLabel', 'Type:'),
    });
    const typeSelect = typeGroup.createEl('select') as HTMLSelectElement;
    this.getTypeOptions().forEach(({ value, label }) => {
      typeSelect.add(new Option(label, value));
    });
    typeSelect.value = initialType;

    // Start time
    const timeGroup = form.createEl('div', { cls: 'form-group' });
    timeGroup.createEl('label', {
      text: this.tv('fields.startTimeLabel', 'Scheduled time:'),
    });
    const timeInput = timeGroup.createEl('input', { type: 'time' }) as HTMLInputElement;
    timeInput.value = getScheduledTime(frontmatter) || '';

    // Interval
    const intervalGroup = form.createEl('div', { cls: 'form-group' });
    intervalGroup.createEl('label', {
      text: this.tv('fields.intervalLabel', 'Interval:'),
    });
    const intervalInput = intervalGroup.createEl('input', {
      type: 'number',
      attr: { min: '1', step: '1' },
    }) as HTMLInputElement;
    intervalInput.value = String(Math.max(1, Number(frontmatter.routine_interval ?? 1)));

    // Enabled toggle
    const enabledGroup = form.createEl('div', { cls: 'form-group form-group--inline' });
    const enabledLabel = enabledGroup.createEl('label', {
      text: this.tv('fields.enabledLabel', 'Enabled:'),
    });
    enabledLabel.classList.add('routine-form__inline-label');
    const enabledToggle = enabledGroup.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
    enabledToggle.checked = frontmatter.routine_enabled !== false;

    // Start / End dates
    const datesGroup = form.createEl('div', { cls: 'form-group form-group--date-range' });
    datesGroup.createEl('label', {
      text: this.tv('fields.startDateLabel', 'Start date:'),
    });
    const startInput = datesGroup.createEl('input', { type: 'date' }) as HTMLInputElement;
    startInput.value = typeof frontmatter.routine_start === 'string' ? frontmatter.routine_start : '';
    const endLabel = datesGroup.createEl('label', {
      text: this.tv('fields.endDateLabel', 'End date:'),
    });
    endLabel.classList.add('routine-form__inline-label', 'routine-form__inline-label--gap');
    const endInput = datesGroup.createEl('input', { type: 'date' }) as HTMLInputElement;
    endInput.value = typeof frontmatter.routine_end === 'string' ? frontmatter.routine_end : '';

    // Weekly controls
    const weeklyGroup = form.createEl('div', {
      cls: 'form-group routine-form__weekly',
      attr: { 'data-kind': 'weekly' },
    });
    weeklyGroup.createEl('div', {
      text: this.tv('fields.weekdaysLabel', 'Weekdays (multi-select):'),
    });
    const weekdayInputs: HTMLInputElement[] = [];
    const weekdayLabels = this.getWeekdayLabels();
    for (let i = 0; i < weekdayLabels.length; i++) {
      const checkboxLabel = weeklyGroup.createEl('label');
      checkboxLabel.classList.add('routine-form__checkbox-label');
      const checkbox = checkboxLabel.createEl('input', {
        type: 'checkbox',
        attr: { value: String(i) },
      }) as HTMLInputElement;
      checkboxLabel.appendChild(document.createTextNode(` ${weekdayLabels[i]}`));
      weekdayInputs.push(checkbox);
    }
    this.applyWeeklySelection(weekdayInputs, frontmatter);

    // Monthly controls
    const monthlyGroup = form.createEl('div', {
      cls: 'form-group routine-form__monthly',
      attr: { 'data-kind': 'monthly' },
    });
    monthlyGroup.createEl('label', {
      text: this.tv('fields.monthWeekLabel', 'Week:'),
    });
    const weekSelect = monthlyGroup.createEl('select') as HTMLSelectElement;
    this.getWeekOptions().forEach(({ value, label }) => {
      weekSelect.add(new Option(label, value === 'last' ? 'last' : String(value)));
    });
    monthlyGroup.createEl('label', {
      text: this.tv('fields.monthWeekSuffix', ' of '),
    });
    const monthWeekdaySelect = monthlyGroup.createEl('select') as HTMLSelectElement;
    weekdayLabels.forEach((day, index) => {
      monthWeekdaySelect.add(
        new Option(
          `${day}${this.tv('fields.monthWeekdaySuffix', ' weekday')}`,
          String(index),
        ),
      );
    });
    this.applyMonthlySelection(weekSelect, monthWeekdaySelect, frontmatter);

    const updateVisibility = () => {
      const selected = this.normalizeRoutineType(typeSelect.value);
      weeklyGroup.classList.toggle('is-hidden', selected !== 'weekly');
      monthlyGroup.classList.toggle('is-hidden', selected !== 'monthly');
    };
    updateVisibility();
    typeSelect.addEventListener('change', updateVisibility);

    // Buttons
    const buttonRow = contentEl.createEl('div', { cls: 'routine-editor__buttons' });
    const saveButton = buttonRow.createEl('button', {
      text: this.tv('fields.saveButton', 'Save'),
    });
    saveButton.classList.add('routine-editor__button', 'routine-editor__button--primary');
    const cancelButton = buttonRow.createEl('button', {
      text: this.tv('fields.cancelButton', 'Cancel'),
    });
    cancelButton.classList.add('routine-editor__button');

    saveButton.addEventListener('click', async () => {
      const errors: string[] = [];
      const routineType = this.normalizeRoutineType(typeSelect.value);
      const interval = Math.max(1, Number(intervalInput.value || 1));
      if (!Number.isFinite(interval) || interval < 1) {
        errors.push(this.tv('errors.intervalInvalid', 'Interval must be an integer of 1 or greater.'));
      }

      const start = (startInput.value || '').trim();
      const end = (endInput.value || '').trim();
      const isDate = (value: string) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
      if (!isDate(start)) {
        errors.push(this.tv('errors.startDateFormat', 'Start date must use YYYY-MM-DD format.'));
      }
      if (!isDate(end)) {
        errors.push(this.tv('errors.endDateFormat', 'End date must use YYYY-MM-DD format.'));
      }
      if (start && end && start > end) {
        errors.push(this.tv('errors.endBeforeStart', 'End date must be on or after the start date.'));
      }

      const weeklyDays = this.getCheckedDays(weekdayInputs);
      let monthlyWeek: RoutineWeek | undefined;
      let monthlyWeekday: number | undefined;

      if (routineType === 'weekly' && weeklyDays.length === 0) {
        errors.push(this.tv('errors.weeklyRequiresDay', 'Select at least one weekday.'));
      } else if (routineType === 'monthly') {
        if (weekSelect.value === 'last') {
          monthlyWeek = 'last';
        } else {
          const parsedWeek = Number.parseInt(weekSelect.value, 10);
          if (!Number.isNaN(parsedWeek) && parsedWeek >= 1 && parsedWeek <= 5) {
            monthlyWeek = parsedWeek as RoutineWeek;
          }
        }
        const parsedWeekday = Number.parseInt(monthWeekdaySelect.value, 10);
        if (!Number.isNaN(parsedWeekday) && parsedWeekday >= 0 && parsedWeekday <= 6) {
          monthlyWeekday = parsedWeekday;
        }
        if (monthlyWeek === undefined || monthlyWeekday === undefined) {
          errors.push(this.tv('errors.monthlyRequiresSelection', 'Choose an "Nth + weekday" combination.'));
        }
      }

      if (errors.length > 0) {
        new Notice(errors[0]);
        return;
      }

      let updatedFrontmatter: RoutineFrontmatter | null = null;

      await this.app.fileManager.processFrontMatter(this.file, (fm: RoutineFrontmatter) => {

        // Prepare changes
        const changes: Record<string, unknown> = {
          routine_type: routineType,
          routine_interval: interval,
          routine_enabled: enabledToggle.checked
        };

        const timeValue = (timeInput.value || '').trim();
        if (timeValue) {
          // 新しいフィールド名(scheduled_time)を使用して時刻を設定
          setScheduledTime(changes, timeValue, { preferNew: true });
        }

        if (start) changes.routine_start = start;
        if (end) changes.routine_end = end;

        // Apply cleanup to remove target_date if routine settings changed
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        const hadTargetDate = !!fm.target_date;
        const cleaned = TaskValidator.cleanupOnRoutineChange(fm, changes);
        const hadTemporaryMoveDate = !!fm.temporary_move_date;

        applyRoutineFrontmatterMerge(fm, cleaned, {
          hadTargetDate,
          hadTemporaryMoveDate,
        });

        // Notify if target_date was removed
        if (hadTargetDate && !cleaned.target_date) {
          new Notice(this.tv('notices.legacyTargetDateRemoved', 'Removed legacy target_date automatically.'));
        }

        // Clean up values that should be removed
        if (!timeValue) setScheduledTime(fm, undefined, { preferNew: true });
        if (!start) delete fm.routine_start;
        if (!end) delete fm.routine_end;

        delete fm.weekday;
        delete fm.weekdays;
        delete fm.monthly_week;
        delete fm.monthly_weekday;
        delete fm.routine_week;
        delete fm.routine_weekday;

        if (routineType === 'weekly') {
          if (weeklyDays.length === 1) {
            fm.routine_weekday = weeklyDays[0];
          } else if (weeklyDays.length > 1) {
            fm.weekdays = weeklyDays;
          }
        } else if (routineType === 'monthly') {
          if (monthlyWeek) {
            fm.routine_week = monthlyWeek;
          }
          if (typeof monthlyWeekday === 'number' && Number.isFinite(monthlyWeekday)) {
            fm.routine_weekday = monthlyWeekday;
          }
        }

        updatedFrontmatter = { ...fm };
        return fm;
      });

      await this.handlePostSave(updatedFrontmatter);
      new Notice(this.tv('notices.saved', 'Saved.'), 1500);
      this.close();
    });

    cancelButton.addEventListener('click', () => this.close());
  }

  private getFrontmatterSnapshot(): RoutineFrontmatter {
    const raw = this.app.metadataCache.getFileCache(this.file)?.frontmatter;
    if (raw && typeof raw === 'object') {
      return { ...(raw as RoutineFrontmatter) };
    }
    return {
      isRoutine: true,
      name: this.file.basename ?? 'untitled',
    } as RoutineFrontmatter;
  }

  private normalizeRoutineType(type: unknown): RoutineType {
    if (type === 'weekly' || type === 'monthly') {
      return type;
    }
    return 'daily';
  }

  private applyWeeklySelection(checkboxes: HTMLInputElement[], fm: RoutineFrontmatter): void {
    const selected = this.getWeeklySelection(fm);
    selected.forEach((day) => {
      if (checkboxes[day]) {
        checkboxes[day].checked = true;
      }
    });
  }

  private getWeeklySelection(fm: RoutineFrontmatter): number[] {
    if (Array.isArray(fm.weekdays)) {
      return fm.weekdays.filter(
        (day) => Number.isInteger(day) && day >= 0 && day < DEFAULT_DAY_NAMES.length,
      );
    }
    if (typeof fm.routine_weekday === 'number') {
      return [fm.routine_weekday];
    }
    if (typeof fm.weekday === 'number') {
      return [fm.weekday];
    }
    return [];
  }

  private applyMonthlySelection(
    weekSelect: HTMLSelectElement,
    weekdaySelect: HTMLSelectElement,
    fm: RoutineFrontmatter,
  ): void {
    const week = this.getMonthlyWeek(fm);
    const weekday = this.getMonthlyWeekday(fm);
    weekSelect.value = week === 'last' ? 'last' : String(week ?? 1);
    weekdaySelect.value = String(typeof weekday === 'number' ? weekday : 1);
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

  private getCheckedDays(checkboxes: HTMLInputElement[]): number[] {
    return checkboxes
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => Number.parseInt(checkbox.value, 10))
      .filter((value) => Number.isInteger(value));
  }

  private async handlePostSave(updatedFrontmatter: RoutineFrontmatter | null): Promise<void> {
    if (this.onSaved && updatedFrontmatter) {
      try {
        this.onSaved(updatedFrontmatter);
      } catch (error) {
        console.error('RoutineEditModal onSaved callback failed', error);
      }
    }

    try {
      await this.refreshTaskView();
    } catch (error) {
      console.error('RoutineEditModal failed to refresh view', error);
    }
  }

  private async refreshTaskView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType('taskchute-view');
    if (!leaves.length) return;

    const leaf = leaves[0] as WorkspaceLeaf | undefined;
    const view = leaf?.view as TaskChuteViewLike | undefined;
    if (view?.reloadTasksAndRestore) {
      await Promise.resolve(view.reloadTasksAndRestore({ runBoundaryCheck: true }));
    }
  }
}
