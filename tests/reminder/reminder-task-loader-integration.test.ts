/**
 * Integration tests: normalizeReminderTime applied at TaskLoaderService boundaries.
 *
 * These tests verify that normalizeReminderTime correctly handles the values
 * that would be passed through the various task creation paths in TaskLoaderService.
 */

import { normalizeReminderTime } from '../../src/features/reminder/services/ReminderFrontmatterService';

describe('TaskLoaderService reminder_time normalization (integration)', () => {
  describe('createTaskFromExecutions path', () => {
    it('should normalize string reminder_time from frontmatter metadata', () => {
      const metadata = { reminder_time: '09:55' };
      expect(normalizeReminderTime(metadata?.reminder_time)).toBe('09:55');
    });

    it('should normalize numeric reminder_time (595) from frontmatter to "09:55"', () => {
      const metadata = { reminder_time: 595 };
      expect(normalizeReminderTime(metadata?.reminder_time)).toBe('09:55');
    });

    it('should return undefined when metadata has no reminder_time', () => {
      const metadata = {};
      expect(normalizeReminderTime((metadata as Record<string, unknown>)?.reminder_time)).toBeUndefined();
    });

    it('should return undefined when metadata is undefined', () => {
      const metadata = undefined;
      expect(normalizeReminderTime(metadata?.reminder_time)).toBeUndefined();
    });
  });

  describe('createRoutineTask path', () => {
    it('should normalize numeric reminder_time (615) to "10:15"', () => {
      const metadata = { reminder_time: 615, isRoutine: true };
      expect(normalizeReminderTime(metadata.reminder_time)).toBe('10:15');
    });

    it('should preserve string reminder_time "09:55"', () => {
      const metadata = { reminder_time: '09:55', isRoutine: true };
      expect(normalizeReminderTime(metadata.reminder_time)).toBe('09:55');
    });

    it('should normalize single-digit hour "9:00" to "09:00"', () => {
      const metadata = { reminder_time: '9:00', isRoutine: true };
      expect(normalizeReminderTime(metadata.reminder_time)).toBe('09:00');
    });
  });

  describe('createNonRoutineTask path', () => {
    it('should normalize numeric reminder_time (595) to "09:55"', () => {
      const metadata = { reminder_time: 595, isRoutine: false };
      expect(normalizeReminderTime(metadata?.reminder_time)).toBe('09:55');
    });

    it('should preserve string reminder_time "14:30"', () => {
      const metadata = { reminder_time: '14:30', isRoutine: false };
      expect(normalizeReminderTime(metadata?.reminder_time)).toBe('14:30');
    });
  });

  describe('addDuplicatedInstances path', () => {
    it('should normalize numeric reminder_time (690) from frontmatter to "11:30"', () => {
      const metadata = { reminder_time: 690 };
      expect(normalizeReminderTime(metadata.reminder_time)).toBe('11:30');
    });

    it('should preserve string reminder_time "08:00"', () => {
      const metadata = { reminder_time: '08:00' };
      expect(normalizeReminderTime(metadata.reminder_time)).toBe('08:00');
    });
  });
});
