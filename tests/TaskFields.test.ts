import {
  isDateString,
  isTimeString,
  isUUIDString,
} from '../src/types/TaskFields';

describe('TaskFields Type System', () => {
  describe('Type Guards', () => {
    test('isDateString validates date format', () => {
      expect(isDateString('2025-09-25')).toBe(true);
      expect(isDateString('2025-13-01')).toBe(true); // Format check only
      expect(isDateString('25-09-2025')).toBe(false);
      expect(isDateString('2025/09/25')).toBe(false);
      expect(isDateString('invalid')).toBe(false);
      expect(isDateString(null)).toBe(false);
    });

    test('isTimeString validates time format', () => {
      expect(isTimeString('09:00')).toBe(true);
      expect(isTimeString('23:59')).toBe(true);
      expect(isTimeString('00:00')).toBe(true);
      expect(isTimeString('9:00')).toBe(false);
      expect(isTimeString('09:00:00')).toBe(false);
      expect(isTimeString('invalid')).toBe(false);
      expect(isTimeString(null)).toBe(false);
      expect(isTimeString(undefined)).toBe(false);
    });

    test('isUUIDString validates UUID format', () => {
      expect(isUUIDString('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
      expect(isUUIDString('not-a-uuid')).toBe(false);
      expect(isUUIDString('550e8400-e29b-41d4-a716')).toBe(false);
      expect(isUUIDString(null)).toBe(false);
      expect(isUUIDString(undefined)).toBe(false);
      expect(isUUIDString(123)).toBe(false);
    });
  });

});