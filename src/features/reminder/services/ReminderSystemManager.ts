/**
 * ReminderSystemManager - Manages the reminder system lifecycle
 *
 * Coordinates EditDetector, ReminderService, and NotificationService.
 * Integrates with Obsidian's plugin lifecycle via registerInterval/registerEvent.
 */

import type { App, EventRef } from 'obsidian';
import type { TaskChuteSettings } from '../../../types';
import { EditDetector } from './EditDetector';
import { ReminderService } from './ReminderService';
import { NotificationService, type ReminderNotificationOptions } from './NotificationService';
import { ReminderNotificationModal } from '../modals/ReminderNotificationModal';
import type { ReminderSchedule } from './ReminderScheduleManager';

// Default values for settings (internal, not exposed to users)
const DEFAULT_CHECK_INTERVAL_SEC = 5;
const DEFAULT_EDIT_DETECTION_SEC = 10;

export interface ReminderSystemManagerOptions {
  app: App;
  settings: TaskChuteSettings;
  registerInterval: (callback: () => void, intervalMs: number) => number;
  registerEvent: (eventRef: EventRef) => EventRef;
}

export interface TaskInstanceForReminder {
  filePath: string;
  task: {
    name?: string;
    scheduledTime?: string;
    reminder_time?: string;
    isRoutine?: boolean;
  };
}

/**
 * Parse time string (HH:mm) to Date object for today.
 */
function parseTimeToDate(timeStr: string): Date | null {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }

  const hours = parseInt(match[1], 10);
  const mins = parseInt(match[2], 10);

  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, mins, 0, 0);
  return date;
}

export class ReminderSystemManager {
  private readonly app: App;
  private readonly settings: TaskChuteSettings;
  private readonly registerInterval: (callback: () => void, intervalMs: number) => number;
  private readonly registerEvent: (eventRef: EventRef) => EventRef;

  private editDetector: EditDetector;
  private reminderService: ReminderService;
  private notificationService: NotificationService;

  private pendingNotifications: ReminderSchedule[] = [];
  private isShowingNotification: boolean = false;
  private intervalId: number | null = null;

  constructor(options: ReminderSystemManagerOptions) {
    this.app = options.app;
    this.settings = options.settings;
    this.registerInterval = options.registerInterval;
    this.registerEvent = options.registerEvent;

    // Initialize EditDetector with fixed internal value
    this.editDetector = new EditDetector({
      editDetectionSec: DEFAULT_EDIT_DETECTION_SEC,
    });

    // Initialize NotificationService
    this.notificationService = new NotificationService({
      showBuiltinReminder: (opts: ReminderNotificationOptions) => {
        this.showBuiltinReminderModal(opts);
      },
    });

    // Initialize ReminderService
    this.reminderService = new ReminderService({
      editDetector: this.editDetector,
      onNotify: (schedule: ReminderSchedule) => {
        this.handleNotification(schedule);
      },
    });

    // Set initial date
    this.reminderService.setCurrentDate(this.getTodayString());
  }

  /**
   * Get the EditDetector instance.
   */
  getEditDetector(): EditDetector {
    return this.editDetector;
  }

  /**
   * Get the ReminderService instance.
   */
  getReminderService(): ReminderService {
    return this.reminderService;
  }

  /**
   * Get the NotificationService instance.
   */
  getNotificationService(): NotificationService {
    return this.notificationService;
  }

  /**
   * Start the periodic reminder check task.
   */
  startPeriodicTask(): void {
    const intervalMs = DEFAULT_CHECK_INTERVAL_SEC * 1000;

    this.intervalId = this.registerInterval(() => {
      this.tick();
    }, intervalMs);
  }

  /**
   * Main tick function - called periodically.
   */
  private tick(): void {
    // Check for date change
    const today = this.getTodayString();
    if (this.reminderService.hasDateChanged(today)) {
      // Clear schedules on date change
      this.reminderService.clearAllSchedules();
      this.reminderService.setCurrentDate(today);
      return;
    }

    // Execute reminder service tick
    this.reminderService.tick();
  }

  /**
   * Register editor change events to track editing state.
   */
  registerEditorEvents(): void {
    // Create event ref for editor changes
    const eventRef = this.app.workspace.on('editor-change', () => {
      this.editDetector.recordKeyPress();
    });

    this.registerEvent(eventRef);
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    // Clear the periodic interval
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.reminderService.clearAllSchedules();
    this.pendingNotifications = [];
  }

