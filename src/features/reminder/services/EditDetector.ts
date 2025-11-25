/**
 * EditDetector - Detects if user is currently editing to suppress notifications
 *
 * Tracks the last key press time and determines if the user is "editing"
 * based on whether the time since last key press is within the detection window.
 */

export interface EditDetectorOptions {
  /** Detection window in seconds. If 0, isEditing() always returns false. */
  editDetectionSec: number;
}

export class EditDetector {
  private lastKeyPressTime: number | null = null;
  private readonly editDetectionMs: number;

  constructor(options: EditDetectorOptions) {
    this.editDetectionMs = options.editDetectionSec * 1000;
  }

  /**
   * Record a key press event.
   * Call this when the user types in the editor.
   */
  recordKeyPress(): void {
    this.lastKeyPressTime = Date.now();
  }

  /**
   * Check if the user is currently editing.
   * Returns true if a key was pressed within the detection window.
   * Returns false if editDetectionSec is 0 (disabled).
   */
  isEditing(): boolean {
    // If detection is disabled, always return false
    if (this.editDetectionMs === 0) {
      return false;
    }

    // If no key press recorded, not editing
    if (this.lastKeyPressTime === null) {
      return false;
    }

    // Check if within the detection window
    const elapsed = Date.now() - this.lastKeyPressTime;
    return elapsed < this.editDetectionMs;
  }
}
