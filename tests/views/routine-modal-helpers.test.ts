import type { TaskData } from '../../src/types';
import {
  deriveRoutineModalTitle,
  deriveWeeklySelection,
  deriveMonthlySelection,
} from '../../src/views/taskchute/helpers';

describe('routine modal helpers', () => {
  const baseTask = (): TaskData => ({
    file: null,
    frontmatter: {},
    path: 'Task/Example.md',
    name: 'Example',
  } as TaskData);

  test('deriveRoutineModalTitle prefers displayTitle', () => {
    const task = {
      ...baseTask(),
      displayTitle: 'Custom Title',
      name: 'Fallback',
    } as TaskData;

    expect(deriveRoutineModalTitle(task)).toBe('Custom Title');
  });

  test('deriveRoutineModalTitle falls back to name then file basename', () => {
    const task = {
      ...baseTask(),
      name: 'Task Name',
      displayTitle: '',
      file: { basename: 'File Name' } as unknown as TaskData['file'],
    } as TaskData;

    expect(deriveRoutineModalTitle(task)).toBe('Task Name');

    task.name = '';
    expect(deriveRoutineModalTitle(task)).toBe('File Name');
  });

  test('deriveWeeklySelection uses routine_weekday from frontmatter', () => {
    const task = {
      ...baseTask(),
      frontmatter: { routine_weekday: 4 },
    } as TaskData;

    expect(deriveWeeklySelection(task)).toEqual([4]);
  });

  test('deriveWeeklySelection uses weekdays array when provided', () => {
    const task = {
      ...baseTask(),
      weekdays: [1, 3],
    } as TaskData;

    expect(deriveWeeklySelection(task)).toEqual([1, 3]);
  });

  test('deriveMonthlySelection reads normalized routine week values', () => {
    const task = {
      ...baseTask(),
      frontmatter: { routine_week: 2, routine_weekday: 5 },
    } as TaskData;

    expect(deriveMonthlySelection(task)).toEqual({ week: 2, weekday: 5 });
  });

  test('deriveMonthlySelection converts legacy zero-based month week', () => {
    const task = {
      ...baseTask(),
      monthly_week: 0,
      monthly_weekday: 2,
    } as TaskData;

    expect(deriveMonthlySelection(task)).toEqual({ week: 1, weekday: 2 });
  });
});
