/**
 * ReminderService - Core service for reminder scheduling and firing
 *
 * Manages reminder schedules, monitors time, and triggers notifications.
 * Uses EditDetector to suppress notifications during editing.
 */

import { EditDetector } from './EditDetector';
import {
  ReminderSchedule,
  ReminderScheduleManager,
  calculateReminderTime,
} from './ReminderScheduleManager';

export interface ReminderServiceOptions {
  editDetector: EditDetector;
  onNotify: (schedule: ReminderSchedule) => void;
}

/** Maximum age (in ms) for a reminder to still be considered valid for firing */
const MAX_REMINDER_AGE_MS = 60 * 1000; // 1 minute

export class ReminderService {
  private scheduleManager: ReminderScheduleManager;
  private editDetector: EditDetector;
  private onNotify: (schedule: ReminderSchedule) => void;
  private intervalTaskRunning: boolean = false;

  constructor(options: ReminderServiceOptions) {
    this.scheduleManager = new ReminderScheduleManager();
    this.editDetector = options.editDetector;
    this.onNotify = options.onNotify;
  }

  /**
   * Add a schedule directly (for testing or internal use).
   */
  addScheduleDirectly(schedule: ReminderSchedule): void {
    this.scheduleManager.addSchedule(schedule);
  }

  /**
   * Get a schedule by task path.
   */
  getScheduleByPath(taskPath: string): ReminderSchedule | null {
    return this.scheduleManager.getScheduleByPath(taskPath);
  }

  /**
   * Main tick function - called periodically to check and fire reminders.
   */
  tick(): void {
    // Prevent duplicate execution
    if (this.intervalTaskRunning) {
      return;
    }

    // Skip if user is editing
    if (this.editDetector.isEditing()) {
      return;
    }

    this.intervalTaskRunning = true;

    try {
      const now = new Date();
      const pendingSchedules = this.scheduleManager.getPendingSchedules();

      for (const schedule of pendingSchedules) {
        if (this.shouldFireReminder(schedule, now)) {
          // Mark as fired first to prevent re-firing
          this.scheduleManager.markAsFired(schedule.taskPath);

          // Fire notification
          this.onNotify(schedule);
        }
      }
    } finally {
      this.intervalTaskRunning = false;
    }
  }

  /**
   * Check if a reminder should fire based on current time.
   */
  private shouldFireReminder(schedule: ReminderSchedule, now: Date): boolean {
    // Already fired
    if (schedule.fired) {
      return false;
    }

    const reminderTime = schedule.reminderTime.getTime();
    const currentTime = now.getTime();

    // Reminder time has not yet arrived
    if (currentTime < reminderTime) {
      return false;
    }

    // Reminder time is too far in the past (stale)
    if (currentTime - reminderTime > MAX_REMINDER_AGE_MS) {
      return false;
    }

    return true;
  }

  /**
   * Called when a task is completed - removes the reminder from schedule.
   */
  onTaskComplete(taskPath: string): void {
    this.scheduleManager.removeSchedule(taskPath);
  }

  /**
   * Called when a task's scheduled time changes - updates the schedule.
   * @deprecated Use ReminderSystemManager.onTaskReminderTimeChanged instead
   */
  onTaskTimeChanged(
    taskPath: string,
    newScheduledTime: string,
    reminderMinutes: number
  ): void {
    const schedule = this.scheduleManager.getScheduleByPath(taskPath);
    if (!schedule) {
      return;
    }

    const newReminderTime = calculateReminderTime(
      newScheduledTime,
      reminderMinutes,
      new Date()
    );

    if (newReminderTime) {
      this.scheduleManager.updateScheduleTime(
        taskPath,
        newScheduledTime,
        newReminderTime
      );
    }
  }

  /**
   * Clear all schedules (e.g., when rebuilding).
   */
  clearAllSchedules(): void {
    this.scheduleManager.clearAllSchedules();
  }

  /**
   * Get all current schedules.
   */
  getSchedules(): ReminderSchedule[] {
    return this.scheduleManager.getSchedules();
  }

  /**
   * Remove a schedule by task path.
   */
  removeSchedule(taskPath: string): void {
    this.scheduleManager.removeSchedule(taskPath);
  }

  /**
   * Set current date for date change detection.
   */
  setCurrentDate(date: string): void {
    this.scheduleManager.setCurrentDate(date);
  }

  /**
   * Check if date has changed.
   */
  hasDateChanged(newDate: string): boolean {
    return this.scheduleManager.hasDateChanged(newDate);
  }
}
