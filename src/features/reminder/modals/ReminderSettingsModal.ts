/**
 * ReminderSettingsModal - Modal for setting reminder time
 *
 * Allows users to input the exact time when reminder notification should fire.
 * Time is stored in HH:mm format.
 */

import { App, Modal } from 'obsidian';
import { t } from '../../../i18n';

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

type CreateElOptions = {
  cls?: string | string[];
  text?: string;
  type?: string;
  value?: string;
  attr?: Record<string, string>;
};

const createElCompat = <K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  options?: CreateElOptions
): HTMLElementTagNameMap[K] => {
  const maybeCreateEl = (
    parent as HTMLElement & {
      createEl?: (tagName: string, options?: Record<string, unknown>) => HTMLElement;
    }
  ).createEl;
  if (typeof maybeCreateEl === 'function') {
    return maybeCreateEl.call(parent, tag, options as Record<string, unknown>) as HTMLElementTagNameMap[K];
  }
  const element = document.createElement(tag);
  if (options?.cls) {
    const classes = Array.isArray(options.cls) ? options.cls : [options.cls];
    element.classList.add(...classes);
  }
  if (options?.text !== undefined) {
    element.textContent = options.text;
  }
  if (options?.type !== undefined && 'type' in element) {
    (element as HTMLInputElement | HTMLButtonElement).type = options.type;
  }
  if (options?.value !== undefined && 'value' in element) {
    (element as HTMLInputElement).value = options.value;
  }
  if (options?.attr) {
    Object.entries(options.attr).forEach(([key, value]) => {
      element.setAttribute(key, value);
    });
  }
  parent.appendChild(element);
  return element;
};

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
    const { contentEl, modalEl } = this;

    // Clear existing content
    if (typeof (contentEl as HTMLElement & { empty?: () => void }).empty === 'function') {
      (contentEl as HTMLElement & { empty?: () => void }).empty();
    } else {
      while (contentEl.firstChild) {
        contentEl.removeChild(contentEl.firstChild);
      }
    }

    modalEl?.classList.add('taskchute-reminder-settings-modal');

    // Header
    const header = createElCompat(contentEl, 'div', { cls: 'reminder-settings-header' });
    createElCompat(header, 'h3', { text: t('reminder.modal.title', 'Reminder settings') });

    // Input section
    const inputSection = createElCompat(contentEl, 'div', { cls: 'reminder-settings-input-section' });
    createElCompat(inputSection, 'label', {
      text: t('reminder.modal.description', 'Set the time to receive a reminder'),
      attr: { for: 'reminder-time-input' },
    });

    const inputContainer = createElCompat(inputSection, 'div', { cls: 'reminder-input-container' });

    // Determine initial value
    const initialValue = this.currentTime || calculateDefaultReminderTime(this.scheduledTime, this.defaultMinutesBefore);

    this.inputEl = createElCompat(inputContainer, 'input', {
      type: 'time',
      value: initialValue,
      attr: {
        id: 'reminder-time-input',
      },
    });

    // Show scheduled time info if available
    if (this.scheduledTime) {
      createElCompat(inputSection, 'p', {
        cls: 'reminder-scheduled-info',
        text: t('reminder.modal.scheduledInfo', 'Scheduled start: {time}', {
          time: this.scheduledTime,
        }),
      });
    }

    // Buttons
    const buttonGroup = createElCompat(contentEl, 'div', { cls: 'reminder-settings-buttons' });

    // Clear button (only if reminder is currently set)
    if (this.currentTime) {
      const clearButton = createElCompat(buttonGroup, 'button', {
        type: 'button',
        cls: ['form-button', 'danger'],
        text: t('reminder.modal.clear', 'Clear'),
      });
      clearButton.addEventListener('click', () => {
        this.onClearCallback();
        this.close();
      });
    }

    // Cancel button
    const cancelButton = createElCompat(buttonGroup, 'button', {
      type: 'button',
      cls: ['form-button', 'cancel'],
      text: t('common.cancel', 'Cancel'),
    });
    cancelButton.addEventListener('click', () => {
      this.close();
    });

    // Save button
    const saveButton = createElCompat(buttonGroup, 'button', {
      type: 'button',
      cls: ['form-button', 'create'],
      text: t('reminder.modal.save', 'Save'),
    });
    saveButton.addEventListener('click', () => {
      this.handleSave();
    });
  }

  onClose(): void {
    // Clear content
    if (typeof (this.contentEl as HTMLElement & { empty?: () => void }).empty === 'function') {
      (this.contentEl as HTMLElement & { empty?: () => void }).empty();
    } else {
      while (this.contentEl.firstChild) {
        this.contentEl.removeChild(this.contentEl.firstChild);
      }
    }

    this.modalEl?.classList.remove('taskchute-reminder-settings-modal');
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
