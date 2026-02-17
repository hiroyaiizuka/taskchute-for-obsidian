/**
 * Tests for normalizeReminderTime utility function.
 *
 * Verifies correct handling of:
 * - String values in HH:mm format (passthrough and normalization)
 * - Number values from YAML sexagesimal parsing (reverse conversion)
 * - Invalid values (out of range, wrong types)
 * - Boundary values
 */

import { normalizeReminderTime } from '../../src/features/reminder/services/ReminderFrontmatterService';

describe('normalizeReminderTime', () => {
  describe('string values', () => {
    it('should pass through valid "09:55" as "09:55"', () => {
      expect(normalizeReminderTime('09:55')).toBe('09:55');
    });

    it('should normalize single-digit hour "9:55" to "09:55"', () => {
      expect(normalizeReminderTime('9:55')).toBe('09:55');
    });

    it('should pass through "14:30" unchanged', () => {
      expect(normalizeReminderTime('14:30')).toBe('14:30');
    });

    it('should normalize "0:00" to "00:00"', () => {
      expect(normalizeReminderTime('0:00')).toBe('00:00');
    });

    it('should pass through "23:59"', () => {
      expect(normalizeReminderTime('23:59')).toBe('23:59');
    });

    it('should return undefined for "24:00" (out of range)', () => {
      expect(normalizeReminderTime('24:00')).toBeUndefined();
    });

    it('should return undefined for "23:60" (minutes out of range)', () => {
      expect(normalizeReminderTime('23:60')).toBeUndefined();
    });

    it('should return undefined for "99:99" (invalid time)', () => {
      expect(normalizeReminderTime('99:99')).toBeUndefined();
    });

    it('should return undefined for empty string', () => {
      expect(normalizeReminderTime('')).toBeUndefined();
    });

    it('should return undefined for "invalid"', () => {
      expect(normalizeReminderTime('invalid')).toBeUndefined();
    });

    it('should return undefined for "abc"', () => {
      expect(normalizeReminderTime('abc')).toBeUndefined();
    });

    it('should return undefined for "12:345"', () => {
      expect(normalizeReminderTime('12:345')).toBeUndefined();
    });
  });

  describe('number values (YAML sexagesimal reverse conversion)', () => {
    it('should convert 595 to "09:55"', () => {
      expect(normalizeReminderTime(595)).toBe('09:55');
    });

    it('should convert 615 to "10:15"', () => {
      expect(normalizeReminderTime(615)).toBe('10:15');
    });

    it('should convert 0 to "00:00"', () => {
      expect(normalizeReminderTime(0)).toBe('00:00');
    });

    it('should convert 1439 to "23:59"', () => {
      expect(normalizeReminderTime(1439)).toBe('23:59');
    });

    it('should return undefined for 1440 (out of range)', () => {
      expect(normalizeReminderTime(1440)).toBeUndefined();
    });

    it('should return undefined for negative numbers', () => {
      expect(normalizeReminderTime(-1)).toBeUndefined();
    });

    it('should return undefined for floating point numbers', () => {
      expect(normalizeReminderTime(9.5)).toBeUndefined();
    });

    it('should return undefined for NaN', () => {
      expect(normalizeReminderTime(NaN)).toBeUndefined();
    });

    it('should return undefined for Infinity', () => {
      expect(normalizeReminderTime(Infinity)).toBeUndefined();
    });

    it('should convert 5 to "00:05"', () => {
      expect(normalizeReminderTime(5)).toBe('00:05');
    });

    it('should convert 60 to "01:00"', () => {
      expect(normalizeReminderTime(60)).toBe('01:00');
    });

    it('should convert 690 to "11:30"', () => {
      expect(normalizeReminderTime(690)).toBe('11:30');
    });
  });

  describe('invalid types', () => {
    it('should return undefined for null', () => {
      expect(normalizeReminderTime(null)).toBeUndefined();
    });

    it('should return undefined for undefined', () => {
      expect(normalizeReminderTime(undefined)).toBeUndefined();
    });

    it('should return undefined for boolean true', () => {
      expect(normalizeReminderTime(true)).toBeUndefined();
    });

    it('should return undefined for boolean false', () => {
      expect(normalizeReminderTime(false)).toBeUndefined();
    });

    it('should return undefined for objects', () => {
      expect(normalizeReminderTime({})).toBeUndefined();
    });

    it('should return undefined for arrays', () => {
      expect(normalizeReminderTime([])).toBeUndefined();
    });
  });
});
