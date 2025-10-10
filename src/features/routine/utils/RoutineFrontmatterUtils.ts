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
  Object.keys(frontmatter).forEach((key) => {
    if (!cleanedSet.has(key)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (frontmatter as any)[key];
    }
  });

  // Apply updated values
  cleanedKeys.forEach((key) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (frontmatter as any)[key] = cleaned[key];
  });

  // Ensure move-related metadata are cleared regardless of previous state
  delete (frontmatter as RoutineFrontmatter).temporary_move_date;
  delete (frontmatter as RoutineFrontmatter).target_date;
  delete (frontmatter as RoutineFrontmatter)['\u958b\u59cb\u6642\u523b'];
}
