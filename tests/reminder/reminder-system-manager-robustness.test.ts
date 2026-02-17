/**
 * Tests for ReminderSystemManager.buildTodaySchedules robustness.
 *
 * Verifies that:
 * - Numeric reminder_time values don't crash parseTimeToDate
 * - Normalized values are used for schedule registration
 * - Invalid values are skipped
 */

import { ReminderSystemManager } from '../../src/features/reminder/services/ReminderSystemManager';
import type { ReminderSchedule } from '../../src/features/reminder/services/ReminderScheduleManager';

describe('ReminderSystemManager.buildTodaySchedules robustness', () => {
  let manager: ReminderSystemManager;
  let addedSchedules: ReminderSchedule[];

  beforeEach(() => {
    addedSchedules = [];

    manager = new ReminderSystemManager({
      app: {
        workspace: { on: jest.fn() },
      } as never,
      settings: {} as never,
      registerInterval: jest.fn(),
      registerEvent: jest.fn(),
    });

    // Spy on the internal ReminderService.addScheduleDirectly
    const reminderService = manager.getReminderService();
    jest.spyOn(reminderService, 'addScheduleDirectly').mockImplementation((schedule: ReminderSchedule) => {
      addedSchedules.push(schedule);
    });
    jest.spyOn(reminderService, 'getSchedules').mockReturnValue([]);
    jest.spyOn(reminderService, 'removeSchedule').mockImplementation(() => {});
  });

  it('should not throw when task has numeric reminder_time (595)', () => {
    const tasks = [{
      filePath: 'tasks/test.md',
      task: {
        name: 'Test Task',
        scheduledTime: '10:00',
        reminder_time: 595 as unknown as string,
        isRoutine: false,
      },
    }];

    expect(() => manager.buildTodaySchedules(tasks)).not.toThrow();
  });

  it('should register normalized schedule for numeric reminder_time (595)', () => {
    const tasks = [{
      filePath: 'tasks/test.md',
      task: {
        name: 'Test Task',
        scheduledTime: '10:00',
        reminder_time: 595 as unknown as string,
        isRoutine: false,
      },
    }];

    manager.buildTodaySchedules(tasks);

    expect(addedSchedules).toHaveLength(1);
    expect(addedSchedules[0].taskPath).toBe('tasks/test.md');
    // reminderTime is a Date; verify hours/minutes match 09:55
    const rt = addedSchedules[0].reminderTime;
    expect(rt.getHours()).toBe(9);
    expect(rt.getMinutes()).toBe(55);
  });

  it('should register schedule for numeric reminder_time (615) as 10:15', () => {
    const tasks = [{
      filePath: 'tasks/routine.md',
      task: {
        name: 'Routine',
        scheduledTime: '10:30',
        reminder_time: 615 as unknown as string,
        isRoutine: true,
      },
    }];

    manager.buildTodaySchedules(tasks);

    expect(addedSchedules).toHaveLength(1);
    const rt = addedSchedules[0].reminderTime;
    expect(rt.getHours()).toBe(10);
    expect(rt.getMinutes()).toBe(15);
  });

  it('should skip tasks with invalid reminder_time "abc"', () => {
    const tasks = [{
      filePath: 'tasks/invalid.md',
      task: {
        name: 'Invalid Task',
        scheduledTime: '10:00',
        reminder_time: 'abc',
        isRoutine: false,
      },
    }];

    manager.buildTodaySchedules(tasks);

    expect(addedSchedules).toHaveLength(0);
  });

  it('should skip tasks with undefined reminder_time', () => {
    const tasks = [{
      filePath: 'tasks/no-reminder.md',
      task: {
        name: 'No Reminder Task',
        scheduledTime: '10:00',
        reminder_time: undefined,
        isRoutine: false,
      },
    }];

    manager.buildTodaySchedules(tasks);

    expect(addedSchedules).toHaveLength(0);
  });

  it('should handle mix of valid and invalid reminder_time values', () => {
    const tasks = [
      {
        filePath: 'tasks/valid.md',
        task: { name: 'Valid', scheduledTime: '10:00', reminder_time: '09:55', isRoutine: false },
      },
      {
        filePath: 'tasks/invalid.md',
        task: { name: 'Invalid', scheduledTime: '10:00', reminder_time: 'abc', isRoutine: false },
      },
      {
        filePath: 'tasks/numeric.md',
        task: { name: 'Numeric', scheduledTime: '11:00', reminder_time: 615 as unknown as string, isRoutine: true },
      },
    ];

    manager.buildTodaySchedules(tasks);

    expect(addedSchedules).toHaveLength(2);
    expect(addedSchedules.map(s => s.taskPath)).toContain('tasks/valid.md');
    expect(addedSchedules.map(s => s.taskPath)).toContain('tasks/numeric.md');
  });
});
