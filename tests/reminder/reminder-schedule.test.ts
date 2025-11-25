/**
 * @jest-environment jsdom
 */
import {
  ReminderSchedule,
  ReminderScheduleManager,
  calculateReminderTime,
} from '../../src/features/reminder/services/ReminderScheduleManager';

describe('ReminderScheduleManager', () => {
  describe('calculateReminderTime', () => {
    it('should calculate reminder time correctly for 5 minutes before', () => {
      const baseDate = new Date('2025-01-15');
      const result = calculateReminderTime('09:00', 5, baseDate);

      expect(result.getHours()).toBe(8);
      expect(result.getMinutes()).toBe(55);
    });

    it('should calculate reminder time correctly for 10 minutes before', () => {
      const baseDate = new Date('2025-01-15');
      const result = calculateReminderTime('14:30', 10, baseDate);

      expect(result.getHours()).toBe(14);
      expect(result.getMinutes()).toBe(20);
    });

    it('should handle reminder time crossing hour boundary', () => {
      const baseDate = new Date('2025-01-15');
      const result = calculateReminderTime('10:05', 10, baseDate);

      expect(result.getHours()).toBe(9);
      expect(result.getMinutes()).toBe(55);
    });

    it('should handle reminder time crossing midnight', () => {
      const baseDate = new Date('2025-01-15');
      const result = calculateReminderTime('00:05', 10, baseDate);

      // Should be 23:55 of the previous day
      expect(result.getHours()).toBe(23);
      expect(result.getMinutes()).toBe(55);
      expect(result.getDate()).toBe(14); // Previous day
    });

    it('should return null for invalid time format', () => {
      const baseDate = new Date('2025-01-15');
      const result = calculateReminderTime('invalid', 5, baseDate);

      expect(result).toBeNull();
    });

    it('should return null for undefined scheduledTime', () => {
      const baseDate = new Date('2025-01-15');
      const result = calculateReminderTime(undefined, 5, baseDate);

      expect(result).toBeNull();
    });
  });

  describe('ReminderScheduleManager', () => {
    let manager: ReminderScheduleManager;

    beforeEach(() => {
      manager = new ReminderScheduleManager();
    });

    describe('addSchedule', () => {
      it('should add a schedule to the list', () => {
        const schedule: ReminderSchedule = {
          taskPath: '/tasks/test.md',
          taskName: 'Test Task',
          scheduledTime: '09:00',
          reminderTime: new Date('2025-01-15T08:55:00'),
          fired: false,
          beingDisplayed: false,
        };

        manager.addSchedule(schedule);
        const schedules = manager.getSchedules();

        expect(schedules).toHaveLength(1);
        expect(schedules[0].taskPath).toBe('/tasks/test.md');
      });

      it('should allow multiple schedules', () => {
        manager.addSchedule({
          taskPath: '/tasks/task1.md',
          taskName: 'Task 1',
          scheduledTime: '09:00',
          reminderTime: new Date('2025-01-15T08:55:00'),
          fired: false,
          beingDisplayed: false,
        });

        manager.addSchedule({
          taskPath: '/tasks/task2.md',
          taskName: 'Task 2',
          scheduledTime: '10:00',
          reminderTime: new Date('2025-01-15T09:55:00'),
          fired: false,
          beingDisplayed: false,
        });

        expect(manager.getSchedules()).toHaveLength(2);
      });
    });

    describe('removeSchedule', () => {
      it('should remove a schedule by task path', () => {
        manager.addSchedule({
          taskPath: '/tasks/test.md',
          taskName: 'Test Task',
          scheduledTime: '09:00',
          reminderTime: new Date('2025-01-15T08:55:00'),
          fired: false,
          beingDisplayed: false,
        });

        manager.removeSchedule('/tasks/test.md');

        expect(manager.getSchedules()).toHaveLength(0);
      });

      it('should not affect other schedules when removing', () => {
        manager.addSchedule({
          taskPath: '/tasks/task1.md',
          taskName: 'Task 1',
          scheduledTime: '09:00',
          reminderTime: new Date('2025-01-15T08:55:00'),
          fired: false,
          beingDisplayed: false,
        });

        manager.addSchedule({
          taskPath: '/tasks/task2.md',
          taskName: 'Task 2',
          scheduledTime: '10:00',
          reminderTime: new Date('2025-01-15T09:55:00'),
          fired: false,
          beingDisplayed: false,
        });

        manager.removeSchedule('/tasks/task1.md');

        const schedules = manager.getSchedules();
        expect(schedules).toHaveLength(1);
        expect(schedules[0].taskPath).toBe('/tasks/task2.md');
      });
    });

    describe('getScheduleByPath', () => {
      it('should return schedule for given path', () => {
        manager.addSchedule({
          taskPath: '/tasks/test.md',
          taskName: 'Test Task',
          scheduledTime: '09:00',
          reminderTime: new Date('2025-01-15T08:55:00'),
          fired: false,
          beingDisplayed: false,
        });

        const schedule = manager.getScheduleByPath('/tasks/test.md');

        expect(schedule).not.toBeNull();
        expect(schedule?.taskName).toBe('Test Task');
      });

      it('should return null for non-existent path', () => {
        const schedule = manager.getScheduleByPath('/tasks/nonexistent.md');

        expect(schedule).toBeNull();
      });
    });

    describe('markAsFired', () => {
      it('should mark a schedule as fired', () => {
        manager.addSchedule({
          taskPath: '/tasks/test.md',
          taskName: 'Test Task',
          scheduledTime: '09:00',
          reminderTime: new Date('2025-01-15T08:55:00'),
          fired: false,
          beingDisplayed: false,
        });

        manager.markAsFired('/tasks/test.md');

        const schedule = manager.getScheduleByPath('/tasks/test.md');
        expect(schedule?.fired).toBe(true);
      });
    });

    describe('setBeingDisplayed', () => {
      it('should set beingDisplayed flag', () => {
        manager.addSchedule({
          taskPath: '/tasks/test.md',
          taskName: 'Test Task',
          scheduledTime: '09:00',
          reminderTime: new Date('2025-01-15T08:55:00'),
          fired: false,
          beingDisplayed: false,
        });

        manager.setBeingDisplayed('/tasks/test.md', true);

        const schedule = manager.getScheduleByPath('/tasks/test.md');
        expect(schedule?.beingDisplayed).toBe(true);
      });

      it('should be able to clear beingDisplayed flag', () => {
        manager.addSchedule({
          taskPath: '/tasks/test.md',
          taskName: 'Test Task',
          scheduledTime: '09:00',
          reminderTime: new Date('2025-01-15T08:55:00'),
          fired: false,
          beingDisplayed: true,
        });

        manager.setBeingDisplayed('/tasks/test.md', false);

        const schedule = manager.getScheduleByPath('/tasks/test.md');
        expect(schedule?.beingDisplayed).toBe(false);
      });
    });

    describe('clearAllSchedules', () => {
      it('should remove all schedules', () => {
        manager.addSchedule({
          taskPath: '/tasks/task1.md',
          taskName: 'Task 1',
          scheduledTime: '09:00',
          reminderTime: new Date('2025-01-15T08:55:00'),
          fired: false,
          beingDisplayed: false,
        });

        manager.addSchedule({
          taskPath: '/tasks/task2.md',
          taskName: 'Task 2',
          scheduledTime: '10:00',
          reminderTime: new Date('2025-01-15T09:55:00'),
          fired: false,
          beingDisplayed: false,
        });

        manager.clearAllSchedules();

        expect(manager.getSchedules()).toHaveLength(0);
      });
    });

    describe('getPendingSchedules', () => {
      it('should return only unfired schedules', () => {
        manager.addSchedule({
          taskPath: '/tasks/task1.md',
          taskName: 'Task 1',
          scheduledTime: '09:00',
          reminderTime: new Date('2025-01-15T08:55:00'),
          fired: true,
          beingDisplayed: false,
        });

        manager.addSchedule({
          taskPath: '/tasks/task2.md',
          taskName: 'Task 2',
          scheduledTime: '10:00',
          reminderTime: new Date('2025-01-15T09:55:00'),
          fired: false,
          beingDisplayed: false,
        });

        const pending = manager.getPendingSchedules();

        expect(pending).toHaveLength(1);
        expect(pending[0].taskPath).toBe('/tasks/task2.md');
      });
    });

    describe('updateScheduleTime', () => {
      it('should update the reminder time for a schedule', () => {
        manager.addSchedule({
          taskPath: '/tasks/test.md',
          taskName: 'Test Task',
          scheduledTime: '09:00',
          reminderTime: new Date('2025-01-15T08:55:00'),
          fired: false,
          beingDisplayed: false,
        });

        const newTime = new Date('2025-01-15T09:55:00');
        manager.updateScheduleTime('/tasks/test.md', '10:00', newTime);

        const schedule = manager.getScheduleByPath('/tasks/test.md');
        expect(schedule?.scheduledTime).toBe('10:00');
        expect(schedule?.reminderTime).toEqual(newTime);
        // Should reset fired flag when time changes
        expect(schedule?.fired).toBe(false);
      });
    });
  });

  describe('Date change detection', () => {
    it('should detect date change', () => {
      const manager = new ReminderScheduleManager();

      manager.setCurrentDate('2025-01-15');
      expect(manager.hasDateChanged('2025-01-15')).toBe(false);
      expect(manager.hasDateChanged('2025-01-16')).toBe(true);
    });

    it('should update current date', () => {
      const manager = new ReminderScheduleManager();

      manager.setCurrentDate('2025-01-15');
      manager.setCurrentDate('2025-01-16');

      expect(manager.hasDateChanged('2025-01-16')).toBe(false);
    });
  });
});
