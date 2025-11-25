/**
 * @jest-environment jsdom
 */
import {
  getReminderTimeFromFrontmatter,
  setReminderTimeToFrontmatter,
  clearReminderFromFrontmatter,
} from '../../src/features/reminder/services/ReminderFrontmatterService';

describe('ReminderFrontmatterService', () => {
  describe('getReminderTimeFromFrontmatter', () => {
    it('should return reminder_time when set', () => {
      const frontmatter = { reminder_time: '08:55' };
      expect(getReminderTimeFromFrontmatter(frontmatter)).toBe('08:55');
    });

    it('should return null when reminder_time is not set', () => {
      const frontmatter = {};
      expect(getReminderTimeFromFrontmatter(frontmatter)).toBeNull();
    });

    it('should return null when frontmatter is undefined', () => {
      expect(getReminderTimeFromFrontmatter(undefined)).toBeNull();
    });

    it('should return null when reminder_time is not a string', () => {
      const frontmatter = { reminder_time: 5 };
      expect(getReminderTimeFromFrontmatter(frontmatter)).toBeNull();
    });

    it('should return null when reminder_time is empty string', () => {
      const frontmatter = { reminder_time: '' };
      expect(getReminderTimeFromFrontmatter(frontmatter)).toBeNull();
    });

    it('should return null when reminder_time is invalid format', () => {
      const frontmatter = { reminder_time: 'invalid' };
      expect(getReminderTimeFromFrontmatter(frontmatter)).toBeNull();
    });

    it('should accept single-digit hour format', () => {
      const frontmatter = { reminder_time: '9:00' };
      expect(getReminderTimeFromFrontmatter(frontmatter)).toBe('9:00');
    });

    it('should accept double-digit hour format', () => {
      const frontmatter = { reminder_time: '09:00' };
      expect(getReminderTimeFromFrontmatter(frontmatter)).toBe('09:00');
    });
  });

  describe('setReminderTimeToFrontmatter', () => {
    it('should set reminder_time in frontmatter', () => {
      const frontmatter: Record<string, unknown> = {};
      setReminderTimeToFrontmatter(frontmatter, '08:55');
      expect(frontmatter.reminder_time).toBe('08:55');
    });

    it('should overwrite existing reminder_time', () => {
      const frontmatter: Record<string, unknown> = { reminder_time: '10:00' };
      setReminderTimeToFrontmatter(frontmatter, '15:30');
      expect(frontmatter.reminder_time).toBe('15:30');
    });

    it('should preserve other frontmatter fields', () => {
      const frontmatter: Record<string, unknown> = {
        name: 'Test Task',
        scheduled_time: '09:00',
      };
      setReminderTimeToFrontmatter(frontmatter, '08:55');

      expect(frontmatter.name).toBe('Test Task');
      expect(frontmatter.scheduled_time).toBe('09:00');
      expect(frontmatter.reminder_time).toBe('08:55');
    });
  });

  describe('clearReminderFromFrontmatter', () => {
    it('should remove reminder_time from frontmatter', () => {
      const frontmatter: Record<string, unknown> = { reminder_time: '08:55' };
      clearReminderFromFrontmatter(frontmatter);
      expect(frontmatter.reminder_time).toBeUndefined();
    });

    it('should do nothing if reminder_time does not exist', () => {
      const frontmatter: Record<string, unknown> = { name: 'Test Task' };
      clearReminderFromFrontmatter(frontmatter);
      expect(frontmatter.name).toBe('Test Task');
      expect(frontmatter.reminder_time).toBeUndefined();
    });

    it('should preserve other frontmatter fields', () => {
      const frontmatter: Record<string, unknown> = {
        name: 'Test Task',
        scheduled_time: '09:00',
        reminder_time: '08:55',
      };
      clearReminderFromFrontmatter(frontmatter);

      expect(frontmatter.name).toBe('Test Task');
      expect(frontmatter.scheduled_time).toBe('09:00');
      expect(frontmatter.reminder_time).toBeUndefined();
    });
  });
});
