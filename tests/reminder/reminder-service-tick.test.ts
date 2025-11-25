/**
 * @jest-environment jsdom
 */
import { ReminderService } from '../../src/features/reminder/services/ReminderService';
import { EditDetector } from '../../src/features/reminder/services/EditDetector';
import { ReminderSchedule } from '../../src/features/reminder/services/ReminderScheduleManager';

describe('ReminderService tick logic', () => {
  let service: ReminderService;
  let editDetector: EditDetector;
  let notifyCallback: jest.Mock<void, [ReminderSchedule]>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-15T09:00:00'));

    editDetector = new EditDetector({ editDetectionSec: 10 });
    notifyCallback = jest.fn();

    service = new ReminderService({
      editDetector,
      onNotify: notifyCallback,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('tick', () => {
    it('should fire reminder when current time reaches reminder time', () => {
      // Add a schedule for 09:00 (current time)
      service.addScheduleDirectly({
        taskPath: '/tasks/test.md',
        taskName: 'Test Task',
        scheduledTime: '09:05',
        reminderTime: new Date('2025-01-15T09:00:00'),
        fired: false,
        beingDisplayed: false,
      });

      service.tick();

      expect(notifyCallback).toHaveBeenCalledTimes(1);
      expect(notifyCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          taskPath: '/tasks/test.md',
          taskName: 'Test Task',
        })
      );
    });

    it('should not fire reminder before reminder time', () => {
      // Add a schedule for 09:05 (5 minutes in future)
      service.addScheduleDirectly({
        taskPath: '/tasks/test.md',
        taskName: 'Test Task',
        scheduledTime: '09:10',
        reminderTime: new Date('2025-01-15T09:05:00'),
        fired: false,
        beingDisplayed: false,
      });

      service.tick();

      expect(notifyCallback).not.toHaveBeenCalled();
    });

    it('should not fire already fired reminder', () => {
      service.addScheduleDirectly({
        taskPath: '/tasks/test.md',
        taskName: 'Test Task',
        scheduledTime: '09:05',
        reminderTime: new Date('2025-01-15T09:00:00'),
        fired: true, // Already fired
        beingDisplayed: false,
      });

      service.tick();

      expect(notifyCallback).not.toHaveBeenCalled();
    });

    it('should mark reminder as fired after notification', () => {
      service.addScheduleDirectly({
        taskPath: '/tasks/test.md',
        taskName: 'Test Task',
        scheduledTime: '09:05',
        reminderTime: new Date('2025-01-15T09:00:00'),
        fired: false,
        beingDisplayed: false,
      });

      service.tick();

      const schedule = service.getScheduleByPath('/tasks/test.md');
      expect(schedule?.fired).toBe(true);
    });

    it('should skip notification when editing', () => {
      service.addScheduleDirectly({
        taskPath: '/tasks/test.md',
        taskName: 'Test Task',
        scheduledTime: '09:05',
        reminderTime: new Date('2025-01-15T09:00:00'),
        fired: false,
        beingDisplayed: false,
      });

      // Simulate editing
      editDetector.recordKeyPress();

      service.tick();

      expect(notifyCallback).not.toHaveBeenCalled();
      // Should NOT mark as fired when skipped due to editing
      const schedule = service.getScheduleByPath('/tasks/test.md');
      expect(schedule?.fired).toBe(false);
    });

    it('should not fire reminder for past times (more than threshold)', () => {
      // Set current time to 09:10
      jest.setSystemTime(new Date('2025-01-15T09:10:00'));

      // Add a schedule for 09:00 (10 minutes in the past)
      service.addScheduleDirectly({
        taskPath: '/tasks/test.md',
        taskName: 'Test Task',
        scheduledTime: '09:05',
        reminderTime: new Date('2025-01-15T09:00:00'),
        fired: false,
        beingDisplayed: false,
      });

      service.tick();

      // Should not fire for reminders more than 1 minute in the past
      expect(notifyCallback).not.toHaveBeenCalled();
    });

    it('should fire multiple reminders at same time', () => {
      service.addScheduleDirectly({
        taskPath: '/tasks/task1.md',
        taskName: 'Task 1',
        scheduledTime: '09:05',
        reminderTime: new Date('2025-01-15T09:00:00'),
        fired: false,
        beingDisplayed: false,
      });

      service.addScheduleDirectly({
        taskPath: '/tasks/task2.md',
        taskName: 'Task 2',
        scheduledTime: '09:05',
        reminderTime: new Date('2025-01-15T09:00:00'),
        fired: false,
        beingDisplayed: false,
      });

      service.tick();

      expect(notifyCallback).toHaveBeenCalledTimes(2);
    });

    it('should prevent duplicate tick execution with intervalTaskRunning flag', () => {
      service.addScheduleDirectly({
        taskPath: '/tasks/test.md',
        taskName: 'Test Task',
        scheduledTime: '09:05',
        reminderTime: new Date('2025-01-15T09:00:00'),
        fired: false,
        beingDisplayed: false,
      });

      // Simulate slow callback
      notifyCallback.mockImplementation(() => {
        // Try to call tick again while first tick is running
        service.tick();
      });

      service.tick();

      // Should only be called once despite nested tick call
      expect(notifyCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe('onTaskComplete', () => {
    it('should remove schedule when task is completed', () => {
      service.addScheduleDirectly({
        taskPath: '/tasks/test.md',
        taskName: 'Test Task',
        scheduledTime: '09:05',
        reminderTime: new Date('2025-01-15T09:00:00'),
        fired: false,
        beingDisplayed: false,
      });

      service.onTaskComplete('/tasks/test.md');

      expect(service.getScheduleByPath('/tasks/test.md')).toBeNull();
    });
  });

  // Note: onTaskTimeChanged is deprecated but kept for backward compatibility
  describe('onTaskTimeChanged (deprecated)', () => {
    it('should recalculate reminder time when task time changes', () => {
      service.addScheduleDirectly({
        taskPath: '/tasks/test.md',
        taskName: 'Test Task',
        scheduledTime: '09:05',
        reminderTime: new Date('2025-01-15T09:00:00'),
        fired: false,
        beingDisplayed: false,
      });

      // Change scheduled time from 09:05 to 10:05
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      service.onTaskTimeChanged('/tasks/test.md', '10:05', 5);

      const schedule = service.getScheduleByPath('/tasks/test.md');
      expect(schedule?.scheduledTime).toBe('10:05');
      expect(schedule?.reminderTime.getHours()).toBe(10);
      expect(schedule?.reminderTime.getMinutes()).toBe(0);
    });

    it('should reset fired flag when time changes', () => {
      service.addScheduleDirectly({
        taskPath: '/tasks/test.md',
        taskName: 'Test Task',
        scheduledTime: '09:05',
        reminderTime: new Date('2025-01-15T09:00:00'),
        fired: true, // Was already fired
        beingDisplayed: false,
      });

      // eslint-disable-next-line @typescript-eslint/no-deprecated
      service.onTaskTimeChanged('/tasks/test.md', '10:05', 5);

      const schedule = service.getScheduleByPath('/tasks/test.md');
      expect(schedule?.fired).toBe(false);
    });
  });
});
