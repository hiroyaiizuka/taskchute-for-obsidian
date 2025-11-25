/**
 * @jest-environment jsdom
 */
import { TaskChuteSettings } from '../../src/types';
import { DEFAULT_SETTINGS } from '../../src/settings';

describe('TaskChuteSettings reminder fields', () => {
  describe('type definition', () => {
    it('should accept defaultReminderMinutes as optional number', () => {
      const settings: TaskChuteSettings = {
        ...DEFAULT_SETTINGS,
        defaultReminderMinutes: 5,
      };
      expect(settings.defaultReminderMinutes).toBe(5);
    });
  });

  describe('DEFAULT_SETTINGS', () => {
    it('should have defaultReminderMinutes defaulting to 5', () => {
      expect(DEFAULT_SETTINGS.defaultReminderMinutes).toBe(5);
    });

    it('should not have reminderCheckIntervalSec in defaults (internal value)', () => {
      // These are now internal fixed values, not exposed to users
      expect((DEFAULT_SETTINGS as Record<string, unknown>).reminderCheckIntervalSec).toBeUndefined();
    });

    it('should not have editDetectionSec in defaults (internal value)', () => {
      // These are now internal fixed values, not exposed to users
      expect((DEFAULT_SETTINGS as Record<string, unknown>).editDetectionSec).toBeUndefined();
    });

    it('should not have reminderEnabled in defaults (always enabled)', () => {
      // Reminder is now always enabled, no user setting
      expect((DEFAULT_SETTINGS as Record<string, unknown>).reminderEnabled).toBeUndefined();
    });
  });
});
