import type { RoutineFrontmatter } from '../../../types';
import { RoutineService } from '../services/RoutineService';

export interface RoutineFrontmatterMergeOptions {
  hadTargetDate?: boolean;
  hadTemporaryMoveDate?: boolean;
}

export interface ResolveTargetDateOnDisableOptions {
  wasEnabled?: boolean;
  previousTargetDate?: string;
}

export function applyRoutineFrontmatterMerge(
  frontmatter: RoutineFrontmatter,
  cleaned: Record<string, unknown>,
  _options: RoutineFrontmatterMergeOptions = {},
): void {
  // Always remove move-related metadata when routines are reconfigured
  delete cleaned.target_date;
  delete cleaned.temporary_move_date;
  delete cleaned['\u958b\u59cb\u6642\u523b'];

  const cleanedKeys = Object.keys(cleaned);
  const cleanedSet = new Set(cleanedKeys);

  // Remove keys that are no longer present
  // Using Record<string, unknown> to allow dynamic key access on frontmatter object
  const frontmatterRecord = frontmatter as Record<string, unknown>;
  const cleanedRecord = cleaned;
  Object.keys(frontmatterRecord).forEach((key) => {
    if (!cleanedSet.has(key)) {
      delete frontmatterRecord[key];
    }
  });

  // Apply updated values
  cleanedKeys.forEach((key) => {
    frontmatterRecord[key] = cleanedRecord[key];
  });

  // Ensure move-related metadata are cleared regardless of previous state
  // Using frontmatterRecord to avoid deprecated field warnings
  delete frontmatterRecord['temporary_move_date'];
  delete frontmatterRecord['target_date'];
  delete frontmatterRecord['開始時刻'];
}

/**
 * Determine target_date when disabling a routine.
 * Returns viewDate if the routine would be due on that date (so it persists
 * as a one-off task), or undefined if it should not appear.
 */
export function resolveTargetDateOnDisable(
  frontmatter: Record<string, unknown>,
  viewDate: string,
  options: ResolveTargetDateOnDisableOptions = {},
): string | undefined {
  const currentTargetDateValue = frontmatter['target_date']
  const currentTargetDate =
    typeof currentTargetDateValue === 'string' && currentTargetDateValue.length > 0
      ? currentTargetDateValue
      : undefined
  const previousTargetDate =
    typeof options.previousTargetDate === 'string' && options.previousTargetDate.length > 0
      ? options.previousTargetDate
      : currentTargetDate
  const wasEnabled = options.wasEnabled ?? (frontmatter.routine_enabled !== false)

  if (!wasEnabled && previousTargetDate) {
    return previousTargetDate
  }

  const fmForCheck = { ...frontmatter, routine_enabled: true };
  const rule = RoutineService.parseFrontmatter(fmForCheck);
  if (!rule) return undefined;
  return RoutineService.isDue(viewDate, rule) ? viewDate : undefined;
}
