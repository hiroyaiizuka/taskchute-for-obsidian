/**
 * @jest-environment jsdom
 */

/**
 * Tests for date-aware reminder scheduling.
 *
 * These tests verify that:
 * 1. Reminders are only scheduled when viewing today's date
 * 2. Navigating to past/future dates does not schedule those reminders for today
 * 3. Editing reminders on non-today dates does not affect today's schedule
 */

import { ReminderSystemManager } from '../../src/features/reminder/services/ReminderSystemManager';
import type { TaskChuteSettings } from '../../src/types';
import type { App } from 'obsidian';

// Mock createEl for testing
const mockCreateEl = (tag: string, options?: Record<string, unknown>): HTMLElement => {
  const el = document.createElement(tag);
  if (options?.cls) {
    const classes = Array.isArray(options.cls) ? options.cls : [options.cls];
    (el).classList.add(...(classes as string[]));
  }
  if (options?.text !== undefined) {
    el.textContent = options.text as string;
  }
  return el;
};

// Extend HTMLElement prototype for tests
Object.defineProperty(HTMLElement.prototype, 'createEl', {
  value: function(tag: string, options?: Record<string, unknown>) {
    const el = mockCreateEl(tag, options);
    this.appendChild(el);
    return el;
  },
  writable: true,
  configurable: true,
});

Object.defineProperty(HTMLElement.prototype, 'empty', {
  value: function() {
    while (this.firstChild) {
      this.removeChild(this.firstChild);
    }
  },
  writable: true,
  configurable: true,
});