  /**
   * Handle task completion - remove from schedule.
   */
  onTaskComplete(taskPath: string): void {
    this.reminderService.onTaskComplete(taskPath);
  }

  /**
   * Handle task reminder time change - update or create schedule.
   * @param taskPath The file path of the task
   * @param newReminderTime The new reminder time in HH:mm format, or null to clear
   * @param taskName Optional task name for creating new schedules
   * @param scheduledTime Optional scheduled time for creating new schedules
   */
  onTaskReminderTimeChanged(
    taskPath: string,
    newReminderTime: string | null,
    taskName?: string,
    scheduledTime?: string
  ): void {
    if (!newReminderTime) {
      this.reminderService.removeSchedule(taskPath);
      return;
    }

    const reminderDate = parseTimeToDate(newReminderTime);
    if (!reminderDate) {
      return;
    }

    const existingSchedule = this.reminderService.getScheduleByPath(taskPath);
    if (existingSchedule) {
      // Update existing schedule
      this.reminderService.removeSchedule(taskPath);
      this.reminderService.addScheduleDirectly({
        ...existingSchedule,
        reminderTime: reminderDate,
        fired: false,
      });
    } else {
      // Create new schedule
      this.reminderService.addScheduleDirectly({
        taskPath,
        taskName: taskName ?? 'Task',
        scheduledTime: scheduledTime ?? '',
        reminderTime: reminderDate,
        fired: false,
        beingDisplayed: false,
      });
    }
  }

  /**
   * Build today's reminder schedules from task instances.
   * Removes stale schedules (tasks no longer in the list or without reminder_time).
   */
  buildTodaySchedules(tasks: unknown[]): void {
    // Collect paths of tasks with valid reminder_time
    const validPaths = new Set<string>();

    for (const taskData of tasks) {
      const task = taskData as TaskInstanceForReminder;

      // Skip tasks without reminder_time
      if (!task.task.reminder_time) {
        continue;
      }

      const reminderDate = parseTimeToDate(task.task.reminder_time);
      if (!reminderDate) {
        continue;
      }

      validPaths.add(task.filePath);

      const schedule: ReminderSchedule = {
        taskPath: task.filePath,
        taskName: task.task.name ?? 'Untitled task',
        scheduledTime: task.task.scheduledTime ?? '',
        reminderTime: reminderDate,
        fired: false,
        beingDisplayed: false,
      };

      this.reminderService.addScheduleDirectly(schedule);
    }

    // Remove stale schedules (paths not in current task list)
    const existingSchedules = this.reminderService.getSchedules();
    for (const schedule of existingSchedules) {
      if (!validPaths.has(schedule.taskPath)) {
        this.reminderService.removeSchedule(schedule.taskPath);
      }
    }
  }

  /**
   * Handle notification from ReminderService.
   */
  private handleNotification(schedule: ReminderSchedule): void {
    // Add to pending queue
    this.pendingNotifications.push(schedule);

    // Process queue if not already showing
    if (!this.isShowingNotification) {
      this.processNotificationQueue();
    }
  }

  /**
   * Process the notification queue sequentially.
   */
  private processNotificationQueue(): void {
    if (this.pendingNotifications.length === 0) {
      this.isShowingNotification = false;
      return;
    }

    this.isShowingNotification = true;
    const schedule = this.pendingNotifications.shift()!;

    this.notificationService.notify({
      taskName: schedule.taskName,
      scheduledTime: schedule.scheduledTime,
      taskPath: schedule.taskPath,
      onOpenFile: () => {
        void this.app.workspace.openLinkText(schedule.taskPath, '', false);
      },
      onNotificationDisplayed: () => {
        // Desktop notification shown - process next immediately
        this.processNotificationQueue();
      },
    });
  }

  /**
   * Show builtin reminder modal.
   */
  private showBuiltinReminderModal(options: ReminderNotificationOptions): void {
    const modal = new ReminderNotificationModal(this.app, {
      taskName: options.taskName,
      scheduledTime: options.scheduledTime,
      taskPath: options.taskPath,
      onClose: () => {
        // Process next notification when this one closes
        this.processNotificationQueue();
      },
    });

    modal.open();
  }

  /**
   * Get today's date as YYYY-MM-DD string.
   */
  private getTodayString(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }
}
