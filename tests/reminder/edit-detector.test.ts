/**
 * @jest-environment jsdom
 */
import { EditDetector } from '../../src/features/reminder/services/EditDetector';

describe('EditDetector', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('isEditing', () => {
    it('should return false when no key press has been recorded', () => {
      const detector = new EditDetector({ editDetectionSec: 10 });
      expect(detector.isEditing()).toBe(false);
    });

    it('should return true immediately after recording a key press', () => {
      const detector = new EditDetector({ editDetectionSec: 10 });
      detector.recordKeyPress();
      expect(detector.isEditing()).toBe(true);
    });

    it('should return true within the detection window', () => {
      const detector = new EditDetector({ editDetectionSec: 10 });
      detector.recordKeyPress();

      // Advance time by 5 seconds (within 10 second window)
      jest.advanceTimersByTime(5000);

      expect(detector.isEditing()).toBe(true);
    });

    it('should return false after the detection window expires', () => {
      const detector = new EditDetector({ editDetectionSec: 10 });
      detector.recordKeyPress();

      // Advance time by 11 seconds (past 10 second window)
      jest.advanceTimersByTime(11000);

      expect(detector.isEditing()).toBe(false);
    });

    it('should reset the timer on subsequent key presses', () => {
      const detector = new EditDetector({ editDetectionSec: 10 });
      detector.recordKeyPress();

      // Advance time by 8 seconds
      jest.advanceTimersByTime(8000);
      expect(detector.isEditing()).toBe(true);

      // Record another key press
      detector.recordKeyPress();

      // Advance time by another 8 seconds (16 total, but only 8 since last key press)
      jest.advanceTimersByTime(8000);
      expect(detector.isEditing()).toBe(true);

      // Advance time by another 3 seconds (11 since last key press)
      jest.advanceTimersByTime(3000);
      expect(detector.isEditing()).toBe(false);
    });
  });

  describe('editDetectionSec = 0', () => {
    it('should always return false when editDetectionSec is 0', () => {
      const detector = new EditDetector({ editDetectionSec: 0 });
      detector.recordKeyPress();
      expect(detector.isEditing()).toBe(false);
    });
  });

  describe('custom detection window', () => {
    it('should respect custom detection window of 5 seconds', () => {
      const detector = new EditDetector({ editDetectionSec: 5 });
      detector.recordKeyPress();

      jest.advanceTimersByTime(4000);
      expect(detector.isEditing()).toBe(true);

      jest.advanceTimersByTime(2000);
      expect(detector.isEditing()).toBe(false);
    });

    it('should respect custom detection window of 30 seconds', () => {
      const detector = new EditDetector({ editDetectionSec: 30 });
      detector.recordKeyPress();

      jest.advanceTimersByTime(25000);
      expect(detector.isEditing()).toBe(true);

      jest.advanceTimersByTime(10000);
      expect(detector.isEditing()).toBe(false);
    });
  });
});
