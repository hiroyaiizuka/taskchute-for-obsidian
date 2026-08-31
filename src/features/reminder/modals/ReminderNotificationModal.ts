/**
 * ReminderNotificationModal - Modal for displaying reminder notifications
 *
 * Used as a fallback on mobile devices or when Electron notifications
 * are unavailable. Also shown when desktop notification is clicked.
 */

import { App, Modal } from 'obsidian';
import { t } from '../../../i18n';
import { createElCompat } from '../../../ui/components/domCompat';
import { createModalFooter } from '../../../ui/components/modalFooter';

export interface ReminderNotificationModalOptions {
  taskName: string;
  scheduledTime: string;
  taskPath: string;
  onClose?: () => void;
}

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

    modalEl?.classList.add('taskchute-modal', 'taskchute-modal--no-close', 'taskchute-reminder-modal');

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

    createModalFooter(contentEl, [
      {
        text: t('common.close', 'Close'),
        role: 'cancel',
        onClick: () => {
          this.close();
        },
      },
      {
        text: this.tv('openFile', 'Open file'),
        role: 'primary',
        onClick: () => {
          this.openTaskFile();
          this.close();
        },
      },
    ]);
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

    this.modalEl?.classList.remove('taskchute-modal', 'taskchute-modal--no-close', 'taskchute-reminder-modal');

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
