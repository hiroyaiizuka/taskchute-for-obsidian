/**
 * @jest-environment jsdom
 */

import TaskSettingsTooltipController, {
  TaskSettingsTooltipHost,
} from '../../src/ui/task/TaskSettingsTooltipController';
import type { TaskInstance } from '../../src/types';

// Mock Obsidian's createEl method on HTMLElement
const mockCreateEl = function (
  this: HTMLElement,
  tagName: string,
  options?: { cls?: string; text?: string; attr?: Record<string, string> }
): HTMLElement {
  const el = document.createElement(tagName);
  if (options?.cls) {
    el.className = options.cls;
  }
  if (options?.text) {
    el.textContent = options.text;
  }
  if (options?.attr) {
    Object.entries(options.attr).forEach(([key, value]) => {
      el.setAttribute(key, value);
    });
  }
  this.appendChild(el);
  // Add createEl to the created element too
  (el as HTMLElement & { createEl: typeof mockCreateEl }).createEl = mockCreateEl;
  return el;
};

// Extend HTMLElement prototype for tests
beforeAll(() => {
  (HTMLElement.prototype as HTMLElement & { createEl: typeof mockCreateEl }).createEl = mockCreateEl;
});

describe('TaskSettingsTooltipController reminder menu item', () => {
  let controller: TaskSettingsTooltipController;
  let mockHost: TaskSettingsTooltipHost & {
    showReminderSettingsDialog: jest.Mock;
  };
  let mockInst: TaskInstance;
  let anchor: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';

    mockHost = {
      tv: jest.fn((key: string, fallback: string) => fallback),
      resetTaskToIdle: jest.fn(),
      showScheduledTimeEditModal: jest.fn(),
      showTaskMoveDatePicker: jest.fn(),
      duplicateInstance: jest.fn(),
      deleteRoutineTask: jest.fn(),
      deleteNonRoutineTask: jest.fn(),
      hasExecutionHistory: jest.fn().mockResolvedValue(false),
      showDeleteConfirmDialog: jest.fn().mockResolvedValue(true),
      showReminderSettingsDialog: jest.fn(),
    };

    mockInst = {
      instanceId: 'test-instance',
      date: '2025-01-15',
      state: 'idle',
      task: {
        id: 'test-task',
        name: 'Test Task',
        path: '/tasks/test.md',
        isRoutine: false,
        estimatedMinutes: 30,
        scheduledTime: '09:00',
        reminder_time: undefined,
      },
    } as TaskInstance;

    anchor = document.createElement('button');
    anchor.classList.add('test-anchor-fixed');
    document.body.appendChild(anchor);

    // Mock getBoundingClientRect
    anchor.getBoundingClientRect = jest.fn().mockReturnValue({
      top: 100,
      bottom: 120,
      left: 100,
      right: 200,
      width: 100,
      height: 20,
    });

    controller = new TaskSettingsTooltipController(mockHost);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('appendReminder', () => {
    it('should add reminder menu item to tooltip', () => {
      controller.show(mockInst, anchor);

      const tooltip = document.querySelector('.task-settings-tooltip');
      expect(tooltip).not.toBeNull();

      const items = tooltip?.querySelectorAll('.tooltip-item');
      const reminderItem = Array.from(items || []).find(
        (item) =>
          item.textContent?.includes('リマインダー') ||
          item.textContent?.includes('Reminder')
      );
      expect(reminderItem).toBeDefined();
    });

    it('should display bell or clock icon in reminder menu item', () => {
      controller.show(mockInst, anchor);

      const tooltip = document.querySelector('.task-settings-tooltip');
      const items = tooltip?.querySelectorAll('.tooltip-item');
      const reminderItem = Array.from(items || []).find(
        (item) =>
          item.textContent?.includes('🔔') || item.textContent?.includes('⏰')
      );
      expect(reminderItem).toBeDefined();
    });

    it('should call showReminderSettingsDialog when clicked', () => {
      controller.show(mockInst, anchor);

      const tooltip = document.querySelector('.task-settings-tooltip');
      const items = tooltip?.querySelectorAll('.tooltip-item');
      const reminderItem = Array.from(items || []).find(
        (item) =>
          item.textContent?.includes('リマインダー') ||
          item.textContent?.includes('Reminder')
      );

      (reminderItem as HTMLElement)?.click();

      expect(mockHost.showReminderSettingsDialog).toHaveBeenCalledWith(mockInst);
    });

    it('should close tooltip after clicking reminder item', () => {
      controller.show(mockInst, anchor);

      const tooltip = document.querySelector('.task-settings-tooltip');
      const items = tooltip?.querySelectorAll('.tooltip-item');
      const reminderItem = Array.from(items || []).find(
        (item) =>
          item.textContent?.includes('リマインダー') ||
          item.textContent?.includes('Reminder')
      );

      (reminderItem as HTMLElement)?.click();

      const tooltipAfterClick = document.querySelector('.task-settings-tooltip');
      expect(tooltipAfterClick).toBeNull();
    });

    it('should show "Set reminder" when no reminder is set', () => {
      mockInst.task.reminder_time = undefined;
      controller.show(mockInst, anchor);

      const tooltip = document.querySelector('.task-settings-tooltip');
      const items = tooltip?.querySelectorAll('.tooltip-item');
      const reminderItem = Array.from(items || []).find(
        (item) =>
          item.textContent?.includes('リマインダー') ||
          item.textContent?.includes('Reminder')
      );

      // Should not have "clear" text when no reminder is set
      expect(reminderItem?.textContent).not.toContain('解除');
      expect(reminderItem?.textContent).not.toContain('Clear');
    });

    it('should show reminder time when reminder is already set', () => {
      mockInst.task.reminder_time = '08:55';
      controller.show(mockInst, anchor);

      const tooltip = document.querySelector('.task-settings-tooltip');
      const items = tooltip?.querySelectorAll('.tooltip-item');
      const reminderItem = Array.from(items || []).find(
        (item) =>
          item.textContent?.includes('リマインダー') ||
          item.textContent?.includes('Reminder')
      );

      // Should indicate current setting with time
      expect(reminderItem?.textContent).toContain('08:55');
    });

    it('should show normalized time for numeric reminder_time (595)', () => {
      (mockInst.task as Record<string, unknown>).reminder_time = 595;
      controller.show(mockInst, anchor);

      const tooltip = document.querySelector('.task-settings-tooltip');
      const items = tooltip?.querySelectorAll('.tooltip-item');
      const reminderItem = Array.from(items || []).find(
        (item) =>
          item.textContent?.includes('リマインダー') ||
          item.textContent?.includes('Reminder')
      );

      expect(reminderItem?.textContent).toContain('09:55');
    });

    it('should show "set reminder" for invalid string reminder_time ("abc")', () => {
      mockInst.task.reminder_time = 'abc';
      controller.show(mockInst, anchor);

      const tooltip = document.querySelector('.task-settings-tooltip');
      const items = tooltip?.querySelectorAll('.tooltip-item');
      const reminderItem = Array.from(items || []).find(
        (item) =>
          item.textContent?.includes('リマインダー') ||
          item.textContent?.includes('Reminder')
      );

      // Should show "set" text, not a time
      expect(reminderItem?.textContent).not.toContain('abc');
      expect(reminderItem?.textContent).toMatch(/設定|Set/i);
    });

    it('should show "set reminder" for undefined reminder_time', () => {
      mockInst.task.reminder_time = undefined;
      controller.show(mockInst, anchor);

      const tooltip = document.querySelector('.task-settings-tooltip');
      const items = tooltip?.querySelectorAll('.tooltip-item');
      const reminderItem = Array.from(items || []).find(
        (item) =>
          item.textContent?.includes('リマインダー') ||
          item.textContent?.includes('Reminder')
      );

      expect(reminderItem?.textContent).toMatch(/設定|Set/i);
    });
  });
});
