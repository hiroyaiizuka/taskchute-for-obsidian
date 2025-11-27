/**
 * Tests for reminder data flow integration.
 *
 * These tests verify that:
 * 1. buildTodaySchedules is called when tasks are loaded
 * 2. onTaskReminderTimeChanged is called when reminder time is updated via UI
 * 3. onTaskComplete is called when a task is completed
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

describe('Reminder Data Flow Integration', () => {
  // Mock settings
  const createMockSettings = (overrides?: Partial<TaskChuteSettings>): TaskChuteSettings => ({
    defaultReminderMinutes: 5,
    ...overrides,
  } as TaskChuteSettings);

  // Mock App
  const createMockApp = (): App => ({
    workspace: {
      openLinkText: jest.fn(),
      on: jest.fn(() => ({ unload: jest.fn() })),
    },
  } as unknown as App);

  describe('buildTodaySchedules - Task Loading', () => {
    it('should build schedules from task list with reminder_time', () => {
      const settings = createMockSettings();
      const app = createMockApp();

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval: jest.fn(),
        registerEvent: jest.fn(),
      });

      // Simulate task data that would come from TaskChuteView.loadTasks()
      const tasks = [
        {
          filePath: 'tasks/meeting.md',
          task: {
            name: 'Morning Meeting',
            scheduledTime: '09:00',
            reminder_time: '08:55',
          },
        },
        {
          filePath: 'tasks/review.md',
          task: {
            name: 'Code Review',
            scheduledTime: '14:00',
            reminder_time: '13:50',
          },
        },
      ];

      // Call buildTodaySchedules (this should be called from loadTasks)
      manager.buildTodaySchedules(tasks);

      const reminderService = manager.getReminderService();
      const schedules = reminderService.getSchedules();

      expect(schedules.length).toBe(2);

      const meetingSchedule = schedules.find(s => s.taskPath === 'tasks/meeting.md');
      expect(meetingSchedule).toBeDefined();
      expect(meetingSchedule?.taskName).toBe('Morning Meeting');
      expect(meetingSchedule?.reminderTime.getHours()).toBe(8);
      expect(meetingSchedule?.reminderTime.getMinutes()).toBe(55);

      const reviewSchedule = schedules.find(s => s.taskPath === 'tasks/review.md');
      expect(reviewSchedule).toBeDefined();
      expect(reviewSchedule?.taskName).toBe('Code Review');
      expect(reviewSchedule?.reminderTime.getHours()).toBe(13);
      expect(reviewSchedule?.reminderTime.getMinutes()).toBe(50);
    });

    it('should skip tasks without reminder_time', () => {
      const settings = createMockSettings();
      const app = createMockApp();

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval: jest.fn(),
        registerEvent: jest.fn(),
      });

      const tasks = [
        {
          filePath: 'tasks/with-reminder.md',
          task: {
            name: 'Task with Reminder',
            scheduledTime: '10:00',
            reminder_time: '09:55',
          },
        },
        {
          filePath: 'tasks/without-reminder.md',
          task: {
            name: 'Task without Reminder',
            scheduledTime: '11:00',
            // No reminder_time
          },
        },
      ];

      manager.buildTodaySchedules(tasks);

      const schedules = manager.getReminderService().getSchedules();
      expect(schedules.length).toBe(1);
      expect(schedules[0].taskPath).toBe('tasks/with-reminder.md');
    });

    it('should remove stale schedules when rebuilding', () => {
      const settings = createMockSettings();
      const app = createMockApp();

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval: jest.fn(),
        registerEvent: jest.fn(),
      });

      const reminderService = manager.getReminderService();

      // Add an existing schedule for a task that will be removed
      reminderService.addScheduleDirectly({
        taskPath: 'old-task.md',
        taskName: 'Old Task',
        scheduledTime: '08:00',
        reminderTime: new Date(),
        fired: false,
        beingDisplayed: false,
      });

      expect(reminderService.getSchedules().length).toBe(1);

      // Rebuild with new tasks (old-task.md is not included)
      const tasks = [
        {
          filePath: 'new-task.md',
          task: {
            name: 'New Task',
            scheduledTime: '10:00',
            reminder_time: '09:55',
          },
        },
      ];

      manager.buildTodaySchedules(tasks);

      const schedules = reminderService.getSchedules();
      expect(schedules.length).toBe(1);
      expect(schedules[0].taskPath).toBe('new-task.md');
      // old-task.md should be removed
      expect(reminderService.getScheduleByPath('old-task.md')).toBeNull();
    });

    it('should remove schedule when reminder_time is removed from frontmatter', () => {
      const settings = createMockSettings();
      const app = createMockApp();

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval: jest.fn(),
        registerEvent: jest.fn(),
      });

      const reminderService = manager.getReminderService();

      // First build with reminder
      manager.buildTodaySchedules([
        {
          filePath: 'task.md',
          task: {
            name: 'Task',
            scheduledTime: '10:00',
            reminder_time: '09:55',
          },
        },
      ]);

      expect(reminderService.getScheduleByPath('task.md')).not.toBeNull();

      // Rebuild same task but without reminder_time (simulates user removing from frontmatter)
      manager.buildTodaySchedules([
        {
          filePath: 'task.md',
          task: {
            name: 'Task',
            scheduledTime: '10:00',
            // No reminder_time
          },
        },
      ]);

      // Schedule should be removed
      expect(reminderService.getScheduleByPath('task.md')).toBeNull();
      expect(reminderService.getSchedules().length).toBe(0);
    });
  });

  describe('onTaskReminderTimeChanged - UI Updates', () => {
    it('should add new schedule when reminder time is set for existing task', () => {
      const settings = createMockSettings();
      const app = createMockApp();

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval: jest.fn(),
        registerEvent: jest.fn(),
      });

      const reminderService = manager.getReminderService();

      // First, add a schedule (simulating initial load)
      reminderService.addScheduleDirectly({
        taskPath: 'tasks/test.md',
        taskName: 'Test Task',
        scheduledTime: '10:00',
        reminderTime: new Date(),
        fired: false,
        beingDisplayed: false,
      });

      // Now update the reminder time (simulating UI update)
      manager.onTaskReminderTimeChanged('tasks/test.md', '09:45');

      const schedule = reminderService.getScheduleByPath('tasks/test.md');
      expect(schedule).toBeDefined();
      expect(schedule?.reminderTime.getHours()).toBe(9);
      expect(schedule?.reminderTime.getMinutes()).toBe(45);
      expect(schedule?.fired).toBe(false); // Should reset fired flag
    });

    it('should remove schedule when reminder time is cleared', () => {
      const settings = createMockSettings();
      const app = createMockApp();

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval: jest.fn(),
        registerEvent: jest.fn(),
      });

      const reminderService = manager.getReminderService();

      // Add a schedule
      reminderService.addScheduleDirectly({
        taskPath: 'tasks/test.md',
        taskName: 'Test Task',
        scheduledTime: '10:00',
        reminderTime: new Date(),
        fired: false,
        beingDisplayed: false,
      });

      expect(reminderService.getSchedules().length).toBe(1);

      // Clear the reminder time
      manager.onTaskReminderTimeChanged('tasks/test.md', null);

      expect(reminderService.getSchedules().length).toBe(0);
    });

    it('should create new schedule when reminder time is set for task without existing schedule', () => {
      const settings = createMockSettings();
      const app = createMockApp();

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval: jest.fn(),
        registerEvent: jest.fn(),
      });

      const reminderService = manager.getReminderService();
      expect(reminderService.getSchedules().length).toBe(0);

      // Set reminder time for a task that doesn't have a schedule yet
      // Pass task name and scheduled time for creating new schedule
      manager.onTaskReminderTimeChanged('tasks/new.md', '10:30', 'New Task', '11:00');

      const schedule = reminderService.getScheduleByPath('tasks/new.md');
      expect(schedule).toBeDefined();
      expect(schedule?.taskName).toBe('New Task');
      expect(schedule?.scheduledTime).toBe('11:00');
      expect(schedule?.reminderTime.getHours()).toBe(10);
      expect(schedule?.reminderTime.getMinutes()).toBe(30);
      expect(schedule?.fired).toBe(false);
    });
  });

  describe('onTaskComplete - Task Completion', () => {
    it('should remove schedule when task is completed', () => {
      const settings = createMockSettings();
      const app = createMockApp();

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval: jest.fn(),
        registerEvent: jest.fn(),
      });

      const reminderService = manager.getReminderService();

      // Add a schedule
      reminderService.addScheduleDirectly({
        taskPath: 'tasks/to-complete.md',
        taskName: 'Task to Complete',
        scheduledTime: '10:00',
        reminderTime: new Date(),
        fired: false,
        beingDisplayed: false,
      });

      expect(reminderService.getSchedules().length).toBe(1);

      // Complete the task
      manager.onTaskComplete('tasks/to-complete.md');

      expect(reminderService.getSchedules().length).toBe(0);
      expect(reminderService.getScheduleByPath('tasks/to-complete.md')).toBeNull();
    });

    it('should not throw when completing task without schedule', () => {
      const settings = createMockSettings();
      const app = createMockApp();

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval: jest.fn(),
        registerEvent: jest.fn(),
      });

      // This should not throw
      expect(() => {
        manager.onTaskComplete('tasks/nonexistent.md');
      }).not.toThrow();
    });
  });

  describe('Full Data Flow Scenario', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2025-01-15T09:00:00'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should fire notification when reminder time is reached after task load', () => {
      const settings = createMockSettings();
      const app = createMockApp();
      let intervalCallback: (() => void) | null = null;
      const registerInterval = jest.fn((cb: () => void) => {
        intervalCallback = cb;
        return 123;
      });

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval,
        registerEvent: jest.fn(),
      });

      // Start the periodic task
      manager.startPeriodicTask();

      // Load tasks with reminder
      const tasks = [
        {
          filePath: 'tasks/test.md',
          task: {
            name: 'Test Task',
            scheduledTime: '09:05',
            reminder_time: '09:00', // Same as current time
          },
        },
      ];

      manager.buildTodaySchedules(tasks);

      // Verify schedule was created
      const reminderService = manager.getReminderService();
      const schedule = reminderService.getScheduleByPath('tasks/test.md');
      expect(schedule).toBeDefined();
      expect(schedule?.fired).toBe(false);

      // Trigger the tick
      expect(intervalCallback).not.toBeNull();
      intervalCallback!();

      // Check that reminder was fired
      const updatedSchedule = reminderService.getScheduleByPath('tasks/test.md');
      expect(updatedSchedule?.fired).toBe(true);
    });

    it('should handle complete workflow: load -> update -> complete', () => {
      const settings = createMockSettings();
      const app = createMockApp();

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval: jest.fn(),
        registerEvent: jest.fn(),
      });

      // Step 1: Load tasks
      const tasks = [
        {
          filePath: 'tasks/workflow.md',
          task: {
            name: 'Workflow Task',
            scheduledTime: '10:00',
            reminder_time: '09:55',
          },
        },
      ];

      manager.buildTodaySchedules(tasks);
      expect(manager.getReminderService().getSchedules().length).toBe(1);

      // Step 2: Update reminder time via UI
      manager.onTaskReminderTimeChanged('tasks/workflow.md', '09:50');
      const updatedSchedule = manager.getReminderService().getScheduleByPath('tasks/workflow.md');
      expect(updatedSchedule?.reminderTime.getMinutes()).toBe(50);

      // Step 3: Complete the task
      manager.onTaskComplete('tasks/workflow.md');
      expect(manager.getReminderService().getSchedules().length).toBe(0);
    });

    it('should re-fire reminder after changing time on already-fired schedule', () => {
      // Scenario: Set reminder for 15:00, it fires, then change to 16:00, it should fire again
      jest.setSystemTime(new Date('2025-01-15T15:00:00'));

      const settings = createMockSettings();
      const app = createMockApp();
      let intervalCallback: (() => void) | null = null;
      const registerInterval = jest.fn((cb: () => void) => {
        intervalCallback = cb;
        return 123;
      });

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval,
        registerEvent: jest.fn(),
      });

      manager.startPeriodicTask();

      // Load task with reminder at 15:00
      const tasks = [
        {
          filePath: 'tasks/reschedule.md',
          task: {
            name: 'Reschedule Task',
            scheduledTime: '15:30',
            reminder_time: '15:00',
          },
        },
      ];

      manager.buildTodaySchedules(tasks);

      const reminderService = manager.getReminderService();

      // Verify initial schedule
      let schedule = reminderService.getScheduleByPath('tasks/reschedule.md');
      expect(schedule).toBeDefined();
      expect(schedule?.fired).toBe(false);

      // Tick - should fire the reminder (current time = 15:00, reminder time = 15:00)
      intervalCallback!();

      // Verify it fired
      schedule = reminderService.getScheduleByPath('tasks/reschedule.md');
      expect(schedule?.fired).toBe(true);

      // Now advance time to 15:30 and change reminder to 16:00
      jest.setSystemTime(new Date('2025-01-15T15:30:00'));
      manager.onTaskReminderTimeChanged(
        'tasks/reschedule.md',
        '16:00',
        'Reschedule Task',
        '16:30'
      );

      // Verify schedule was updated with fired = false
      schedule = reminderService.getScheduleByPath('tasks/reschedule.md');
      expect(schedule).toBeDefined();
      expect(schedule?.reminderTime.getHours()).toBe(16);
      expect(schedule?.reminderTime.getMinutes()).toBe(0);
      expect(schedule?.fired).toBe(false); // CRITICAL: This should be reset

      // Tick at 15:30 - should NOT fire (16:00 hasn't come yet)
      intervalCallback!();
      schedule = reminderService.getScheduleByPath('tasks/reschedule.md');
      expect(schedule?.fired).toBe(false);

      // Advance time to 16:00 and tick
      jest.setSystemTime(new Date('2025-01-15T16:00:00'));
      intervalCallback!();

      // Verify it fired again
      schedule = reminderService.getScheduleByPath('tasks/reschedule.md');
      expect(schedule?.fired).toBe(true);
    });

    it('should allow multiple reschedules and fires', () => {
      // Scenario: Fire at 14:00, reschedule to 15:00, fire, reschedule to 16:00, fire
      jest.setSystemTime(new Date('2025-01-15T14:00:00'));

      const settings = createMockSettings();
      const app = createMockApp();
      let intervalCallback: (() => void) | null = null;
      const registerInterval = jest.fn((cb: () => void) => {
        intervalCallback = cb;
        return 123;
      });

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval,
        registerEvent: jest.fn(),
      });

      manager.startPeriodicTask();

      // Load task with reminder at 14:00
      manager.buildTodaySchedules([
        {
          filePath: 'tasks/multi.md',
          task: {
            name: 'Multi Reschedule',
            scheduledTime: '14:30',
            reminder_time: '14:00',
          },
        },
      ]);

      const reminderService = manager.getReminderService();

      // First fire at 14:00
      intervalCallback!();
      let schedule = reminderService.getScheduleByPath('tasks/multi.md');
      expect(schedule?.fired).toBe(true);

      // Reschedule to 15:00
      jest.setSystemTime(new Date('2025-01-15T14:30:00'));
      manager.onTaskReminderTimeChanged('tasks/multi.md', '15:00', 'Multi Reschedule', '15:30');
      schedule = reminderService.getScheduleByPath('tasks/multi.md');
      expect(schedule?.fired).toBe(false);

      // Second fire at 15:00
      jest.setSystemTime(new Date('2025-01-15T15:00:00'));
      intervalCallback!();
      schedule = reminderService.getScheduleByPath('tasks/multi.md');
      expect(schedule?.fired).toBe(true);

      // Reschedule to 16:00
      manager.onTaskReminderTimeChanged('tasks/multi.md', '16:00', 'Multi Reschedule', '16:30');
      schedule = reminderService.getScheduleByPath('tasks/multi.md');
      expect(schedule?.fired).toBe(false);

      // Third fire at 16:00
      jest.setSystemTime(new Date('2025-01-15T16:00:00'));
      intervalCallback!();
      schedule = reminderService.getScheduleByPath('tasks/multi.md');
      expect(schedule?.fired).toBe(true);
    });
  });
});
