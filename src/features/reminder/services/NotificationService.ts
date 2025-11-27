/**
 * NotificationService - Handles reminder notifications
 *
 * Displays system notifications on desktop (via Web Notifications API) and
 * falls back to builtin modal on mobile or when notifications are unavailable.
 */

import { Platform } from 'obsidian';

export interface ReminderNotificationOptions {
  taskName: string;
  scheduledTime: string;
  taskPath: string;
  onOpenFile?: () => void;
  /** Called after notification is displayed (for queue processing) */
  onNotificationDisplayed?: () => void;
}

export interface NotificationServiceOptions {
  showBuiltinReminder: (options: ReminderNotificationOptions) => void;
}

export class NotificationService {
  private showBuiltinReminder: (options: ReminderNotificationOptions) => void;
  private notificationsSupported: boolean;

  constructor(options: NotificationServiceOptions) {
    this.showBuiltinReminder = options.showBuiltinReminder;
    // Web Notifications API is available on desktop only
    // Platform.isMobile may be undefined in test environments
    const isMobile = Platform?.isMobile ?? false;
    this.notificationsSupported = !isMobile && typeof Notification !== 'undefined';
  }

  /**
   * Check if running on mobile.
   */
  isMobile(): boolean {
    return Platform?.isMobile ?? false;
  }

  /**
   * Display a reminder notification.
   * Uses Web Notifications API on desktop, builtin modal on mobile.
   */
  notify(options: ReminderNotificationOptions): void {
    if (this.isMobile() || !this.notificationsSupported) {
      // Mobile or notifications not available - use builtin
      // Note: onNotificationDisplayed is called in modal's onClose
      this.showBuiltinReminder(options);
      return;
    }

    // Desktop - use Web Notifications API
    this.showWebNotification(options);
  }

  private showWebNotification(options: ReminderNotificationOptions): void {
    // Check permission
    if (Notification.permission === 'denied') {
      this.showBuiltinReminder(options);
      return;
    }

    if (Notification.permission === 'granted') {
      this.createNotification(options);
      return;
    }

    // Request permission
    Notification.requestPermission()
      .then((permission) => {
        if (permission === 'granted') {
          this.createNotification(options);
        } else {
          this.showBuiltinReminder(options);
        }
      })
      .catch(() => {
        this.showBuiltinReminder(options);
      });
  }

  private createNotification(options: ReminderNotificationOptions): void {
    try {
      const notification = new Notification('TaskChute Plus', {
        body: this.formatNotificationBody(options.taskName, options.scheduledTime),
        tag: options.taskPath,
      });

      notification.onclick = () => {
        notification.close();
        this.showBuiltinReminder(options);
      };

      // Desktop notification shown - signal to process next in queue
      options.onNotificationDisplayed?.();
    } catch {
      // Fallback to builtin if notification fails
      // Note: onNotificationDisplayed is called in modal's onClose
      this.showBuiltinReminder(options);
    }
  }

  /**
   * Format the notification body text.
   */
  formatNotificationBody(taskName: string, scheduledTime: string): string {
    return `${taskName} - まもなく開始 (${scheduledTime})`;
  }
}
