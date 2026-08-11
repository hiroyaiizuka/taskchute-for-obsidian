import { applyRoutineFrontmatterMerge } from '../../src/features/routine/utils/RoutineFrontmatterUtils';
import { TaskValidator } from '../../src/features/core/services/TaskValidator';
import { getToday } from '../../src/utils/date';
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

  test('target_date can be set after merge for disabled routines', () => {
    const frontmatter = {
      name: 'Test Task',
      isRoutine: true,
      routine_type: 'daily',
      routine_interval: 1,
      routine_enabled: false,
    } as unknown as RoutineFrontmatter;

    const cleaned = TaskValidator.cleanupOnRoutineChange(frontmatter, {
      routine_type: 'daily',
      routine_interval: 1,
      routine_enabled: false,
    });

    applyRoutineFrontmatterMerge(frontmatter, cleaned, {
      hadTargetDate: false,
      hadTemporaryMoveDate: false,
    });

    // Merge deletes target_date, so it must be set after merge
    expect((frontmatter as Record<string, unknown>)['target_date']).toBeUndefined();

    // Simulate what RoutineEditModal does after merge
    if (!frontmatter.routine_enabled) {
      const fmRecord = frontmatter as Record<string, unknown>;
      fmRecord['target_date'] = getToday();
    }

    expect((frontmatter as Record<string, unknown>)['target_date']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('target_date is not set after merge for enabled routines', () => {
    const frontmatter = {
      name: 'Test Task',
      isRoutine: true,
      routine_type: 'daily',
      routine_interval: 1,
      routine_enabled: true,
    } as unknown as RoutineFrontmatter;

    const cleaned = TaskValidator.cleanupOnRoutineChange(frontmatter, {
      routine_type: 'daily',
      routine_interval: 1,
      routine_enabled: true,
    });

    applyRoutineFrontmatterMerge(frontmatter, cleaned, {
      hadTargetDate: false,
      hadTemporaryMoveDate: false,
    });

    expect((frontmatter as Record<string, unknown>)['target_date']).toBeUndefined();
  });
});
