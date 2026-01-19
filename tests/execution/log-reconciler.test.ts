import { LogReconciler } from '../../src/features/log/services/LogReconciler'
import { createPluginStub, seedDeltaFile, seedSnapshot } from './logTestUtils'

describe('LogReconciler', () => {
  test('applies delta entries into snapshot and updates meta cursors', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2025-10', [
      {
        schemaVersion: 1,
        op: 'upsert',
        entryId: 'device-alpha:1',
        deviceId: 'device-alpha',
        monthKey: '2025-10',
        dateKey: '2025-10-01',
        recordedAt: '2025-10-01T08:00:00.000Z',
        payload: {
          instanceId: 'inst-1',
          taskId: 'tc-task-1',
          taskTitle: 'Sample',
          taskPath: 'TASKS/sample.md',
          durationSec: 1800,
          stopTime: '09:00',
        },
      },
      {
        schemaVersion: 1,
        op: 'upsert',
        entryId: 'device-alpha:2',
        deviceId: 'device-alpha',
        monthKey: '2025-10',
        dateKey: '2025-10-01',
        recordedAt: '2025-10-01T10:00:00.000Z',
        payload: {
          instanceId: 'inst-2',
          taskId: 'tc-task-2',
          taskTitle: 'Other',
          taskPath: 'TASKS/other.md',
          durationSec: 600,
          stopTime: '10:15',
        },
      },
    ])

    seedSnapshot(store, abstractStore, '2025-10', {
      taskExecutions: {},
      dailySummary: {},
      meta: { revision: 0, processedCursor: {} },
    })

    const reconciler = new LogReconciler(plugin)
    const stats = await reconciler.reconcilePendingDeltas()

    expect(stats.processedEntries).toBe(2)
    const payload = store.get('LOGS/2025-10-tasks.json')
    expect(payload).toBeDefined()
    const snapshot = JSON.parse(payload!)
    expect(snapshot.taskExecutions['2025-10-01']).toHaveLength(2)
    expect(snapshot.taskExecutions['2025-10-01'][0].deviceId).toBe('device-alpha')
    expect(snapshot.meta.processedCursor['device-alpha']).toBe(2)
    expect(snapshot.meta.revision).toBe(1)

    const recordsPath = 'LOGS/records/2025/record-2025-10-01.md'
    const recordsNote = store.get(recordsPath)
    expect(recordsNote).toBeDefined()
    expect(recordsNote).toContain('recordsVersion: 1')
    const recordMatches = recordsNote?.match(/entryId:/g) ?? []
    expect(recordMatches.length).toBe(2)
    expect(recordsNote).toContain('device-alpha')
  })

  test('skips already processed records on subsequent runs', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2025-10', [
      {
        schemaVersion: 1,
        op: 'upsert',
        entryId: 'device-alpha:1',
        deviceId: 'device-alpha',
        monthKey: '2025-10',
        dateKey: '2025-10-02',
        recordedAt: '2025-10-02T08:00:00.000Z',
        payload: {
          instanceId: 'inst-3',
          taskId: 'tc-task-3',
          taskTitle: 'Reapply',
          taskPath: 'TASKS/reapply.md',
          durationSec: 900,
          stopTime: '08:20',
        },
      },
    ])

    seedSnapshot(store, abstractStore, '2025-10', {
      taskExecutions: {},
      dailySummary: {},
      meta: { revision: 1, processedCursor: {} },
    })

    const reconciler = new LogReconciler(plugin)
    await reconciler.reconcilePendingDeltas()
    const first = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
    expect(first.meta.processedCursor['device-alpha']).toBe(1)
    expect(first.taskExecutions['2025-10-02']).toHaveLength(1)

    const stats = await reconciler.reconcilePendingDeltas()
    expect(stats.processedEntries).toBe(0)
    const second = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
    expect(second.meta.revision).toBe(first.meta.revision) // no new revision when nothing applied
  })

  test('applies delete operations and rewrites records', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    seedSnapshot(store, abstractStore, '2025-10', {
      taskExecutions: {
        '2025-10-01': [
          { instanceId: 'inst-1', taskId: 'tc-keep', taskTitle: 'Keep', durationSec: 600, stopTime: '08:10' },
          { instanceId: 'inst-remove', taskId: 'tc-remove', taskTitle: 'Remove me', durationSec: 900, stopTime: '08:30' },
        ],
      },
      dailySummary: {
        '2025-10-01': {
          totalMinutes: 25,
          totalTasks: 2,
          completedTasks: 2,
          procrastinatedTasks: 0,
          completionRate: 1,
        },
      },
      meta: { revision: 2, processedCursor: { 'device-alpha': 0 } },
    })

    seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2025-10', [
      {
        schemaVersion: 1,
        op: 'delete',
        entryId: 'device-alpha:del',
        deviceId: 'device-alpha',
        monthKey: '2025-10',
        dateKey: '2025-10-01',
        recordedAt: '2025-10-01T12:00:00Z',
        payload: { instanceId: 'inst-remove', taskId: 'tc-remove' },
      },
    ])

    const reconciler = new LogReconciler(plugin)
    const stats = await reconciler.reconcilePendingDeltas()

    expect(stats.processedEntries).toBe(1)
    const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
    expect(snapshot.taskExecutions['2025-10-01']).toHaveLength(1)
    expect(snapshot.taskExecutions['2025-10-01'][0].instanceId).toBe('inst-1')
    expect(snapshot.meta.processedCursor['device-alpha']).toBe(1)

    const recordsPath = 'LOGS/records/2025/record-2025-10-01.md'
    const recordsNote = store.get(recordsPath)
    expect(recordsNote).toBeDefined()
    expect(recordsNote).not.toContain('Remove me')
  })

  test('applies summary delta using recordedAt LWW', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    seedSnapshot(store, abstractStore, '2025-10', {
      taskExecutions: {},
      dailySummary: {
        '2025-10-01': {
          totalTasks: 2,
          totalTasksRecordedAt: '2025-10-01T08:00:00.000Z',
          totalTasksDeviceId: 'device-alpha',
          totalTasksEntryId: 'device-alpha:1',
        },
      },
      meta: { revision: 1, processedCursor: { 'device-alpha': 0 } },
    })

    seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2025-10', [
      {
        schemaVersion: 1,
        op: 'summary',
        entryId: 'device-alpha:old',
        deviceId: 'device-alpha',
        monthKey: '2025-10',
        dateKey: '2025-10-01',
        recordedAt: '2025-10-01T07:00:00.000Z',
        payload: { summary: { totalTasks: 1 } },
      },
      {
        schemaVersion: 1,
        op: 'summary',
        entryId: 'device-alpha:new',
        deviceId: 'device-alpha',
        monthKey: '2025-10',
        dateKey: '2025-10-01',
        recordedAt: '2025-10-01T09:00:00.000Z',
        payload: { summary: { totalTasks: 5 } },
      },
    ])

    const reconciler = new LogReconciler(plugin)
    await reconciler.reconcilePendingDeltas()

    const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
    expect(snapshot.dailySummary['2025-10-01'].totalTasks).toBe(5)
    expect(snapshot.dailySummary['2025-10-01'].totalTasksRecordedAt).toBe('2025-10-01T09:00:00.000Z')
    expect(snapshot.dailySummary['2025-10-01'].totalTasksDeviceId).toBe('device-alpha')
    expect(snapshot.dailySummary['2025-10-01'].totalTasksEntryId).toBe('device-alpha:new')
  })

  test('uses deviceId/entryId tie-break for summary delta', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    seedSnapshot(store, abstractStore, '2025-10', {
      taskExecutions: {},
      dailySummary: {},
      meta: { revision: 0, processedCursor: {} },
    })

    seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2025-10', [
      {
        schemaVersion: 1,
        op: 'summary',
        entryId: 'device-zulu:1',
        deviceId: 'device-zulu',
        monthKey: '2025-10',
        dateKey: '2025-10-02',
        recordedAt: '2025-10-02T08:00:00.000Z',
        payload: { summary: { totalTasks: 9 } },
      },
      {
        schemaVersion: 1,
        op: 'summary',
        entryId: 'device-alpha:2',
        deviceId: 'device-alpha',
        monthKey: '2025-10',
        dateKey: '2025-10-02',
        recordedAt: '2025-10-02T08:00:00.000Z',
        payload: { summary: { totalTasks: 3 } },
      },
    ])

    const reconciler = new LogReconciler(plugin)
    await reconciler.reconcilePendingDeltas()

    const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
    expect(snapshot.dailySummary['2025-10-02'].totalTasks).toBe(9)
    expect(snapshot.dailySummary['2025-10-02'].totalTasksDeviceId).toBe('device-zulu')
    expect(snapshot.dailySummary['2025-10-02'].totalTasksEntryId).toBe('device-zulu:1')
  })

  test('recomputes derived summary fields when totalTasks changes', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    seedSnapshot(store, abstractStore, '2025-10', {
      taskExecutions: {
        '2025-10-03': [
          {
            instanceId: 'inst-1',
            taskId: 'tc-task-1',
            taskTitle: 'Sample',
            taskPath: 'TASKS/sample.md',
            durationSec: 600,
            stopTime: '09:00',
          },
        ],
      },
      dailySummary: {
        '2025-10-03': {
          totalMinutes: 5,
          totalTasks: 2,
          completedTasks: 1,
          procrastinatedTasks: 1,
          completionRate: 0.5,
          totalTasksRecordedAt: '2025-10-03T08:00:00.000Z',
          totalTasksDeviceId: 'device-alpha',
          totalTasksEntryId: 'device-alpha:1',
        },
      },
      meta: { revision: 1, processedCursor: { 'device-alpha': 0 } },
    })

    seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2025-10', [
      {
        schemaVersion: 1,
        op: 'summary',
        entryId: 'device-alpha:2',
        deviceId: 'device-alpha',
        monthKey: '2025-10',
        dateKey: '2025-10-03',
        recordedAt: '2025-10-03T09:00:00.000Z',
        payload: { summary: { totalTasks: 5 } },
      },
    ])

    const reconciler = new LogReconciler(plugin)
    await reconciler.reconcilePendingDeltas()

    const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
    const summary = snapshot.dailySummary['2025-10-03']
    expect(summary.totalTasks).toBe(5)
    expect(summary.completedTasks).toBe(1)
    expect(summary.totalMinutes).toBe(10)
    expect(summary.procrastinatedTasks).toBe(4)
    expect(summary.completionRate).toBeCloseTo(0.2)
  })

  test('resets processed cursor when delta file shrinks', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    seedSnapshot(store, abstractStore, '2025-11', {
      taskExecutions: {},
      dailySummary: {},
      meta: { revision: 1, processedCursor: { 'device-alpha': 5 } },
    })

    const deltaRecords = [1, 2].map((index) => ({
      schemaVersion: 1,
      op: 'upsert',
      entryId: `device-alpha:${index}`,
      deviceId: 'device-alpha',
      monthKey: '2025-11',
      dateKey: '2025-11-02',
      recordedAt: `2025-11-02T0${index}:00:00Z`,
      payload: {
        instanceId: `inst-${index}`,
        taskId: `tc-task-${index}`,
        taskTitle: `Entry ${index}`,
        durationSec: 600,
        stopTime: `0${index}:10`,
      },
    }))
    seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2025-11', deltaRecords)

    const reconciler = new LogReconciler(plugin)
    const stats = await reconciler.reconcilePendingDeltas()

    expect(stats.processedEntries).toBe(2)
    const snapshot = JSON.parse(store.get('LOGS/2025-11-tasks.json')!)
    expect(snapshot.taskExecutions['2025-11-02']).toHaveLength(2)
    expect(snapshot.meta.processedCursor['device-alpha']).toBe(2)
  })
})
