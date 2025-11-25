import type { TaskChuteView } from '../../src/features/core/views/TaskChuteView';
import { TaskLoaderService, isTaskFile } from '../../src/features/core/services/TaskLoaderService';
import {
  createNonRoutineLoadContext,
  createRoutineLoadContext,
  createExecutionLogContext,
} from '../utils/taskViewTestUtils';

describe('TaskLoaderService', () => {
  test('loads visible non-routine task from vault folder', async () => {
    const { context } = createNonRoutineLoadContext();
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    expect(context.tasks).toHaveLength(1);
    expect(context.taskInstances).toHaveLength(1);
    expect(context.renderTaskList).toHaveBeenCalled();
  });

  test('skips permanently deleted non-routine task', async () => {
    const { context } = createNonRoutineLoadContext({ deletionType: 'permanent' });
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    expect(context.tasks).toHaveLength(0);
    expect(context.taskInstances).toHaveLength(0);
  });

  test('restores duplicated instance from day state snapshot', async () => {
    const duplicatedInstances = [
      {
        instanceId: 'dup-1',
        originalPath: 'TASKS/routine.md',
        clonedPath: 'TASKS/routine.md',
        slotKey: '8:00-12:00',
        timestamp: 1_700_000_000_000,
      },
    ];
    const { context } = createRoutineLoadContext({
      duplicatedInstances,
    });
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    expect(context.tasks.length).toBeGreaterThanOrEqual(1);
    const restored = context.taskInstances.find((inst) => inst.instanceId === 'dup-1');
    expect(restored).toBeDefined();
    expect(restored?.createdMillis).toBe(duplicatedInstances[0].timestamp);
  });

  test('hydrates execution log driven instances when log file exists', async () => {
    const { context } = createExecutionLogContext();
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    expect(context.taskInstances.length).toBeGreaterThan(0);
    expect(context.tasks.length).toBeGreaterThan(0);
  });

  test('skips routine task hidden through day state manager metadata', async () => {
    const hiddenRoutines = [
      {
        instanceId: null,
        path: 'TASKS/routine.md',
      },
    ];
    const { context } = createRoutineLoadContext({ hiddenRoutines });
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    expect(context.taskInstances.length).toBe(0);
    expect(context.tasks.length).toBeGreaterThanOrEqual(0);
  });
});

describe('isTaskFile', () => {
  test('returns true when content contains #task tag (legacy)', () => {
    expect(isTaskFile('#task\n# My Task', undefined)).toBe(true);
    expect(isTaskFile('Some text\n#task', undefined)).toBe(true);
  });

  test('returns true when frontmatter tags array contains task', () => {
    expect(isTaskFile('# My Task', { tags: ['task'] })).toBe(true);
    expect(isTaskFile('# My Task', { tags: ['other', 'task'] })).toBe(true);
  });

  test('returns true when frontmatter tags is string task', () => {
    expect(isTaskFile('# My Task', { tags: 'task' })).toBe(true);
  });

  test('returns true when frontmatter has estimatedMinutes (legacy)', () => {
    expect(isTaskFile('# My Task', { estimatedMinutes: 30 })).toBe(true);
  });

  test('returns false when no task indicators present', () => {
    expect(isTaskFile('# Regular Note', undefined)).toBe(false);
    expect(isTaskFile('# Regular Note', {})).toBe(false);
    expect(isTaskFile('# Regular Note', { tags: ['other'] })).toBe(false);
    expect(isTaskFile('# Regular Note', { tags: 'other' })).toBe(false);
  });

  test('returns false for empty content and frontmatter', () => {
    expect(isTaskFile('', undefined)).toBe(false);
    expect(isTaskFile('', {})).toBe(false);
  });
});
