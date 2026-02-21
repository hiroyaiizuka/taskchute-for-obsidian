import type { TaskChuteView } from '../../src/features/core/views/TaskChuteView';
import { TaskLoaderService, isTaskFile } from '../../src/features/core/services/TaskLoaderService';
import { SectionConfigService } from '../../src/services/SectionConfigService';
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

  test('uses day-state slot override for non-routine task', async () => {
    const { context } = createNonRoutineLoadContext({
      dayStateOverrides: {
        slotOverrides: {
          'tc-task-non-routine': '16:00-0:00',
        },
      },
    });
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    expect(context.taskInstances).toHaveLength(1);
    expect(context.taskInstances[0].slotKey).toBe('16:00-0:00');
  });

  test('migrates legacy non-routine settings slot key into current day state', async () => {
    const { context, dayState } = createNonRoutineLoadContext();
    const persistMock = context.dayStateManager?.persist as jest.Mock;
    const saveSettingsMock = context.plugin.saveSettings as jest.Mock;
    context.plugin.settings.slotKeys['tc-task-non-routine'] = '16:00-0:00';
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    expect(dayState.slotOverrides['tc-task-non-routine']).toBe('16:00-0:00');
    expect(dayState.slotOverridesMeta?.['tc-task-non-routine']?.slotKey).toBe('16:00-0:00');
    expect(typeof dayState.slotOverridesMeta?.['tc-task-non-routine']?.updatedAt).toBe('number');
    expect(context.plugin.settings.slotKeys['tc-task-non-routine']).toBeUndefined();
    expect(persistMock).toHaveBeenCalledWith('2025-09-24');
    expect(saveSettingsMock).toHaveBeenCalled();
    expect(context.taskInstances[0]?.slotKey).toBe('16:00-0:00');
  });

  test('migrates slotOverridesMeta key from path to taskId for non-routine day-state override migration', async () => {
    const { context, dayState } = createNonRoutineLoadContext({
      dayStateOverrides: {
        slotOverrides: {
          'TASKS/non-routine.md': '16:00-0:00',
        },
        slotOverridesMeta: {
          'TASKS/non-routine.md': {
            slotKey: '16:00-0:00',
            updatedAt: 1_000,
          },
        },
      },
    });
    const persistMock = context.dayStateManager?.persist as jest.Mock;
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    expect(dayState.slotOverrides['tc-task-non-routine']).toBe('16:00-0:00');
    expect(dayState.slotOverrides['TASKS/non-routine.md']).toBeUndefined();
    expect(dayState.slotOverridesMeta?.['tc-task-non-routine']?.slotKey).toBe('16:00-0:00');
    expect(dayState.slotOverridesMeta?.['tc-task-non-routine']?.updatedAt).toBe(1_000);
    expect(dayState.slotOverridesMeta?.['TASKS/non-routine.md']).toBeUndefined();
    expect(persistMock).toHaveBeenCalledWith('2025-09-24');
    expect(context.taskInstances[0]?.slotKey).toBe('16:00-0:00');
  });

  test('keeps existing taskId meta updatedAt when legacy path meta is missing', async () => {
    const { context, dayState } = createNonRoutineLoadContext({
      dayStateOverrides: {
        slotOverrides: {
          'TASKS/non-routine.md': '16:00-0:00',
        },
        slotOverridesMeta: {
          'tc-task-non-routine': {
            slotKey: '8:00-12:00',
            updatedAt: 5_000,
          },
        },
      },
    });
    const persistMock = context.dayStateManager?.persist as jest.Mock;
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    expect(dayState.slotOverrides['tc-task-non-routine']).toBe('16:00-0:00');
    expect(dayState.slotOverridesMeta?.['tc-task-non-routine']?.slotKey).toBe('16:00-0:00');
    expect(dayState.slotOverridesMeta?.['tc-task-non-routine']?.updatedAt).toBe(5_000);
    expect(persistMock).toHaveBeenCalledWith('2025-09-24');
  });

  test('normalizes invalid legacy settings slot key before saving into day state', async () => {
    const { context, dayState } = createNonRoutineLoadContext();
    const sectionConfig = new SectionConfigService([
      { hour: 0, minute: 0 },
      { hour: 6, minute: 0 },
      { hour: 18, minute: 0 },
    ]);
    context.getSectionConfig = () => sectionConfig;
    const persistMock = context.dayStateManager?.persist as jest.Mock;
    const saveSettingsMock = context.plugin.saveSettings as jest.Mock;
    context.plugin.settings.slotKeys['tc-task-non-routine'] = '16:00-0:00';
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    expect(dayState.slotOverrides['tc-task-non-routine']).toBe('6:00-18:00');
    expect(dayState.slotOverridesMeta?.['tc-task-non-routine']?.slotKey).toBe('6:00-18:00');
    expect(context.taskInstances[0]?.slotKey).toBe('6:00-18:00');
    expect(persistMock).toHaveBeenCalledWith('2025-09-24');
    expect(saveSettingsMock).toHaveBeenCalled();
  });

  test('skips permanently deleted non-routine task', async () => {
    const { context } = createNonRoutineLoadContext({ deletionType: 'permanent' });
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    expect(context.tasks).toHaveLength(0);
    expect(context.taskInstances).toHaveLength(0);
  });

  test('skips legacy path deletion without timestamp', async () => {
    const { context } = createNonRoutineLoadContext({
      metadataOverrides: { taskId: null },
      deletedInstances: [
        {
          path: 'TASKS/non-routine.md',
          deletionType: 'permanent',
        },
      ],
    });
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    expect(context.tasks).toHaveLength(0);
    expect(context.taskInstances).toHaveLength(0);
  });

  test('skips legacy deletion after taskId promotion', async () => {
    const { context } = createNonRoutineLoadContext({
      deletedInstances: [
        {
          path: 'TASKS/non-routine.md',
          deletionType: 'permanent',
        },
      ],
    });
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    expect(context.tasks).toHaveLength(0);
    expect(context.taskInstances).toHaveLength(0);
  });

  test('shows restored non-routine task when deletion entry has newer restoredAt', async () => {
    const { context } = createNonRoutineLoadContext({
      deletedInstances: [
        {
          path: 'TASKS/non-routine.md',
          deletionType: 'permanent',
          taskId: 'tc-task-non-routine',
          deletedAt: 1_000,
          restoredAt: 2_000,
        },
      ],
    });
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    expect(context.tasks).toHaveLength(1);
    expect(context.taskInstances).toHaveLength(1);
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

  test('keeps execution-log disabled routine as routine', async () => {
    const date = '2025-09-24';
    const { context } = createExecutionLogContext({
      date,
      executions: [
        {
          taskTitle: 'Disabled Routine',
          taskPath: 'TASKS/disabled-routine.md',
          slotKey: '08:00-09:00',
          instanceId: 'disabled-routine-instance',
          startTime: `${date}T08:00:00.000Z`,
          stopTime: `${date}T08:30:00.000Z`,
        },
      ],
      taskFiles: [
        {
          path: 'TASKS/disabled-routine.md',
          content: '#task',
          frontmatter: {
            isRoutine: true,
            routine_enabled: false,
            routine_type: 'daily',
            routine_interval: 1,
            target_date: date,
            taskId: 'tc-task-disabled-routine',
          },
        },
      ],
    });
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    const instance = context.taskInstances.find(
      (candidate) => candidate.instanceId === 'disabled-routine-instance',
    );
    expect(instance).toBeDefined();
    expect(instance?.task.isRoutine).toBe(true);
  });

  test('migrates legacy execution slotKey to current section key', async () => {
    const date = '2025-09-24';
    const startTime = `${date}T08:30:00.000Z`;
    const { context } = createExecutionLogContext({
      date,
      executions: [
        {
          taskTitle: 'Log Task',
          taskPath: 'TASKS/log-task.md',
          slotKey: '8:00-12:00',
          instanceId: 'log-instance-legacy-slot',
          startTime,
          stopTime: `${date}T09:00:00.000Z`,
        },
      ],
      taskFiles: [{ path: 'TASKS/log-task.md', content: '#task' }],
    });
    const sectionConfig = new SectionConfigService([
      { hour: 0, minute: 0 },
      { hour: 6, minute: 0 },
      { hour: 12, minute: 0 },
      { hour: 18, minute: 0 },
    ]);
    context.getSectionConfig = () => sectionConfig;
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    const restored = context.taskInstances.find((inst) => inst.instanceId === 'log-instance-legacy-slot');
    expect(restored).toBeDefined();
    expect(restored?.slotKey).toBe(sectionConfig.getCurrentTimeSlot(new Date(startTime)));
  });

  test('discards order entries with invalid slot keys after section change', async () => {
    const { context, dayState } = createNonRoutineLoadContext({
      dayStateOverrides: {
        orders: {
          'TASKS/non-routine.md::8:00-12:00': 10,
          'TASKS/non-routine.md::12:00-16:00': 20,
          'TASKS/non-routine.md::6:00-18:00': 30,
        },
        ordersMeta: {
          'TASKS/non-routine.md::12:00-16:00': {
            order: 20,
            updatedAt: 2_000,
          },
          'TASKS/non-routine.md::6:00-18:00': {
            order: 30,
            updatedAt: 3_000,
          },
        },
      },
    });
    const sectionConfig = new SectionConfigService([
      { hour: 0, minute: 0 },
      { hour: 6, minute: 0 },
      { hour: 18, minute: 0 },
    ]);
    context.getSectionConfig = () => sectionConfig;
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    // Invalid slot keys (8:00-12:00, 12:00-16:00) are discarded; valid key (6:00-18:00) is kept
    expect(dayState.orders['TASKS/non-routine.md::8:00-12:00']).toBeUndefined();
    expect(dayState.orders['TASKS/non-routine.md::12:00-16:00']).toBeUndefined();
    expect(dayState.orders['TASKS/non-routine.md::6:00-18:00']).toBe(30);
    expect(dayState.ordersMeta?.['TASKS/non-routine.md::6:00-18:00']).toEqual({
      order: 30,
      updatedAt: 3_000,
    });
  });

  test('persists day state when legacy slot keys are migrated (keep mapped overrides)', async () => {
    const { context, dayState } = createNonRoutineLoadContext({
      dayStateOverrides: {
        slotOverrides: {
          'tc-task-non-routine': '8:00-12:00',
        },
        slotOverridesMeta: {
          'tc-task-non-routine': {
            slotKey: '12:00-16:00',
            updatedAt: 1234,
          },
        },
        duplicatedInstances: [
          {
            instanceId: 'dup-migrate',
            originalPath: 'TASKS/non-routine.md',
            timestamp: 1_700_000_000_000,
            slotKey: '16:00-0:00',
            originalSlotKey: '8:00-12:00',
          },
        ],
        orders: {
          'TASKS/non-routine.md::8:00-12:00': 10,
        },
      },
    });
    const sectionConfig = new SectionConfigService([
      { hour: 0, minute: 0 },
      { hour: 6, minute: 0 },
      { hour: 18, minute: 0 },
    ]);
    context.getSectionConfig = () => sectionConfig;
    const persistMock = context.dayStateManager!.persist as jest.Mock;
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    // slotOverrides: invalid key is migrated and kept
    expect(dayState.slotOverrides['tc-task-non-routine']).toBe('6:00-18:00');
    // slotOverridesMeta: migrated slotKey with refreshed timestamp
    expect(dayState.slotOverridesMeta?.['tc-task-non-routine']?.slotKey).toBe('6:00-18:00');
    expect(dayState.slotOverridesMeta?.['tc-task-non-routine']?.updatedAt).toBeGreaterThan(1234);
    // duplicatedInstances: invalid slotKey/originalSlotKey cleared
    expect(dayState.duplicatedInstances[0]?.slotKey).toBeUndefined();
    expect(dayState.duplicatedInstances[0]?.originalSlotKey).toBeUndefined();
    // orders: invalid slot key entries discarded
    expect(dayState.orders['TASKS/non-routine.md::8:00-12:00']).toBeUndefined();
    expect(persistMock).toHaveBeenCalledWith('2025-09-24');
  });

  test('keeps migrated routine slot override even when scheduled time is missing', async () => {
    const { context, dayState } = createRoutineLoadContext({
      metadataOverrides: {
        開始時刻: undefined,
        scheduled_time: undefined,
      },
      dayStateOverrides: {
        slotOverrides: {
          'tc-task-routine': '8:00-12:00',
        },
      },
    });
    const sectionConfig = new SectionConfigService([
      { hour: 0, minute: 0 },
      { hour: 9, minute: 0 },
      { hour: 12, minute: 0 },
      { hour: 16, minute: 50 },
    ]);
    context.getSectionConfig = () => sectionConfig;
    const persistMock = context.dayStateManager!.persist as jest.Mock;
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    expect(dayState.slotOverrides['tc-task-routine']).toBe('0:00-9:00');
    expect(dayState.slotOverridesMeta?.['tc-task-routine']?.slotKey).toBe('0:00-9:00');
    expect(persistMock).toHaveBeenCalledWith('2025-09-24');

    const restoredRoutine = context.taskInstances.find((inst) => inst.task.taskId === 'tc-task-routine');
    expect(restoredRoutine?.slotKey).toBe('0:00-9:00');
  });

  test('does not persist day state when slot keys are already valid', async () => {
    const { context } = createNonRoutineLoadContext({
      dayStateOverrides: {
        slotOverrides: {
          'tc-task-non-routine': '8:00-12:00',
        },
      },
    });
    const persistMock = context.dayStateManager!.persist as jest.Mock;
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    expect(persistMock).not.toHaveBeenCalled();
  });

  test('derives task path from instanceId when execution entry lacks path', async () => {
    const { context } = createExecutionLogContext({
      executions: [
        {
          instanceId: 'TASKS/missing.md_2025-09-24_123_abc',
          startTime: '08:00',
          stopTime: '09:00',
        },
      ],
      taskFiles: [
        {
          path: 'TASKS/missing.md',
          content: '#task',
        },
      ],
    });
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    const inst = context.taskInstances.find((candidate) =>
      candidate.instanceId?.includes('TASKS/missing.md'),
    );
    expect(inst?.task.path).toBe('TASKS/missing.md');
    expect(inst?.task.name).not.toBe('Untitled task');
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

  test('shows routine when hidden entry has newer restoredAt', async () => {
    const hiddenRoutines = [
      {
        instanceId: null,
        path: 'TASKS/routine.md',
        hiddenAt: 1000,
        restoredAt: 2000,
      },
    ];
    const { context } = createRoutineLoadContext({ hiddenRoutines });
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    expect(context.taskInstances.length).toBe(1);
    expect(context.taskInstances[0]?.task.path).toBe('TASKS/routine.md');
  });

  test('restores duplicated routine even when base routine is hidden by path', async () => {
    const hiddenRoutines = [
      {
        instanceId: null,
        path: 'TASKS/routine.md',
      },
    ];
    const duplicatedInstances = [
      {
        instanceId: 'dup-reuse',
        originalPath: 'TASKS/routine.md',
        slotKey: 'none',
        timestamp: 1_700_000_123_000,
      },
    ];
    const { context } = createRoutineLoadContext({
      hiddenRoutines,
      duplicatedInstances,
    });
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    const instances = context.taskInstances.filter((inst) => inst.task?.path === 'TASKS/routine.md');
    expect(instances).toHaveLength(1);
    expect(instances[0]?.instanceId).toBe('dup-reuse');
    expect(instances[0]?.slotKey).toBe('none');
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

describe('slot key migration - boundary change scenario', () => {
  test('execution log with invalid slotKey recalculates from startTime', async () => {
    const date = '2025-09-24';
    const { context } = createExecutionLogContext({
      date,
      executions: [
        {
          taskTitle: 'Evening Task',
          taskPath: 'TASKS/evening.md',
          slotKey: '16:00-0:00',
          instanceId: 'evening-instance',
          startTime: '18:30',
          stopTime: '19:00',
        },
      ],
      taskFiles: [{ path: 'TASKS/evening.md', content: '#task' }],
    });
    // Change boundaries: 16:00 → 16:50
    const sectionConfig = new SectionConfigService([
      { hour: 0, minute: 0 },
      { hour: 9, minute: 0 },
      { hour: 12, minute: 0 },
      { hour: 16, minute: 50 },
    ]);
    context.getSectionConfig = () => sectionConfig;
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    const restored = context.taskInstances.find((inst) => inst.instanceId === 'evening-instance');
    expect(restored).toBeDefined();
    // 18:30 falls in 16:50-0:00
    expect(restored?.slotKey).toBe('16:50-0:00');
  });

  test('non-routine task with invalid storedSlot is normalized to current section key', async () => {
    const { context, dayState } = createNonRoutineLoadContext({
      metadataOverrides: {
        開始時刻: '18:00',
      },
    });
    // Set an invalid stored slot key
    context.plugin.settings.slotKeys = {
      'tc-task-non-routine': '16:00-0:00',
    };
    // Change boundaries: 16:00 → 16:50
    const sectionConfig = new SectionConfigService([
      { hour: 0, minute: 0 },
      { hour: 9, minute: 0 },
      { hour: 12, minute: 0 },
      { hour: 16, minute: 50 },
    ]);
    context.getSectionConfig = () => sectionConfig;
    const loader = new TaskLoaderService();

    await loader.load(context as unknown as TaskChuteView);

    const inst = context.taskInstances.find((i) => i.task.taskId === 'tc-task-non-routine');
    expect(inst).toBeDefined();
    // Invalid legacy slot is normalized via SectionConfigService.migrateSlotKey
    expect(inst?.slotKey).toBe('12:00-16:50');
    expect(dayState.slotOverrides['tc-task-non-routine']).toBe('12:00-16:50');
  });
});
