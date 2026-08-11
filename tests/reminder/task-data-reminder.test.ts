/**
 * @jest-environment jsdom
 */
import { TaskData } from '../../src/types';

describe('TaskData reminder_time field', () => {
  describe('type definition', () => {
    it('should accept reminder_time as optional string field', () => {
      const taskWithReminder: TaskData = {
        file: null,
        frontmatter: { reminder_time: '08:55' },
        path: '/tasks/test-task.md',
        name: 'Test Task',
        reminder_time: '08:55',
      };

      expect(taskWithReminder.reminder_time).toBe('08:55');
    });

    it('should allow reminder_time to be undefined', () => {
      const taskWithoutReminder: TaskData = {
        file: null,
        frontmatter: {},
        path: '/tasks/test-task.md',
        name: 'Test Task',
      };

      expect(taskWithoutReminder.reminder_time).toBeUndefined();
    });

    it('should store reminder_time in frontmatter', () => {
      const task: TaskData = {
        file: null,
        frontmatter: { reminder_time: '10:15' },
        path: '/tasks/test-task.md',
        name: 'Test Task',
        reminder_time: '10:15',
      };

      expect(task.frontmatter.reminder_time).toBe('10:15');
    });
  });

  describe('valid reminder_time values', () => {
    it('should accept valid HH:mm time strings', () => {
      const validValues = ['08:55', '09:00', '10:15', '15:30', '23:59', '00:00'];

      validValues.forEach(time => {
        const task: TaskData = {
          file: null,
          frontmatter: { reminder_time: time },
          path: '/tasks/test-task.md',
          name: 'Test Task',
          reminder_time: time,
        };

        expect(task.reminder_time).toBe(time);
      });
    });
  });
});
