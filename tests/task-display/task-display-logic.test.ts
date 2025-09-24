import { createNonRoutineLoadContext, createRoutineLoadContext } from '../utils/taskViewTestUtils';

describe('Task display logic', () => {
  describe('target_date handling for routines', () => {
    test('routine with moved target date is hidden before target', async () => {
      const targetDate = '2025-09-25';
      const { context, load } = createRoutineLoadContext({
        date: '2025-09-24',
        targetDate,
      });

      await load();

      expect(context.taskInstances).toHaveLength(0);
      expect(context.tasks).toHaveLength(0);
    });

    test('routine with moved target date appears only on target day', async () => {
      const targetDate = '2025-09-25';
      const { context, load } = createRoutineLoadContext({
        date: targetDate,
        targetDate,
      });

      await load();

      expect(context.taskInstances).toHaveLength(1);
      expect(context.tasks).toHaveLength(1);
    });
  });

  describe('non-routine deletion scope', () => {
    test('permanent deletions hide the task for the day', async () => {
      const { context, load } = createNonRoutineLoadContext({
        deletionType: 'permanent',
      });

      await load();

      expect(context.taskInstances).toHaveLength(0);
      expect(context.tasks).toHaveLength(0);
    });

    test('temporary deletions do not hide base non-routine task', async () => {
      const { context, load } = createNonRoutineLoadContext({
        deletionType: 'temporary',
      });

      await load();

      expect(context.taskInstances).toHaveLength(1);
      expect(context.tasks).toHaveLength(1);
    });
  });
});
