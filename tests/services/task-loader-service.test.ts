import type { TaskChuteView } from '../../src/views/TaskChuteView';
import { TaskLoaderService } from '../../src/services/TaskLoaderService';
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
      },
    ];
    const { context } = createRoutineLoadContext({
      duplicatedInstances,
    });
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    expect(context.tasks.length).toBeGreaterThanOrEqual(1);
    expect(context.taskInstances.some((inst) => inst.instanceId === 'dup-1')).toBe(true);
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
