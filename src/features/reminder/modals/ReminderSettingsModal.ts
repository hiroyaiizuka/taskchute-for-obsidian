/**
 * ReminderSettingsModal - Modal for setting reminder time
 *
 * Allows users to input the exact time when reminder notification should fire.
 * Time is stored in HH:mm format.
 */

import { App, Modal } from 'obsidian';
import { t } from '../../../i18n';
import { createModalFooter } from '../../../ui/components/modalFooter';

export interface ReminderSettingsModalOptions {
  /** Current reminder time in HH:mm format, or undefined if not set */
  currentTime: string | undefined;
  /** Scheduled start time in HH:mm format (used for default calculation) */
  scheduledTime: string | undefined;
  /** Default minutes before scheduled time for initial value */
  defaultMinutesBefore: number;
  /** Callback when user saves a time */
  onSave: (time: string) => void;
  /** Callback when user clears the reminder */
  onClear: () => void;
}

/**
 * Calculate default reminder time (X minutes before scheduled time).
 */
function calculateDefaultReminderTime(scheduledTime: string | undefined, minutesBefore: number): string {
  if (!scheduledTime) {
    // No scheduled time - default to current time
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }

  const match = scheduledTime.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return scheduledTime;
  }

  const hours = parseInt(match[1], 10);
  const mins = parseInt(match[2], 10);

  let totalMinutes = hours * 60 + mins - minutesBefore;
  if (totalMinutes < 0) {
    totalMinutes += 24 * 60;
  }

  const newHours = Math.floor(totalMinutes / 60) % 24;
  const newMins = totalMinutes % 60;

  return `${String(newHours).padStart(2, '0')}:${String(newMins).padStart(2, '0')}`;
}

export class ReminderSettingsModal extends Modal {
  private readonly currentTime: string | undefined;
  private readonly scheduledTime: string | undefined;
  private readonly defaultMinutesBefore: number;
  private readonly onSaveCallback: (time: string) => void;
  private readonly onClearCallback: () => void;
  private inputEl: HTMLInputElement | null = null;

  constructor(app: App, options: ReminderSettingsModalOptions) {
    super(app);
    this.currentTime = options.currentTime;
    this.scheduledTime = options.scheduledTime;
    this.defaultMinutesBefore = options.defaultMinutesBefore;
    this.onSaveCallback = options.onSave;
    this.onClearCallback = options.onClear;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass('taskchute-modal', 'taskchute-modal--no-close', 'taskchute-reminder-settings-modal');
    this.setTitle(t('reminder.modal.title', 'Reminder settings'));

    const initialValue =
      this.currentTime || calculateDefaultReminderTime(this.scheduledTime, this.defaultMinutesBefore);

    // Laid out like the scheduled-time dialog: the label sits above a
    // full-width field rather than in a `Setting` row, which would squeeze the
    // time picker into the right-hand control slot.
    const form = contentEl.createEl('form', { cls: 'task-form' });
    const group = form.createDiv({ cls: 'form-group' });
    group.createEl('label', {
      cls: 'form-label',
      text: t('reminder.modal.description', 'Reminder time:'),
    });
    this.inputEl = group.createEl('input', {
      type: 'time',
      cls: 'form-input',
      value: initialValue,
    });
    this.inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
      }
    });

    if (this.scheduledTime) {
      contentEl.createEl('p', {
        cls: 'modal-description',
        text: t('reminder.modal.scheduledInfo', 'Scheduled start: {time}', {
          time: this.scheduledTime,
        }),
      });
    }

    createModalFooter(contentEl, [
      // Clearing is only on offer once a reminder exists to clear.
      ...(this.currentTime
        ? [
            {
              text: t('reminder.modal.clear', 'Clear'),
              role: 'danger' as const,
              onClick: () => {
                this.onClearCallback();
                this.close();
              },
            },
          ]
        : []),
      { text: t('common.cancel', 'Cancel'), role: 'cancel', onClick: () => this.close() },
      { text: t('reminder.modal.save', 'Save'), role: 'primary', onClick: () => this.handleSave() },
    ]);

    this.inputEl?.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    this.inputEl = null;
  }

  private handleSave(): void {
    if (!this.inputEl) {
      return;
    }

    const value = this.inputEl.value;

    // Validate: must be a valid time format
    if (!value || !/^\d{2}:\d{2}$/.test(value)) {
      return;
    }

    this.onSaveCallback(value);
    this.close();
  }
}