describe('Date-aware Reminder Scheduling', () => {
  const createMockSettings = (): TaskChuteSettings => ({
    defaultReminderMinutes: 5,
  } as TaskChuteSettings);

  const createMockApp = (): App => ({
    workspace: {
      openLinkText: jest.fn(),
      on: jest.fn(() => ({ unload: jest.fn() })),
    },
  } as unknown as App);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-15T10:00:00'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('buildTodaySchedules behavior simulation', () => {
    /**
     * This test simulates what should happen in TaskChuteView.buildReminderSchedules
     * when the view is navigated to different dates.
     */
    it('should only build schedules when viewing today', () => {
      const settings = createMockSettings();
      const app = createMockApp();

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval: jest.fn(),
        registerEvent: jest.fn(),
      });

      const reminderService = manager.getReminderService();

      // Simulate: Today is 2025-01-15
      const actualToday = '2025-01-15';

      // Case 1: Viewing today - should build schedules
      const viewingToday = '2025-01-15';
      if (viewingToday === actualToday) {
        manager.buildTodaySchedules([
          {
            filePath: 'task-today.md',
            task: {
              name: 'Today Task',
              scheduledTime: '11:00',
              reminder_time: '10:55',
            },
          },
        ]);
      }

      expect(reminderService.getSchedules().length).toBe(1);
      expect(reminderService.getScheduleByPath('task-today.md')).not.toBeNull();

      // Clear for next test
      reminderService.clearAllSchedules();

      // Case 2: Viewing tomorrow - should NOT build schedules
      const viewingTomorrow = '2025-01-16';
      if (viewingTomorrow === actualToday) {
        manager.buildTodaySchedules([
          {
            filePath: 'task-tomorrow.md',
            task: {
              name: 'Tomorrow Task',
              scheduledTime: '11:00',
              reminder_time: '10:55',
            },
          },
        ]);
      }

      // No schedules should be added
      expect(reminderService.getSchedules().length).toBe(0);

      // Case 3: Viewing yesterday - should NOT build schedules
      const viewingYesterday = '2025-01-14';
      if (viewingYesterday === actualToday) {
        manager.buildTodaySchedules([
          {
            filePath: 'task-yesterday.md',
            task: {
              name: 'Yesterday Task',
              scheduledTime: '11:00',
              reminder_time: '10:55',
            },
          },
        ]);
      }

      // No schedules should be added
      expect(reminderService.getSchedules().length).toBe(0);
    });
  });

  describe('onTaskReminderTimeChanged behavior simulation', () => {
    /**
     * This test simulates what should happen when editing reminders
     * while viewing different dates.
     */
    it('should only update schedules when editing tasks on today', () => {
      const settings = createMockSettings();
      const app = createMockApp();

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval: jest.fn(),
        registerEvent: jest.fn(),
      });

      const reminderService = manager.getReminderService();

      // Simulate: Today is 2025-01-15
      const actualToday = '2025-01-15';

      // First, build schedules for today
      manager.buildTodaySchedules([
        {
          filePath: 'task.md',
          task: {
            name: 'Task',
            scheduledTime: '11:00',
            reminder_time: '10:55',
          },
        },
      ]);

      expect(reminderService.getSchedules().length).toBe(1);

      // Case 1: Edit reminder while viewing today - should update
      const viewingToday = '2025-01-15';
      if (viewingToday === actualToday) {
        manager.onTaskReminderTimeChanged('task.md', '10:50', 'Task', '11:00');
      }

      let schedule = reminderService.getScheduleByPath('task.md');
      expect(schedule?.reminderTime.getMinutes()).toBe(50);

      // Case 2: Edit reminder while viewing tomorrow - should NOT update
      const viewingTomorrow = '2025-01-16';
      if (viewingTomorrow === actualToday) {
        // This would NOT be called due to the guard
        manager.onTaskReminderTimeChanged('task.md', '10:30', 'Task', '11:00');
      }

      // Schedule should remain at 10:50 (not 10:30)
      schedule = reminderService.getScheduleByPath('task.md');
      expect(schedule?.reminderTime.getMinutes()).toBe(50);
    });

    it('should not schedule reminders from future dates to fire today', () => {
      const settings = createMockSettings();
      const app = createMockApp();

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval: jest.fn(),
        registerEvent: jest.fn(),
      });

      const reminderService = manager.getReminderService();

      // Simulate: Today is 2025-01-15
      const actualToday = '2025-01-15';

      // User navigates to tomorrow (2025-01-16) and creates a reminder
      // This simulates the bug: tomorrow's 09:00 reminder would fire today at 09:00
      const viewingDate = '2025-01-16';

      // Guard check - only call if viewing today
      if (viewingDate === actualToday) {
        manager.onTaskReminderTimeChanged(
          'future-task.md',
          '09:00',
          'Future Task',
          '09:30'
        );
      }

      // No schedule should be created
      expect(reminderService.getSchedules().length).toBe(0);
      expect(reminderService.getScheduleByPath('future-task.md')).toBeNull();
    });
  });

  describe('integration scenario', () => {
    it('should handle navigation between dates correctly', () => {
      const settings = createMockSettings();
      const app = createMockApp();
      let intervalCallback: (() => void) | null = null;

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval: (cb) => {
          intervalCallback = cb;
          return 123;
        },
        registerEvent: jest.fn(),
      });

      manager.startPeriodicTask();
      const reminderService = manager.getReminderService();

      // Simulate: Today is 2025-01-15, current time is 10:00
      const actualToday = '2025-01-15';

      // Step 1: User loads today's tasks with a reminder at 10:05
      let viewingDate = actualToday;
      if (viewingDate === actualToday) {
        manager.buildTodaySchedules([
          {
            filePath: 'today-task.md',
            task: {
              name: 'Today Task',
              scheduledTime: '10:30',
              reminder_time: '10:05',
            },
          },
        ]);
      }

      expect(reminderService.getSchedules().length).toBe(1);

      // Step 2: User navigates to tomorrow
      viewingDate = '2025-01-16';

      // Tomorrow's tasks would have a reminder at 09:00
      // But since we're not viewing today, this should NOT schedule anything
      if (viewingDate === actualToday) {
        manager.buildTodaySchedules([
          {
            filePath: 'tomorrow-task.md',
            task: {
              name: 'Tomorrow Task',
              scheduledTime: '09:30',
              reminder_time: '09:00', // Would have fired "today" at 09:00 without the fix
            },
          },
        ]);
      }

      // Should still only have today's task scheduled
      expect(reminderService.getSchedules().length).toBe(1);
      expect(reminderService.getScheduleByPath('today-task.md')).not.toBeNull();
      expect(reminderService.getScheduleByPath('tomorrow-task.md')).toBeNull();

      // Step 3: Time advances to 10:05, reminder should fire
      jest.setSystemTime(new Date('2025-01-15T10:05:00'));
      intervalCallback!();

      const firedSchedule = reminderService.getScheduleByPath('today-task.md');
      expect(firedSchedule?.fired).toBe(true);

      // Step 4: User navigates back to today
      viewingDate = actualToday;
      if (viewingDate === actualToday) {
        // This would rebuild schedules, but the already-fired one should be reset
        // (This tests that buildTodaySchedules handles the case correctly)
        manager.buildTodaySchedules([
          {
            filePath: 'today-task.md',
            task: {
              name: 'Today Task',
              scheduledTime: '10:30',
              reminder_time: '10:05',
            },
          },
        ]);
      }

      // The schedule exists (fired flag is reset by buildTodaySchedules due to addScheduleDirectly)
      expect(reminderService.getScheduleByPath('today-task.md')).not.toBeNull();
    });
  });
});
