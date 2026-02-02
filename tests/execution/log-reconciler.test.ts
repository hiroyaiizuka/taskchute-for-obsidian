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

  test('delete by instanceId does not affect other entries with same taskId', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    // 同じtaskIdを持つ2つのエントリを用意（異なるinstanceId）
    seedSnapshot(store, abstractStore, '2025-10', {
      taskExecutions: {
        '2025-10-01': [
          {
            instanceId: 'inst-desktop',
            taskId: 'tc-same-task',
            taskTitle: '薬を飲むよ',
            durationSec: 600,
            stopTime: '10:59',
            deviceId: 'device-desktop',
          },
          {
            instanceId: 'inst-mobile',
            taskId: 'tc-same-task',
            taskTitle: '薬を飲むよ',
            durationSec: 300,
            stopTime: '11:30',
            deviceId: 'device-mobile',
          },
        ],
      },
      dailySummary: {},
      meta: { revision: 2, processedCursor: { 'device-mobile': 0 } },
    })

    // モバイルから inst-mobile のみを削除するdeltaを送信
    seedDeltaFile(abstractStore, deltaStore, 'device-mobile', '2025-10', [
      {
        schemaVersion: 1,
        op: 'delete',
        entryId: 'device-mobile:del',
        deviceId: 'device-mobile',
        monthKey: '2025-10',
        dateKey: '2025-10-01',
        recordedAt: '2025-10-01T12:00:00Z',
        payload: { instanceId: 'inst-mobile', taskId: 'tc-same-task' },
      },
    ])

    const reconciler = new LogReconciler(plugin)
    const stats = await reconciler.reconcilePendingDeltas()

    expect(stats.processedEntries).toBe(1)
    const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)

    // inst-mobile のみが削除され、inst-desktop は残っていること
    expect(snapshot.taskExecutions['2025-10-01']).toHaveLength(1)
    expect(snapshot.taskExecutions['2025-10-01'][0].instanceId).toBe('inst-desktop')
    expect(snapshot.taskExecutions['2025-10-01'][0].taskId).toBe('tc-same-task')
  })

  test('delete without instanceId falls back to taskId for backward compatibility', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    // instanceIdがない旧形式のログデータを用意
    seedSnapshot(store, abstractStore, '2025-09', {
      taskExecutions: {
        '2025-09-15': [
          {
            taskId: 'tc-old-task',
            taskTitle: 'Legacy Task',
            durationSec: 600,
            stopTime: '10:00',
          },
          {
            taskId: 'tc-keep-task',
            taskTitle: 'Keep This',
            durationSec: 300,
            stopTime: '11:00',
          },
        ],
      },
      dailySummary: {},
      meta: { revision: 1, processedCursor: { 'device-alpha': 0 } },
    })

    // instanceIdなしの削除delta（旧形式互換）
    seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2025-09', [
      {
        schemaVersion: 1,
        op: 'delete',
        entryId: 'device-alpha:del',
        deviceId: 'device-alpha',
        monthKey: '2025-09',
        dateKey: '2025-09-15',
        recordedAt: '2025-09-15T12:00:00Z',
        payload: { taskId: 'tc-old-task' },
      },
    ])

    const reconciler = new LogReconciler(plugin)
    await reconciler.reconcilePendingDeltas()

    const snapshot = JSON.parse(store.get('LOGS/2025-09-tasks.json')!)
    expect(snapshot.taskExecutions['2025-09-15']).toHaveLength(1)
    expect(snapshot.taskExecutions['2025-09-15'][0].taskId).toBe('tc-keep-task')
  })

  test('delete after upsert correctly restores entry from different device', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    seedSnapshot(store, abstractStore, '2025-10', {
      taskExecutions: {},
      dailySummary: {},
      meta: { revision: 0, processedCursor: {} },
    })

    // デスクトップでupsert、モバイルでdelete、デスクトップで再度upsert
    seedDeltaFile(abstractStore, deltaStore, 'device-desktop', '2025-10', [
      {
        schemaVersion: 1,
        op: 'upsert',
        entryId: 'device-desktop:1',
        deviceId: 'device-desktop',
        monthKey: '2025-10',
        dateKey: '2025-10-05',
        recordedAt: '2025-10-05T08:00:00Z',
        payload: {
          instanceId: 'inst-1',
          taskId: 'tc-task-1',
          taskTitle: 'Task One',
          durationSec: 600,
          stopTime: '08:10',
        },
      },
    ])

    seedDeltaFile(abstractStore, deltaStore, 'device-mobile', '2025-10', [
      {
        schemaVersion: 1,
        op: 'delete',
        entryId: 'device-mobile:del',
        deviceId: 'device-mobile',
        monthKey: '2025-10',
        dateKey: '2025-10-05',
        recordedAt: '2025-10-05T09:00:00Z',
        payload: { instanceId: 'inst-1', taskId: 'tc-task-1' },
      },
    ])

    // 最初のreconcile: upsertしてからdelete
    const reconciler = new LogReconciler(plugin)
    await reconciler.reconcilePendingDeltas()

    let snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
    // 削除後なのでエントリは空のはず
    expect(snapshot.taskExecutions['2025-10-05'] ?? []).toHaveLength(0)

    // デスクトップから再度upsert（復活シナリオ）
    seedDeltaFile(abstractStore, deltaStore, 'device-desktop', '2025-10', [
      {
        schemaVersion: 1,
        op: 'upsert',
        entryId: 'device-desktop:1',
        deviceId: 'device-desktop',
        monthKey: '2025-10',
        dateKey: '2025-10-05',
        recordedAt: '2025-10-05T08:00:00Z',
        payload: {
          instanceId: 'inst-1',
          taskId: 'tc-task-1',
          taskTitle: 'Task One',
          durationSec: 600,
          stopTime: '08:10',
        },
      },
      {
        schemaVersion: 1,
        op: 'upsert',
        entryId: 'device-desktop:2',
        deviceId: 'device-desktop',
        monthKey: '2025-10',
        dateKey: '2025-10-05',
        recordedAt: '2025-10-05T10:00:00Z',
        payload: {
          instanceId: 'inst-1',
          taskId: 'tc-task-1',
          taskTitle: 'Task One Restored',
          durationSec: 700,
          stopTime: '10:11',
        },
      },
    ])

    // 新しいリコンサイラーでカーソルリセット
    snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
    snapshot.meta.processedCursor['device-desktop'] = 0
    store.set('LOGS/2025-10-tasks.json', JSON.stringify(snapshot))

    const reconciler2 = new LogReconciler(plugin)
    await reconciler2.reconcilePendingDeltas()

    snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
    // 新しいupsertで復活
    expect(snapshot.taskExecutions['2025-10-05']).toHaveLength(1)
    expect(snapshot.taskExecutions['2025-10-05'][0].taskTitle).toBe('Task One Restored')
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
