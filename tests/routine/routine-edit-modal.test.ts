import { applyRoutineFrontmatterMerge } from '../../src/features/routine/utils/RoutineFrontmatterUtils';
import { TaskValidator } from '../../src/features/core/services/TaskValidator';
import type { RoutineFrontmatter } from '../../src/types';

describe('applyRoutineFrontmatterMerge', () => {
  test('removes stale move metadata when routine settings change', () => {
    const frontmatter = {
      name: 'Green Rock準備',
      isRoutine: true,
      target_date: '2025-09-24',
      temporary_move_date: '2025-09-25',
      routine_type: 'daily',
      routine_interval: 1,
      routine_enabled: true,
    } as unknown as RoutineFrontmatter;

    const cleaned = TaskValidator.cleanupOnRoutineChange(frontmatter, {
      routine_type: 'weekly',
      routine_interval: 1,
      routine_enabled: true,
    });

    applyRoutineFrontmatterMerge(frontmatter, cleaned, {
      hadTargetDate: true,
      hadTemporaryMoveDate: true,
    });

     
    expect(frontmatter.target_date).toBeUndefined();
    expect(frontmatter.temporary_move_date).toBeUndefined();
     
    expect(frontmatter['\u958b\u59cb\u6642\u523b']).toBeUndefined();
  });
});
