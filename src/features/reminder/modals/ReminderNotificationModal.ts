/**
 * ReminderNotificationModal - Modal for displaying reminder notifications
 *
 * Used as a fallback on mobile devices or when Electron notifications
 * are unavailable. Also shown when desktop notification is clicked.
 */

import { App, Modal } from 'obsidian'
;
import { t } from '../../../i18n';

export interface ReminderNotificationModalOptions {
  taskName: string;
  scheduledTime: string;
  taskPath: string;
  onClose?: () => void;
}

type CreateElOptions = {
  cls?: string | string[];
  text?: string;
  type?: 'button' | 'reset' | 'submit';
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
  const element = createEl(tag);
  if (options?.cls) {
    const classes = Array.isArray(options.cls) ? options.cls : [options.cls];
    element.classList.add(...classes);
  }
  if (options?.text !== undefined) {
    element.textContent = options.text;
  }
  if (options?.type !== undefined && 'type' in element) {
    (element as HTMLButtonElement).type = options.type;
  }
  parent.appendChild(element);
  return element;
};

export class ReminderNotificationModal extends Modal {
  private readonly taskName: string;
  private readonly scheduledTime: string;
  private readonly taskPath: string;
  private readonly onCloseCallback?: () => void;
  private beingDisplayed: boolean = false;

  constructor(app: App, options: ReminderNotificationModalOptions) {
    super(app);
    this.taskName = options.taskName;
    this.scheduledTime = options.scheduledTime;
    this.taskPath = options.taskPath;
    this.onCloseCallback = options.onClose;
  }

  /**
   * Get the task name (for testing).
   */
  getTaskName(): string {
    return this.taskName;
  }

  /**
   * Get the scheduled time (for testing).
   */
  getScheduledTime(): string {
    return this.scheduledTime;
  }

  /**
   * Get the task path (for testing).
   */
  getTaskPath(): string {
    return this.taskPath;
  }

  /**
   * Check if the modal is currently being displayed.
   */
  isBeingDisplayed(): boolean {
    return this.beingDisplayed;
  }

  private tv(key: string, fallback: string, vars?: Record<string, string | number>): string {
    return t(`reminder.notification.${key}`, fallback, vars);
  }

  onOpen(): void {
    this.beingDisplayed = true;
    const { contentEl, modalEl } = this;

    // Clear existing content
    if (typeof (contentEl as HTMLElement & { empty?: () => void }).empty === 'function') {
      (contentEl as HTMLElement & { empty?: () => void }).empty();
    } else {
      while (contentEl.firstChild) {
        contentEl.removeChild(contentEl.firstChild);
      }
    }

    modalEl?.classList.add('taskchute-reminder-modal');

    // Header
    const header = createElCompat(contentEl, 'div', { cls: 'modal-header' });
    createElCompat(header, 'h3', { text: this.tv('title', 'Reminder') });

    // Task info
    createElCompat(contentEl, 'p', {
      cls: 'modal-message',
      text: this.taskName,
    });
    createElCompat(contentEl, 'p', {
      cls: 'modal-description',
      text: this.tv('startingSoon', 'Starting soon ({time})', { time: this.scheduledTime }),
    });

    // Buttons
    const buttonGroup = createElCompat(contentEl, 'div', { cls: 'form-button-group' });
    buttonGroup.classList.add('confirm-button-group');

    const openFileButton = createElCompat(buttonGroup, 'button', {
      type: 'button',
      cls: ['form-button', 'create'],
      text: this.tv('openFile', 'Open file'),
    });
    openFileButton.addEventListener('click', () => {
      this.openTaskFile();
      this.close();
    });

    const closeButton = createElCompat(buttonGroup, 'button', {
      type: 'button',
      cls: ['form-button', 'cancel'],
      text: t('common.close', 'Close'),
    });
    closeButton.addEventListener('click', () => {
      this.close();
    });
  }

  onClose(): void {
    this.beingDisplayed = false;

    // Clear content
    if (typeof (this.contentEl as HTMLElement & { empty?: () => void }).empty === 'function') {
      (this.contentEl as HTMLElement & { empty?: () => void }).empty();
    } else {
      while (this.contentEl.firstChild) {
        this.contentEl.removeChild(this.contentEl.firstChild);
      }
    }

    this.modalEl?.classList.remove('taskchute-reminder-modal');

    // Call the onClose callback
    this.onCloseCallback?.();
  }

  /**
   * Open the task file in Obsidian.
   */
  private openTaskFile(): void {
    void this.app.workspace.openLinkText(this.taskPath, '', false);
  }
}
