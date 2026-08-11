/**
 * ReminderScheduleManager - Manages reminder schedules in memory
 *
 * Holds today's reminder schedules and provides methods to manipulate them.
 * The actual persistence is handled by frontmatter; this is the runtime state.
 */

export interface ReminderSchedule {
  /** Task file path */
  taskPath: string;
  /** Display instance id, used to distinguish duplicated task rows with the same file path */
  instanceId?: string;
  /** True when this duplicate schedule inherits reminder_time from the base task frontmatter. */
  inheritsBaseReminder?: boolean;
  /** Task name */
  taskName: string;
  /** Scheduled start time (HH:mm format) */
  scheduledTime: string;
  /** Calculated reminder fire time */
  reminderTime: Date;
  /** Whether the reminder has already fired */
  fired: boolean;
  /** Whether a notification modal is currently being displayed for this */
  beingDisplayed: boolean;
}

/**
 * Calculate the reminder time based on scheduled time and minutes before.
 *
 * @param scheduledTime - The scheduled start time in HH:mm format
 * @param minutesBefore - How many minutes before the scheduled time to fire
 * @param baseDate - The date to use for calculation (defaults to today)
 * @returns The calculated reminder time, or null if invalid input
 */
export function calculateReminderTime(
  scheduledTime: string | undefined,
  minutesBefore: number,
  baseDate: Date = new Date()
): Date | null {
  if (!scheduledTime) {
    return null;
  }

  // Parse HH:mm format
  const match = scheduledTime.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);

  // Validate time values
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  // Create date with the scheduled time
  const scheduledDate = new Date(baseDate);
  scheduledDate.setHours(hours, minutes, 0, 0);

  // Subtract minutes to get reminder time
  const reminderDate = new Date(scheduledDate.getTime() - minutesBefore * 60 * 1000);

  return reminderDate;
}

export function getReminderScheduleKey(schedule: Pick<ReminderSchedule, 'taskPath' | 'instanceId'>): string {
  return schedule.instanceId ? `${schedule.taskPath}::${schedule.instanceId}` : schedule.taskPath;
}

export class ReminderScheduleManager {
  private schedules: ReminderSchedule[] = [];
  private currentDate: string = '';

  /**
   * Add a schedule to the manager.
   * If a schedule for the same task path already exists and the reminder time
   * is unchanged, the fired flag is preserved to prevent duplicate notifications.
   */
  addSchedule(schedule: ReminderSchedule): void {
    const existing = this.getScheduleByExactKey(schedule.taskPath, schedule.instanceId);

    if (existing) {
      // Preserve fired flag if reminder time is unchanged
      const sameTime =
        existing.reminderTime.getTime() === schedule.reminderTime.getTime();
      if (sameTime && existing.fired) {
        schedule.fired = true;
      }
      this.removeScheduleByExactKey(schedule.taskPath, schedule.instanceId);
    }

    this.schedules.push(schedule);
  }

  /**
   * Remove a schedule by task path.
   */
  removeSchedule(taskPath: string, instanceId?: string): void {
    this.removeScheduleByExactKey(taskPath, instanceId);
  }

  /**
   * Get all schedules.
   */
  getSchedules(): ReminderSchedule[] {
    return [...this.schedules];
  }

  /**
   * Get a schedule by task path.
   */
  getScheduleByPath(taskPath: string, instanceId?: string): ReminderSchedule | null {
    return this.getScheduleByExactKey(taskPath, instanceId);
  }

  /**
   * Mark a schedule as fired.
   */
  markAsFired(taskPath: string, instanceId?: string): void {
    const schedule = this.getScheduleByExactKey(taskPath, instanceId);
    if (schedule) {
      schedule.fired = true;
    }
  }

  /**
   * Set the beingDisplayed flag for a schedule.
   */
  setBeingDisplayed(taskPath: string, displayed: boolean, instanceId?: string): void {
    const schedule = this.getScheduleByExactKey(taskPath, instanceId);
    if (schedule) {
      schedule.beingDisplayed = displayed;
    }
  }

  /**
   * Clear all schedules.
   */
  clearAllSchedules(): void {
    this.schedules = [];
  }

  /**
   * Get all pending (unfired) schedules.
   */
  getPendingSchedules(): ReminderSchedule[] {
    return this.schedules.filter(s => !s.fired);
  }

  /**
   * Update the reminder time for a schedule.
   * This also resets the fired flag since the time has changed.
   */
  updateScheduleTime(taskPath: string, newScheduledTime: string, newReminderTime: Date, instanceId?: string): void {
    const schedule = this.getScheduleByExactKey(taskPath, instanceId);
    if (schedule) {
      schedule.scheduledTime = newScheduledTime;
      schedule.reminderTime = newReminderTime;
      schedule.fired = false; // Reset fired flag when time changes
    }
  }

  /**
   * Set the current date for tracking date changes.
   */
  setCurrentDate(date: string): void {
    this.currentDate = date;
  }

  /**
   * Check if the date has changed from the stored current date.
   */
  hasDateChanged(newDate: string): boolean {
    return this.currentDate !== newDate;
  }

  /**
   * Get the current stored date.
   */
  getCurrentDate(): string {
    return this.currentDate;
  }

  private getScheduleByExactKey(taskPath: string, instanceId?: string): ReminderSchedule | null {
    return this.schedules.find((schedule) => {
      if (schedule.taskPath !== taskPath) {
        return false;
      }
      if (instanceId !== undefined) {
        return schedule.instanceId === instanceId;
      }
      return schedule.instanceId === undefined;
    }) ?? null;
  }

  private removeScheduleByExactKey(taskPath: string, instanceId?: string): void {
    this.schedules = this.schedules.filter((schedule) => {
      if (schedule.taskPath !== taskPath) {
        return true;
      }
      if (instanceId !== undefined) {
        return schedule.instanceId !== instanceId;
      }
      return schedule.instanceId !== undefined;
    });
  }
}
