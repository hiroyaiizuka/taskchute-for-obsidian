import { RoutineService } from '../../src/features/routine/services/RoutineService';

describe('RoutineService.isDue', () => {
  test('daily routine respects interval and start date', () => {
    const rule = RoutineService.parseFrontmatter({
      isRoutine: true,
      routine_type: 'daily',
      routine_interval: 2,
      routine_start: '2025-09-20',
    });

    expect(rule).not.toBeNull();
    expect(RoutineService.isDue('2025-09-20', rule)).toBe(true); // day 0
    expect(RoutineService.isDue('2025-09-21', rule)).toBe(false); // day 1
    expect(RoutineService.isDue('2025-09-22', rule)).toBe(true); // day 2
  });

  test('weekly routine applies interval and weekday', () => {
    const rule = RoutineService.parseFrontmatter({
      isRoutine: true,
      routine_type: 'weekly',
      routine_interval: 2,
      routine_start: '2025-09-01', // Monday
      routine_weekday: 1, // Monday
    });

    expect(rule).not.toBeNull();
    expect(RoutineService.isDue('2025-09-01', rule)).toBe(true); // week 0 Monday
    expect(RoutineService.isDue('2025-09-08', rule)).toBe(false); // week 1 Monday skipped
    expect(RoutineService.isDue('2025-09-15', rule)).toBe(true); // week 2 Monday
  });

  test('monthly routine supports last weekday rule', () => {
    const rule = RoutineService.parseFrontmatter({
      isRoutine: true,
      routine_type: 'monthly',
      routine_interval: 1,
      routine_start: '2025-01-01',
      routine_week: 'last',
      routine_weekday: 5, // Friday
    });

    expect(rule).not.toBeNull();
    // 2025-09-26 is the last Friday of September 2025
    expect(RoutineService.isDue('2025-09-26', rule)).toBe(true);
    // Earlier Friday in same month should be false
    expect(RoutineService.isDue('2025-09-19', rule)).toBe(false);
  });

  test('moved target date snoozes until the specified day and then resumes schedule', () => {
    const rule = RoutineService.parseFrontmatter({
      isRoutine: true,
      routine_type: 'daily',
      routine_interval: 1,
      routine_start: '2025-09-20',
    });

    expect(rule).not.toBeNull();
    expect(RoutineService.isDue('2025-09-20', rule, '2025-09-22')).toBe(false);
    expect(RoutineService.isDue('2025-09-21', rule, '2025-09-22')).toBe(false);
    expect(RoutineService.isDue('2025-09-22', rule, '2025-09-22')).toBe(true);
    expect(RoutineService.isDue('2025-09-23', rule, '2025-09-22')).toBe(true);
  });

  test('moved target date forces visibility on the moved day for weekly routines', () => {
    const rule = RoutineService.parseFrontmatter({
      isRoutine: true,
      routine_type: 'weekly',
      routine_interval: 1,
      routine_start: '2025-09-01', // Monday
      routine_weekday: 1, // Monday
    });

    expect(rule).not.toBeNull();
    // Moved to Wednesday (2025-09-03)
    expect(RoutineService.isDue('2025-09-02', rule, '2025-09-03')).toBe(false);
    expect(RoutineService.isDue('2025-09-03', rule, '2025-09-03')).toBe(true);
    // Resume normal cadence: next due on Monday 2025-09-08
    expect(RoutineService.isDue('2025-09-04', rule, '2025-09-03')).toBe(false);
    expect(RoutineService.isDue('2025-09-08', rule, '2025-09-03')).toBe(true);
  });

  test('disabled routines never trigger', () => {
    const rule = RoutineService.parseFrontmatter({
      isRoutine: true,
      routine_type: 'daily',
      routine_interval: 1,
      routine_enabled: false,
      routine_start: '2025-09-20',
    });

    expect(rule).not.toBeNull();
    expect(RoutineService.isDue('2025-09-20', rule)).toBe(false);
  });
});
