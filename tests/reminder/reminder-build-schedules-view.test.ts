/**
 * Tests for TaskChuteView.buildReminderSchedules normalization (Step 7).
 *
 * Since buildReminderSchedules is a private method, we test the normalization
 * behavior that feeds into ReminderSystemManager.buildTodaySchedules.
 */

import { normalizeReminderTime } from '../../src/features/reminder/services/ReminderFrontmatterService';

describe('buildReminderSchedules View-layer normalization', () => {
  // Simulates the filter+map logic from buildReminderSchedules
  const buildTasksWithReminders = (taskInstances: Array<{ task: { reminder_time?: unknown; name?: string; scheduledTime?: string; isRoutine?: boolean; path: string } }>) => {
    return taskInstances
      .map((inst) => {
        const normalized = normalizeReminderTime(inst.task.reminder_time);
        if (!normalized) return null;
        return {
          filePath: inst.task.path,
          task: {
            name: inst.task.name || 'Task',
            scheduledTime: inst.task.scheduledTime || '',
            reminder_time: normalized,
            isRoutine: inst.task.isRoutine,
          },
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  };

  it('should normalize numeric reminder_time (615) to "10:15"', () => {
    const instances = [{
      task: { path: 'tasks/test.md', name: 'Test', reminder_time: 615, scheduledTime: '10:30', isRoutine: true },
    }];

    const result = buildTasksWithReminders(instances);

    expect(result).toHaveLength(1);
    expect(result[0].task.reminder_time).toBe('10:15');
    expect(result[0].filePath).toBe('tasks/test.md');
  });

  it('should filter out invalid reminder_time "abc"', () => {
    const instances = [{
      task: { path: 'tasks/invalid.md', name: 'Invalid', reminder_time: 'abc', scheduledTime: '10:00' },
    }];

    const result = buildTasksWithReminders(instances);

    expect(result).toHaveLength(0);
  });

  it('should preserve valid string reminder_time "09:55"', () => {
    const instances = [{
      task: { path: 'tasks/valid.md', name: 'Valid', reminder_time: '09:55', scheduledTime: '10:00' },
    }];

    const result = buildTasksWithReminders(instances);

    expect(result).toHaveLength(1);
    expect(result[0].task.reminder_time).toBe('09:55');
  });

  it('should handle mixed valid, invalid, and numeric values', () => {
    const instances = [
      { task: { path: 'tasks/a.md', name: 'A', reminder_time: '09:55', scheduledTime: '10:00' } },
      { task: { path: 'tasks/b.md', name: 'B', reminder_time: 'abc', scheduledTime: '11:00' } },
      { task: { path: 'tasks/c.md', name: 'C', reminder_time: 595, scheduledTime: '10:00' } },
      { task: { path: 'tasks/d.md', name: 'D', reminder_time: undefined, scheduledTime: '12:00' } },
    ];

    const result = buildTasksWithReminders(instances);

    expect(result).toHaveLength(2);
    expect(result[0].filePath).toBe('tasks/a.md');
    expect(result[0].task.reminder_time).toBe('09:55');
    expect(result[1].filePath).toBe('tasks/c.md');
    expect(result[1].task.reminder_time).toBe('09:55');
  });

  it('should filter out undefined reminder_time', () => {
    const instances = [{
      task: { path: 'tasks/none.md', name: 'None', reminder_time: undefined, scheduledTime: '10:00' },
    }];

    const result = buildTasksWithReminders(instances);

    expect(result).toHaveLength(0);
  });
});
