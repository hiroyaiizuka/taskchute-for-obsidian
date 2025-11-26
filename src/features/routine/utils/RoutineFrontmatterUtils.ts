import type { RoutineFrontmatter } from '../types';

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
  const cleanedRecord = cleaned as Record<string, unknown>;
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
  delete (frontmatter).temporary_move_date;
  delete (frontmatter).target_date;
  delete (frontmatter)['\u958b\u59cb\u6642\u523b'];
}
