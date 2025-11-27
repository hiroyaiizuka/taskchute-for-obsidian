import type { RoutineFrontmatter } from '../../../types';

export interface RoutineFrontmatterMergeOptions {
  hadTargetDate?: boolean;
  hadTemporaryMoveDate?: boolean;
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
