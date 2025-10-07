/**
 * TaskChute Plus - Task Field Type Definitions
 * Phase 3: Properly typed field definitions
 */

// ============================================================================
// Base Types
// ============================================================================

/** ISO 8601 date string (YYYY-MM-DD) */
export type DateString = string;

/** Time string (HH:mm) */
export type TimeString = string;

/** UUID v4 string */
export type UUIDString = string;

// Type guards
export function isDateString(value: unknown): value is DateString {
  if (typeof value !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function isTimeString(value: unknown): value is TimeString {
  if (typeof value !== 'string') return false;
  return /^\d{2}:\d{2}$/.test(value);
}

export function isUUIDString(value: unknown): value is UUIDString {
  if (typeof value !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// ============================================================================
// Task Scheduling Fields
// ============================================================================

export interface TaskSchedulingFields {
  /**
   * Scheduled time for the task (new format)
   * Replaces: 開始時刻
   */
  scheduled_time?: TimeString;

  /**
   * Legacy: Scheduled time in Japanese
   * @deprecated Use scheduled_time instead
   */
  開始時刻?: TimeString;

  /**
   * Execution date for non-routine tasks
   * Separates from temporary_move_date for clarity
   */
  execution_date?: DateString;

  /**
   * Temporary move date for routine tasks
   * When a routine task is moved to a different date temporarily
   */
  temporary_move_date?: DateString;

  /**
   * Legacy: Combined field for both execution and temporary move
   * @deprecated Use execution_date or temporary_move_date
   */
  target_date?: DateString;
}

// ============================================================================
// Routine Task Fields
// ============================================================================

export type RoutineType = 'daily' | 'weekly' | 'monthly';
export type RoutineWeek = 1 | 2 | 3 | 4 | 5 | 'last';

export interface RoutineTaskFields {
  /** Whether this is a routine task */
  isRoutine: boolean;

  /** Type of routine */
  routine_type?: RoutineType;

  /** Interval between routine occurrences */
  routine_interval?: number;

  /** Whether the routine is enabled */
  routine_enabled?: boolean;

  /** Start date for the routine */
  routine_start?: DateString;

  /** End date for the routine */
  routine_end?: DateString;

  /** Weekday for weekly routines (0-6, 0=Sunday) */
  routine_weekday?: number;

  /** Multiple weekdays for weekly routines */
  weekdays?: number[];

  /** Week of month for monthly routines */
  routine_week?: RoutineWeek;
}

// ============================================================================
// Task Metadata Fields
// ============================================================================

export interface TaskMetadataFields {
  /** Unique identifier for the task */
  id?: UUIDString;

  /** Task name/title */
  name: string;

  /** Estimated duration in minutes */
  estimatedMinutes?: number;

  /** Associated project path */
  projectPath?: string;

  /** Associated project title */
  projectTitle?: string;

  /** Creation timestamp */
  createdAt?: string;

  /** Last update timestamp */
  updatedAt?: string;
}

// ============================================================================
// Complete Task Frontmatter
// ============================================================================

export interface TaskFrontmatter extends
  TaskSchedulingFields,
  RoutineTaskFields,
  TaskMetadataFields {
  // Allow additional fields for extensibility
  [key: string]: unknown;
}
