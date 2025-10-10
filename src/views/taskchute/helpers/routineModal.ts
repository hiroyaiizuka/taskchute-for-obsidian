import type { TaskData } from '../../../types';

const VALID_WEEKDAY = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6;

const VALID_INTERVAL = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1;

/**
 * Derive the display title for the routine modal header.
 */
export function deriveRoutineModalTitle(task: TaskData): string {
  if (typeof task.displayTitle === 'string' && task.displayTitle.trim().length > 0) {
    return task.displayTitle.trim();
  }
  if (typeof task.name === 'string' && task.name.trim().length > 0) {
    return task.name.trim();
  }
  const fileBase = task.file?.basename;
  if (typeof fileBase === 'string' && fileBase.trim().length > 0) {
    return fileBase.trim();
  }
  return 'Untitled Task';
}

/**
 * Determine which weekdays should be pre-selected for a routine task.
 */
export function deriveWeeklySelection(task: TaskData): number[] {
  if (Array.isArray(task.weekdays) && task.weekdays.length > 0) {
    return task.weekdays.filter(VALID_WEEKDAY);
  }

  const candidates: unknown[] = [
    task.routine_weekday,
    task.weekday,
    (task.frontmatter?.routine_weekday as unknown),
    (task.frontmatter?.weekday as unknown),
  ];

  for (const candidate of candidates) {
    if (VALID_WEEKDAY(candidate)) {
      return [candidate];
    }
  }

  return [];
}

export interface MonthlySelection {
  week?: number | 'last';
  weekday?: number;
}

/**
 * Determine which monthly options should be pre-selected for a routine task.
 */
export function deriveMonthlySelection(task: TaskData): MonthlySelection {
  const frontmatter = task.frontmatter || {};
  const sources: Array<number | 'last' | undefined> = [
    task.routine_week as number | 'last' | undefined,
    typeof task.monthly_week === 'number' ? (task.monthly_week + 1) : undefined,
    (frontmatter.routine_week as number | 'last' | undefined),
    (frontmatter.monthly_week as number | 'last' | undefined),
  ];

  let week: number | 'last' | undefined;
  for (const candidate of sources) {
    if (candidate === 'last') {
      week = 'last';
      break;
    }
    if (VALID_INTERVAL(candidate)) {
      week = candidate;
      break;
    }
  }

  if (week === undefined && typeof task.monthly_week === 'number') {
    const zeroBased = task.monthly_week;
    if (Number.isInteger(zeroBased) && zeroBased >= 0 && zeroBased <= 4) {
      week = zeroBased + 1;
    }
  }

  const weekdayCandidates: unknown[] = [
    task.routine_weekday,
    task.monthly_weekday,
    task.weekday,
    (frontmatter.routine_weekday as unknown),
    (frontmatter.monthly_weekday as unknown),
  ];

  let weekday: number | undefined;
  for (const candidate of weekdayCandidates) {
    if (VALID_WEEKDAY(candidate)) {
      weekday = candidate;
      break;
    }
  }

  return { week, weekday };
}
