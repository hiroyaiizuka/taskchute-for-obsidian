/**
 * Tests for showReminderSettingsDialog normalization (Step 8).
 *
 * Verifies that normalizeReminderTime is applied to inst.task.reminder_time
 * before passing to ReminderSettingsModal.
 */

import { normalizeReminderTime } from '../../src/features/reminder/services/ReminderFrontmatterService';

describe('showReminderSettingsDialog currentTime normalization', () => {
  it('should normalize numeric reminder_time (595) to "09:55" for modal', () => {
    const taskReminderTime = 595 as unknown;
    const currentTime = normalizeReminderTime(taskReminderTime);
    expect(currentTime).toBe('09:55');
  });

  it('should pass through valid string "14:30"', () => {
    const taskReminderTime = '14:30';
    const currentTime = normalizeReminderTime(taskReminderTime);
    expect(currentTime).toBe('14:30');
  });

  it('should return undefined for invalid string "abc"', () => {
    const taskReminderTime = 'abc';
    const currentTime = normalizeReminderTime(taskReminderTime);
    expect(currentTime).toBeUndefined();
  });

  it('should return undefined for undefined', () => {
    const taskReminderTime = undefined;
    const currentTime = normalizeReminderTime(taskReminderTime);
    expect(currentTime).toBeUndefined();
  });

  it('should normalize numeric 615 to "10:15"', () => {
    const taskReminderTime = 615 as unknown;
    const currentTime = normalizeReminderTime(taskReminderTime);
    expect(currentTime).toBe('10:15');
  });
});
