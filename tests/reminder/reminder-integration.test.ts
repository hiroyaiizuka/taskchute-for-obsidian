/**
 * Tests for reminder system integration with plugin lifecycle.
 */

import { ReminderSystemManager } from '../../src/features/reminder/services/ReminderSystemManager';
import { EditDetector } from '../../src/features/reminder/services/EditDetector';
import { ReminderService } from '../../src/features/reminder/services/ReminderService';
import { NotificationService } from '../../src/features/reminder/services/NotificationService';
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

describe('ReminderSystemManager', () => {
  // Mock settings - now uses only user-configurable fields
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

  describe('initialization', () => {
    it('should create all required services', () => {
      const settings = createMockSettings();
      const app = createMockApp();

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval: jest.fn(),
        registerEvent: jest.fn(),
      });

      expect(manager.getEditDetector()).toBeInstanceOf(EditDetector);
      expect(manager.getReminderService()).toBeInstanceOf(ReminderService);
      expect(manager.getNotificationService()).toBeInstanceOf(NotificationService);
    });

    it('should use internal fixed values for service configuration', () => {
      const settings = createMockSettings();
      const app = createMockApp();

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval: jest.fn(),
        registerEvent: jest.fn(),
      });

      // EditDetector uses internal fixed value (10 seconds)
      const editDetector = manager.getEditDetector();
      // With 10 second detection, isEditing should return false when no key press
      expect(editDetector.isEditing()).toBe(false);

      // ReminderService should process tick without error
      const reminderService = manager.getReminderService();
      reminderService.tick();
      // No error means it worked
    });
  });

  describe('startPeriodicTask', () => {
    it('should register interval with internal fixed check interval (5 seconds)', () => {
      const settings = createMockSettings();
      const app = createMockApp();
      const registerInterval = jest.fn();

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval,
        registerEvent: jest.fn(),
      });

      manager.startPeriodicTask();

      // Should register interval with internal fixed value (5 * 1000)
      expect(registerInterval).toHaveBeenCalledWith(
        expect.any(Function),
        5 * 1000
      );
    });

    it('should call tick on each interval', () => {
      const settings = createMockSettings();
      const app = createMockApp();
      let intervalCallback: (() => void) | null = null;
      const registerInterval = jest.fn((cb: () => void) => {
        intervalCallback = cb;
        return 123; // interval ID
      });

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval,
        registerEvent: jest.fn(),
      });

      manager.startPeriodicTask();

      // Mock a schedule
      const reminderService = manager.getReminderService();
      const now = new Date();
      reminderService.addScheduleDirectly({
        taskPath: 'test/task.md',
        taskName: 'Test Task',
        scheduledTime: '10:00',
        reminderTime: new Date(now.getTime() - 1000), // 1 second ago
        fired: false,
        beingDisplayed: false,
      });

      // Trigger the interval callback
      expect(intervalCallback).not.toBeNull();
      intervalCallback!();

      // The reminder should have been fired
      const schedule = reminderService.getScheduleByPath('test/task.md');
      expect(schedule?.fired).toBe(true);
    });

    it('should handle date change by clearing schedules', () => {
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

      const reminderService = manager.getReminderService();

      // Set initial date
      reminderService.setCurrentDate('2025-01-01');

      // Add a schedule
      reminderService.addScheduleDirectly({
        taskPath: 'test/task.md',
        taskName: 'Test Task',
        scheduledTime: '10:00',
        reminderTime: new Date(),
        fired: false,
        beingDisplayed: false,
      });

      expect(reminderService.getSchedules().length).toBe(1);

      // Simulate date change in tick by mocking hasDateChanged
      // The manager should detect this and clear schedules
      const originalHasDateChanged = reminderService.hasDateChanged.bind(reminderService);
      reminderService.hasDateChanged = jest.fn(() => true);

      intervalCallback!();

      // Schedules should be cleared on date change
      expect(reminderService.getSchedules().length).toBe(0);

      // Restore
      reminderService.hasDateChanged = originalHasDateChanged;
    });
  });

  describe('registerEditorEvents', () => {
    it('should register editor change event', () => {
      const settings = createMockSettings();
      const app = createMockApp();
      const registerEvent = jest.fn();

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval: jest.fn(),
        registerEvent,
      });

      manager.registerEditorEvents();

      expect(registerEvent).toHaveBeenCalled();
    });

    it('should record key press on editor change', () => {
      const settings = createMockSettings();
      let editorChangeCallback: (() => void) | null = null;
      const app = {
        workspace: {
          openLinkText: jest.fn(),
          on: jest.fn((eventName: string, callback: () => void) => {
            if (eventName === 'editor-change') {
              editorChangeCallback = callback;
            }
            return { unload: jest.fn() };
          }),
        },
      } as unknown as App;
      const registerEvent = jest.fn((eventRef) => eventRef);

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval: jest.fn(),
        registerEvent,
      });

      manager.registerEditorEvents();

      const editDetector = manager.getEditDetector();
      expect(editDetector.isEditing()).toBe(false);

      // Simulate editor change event
      expect(editorChangeCallback).not.toBeNull();
      if (editorChangeCallback) {
        editorChangeCallback();
      }

      // Now should be editing
      expect(editDetector.isEditing()).toBe(true);
    });
  });

  describe('dispose', () => {
    it('should clear all schedules on dispose', () => {
      const settings = createMockSettings();
      const app = createMockApp();

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval: jest.fn(),
        registerEvent: jest.fn(),
      });

      const reminderService = manager.getReminderService();
      reminderService.addScheduleDirectly({
        taskPath: 'test/task.md',
        taskName: 'Test Task',
        scheduledTime: '10:00',
        reminderTime: new Date(),
        fired: false,
        beingDisplayed: false,
      });

      expect(reminderService.getSchedules().length).toBe(1);

      manager.dispose();

      expect(reminderService.getSchedules().length).toBe(0);
    });

    it('should clear interval on dispose', () => {
      const settings = createMockSettings();
      const app = createMockApp();
      const mockClearInterval = jest.spyOn(window, 'clearInterval');

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval: jest.fn(() => 123), // Return interval ID
        registerEvent: jest.fn(),
      });

      manager.startPeriodicTask();
      manager.dispose();

      expect(mockClearInterval).toHaveBeenCalledWith(123);
      mockClearInterval.mockRestore();
    });

    it('should not throw when disposing without starting periodic task', () => {
      const settings = createMockSettings();
      const app = createMockApp();

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval: jest.fn(),
        registerEvent: jest.fn(),
      });

      // Should not throw even if startPeriodicTask was never called
      expect(() => manager.dispose()).not.toThrow();
    });
  });

  describe('onTaskComplete', () => {
    it('should forward task completion to reminder service', () => {
      const settings = createMockSettings();
      const app = createMockApp();

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval: jest.fn(),
        registerEvent: jest.fn(),
      });

      const reminderService = manager.getReminderService();
      reminderService.addScheduleDirectly({
        taskPath: 'test/task.md',
        taskName: 'Test Task',
        scheduledTime: '10:00',
        reminderTime: new Date(),
        fired: false,
        beingDisplayed: false,
      });

      expect(reminderService.getSchedules().length).toBe(1);

      manager.onTaskComplete('test/task.md');

      expect(reminderService.getSchedules().length).toBe(0);
    });
  });

  describe('onTaskReminderTimeChanged', () => {
    it('should update schedule when reminder time changes', () => {
      const settings = createMockSettings();
      const app = createMockApp();

      const manager = new ReminderSystemManager({
        app,
        settings,
        registerInterval: jest.fn(),
        registerEvent: jest.fn(),
      });

      const reminderService = manager.getReminderService();
      const originalTime = new Date();
      originalTime.setHours(9, 55, 0, 0);

      reminderService.addScheduleDirectly({
        taskPath: 'test/task.md',
        taskName: 'Test Task',
        scheduledTime: '10:00',
        reminderTime: originalTime,
        fired: false,
        beingDisplayed: false,
      });

      // Change reminder time to 10:55
      manager.onTaskReminderTimeChanged('test/task.md', '10:55');

      const schedule = reminderService.getScheduleByPath('test/task.md');
      expect(schedule?.reminderTime.getHours()).toBe(10);
      expect(schedule?.reminderTime.getMinutes()).toBe(55);
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
      reminderService.addScheduleDirectly({
        taskPath: 'test/task.md',
        taskName: 'Test Task',
        scheduledTime: '10:00',
        reminderTime: new Date(),
        fired: false,
        beingDisplayed: false,
      });

      expect(reminderService.getSchedules().length).toBe(1);

      manager.onTaskReminderTimeChanged('test/task.md', null);

      expect(reminderService.getSchedules().length).toBe(0);
    });
  });

  describe('buildTodaySchedules', () => {
    it('should accept task instances with reminder_time and build schedules', () => {
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
          filePath: 'task1.md',
          task: {
            name: 'Task 1',
            scheduledTime: '10:00',
            reminder_time: '09:55',
          },
        },
        {
          filePath: 'task2.md',
          task: {
            name: 'Task 2',
            scheduledTime: '11:00',
            reminder_time: '10:50',
          },
        },
        {
          filePath: 'task3.md',
          task: {
            name: 'Task 3 (no reminder)',
            scheduledTime: '12:00',
            // No reminder_time
          },
        },
      ];

      manager.buildTodaySchedules(tasks as unknown[]);

      const reminderService = manager.getReminderService();
      const schedules = reminderService.getSchedules();

      // Only tasks with reminder_time should have schedules
      expect(schedules.length).toBe(2);
      expect(schedules.find(s => s.taskPath === 'task1.md')).toBeDefined();
      expect(schedules.find(s => s.taskPath === 'task2.md')).toBeDefined();
      expect(schedules.find(s => s.taskPath === 'task3.md')).toBeUndefined();
    });

    it('should parse reminder_time correctly', () => {
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
          filePath: 'task1.md',
          task: {
            name: 'Task 1',
            scheduledTime: '10:00',
            reminder_time: '09:55',
          },
        },
      ];

      manager.buildTodaySchedules(tasks as unknown[]);

      const reminderService = manager.getReminderService();
      const schedule = reminderService.getScheduleByPath('task1.md');

      expect(schedule?.reminderTime.getHours()).toBe(9);
      expect(schedule?.reminderTime.getMinutes()).toBe(55);
    });

    it('should handle routine tasks', () => {
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
          filePath: 'routine.md',
          task: {
            name: 'Routine Task',
            scheduledTime: '09:00',
            reminder_time: '08:57',
            isRoutine: true,
          },
        },
      ];

      manager.buildTodaySchedules(tasks as unknown[]);

      const schedules = manager.getReminderService().getSchedules();
      expect(schedules.length).toBe(1);
      expect(schedules[0].taskName).toBe('Routine Task');
    });
  });

});
