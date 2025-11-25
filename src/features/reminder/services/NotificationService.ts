/**
 * NotificationService - Handles reminder notifications
 *
 * Displays system notifications on desktop (via Electron) and
 * falls back to builtin modal on mobile or when Electron is unavailable.
 */

// Electron type for TypeScript
interface ElectronRemote {
  Notification: new (options: { title: string; body: string }) => ElectronNotification;
}

interface ElectronNotification {
  on(event: 'click', handler: () => void): void;
  show(): void;
  close(): void;
}

interface ElectronModule {
  remote: ElectronRemote;
}

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

// Try to get Electron module
function getElectron(): ElectronModule | undefined {
  try {
    const windowWithRequire = window as { require?: (module: string) => unknown };
    if (windowWithRequire.require) {
      return windowWithRequire.require('electron') as ElectronModule | undefined;
    }
  } catch {
    // Electron not available
  }
  return undefined;
}

export class NotificationService {
  private electron: ElectronModule | undefined;
  private showBuiltinReminder: (options: ReminderNotificationOptions) => void;

  constructor(options: NotificationServiceOptions) {
    this.electron = getElectron();
    this.showBuiltinReminder = options.showBuiltinReminder;
  }

  /**
   * Check if running on mobile (Electron not available).
   */
  isMobile(): boolean {
    return this.electron === undefined;
  }

  /**
   * Display a reminder notification.
   * Uses Electron notification on desktop, builtin modal on mobile.
   */
  async notify(options: ReminderNotificationOptions): Promise<void> {
    if (this.isMobile()) {
      // Mobile or Electron not available - use builtin
      // Note: onNotificationDisplayed is called in modal's onClose
      this.showBuiltinReminder(options);
      return;
    }

    // Desktop - use Electron notification
    try {
      const Notification = this.electron!.remote.Notification;
      const notification = new Notification({
        title: 'TaskChute Plus',
        body: this.formatNotificationBody(options.taskName, options.scheduledTime),
      });

      notification.on('click', () => {
        notification.close();
        this.showBuiltinReminder(options);
      });

      notification.show();
      // Desktop notification shown - signal to process next in queue
      options.onNotificationDisplayed?.();
    } catch {
      // Fallback to builtin if Electron notification fails
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
