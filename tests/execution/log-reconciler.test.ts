import { LogReconciler } from '../../src/features/log/services/LogReconciler'
import { MonthSyncCoordinator } from '../../src/features/log/services/MonthSyncCoordinator'
import { createPluginStub, seedDeltaFile, seedSnapshot } from './logTestUtils'

describe('LogReconciler', () => {
  beforeEach(() => {
    MonthSyncCoordinator._testReset()
  })

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

  test('continues applying valid records when delta file contains malformed lines', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    seedSnapshot(store, abstractStore, '2025-10', {
      taskExecutions: {},
      dailySummary: {},
      meta: { revision: 0, processedCursor: {} },
    })

    const valid1 = {
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
        taskTitle: 'Sample 1',
        taskPath: 'TASKS/sample-1.md',
        durationSec: 900,
        stopTime: '08:15',
      },
    }
    const valid2 = {
      schemaVersion: 1,
      op: 'upsert',
      entryId: 'device-alpha:2',
      deviceId: 'device-alpha',
      monthKey: '2025-10',
      dateKey: '2025-10-01',
      recordedAt: '2025-10-01T09:00:00.000Z',
      payload: {
        instanceId: 'inst-2',
        taskId: 'tc-task-2',
        taskTitle: 'Sample 2',
        taskPath: 'TASKS/sample-2.md',
        durationSec: 1200,
        stopTime: '09:20',
      },
    }
    seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2025-10', [valid1, valid2])
    deltaStore.set(
      'LOGS/inbox/device-alpha/2025-10.jsonl',
      `${JSON.stringify(valid1)}\n{"broken-json"\n${JSON.stringify(valid2)}\n`,
    )

    const reconciler = new LogReconciler(plugin)
    const stats = await reconciler.reconcilePendingDeltas()

    expect(stats.processedEntries).toBe(2)
    const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
    expect(snapshot.taskExecutions['2025-10-01']).toHaveLength(2)
    expect(snapshot.meta.processedCursor['device-alpha']).toBe(2)
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

  test('delete without instanceId should be ignored in strict instanceId mode', async () => {
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
    const stats = await reconciler.reconcilePendingDeltas()

    const snapshot = JSON.parse(store.get('LOGS/2025-09-tasks.json')!)
    expect(stats.processedEntries).toBe(0)
    expect(snapshot.taskExecutions['2025-09-15']).toHaveLength(2)
    expect(snapshot.taskExecutions['2025-09-15'][0].taskId).toBe('tc-old-task')
    expect(snapshot.taskExecutions['2025-09-15'][1].taskId).toBe('tc-keep-task')
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

  // ── CSR (cursorSnapshotRevision) 関連テスト ──

  describe('CSR external overwrite detection', () => {
    function makeDelta(deviceId: string, entryId: string, dateKey: string, instanceId: string, recordedAt: string) {
      return {
        schemaVersion: 1,
        op: 'upsert' as const,
        entryId,
        deviceId,
        monthKey: '2025-10',
        dateKey,
        recordedAt,
        payload: {
          instanceId,
          taskId: `tc-${instanceId}`,
          taskTitle: `Task ${instanceId}`,
          taskPath: `TASKS/${instanceId}.md`,
          durationSec: 600,
          stopTime: '10:00',
        },
      }
    }

    test('cursor at end + revision mismatch + missing entries → full replay restores entries', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Snapshot is missing entry inst-2 (simulates external overwrite from phone)
      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            { instanceId: 'inst-1', taskId: 'tc-1', taskTitle: 'Task1', durationSec: 600, stopTime: '09:00',
              entryId: 'dev-pc:1', deviceId: 'dev-pc', recordedAt: '2025-10-01T08:00:00Z' },
          ],
        },
        dailySummary: { '2025-10-01': { totalMinutes: 10, completedTasks: 1, totalTasks: 1, procrastinatedTasks: 0, completionRate: 1 } },
        meta: {
          revision: 5,  // Phone wrote revision 5
          processedCursor: { 'dev-pc': 2 },
          cursorSnapshotRevision: { 'dev-pc': 3 },  // PC set CSR at revision 3, but now revision is 5
        },
      })

      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-01', 'inst-1', '2025-10-01T08:00:00Z'),
        makeDelta('dev-pc', 'dev-pc:2', '2025-10-01', 'inst-2', '2025-10-01T09:00:00Z'),
      ])

      const reconciler = new LogReconciler(plugin)
      await reconciler.reconcilePendingDeltas()

      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      // inst-2 should be restored by full replay
      expect(snapshot.taskExecutions['2025-10-01']).toHaveLength(2)
      const instanceIds = snapshot.taskExecutions['2025-10-01'].map((e: { instanceId: string }) => e.instanceId).sort()
      expect(instanceIds).toEqual(['inst-1', 'inst-2'])
      // CSR should be updated to new revision
      expect(snapshot.meta.cursorSnapshotRevision['dev-pc']).toBe(snapshot.meta.revision)
    })

    test('CSR mismatch full replay should not roll back newer snapshot entry with older delta', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Snapshot already has newer content from another device
      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            {
              instanceId: 'inst-1',
              taskId: 'tc-inst-1',
              taskTitle: 'Task inst-1 NEW',
              taskPath: 'TASKS/inst-1.md',
              durationSec: 1200,
              stopTime: '10:20',
              entryId: 'dev-phone:9',
              deviceId: 'dev-phone',
              recordedAt: '2025-10-01T09:00:00Z',
            },
          ],
        },
        dailySummary: {
          '2025-10-01': {
            totalMinutes: 20,
            completedTasks: 1,
            totalTasks: 1,
            procrastinatedTasks: 0,
            completionRate: 1,
          },
        },
        meta: {
          revision: 5,
          processedCursor: { 'dev-pc': 1 },
          cursorSnapshotRevision: { 'dev-pc': 3 }, // mismatch -> full replay path
        },
      })

      // Delta is older for the same instanceId
      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-01', 'inst-1', '2025-10-01T08:00:00Z'),
      ])

      const reconciler = new LogReconciler(plugin)
      const stats = await reconciler.reconcilePendingDeltas()

      // No rollback write should occur
      expect(stats.processedEntries).toBe(0)
      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snapshot.meta.revision).toBe(5)
      expect(snapshot.taskExecutions['2025-10-01'][0].taskTitle).toBe('Task inst-1 NEW')
      expect(snapshot.taskExecutions['2025-10-01'][0].durationSec).toBe(1200)
      expect(snapshot.taskExecutions['2025-10-01'][0].recordedAt).toBe('2025-10-01T09:00:00Z')
    })

    test('CSR mismatch full replay should not resurrect entry deleted by newer peer delete', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {},
        dailySummary: {},
        meta: {
          revision: 5,
          processedCursor: { 'aa-delete': 1, 'zz-upsert': 1 },
          cursorSnapshotRevision: { 'aa-delete': 3, 'zz-upsert': 3 },
        },
      })

      // Source order: aa-delete -> zz-upsert
      seedDeltaFile(abstractStore, deltaStore, 'aa-delete', '2025-10', [
        {
          schemaVersion: 1,
          op: 'delete',
          entryId: 'aa-delete:1',
          deviceId: 'aa-delete',
          monthKey: '2025-10',
          dateKey: '2025-10-01',
          recordedAt: '2025-10-01T11:00:00Z',
          payload: { instanceId: 'inst-1', taskId: 'tc-inst-1' },
        },
      ])
      seedDeltaFile(abstractStore, deltaStore, 'zz-upsert', '2025-10', [
        makeDelta('zz-upsert', 'zz-upsert:1', '2025-10-01', 'inst-1', '2025-10-01T09:00:00Z'),
      ])

      const reconciler = new LogReconciler(plugin)
      const stats = await reconciler.reconcilePendingDeltas()

      expect(stats.processedEntries).toBe(0)
      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snapshot.taskExecutions['2025-10-01'] ?? []).toHaveLength(0)
      expect(snapshot.meta.revision).toBe(5)
    })

    test('CSR mismatch full replay should ignore legacy records without instanceId', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {},
        dailySummary: {},
        meta: {
          revision: 5,
          processedCursor: { 'aa-delete': 1, 'zz-upsert': 1 },
          cursorSnapshotRevision: { 'aa-delete': 3, 'zz-upsert': 3 },
        },
      })

      // day-1 delete without instanceId should be ignored
      seedDeltaFile(abstractStore, deltaStore, 'aa-delete', '2025-10', [
        {
          schemaVersion: 1,
          op: 'delete',
          entryId: 'aa-delete:1',
          deviceId: 'aa-delete',
          monthKey: '2025-10',
          dateKey: '2025-10-01',
          recordedAt: '2025-10-01T12:00:00Z',
          payload: { taskId: 'legacy-task', taskTitle: 'Legacy' },
        },
      ])

      // day-2 upsert without instanceId should also be ignored
      seedDeltaFile(abstractStore, deltaStore, 'zz-upsert', '2025-10', [
        {
          schemaVersion: 1,
          op: 'upsert',
          entryId: 'zz-upsert:1',
          deviceId: 'zz-upsert',
          monthKey: '2025-10',
          dateKey: '2025-10-02',
          recordedAt: '2025-10-01T09:00:00Z',
          payload: {
            taskId: 'legacy-task',
            taskTitle: 'Legacy day2',
            durationSec: 600,
            stopTime: '10:00',
          },
        },
      ])

      const reconciler = new LogReconciler(plugin)
      const stats = await reconciler.reconcilePendingDeltas()

      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(stats.processedEntries).toBe(0)
      expect(snapshot.taskExecutions['2025-10-01'] ?? []).toHaveLength(0)
      expect(snapshot.taskExecutions['2025-10-02'] ?? []).toHaveLength(0)
    })

    test('delayed mobile reopen should not roll back three-day pc progress', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Simulate stale mobile overwrite: snapshot only keeps old shared entry.
      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            {
              instanceId: 'inst-shared',
              taskId: 'tc-inst-shared',
              taskTitle: 'Shared old mobile state',
              taskPath: 'TASKS/shared-old.md',
              durationSec: 300,
              stopTime: '08:05',
              entryId: 'dev-mobile:1',
              deviceId: 'dev-mobile',
              recordedAt: '2025-10-01T08:00:00Z',
            },
          ],
        },
        dailySummary: {
          '2025-10-01': {
            totalMinutes: 5,
            completedTasks: 1,
            totalTasks: 1,
            procrastinatedTasks: 0,
            completionRate: 1,
          },
        },
        meta: {
          revision: 20,
          processedCursor: { 'dev-pc': 3, 'dev-mobile': 1 },
          cursorSnapshotRevision: { 'dev-pc': 18, 'dev-mobile': 18 },
        },
      })

      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        {
          schemaVersion: 1,
          op: 'upsert',
          entryId: 'dev-pc:1',
          deviceId: 'dev-pc',
          monthKey: '2025-10',
          dateKey: '2025-10-01',
          recordedAt: '2025-10-01T12:00:00Z',
          payload: {
            instanceId: 'inst-shared',
            taskId: 'tc-inst-shared',
            taskTitle: 'Shared updated on PC',
            taskPath: 'TASKS/shared-updated.md',
            durationSec: 900,
            stopTime: '12:15',
          },
        },
        makeDelta('dev-pc', 'dev-pc:2', '2025-10-02', 'inst-day2', '2025-10-02T09:00:00Z'),
        makeDelta('dev-pc', 'dev-pc:3', '2025-10-03', 'inst-day3', '2025-10-03T09:00:00Z'),
      ])

      seedDeltaFile(abstractStore, deltaStore, 'dev-mobile', '2025-10', [
        {
          schemaVersion: 1,
          op: 'upsert',
          entryId: 'dev-mobile:1',
          deviceId: 'dev-mobile',
          monthKey: '2025-10',
          dateKey: '2025-10-01',
          recordedAt: '2025-10-01T08:00:00Z',
          payload: {
            instanceId: 'inst-shared',
            taskId: 'tc-inst-shared',
            taskTitle: 'Shared old mobile state',
            taskPath: 'TASKS/shared-old.md',
            durationSec: 300,
            stopTime: '08:05',
          },
        },
      ])

      const reconciler = new LogReconciler(plugin)
      const stats = await reconciler.reconcilePendingDeltas()
      expect(stats.processedEntries).toBeGreaterThan(0)

      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snapshot.taskExecutions['2025-10-01']).toHaveLength(1)
      expect(snapshot.taskExecutions['2025-10-01'][0].taskTitle).toBe('Shared updated on PC')
      expect(snapshot.taskExecutions['2025-10-01'][0].recordedAt).toBe('2025-10-01T12:00:00Z')
      expect(snapshot.taskExecutions['2025-10-02']).toHaveLength(1)
      expect(snapshot.taskExecutions['2025-10-03']).toHaveLength(1)
      expect(snapshot.meta.revision).toBe(21)
      expect(snapshot.meta.cursorSnapshotRevision['dev-pc']).toBe(21)
      expect(snapshot.meta.cursorSnapshotRevision['dev-mobile']).toBe(21)
    })

    test('delayed mobile stale upsert should not resurrect pc-deleted task', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Snapshot still has stale task (simulating mobile stale overwrite).
      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-05': [
            {
              instanceId: 'inst-deleted',
              taskId: 'tc-inst-deleted',
              taskTitle: 'Deleted task should stay deleted',
              taskPath: 'TASKS/deleted.md',
              durationSec: 300,
              stopTime: '09:05',
              entryId: 'dev-mobile:1',
              deviceId: 'dev-mobile',
              recordedAt: '2025-10-05T09:00:00Z',
            },
          ],
        },
        dailySummary: {
          '2025-10-05': {
            totalMinutes: 5,
            completedTasks: 1,
            totalTasks: 1,
            procrastinatedTasks: 0,
            completionRate: 1,
          },
        },
        meta: {
          revision: 50,
          processedCursor: { 'dev-pc': 2, 'dev-mobile': 1 },
          cursorSnapshotRevision: { 'dev-pc': 48, 'dev-mobile': 48 },
        },
      })

      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        {
          schemaVersion: 1,
          op: 'upsert',
          entryId: 'dev-pc:1',
          deviceId: 'dev-pc',
          monthKey: '2025-10',
          dateKey: '2025-10-05',
          recordedAt: '2025-10-05T10:00:00Z',
          payload: {
            instanceId: 'inst-deleted',
            taskId: 'tc-inst-deleted',
            taskTitle: 'Deleted task should stay deleted',
            taskPath: 'TASKS/deleted.md',
            durationSec: 600,
            stopTime: '10:10',
          },
        },
        {
          schemaVersion: 1,
          op: 'delete',
          entryId: 'dev-pc:2',
          deviceId: 'dev-pc',
          monthKey: '2025-10',
          dateKey: '2025-10-05',
          recordedAt: '2025-10-05T12:00:00Z',
          payload: {
            instanceId: 'inst-deleted',
            taskId: 'tc-inst-deleted',
          },
        },
      ])

      seedDeltaFile(abstractStore, deltaStore, 'dev-mobile', '2025-10', [
        {
          schemaVersion: 1,
          op: 'upsert',
          entryId: 'dev-mobile:1',
          deviceId: 'dev-mobile',
          monthKey: '2025-10',
          dateKey: '2025-10-05',
          recordedAt: '2025-10-05T09:00:00Z',
          payload: {
            instanceId: 'inst-deleted',
            taskId: 'tc-inst-deleted',
            taskTitle: 'Deleted task should stay deleted',
            taskPath: 'TASKS/deleted.md',
            durationSec: 300,
            stopTime: '09:05',
          },
        },
      ])

      const reconciler = new LogReconciler(plugin)
      const stats = await reconciler.reconcilePendingDeltas()
      expect(stats.processedEntries).toBeGreaterThan(0)

      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snapshot.taskExecutions['2025-10-05'] ?? []).toHaveLength(0)
      expect(snapshot.meta.revision).toBe(51)
      expect(snapshot.meta.cursorSnapshotRevision['dev-pc']).toBe(51)
      expect(snapshot.meta.cursorSnapshotRevision['dev-mobile']).toBe(51)
    })

    test('delayed mobile stale overwrite with mixed update/delete should keep pc latest state', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Stale snapshot from mobile side: old update + to-be-deleted entry still present.
      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-20': [
            {
              instanceId: 'inst-shared',
              taskId: 'tc-inst-shared',
              taskTitle: 'Shared task',
              taskPath: 'TASKS/shared.md',
              durationSec: 600,
              stopTime: '09:00',
              entryId: 'dev-mobile:1',
              deviceId: 'dev-mobile',
              recordedAt: '2025-10-20T09:00:00Z',
            },
            {
              instanceId: 'inst-update',
              taskId: 'tc-inst-update',
              taskTitle: 'Old title',
              taskPath: 'TASKS/update-old.md',
              durationSec: 600,
              stopTime: '09:10',
              entryId: 'dev-mobile:2',
              deviceId: 'dev-mobile',
              recordedAt: '2025-10-20T09:10:00Z',
            },
            {
              instanceId: 'inst-delete',
              taskId: 'tc-inst-delete',
              taskTitle: 'Should stay deleted',
              taskPath: 'TASKS/delete.md',
              durationSec: 600,
              stopTime: '09:20',
              entryId: 'dev-mobile:3',
              deviceId: 'dev-mobile',
              recordedAt: '2025-10-20T09:20:00Z',
            },
          ],
        },
        dailySummary: {
          '2025-10-20': { totalMinutes: 30, completedTasks: 3, totalTasks: 3, procrastinatedTasks: 0, completionRate: 1 },
        },
        meta: {
          revision: 30,
          processedCursor: { 'dev-pc': 4, 'dev-mobile': 3 },
          cursorSnapshotRevision: { 'dev-pc': 20, 'dev-mobile': 20 },
        },
      })

      // PC has newer update + delete.
      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-20', 'inst-shared', '2025-10-20T09:00:00Z'),
        makeDelta('dev-pc', 'dev-pc:2', '2025-10-20', 'inst-update', '2025-10-20T09:10:00Z'),
        {
          schemaVersion: 1,
          op: 'upsert',
          entryId: 'dev-pc:3',
          deviceId: 'dev-pc',
          monthKey: '2025-10',
          dateKey: '2025-10-20',
          recordedAt: '2025-10-20T11:30:00Z',
          payload: {
            instanceId: 'inst-update',
            taskId: 'tc-inst-update',
            taskTitle: 'Updated title',
            taskPath: 'TASKS/update-new.md',
            durationSec: 900,
            stopTime: '11:30',
          },
        },
        {
          schemaVersion: 1,
          op: 'delete',
          entryId: 'dev-pc:4',
          deviceId: 'dev-pc',
          monthKey: '2025-10',
          dateKey: '2025-10-20',
          recordedAt: '2025-10-20T11:45:00Z',
          payload: {
            instanceId: 'inst-delete',
            taskId: 'tc-inst-delete',
          },
        },
      ])

      // Mobile keeps stale upserts only.
      seedDeltaFile(abstractStore, deltaStore, 'dev-mobile', '2025-10', [
        makeDelta('dev-mobile', 'dev-mobile:1', '2025-10-20', 'inst-shared', '2025-10-20T09:00:00Z'),
        makeDelta('dev-mobile', 'dev-mobile:2', '2025-10-20', 'inst-update', '2025-10-20T09:10:00Z'),
        makeDelta('dev-mobile', 'dev-mobile:3', '2025-10-20', 'inst-delete', '2025-10-20T09:20:00Z'),
      ])

      const reconciler = new LogReconciler(plugin)
      const stats = await reconciler.reconcilePendingDeltas()
      expect(stats.processedEntries).toBe(7)

      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      const entries = snapshot.taskExecutions['2025-10-20'] ?? []
      const byId = new Map(entries.map((entry: { instanceId: string }) => [entry.instanceId, entry]))

      expect(entries).toHaveLength(2)
      expect(byId.has('inst-shared')).toBe(true)
      expect(byId.has('inst-delete')).toBe(false)
      expect(byId.get('inst-update')).toEqual(expect.objectContaining({
        taskTitle: 'Updated title',
        taskPath: 'TASKS/update-new.md',
        recordedAt: '2025-10-20T11:30:00Z',
      }))
      expect(snapshot.meta.cursorSnapshotRevision['dev-pc']).toBe(31)
      expect(snapshot.meta.cursorSnapshotRevision['dev-mobile']).toBe(31)
    })

    test('multi-cycle delayed mobile stale overwrite should keep latest state across restarts', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      const pcRecords: unknown[] = [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-20', 'inst-a', '2025-10-20T09:00:00Z'),
        makeDelta('dev-pc', 'dev-pc:2', '2025-10-20', 'inst-c', '2025-10-20T09:30:00Z'),
      ]
      const mobileRecords: unknown[] = [
        makeDelta('dev-mobile', 'dev-mobile:1', '2025-10-20', 'inst-a', '2025-10-20T09:00:00Z'),
        makeDelta('dev-mobile', 'dev-mobile:2', '2025-10-20', 'inst-b', '2025-10-20T09:10:00Z'),
      ]

      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', pcRecords)
      seedDeltaFile(abstractStore, deltaStore, 'dev-mobile', '2025-10', mobileRecords)

      const seedStaleSnapshot = (revision: number): void => {
        seedSnapshot(store, abstractStore, '2025-10', {
          taskExecutions: {
            '2025-10-20': [
              {
                instanceId: 'inst-a',
                taskId: 'tc-inst-a',
                taskTitle: 'Task inst-a',
                taskPath: 'TASKS/inst-a.md',
                durationSec: 600,
                stopTime: '10:00',
                entryId: 'dev-mobile:1',
                deviceId: 'dev-mobile',
                recordedAt: '2025-10-20T09:00:00Z',
              },
              {
                instanceId: 'inst-b',
                taskId: 'tc-inst-b',
                taskTitle: 'Task inst-b',
                taskPath: 'TASKS/inst-b.md',
                durationSec: 600,
                stopTime: '10:00',
                entryId: 'dev-mobile:2',
                deviceId: 'dev-mobile',
                recordedAt: '2025-10-20T09:10:00Z',
              },
            ],
          },
          dailySummary: {
            '2025-10-20': { totalMinutes: 20, completedTasks: 2, totalTasks: 2, procrastinatedTasks: 0, completionRate: 1 },
          },
          meta: {
            revision,
            processedCursor: { 'dev-pc': pcRecords.length, 'dev-mobile': mobileRecords.length },
            cursorSnapshotRevision: { 'dev-pc': revision, 'dev-mobile': revision },
          },
        })
      }

      // Cycle 1: stale mobile overwrite -> replay should restore PC-only inst-c.
      seedStaleSnapshot(40)
      let reconciler = new LogReconciler(plugin)
      let stats = await reconciler.reconcilePendingDeltas()
      expect(stats.processedEntries).toBeGreaterThan(0)

      let snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      let entries = snapshot.taskExecutions['2025-10-20'] ?? []
      expect(entries.map((e: { instanceId: string }) => e.instanceId).sort()).toEqual(['inst-a', 'inst-b', 'inst-c'])
      const revAfter1 = snapshot.meta.revision

      // Prepare newer PC operations: delete inst-a, update inst-b.
      pcRecords.push(
        {
          schemaVersion: 1,
          op: 'delete',
          entryId: 'dev-pc:3',
          deviceId: 'dev-pc',
          monthKey: '2025-10',
          dateKey: '2025-10-20',
          recordedAt: '2025-10-20T11:00:00Z',
          payload: { instanceId: 'inst-a', taskId: 'tc-inst-a' },
        },
        {
          schemaVersion: 1,
          op: 'upsert',
          entryId: 'dev-pc:4',
          deviceId: 'dev-pc',
          monthKey: '2025-10',
          dateKey: '2025-10-20',
          recordedAt: '2025-10-20T11:10:00Z',
          payload: {
            instanceId: 'inst-b',
            taskId: 'tc-inst-b',
            taskTitle: 'Task inst-b updated',
            taskPath: 'TASKS/inst-b-new.md',
            durationSec: 900,
            stopTime: '11:10',
          },
        },
      )
      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', pcRecords)

      // Cycle 2: stale overwrite again, and restart (new reconciler instance).
      seedStaleSnapshot(revAfter1)
      reconciler = new LogReconciler(plugin)
      stats = await reconciler.reconcilePendingDeltas()
      expect(stats.processedEntries).toBeGreaterThan(0)

      snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      entries = snapshot.taskExecutions['2025-10-20'] ?? []
      expect(entries.map((e: { instanceId: string }) => e.instanceId).sort()).toEqual(['inst-b', 'inst-c'])
      const updatedB = entries.find((e: { instanceId: string }) => e.instanceId === 'inst-b')
      expect(updatedB).toEqual(expect.objectContaining({
        taskPath: 'TASKS/inst-b-new.md',
        recordedAt: '2025-10-20T11:10:00Z',
      }))
      const revAfter2 = snapshot.meta.revision

      // Cycle 3: same stale overwrite once more after restart; latest state must remain.
      seedStaleSnapshot(revAfter2)
      reconciler = new LogReconciler(plugin)
      stats = await reconciler.reconcilePendingDeltas()
      expect(stats.processedEntries).toBeGreaterThan(0)

      snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      entries = snapshot.taskExecutions['2025-10-20'] ?? []
      expect(entries.map((e: { instanceId: string }) => e.instanceId).sort()).toEqual(['inst-b', 'inst-c'])
      expect(entries.some((e: { instanceId: string }) => e.instanceId === 'inst-a')).toBe(false)
      expect(snapshot.meta.revision).toBeGreaterThan(revAfter2)
    })

    test('cursor at end + revision mismatch + all entries present (no-op) → write suppressed', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Snapshot has all entries (phone already applied same records)
      // Note: entries must exactly match delta payload (including taskPath) for no-op detection
      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            { instanceId: 'inst-1', taskId: 'tc-inst-1', taskTitle: 'Task inst-1', taskPath: 'TASKS/inst-1.md',
              durationSec: 600, stopTime: '10:00',
              entryId: 'dev-pc:1', deviceId: 'dev-pc', recordedAt: '2025-10-01T08:00:00Z' },
            { instanceId: 'inst-2', taskId: 'tc-inst-2', taskTitle: 'Task inst-2', taskPath: 'TASKS/inst-2.md',
              durationSec: 600, stopTime: '10:00',
              entryId: 'dev-pc:2', deviceId: 'dev-pc', recordedAt: '2025-10-01T09:00:00Z' },
          ],
        },
        dailySummary: { '2025-10-01': { totalMinutes: 20, completedTasks: 2, totalTasks: 2, procrastinatedTasks: 0, completionRate: 1 } },
        meta: {
          revision: 5,  // Different revision
          processedCursor: { 'dev-pc': 2 },
          cursorSnapshotRevision: { 'dev-pc': 3 },  // Mismatched
        },
      })

      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-01', 'inst-1', '2025-10-01T08:00:00Z'),
        makeDelta('dev-pc', 'dev-pc:2', '2025-10-01', 'inst-2', '2025-10-01T09:00:00Z'),
      ])

      const reconciler = new LogReconciler(plugin)
      const stats = await reconciler.reconcilePendingDeltas()

      // No-op: all entries already present → processedEntries should be 0, no write
      expect(stats.processedEntries).toBe(0)
      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      // Revision should NOT have changed (write suppressed)
      expect(snapshot.meta.revision).toBe(5)
    })

    test('cursor at end + revision match → normal skip (regression test)', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            { instanceId: 'inst-1', taskId: 'tc-1', taskTitle: 'Task1', durationSec: 600, stopTime: '09:00' },
          ],
        },
        dailySummary: {},
        meta: {
          revision: 3,
          processedCursor: { 'dev-pc': 1 },
          cursorSnapshotRevision: { 'dev-pc': 3 },  // Matches current revision
        },
      })

      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-01', 'inst-1', '2025-10-01T08:00:00Z'),
      ])

      const reconciler = new LogReconciler(plugin)
      const stats = await reconciler.reconcilePendingDeltas()
      expect(stats.processedEntries).toBe(0)
      // Revision unchanged
      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snapshot.meta.revision).toBe(3)
    })

    test('CSR undefined (old version snapshot) → bootstrap full replay protects entries', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            { instanceId: 'inst-1', taskId: 'tc-inst-1', taskTitle: 'Task inst-1', taskPath: 'TASKS/inst-1.md',
              durationSec: 600, stopTime: '10:00',
              entryId: 'dev-pc:1', deviceId: 'dev-pc', recordedAt: '2025-10-01T08:00:00Z' },
          ],
        },
        dailySummary: { '2025-10-01': { totalMinutes: 10, completedTasks: 1, totalTasks: 1, procrastinatedTasks: 0, completionRate: 1 } },
        meta: {
          revision: 2,
          processedCursor: { 'dev-pc': 1 },
          // No cursorSnapshotRevision → should trigger bootstrap full replay
        },
      })

      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-01', 'inst-1', '2025-10-01T08:00:00Z'),
      ])

      const reconciler = new LogReconciler(plugin)
      const stats = await reconciler.reconcilePendingDeltas()
      // No-op: all entries already present
      expect(stats.processedEntries).toBe(0)
      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snapshot.meta.revision).toBe(2) // No write
    })

    test('CSR undefined + no-op → second reconcile uses cache to skip replay', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            { instanceId: 'inst-1', taskId: 'tc-1', taskTitle: 'Task1', durationSec: 600, stopTime: '09:00',
              entryId: 'dev-pc:1', deviceId: 'dev-pc', recordedAt: '2025-10-01T08:00:00Z' },
          ],
        },
        dailySummary: { '2025-10-01': { totalMinutes: 10, completedTasks: 1, totalTasks: 1, procrastinatedTasks: 0, completionRate: 1 } },
        meta: {
          revision: 2,
          processedCursor: { 'dev-pc': 1 },
        },
      })

      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-01', 'inst-1', '2025-10-01T08:00:00Z'),
      ])

      const reconciler = new LogReconciler(plugin)
      // First reconcile: CSR undefined → full replay → no-op → cache
      await reconciler.reconcilePendingDeltas()
      // Second reconcile: cache hit → skip replay
      const stats2 = await reconciler.reconcilePendingDeltas()
      expect(stats2.processedEntries).toBe(0)
    })

    test('legacy snapshot + no-op full replay should still persist migration', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            { instanceId: 'inst-1', taskId: 'tc-inst-1', taskTitle: 'Task inst-1', taskPath: 'TASKS/inst-1.md',
              durationSec: 600, stopTime: '10:00',
              entryId: 'dev-pc:1', deviceId: 'dev-pc', recordedAt: '2025-10-01T08:00:00Z' },
          ],
        },
        dailySummary: { '2025-10-01': { totalMinutes: 10, completedTasks: 1, totalTasks: 1, procrastinatedTasks: 0, completionRate: 1 } },
        // meta intentionally omitted: legacy snapshot
      })

      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-01', 'inst-1', '2025-10-01T08:00:00Z'),
      ])

      const reconciler = new LogReconciler(plugin)
      const stats = await reconciler.reconcilePendingDeltas()
      expect(stats.processedEntries).toBe(0)

      // no-opでもlegacy移行が完了していればmetaが永続化される
      const raw = store.get('LOGS/2025-10-tasks.json')
      expect(raw).toBeDefined()
      const persisted = JSON.parse(raw!)
      expect(persisted.meta).toBeDefined()
      expect(typeof persisted.meta.revision).toBe('number')
      expect(persisted.meta.revision).toBeGreaterThanOrEqual(0)
    })

    test('no-op source + another source writes → no-op source CSR aligned to nextRevision', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            { instanceId: 'inst-1', taskId: 'tc-1', taskTitle: 'Task1', durationSec: 600, stopTime: '09:00',
              entryId: 'dev-pc:1', deviceId: 'dev-pc', recordedAt: '2025-10-01T08:00:00Z' },
          ],
        },
        dailySummary: { '2025-10-01': { totalMinutes: 10, completedTasks: 1, totalTasks: 1, procrastinatedTasks: 0, completionRate: 1 } },
        meta: {
          revision: 3,
          processedCursor: { 'dev-pc': 1, 'dev-phone': 0 },
          cursorSnapshotRevision: { 'dev-pc': 2 },  // Mismatch → triggers full replay for PC
        },
      })

      // PC delta: 1 record already in snapshot
      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-01', 'inst-1', '2025-10-01T08:00:00Z'),
      ])

      // Phone delta: 1 new record
      seedDeltaFile(abstractStore, deltaStore, 'dev-phone', '2025-10', [
        makeDelta('dev-phone', 'dev-phone:1', '2025-10-01', 'inst-3', '2025-10-01T11:00:00Z'),
      ])

      const reconciler = new LogReconciler(plugin)
      await reconciler.reconcilePendingDeltas()

      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      // Both PC and Phone CSRs should be aligned to the new revision
      expect(snapshot.meta.cursorSnapshotRevision['dev-pc']).toBe(snapshot.meta.revision)
      expect(snapshot.meta.cursorSnapshotRevision['dev-phone']).toBe(snapshot.meta.revision)
      // PC processedCursor should also be aligned
      expect(snapshot.meta.processedCursor['dev-pc']).toBe(1)
      expect(snapshot.meta.processedCursor['dev-phone']).toBe(1)
    })

    test('revision mismatch + delete record removes externally restored entry', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Snapshot has inst-2 which was deleted by PC but restored by external overwrite
      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            { instanceId: 'inst-1', taskId: 'tc-1', taskTitle: 'Task1', durationSec: 600, stopTime: '09:00',
              entryId: 'dev-pc:1', deviceId: 'dev-pc', recordedAt: '2025-10-01T08:00:00Z' },
            { instanceId: 'inst-2', taskId: 'tc-2', taskTitle: 'Task2', durationSec: 600, stopTime: '10:00',
              entryId: 'dev-pc:2', deviceId: 'dev-pc', recordedAt: '2025-10-01T09:00:00Z' },
          ],
        },
        dailySummary: { '2025-10-01': { totalMinutes: 20, completedTasks: 2, totalTasks: 2, procrastinatedTasks: 0, completionRate: 1 } },
        meta: {
          revision: 5,
          processedCursor: { 'dev-pc': 3 },
          cursorSnapshotRevision: { 'dev-pc': 3 },  // Mismatch
        },
      })

      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-01', 'inst-1', '2025-10-01T08:00:00Z'),
        makeDelta('dev-pc', 'dev-pc:2', '2025-10-01', 'inst-2', '2025-10-01T09:00:00Z'),
        {
          schemaVersion: 1, op: 'delete', entryId: 'dev-pc:3', deviceId: 'dev-pc',
          monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T10:00:00Z',
          payload: { instanceId: 'inst-2', taskId: 'tc-2' },
        },
      ])

      const reconciler = new LogReconciler(plugin)
      await reconciler.reconcilePendingDeltas()

      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      // inst-2 should be deleted by the delete record
      expect(snapshot.taskExecutions['2025-10-01']).toHaveLength(1)
      expect(snapshot.taskExecutions['2025-10-01'][0].instanceId).toBe('inst-1')
    })

    test('superseded records → post-signature comparison correctly detects no-op', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Snapshot has the FINAL state of inst-1 (after second upsert)
      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            { instanceId: 'inst-1', taskId: 'tc-1', taskTitle: 'Updated', taskPath: 'TASKS/updated.md',
              durationSec: 900, stopTime: '10:00',
              entryId: 'dev-pc:1', deviceId: 'dev-pc', recordedAt: '2025-10-01T09:00:00Z' },
          ],
        },
        dailySummary: { '2025-10-01': { totalMinutes: 15, completedTasks: 1, totalTasks: 1, procrastinatedTasks: 0, completionRate: 1 } },
        meta: {
          revision: 5,
          processedCursor: { 'dev-pc': 2 },
          cursorSnapshotRevision: { 'dev-pc': 3 },  // Mismatch
        },
      })

      // Delta: first upsert then superseded by second upsert (same instanceId/entryId)
      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        {
          schemaVersion: 1, op: 'upsert', entryId: 'dev-pc:1', deviceId: 'dev-pc',
          monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T08:00:00Z',
          payload: { instanceId: 'inst-1', taskId: 'tc-1', taskTitle: 'Original', taskPath: 'TASKS/original.md',
            durationSec: 600, stopTime: '09:00' },
        },
        {
          schemaVersion: 1, op: 'upsert', entryId: 'dev-pc:1', deviceId: 'dev-pc',
          monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T09:00:00Z',
          payload: { instanceId: 'inst-1', taskId: 'tc-1', taskTitle: 'Updated', taskPath: 'TASKS/updated.md',
            durationSec: 900, stopTime: '10:00' },
        },
      ])

      const reconciler = new LogReconciler(plugin)
      const stats = await reconciler.reconcilePendingDeltas()
      // No-op: final state already matches
      expect(stats.processedEntries).toBe(0)
      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snapshot.meta.revision).toBe(5) // No write
    })

    test('same entryId + content diff (renameTaskPath) → write occurs', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Snapshot has OLD taskPath (external overwrite reverted rename)
      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            { instanceId: 'inst-1', taskId: 'tc-1', taskTitle: 'Task1', taskPath: 'TASKS/old-path.md',
              durationSec: 600, stopTime: '09:00',
              entryId: 'dev-pc:1', deviceId: 'dev-pc', recordedAt: '2025-10-01T08:00:00Z' },
          ],
        },
        dailySummary: { '2025-10-01': { totalMinutes: 10, completedTasks: 1, totalTasks: 1, procrastinatedTasks: 0, completionRate: 1 } },
        meta: {
          revision: 5,
          processedCursor: { 'dev-pc': 1 },
          cursorSnapshotRevision: { 'dev-pc': 3 },  // Mismatch
        },
      })

      // Delta has RENAMED taskPath
      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        {
          schemaVersion: 1, op: 'upsert', entryId: 'dev-pc:1', deviceId: 'dev-pc',
          monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T08:00:00Z',
          payload: { instanceId: 'inst-1', taskId: 'tc-1', taskTitle: 'Task1', taskPath: 'TASKS/new-path.md',
            durationSec: 600, stopTime: '09:00' },
        },
      ])

      const reconciler = new LogReconciler(plugin)
      const stats = await reconciler.reconcilePendingDeltas()
      // Content diff detected → write occurs
      expect(stats.processedEntries).toBeGreaterThan(0)
      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snapshot.taskExecutions['2025-10-01'][0].taskPath).toBe('TASKS/new-path.md')
      expect(snapshot.meta.revision).toBe(6) // Written
    })

    test('CSR mismatch + malformed taskExecutions entry should not throw and should recover', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-01', 'inst-1', '2025-10-01T08:00:00Z'),
      ])

      // taskExecutions['2025-10-01'] が配列でない壊れたJSONスナップショット
      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': { malformed: true },
        },
        dailySummary: {},
        meta: {
          revision: 5,
          processedCursor: { 'dev-pc': 1 },
          cursorSnapshotRevision: { 'dev-pc': 3 }, // CSR mismatch → full replay path
        },
      })

      const reconciler = new LogReconciler(plugin)
      await expect(reconciler.reconcilePendingDeltas()).resolves.toEqual(expect.objectContaining({
        processedEntries: expect.any(Number),
      }))

      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(Array.isArray(snapshot.taskExecutions['2025-10-01'])).toBe(true)
      expect(snapshot.taskExecutions['2025-10-01']).toHaveLength(1)
      expect(snapshot.taskExecutions['2025-10-01'][0].instanceId).toBe('inst-1')
    })

    test('summary-only diff (totalTasks changed) → write occurs', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            { instanceId: 'inst-1', taskId: 'tc-1', taskTitle: 'Task1', durationSec: 600, stopTime: '09:00',
              entryId: 'dev-pc:1', deviceId: 'dev-pc', recordedAt: '2025-10-01T08:00:00Z' },
          ],
        },
        dailySummary: { '2025-10-01': { totalMinutes: 10, completedTasks: 1, totalTasks: 5, procrastinatedTasks: 4, completionRate: 0.2 } },
        meta: {
          revision: 3,
          processedCursor: { 'dev-pc': 2 },
          cursorSnapshotRevision: { 'dev-pc': 2 },  // Mismatch with revision 3
        },
      })

      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-01', 'inst-1', '2025-10-01T08:00:00Z'),
        {
          schemaVersion: 1, op: 'summary', entryId: 'dev-pc:s1', deviceId: 'dev-pc',
          monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T12:00:00Z',
          payload: { totalTasks: 10, totalTasksRecordedAt: '2025-10-01T12:00:00Z', totalTasksDeviceId: 'dev-pc', totalTasksEntryId: 'dev-pc:s1' },
        },
      ])

      const reconciler = new LogReconciler(plugin)
      const stats = await reconciler.reconcilePendingDeltas()
      // Summary change should trigger write (totalTasks 5 → 10 via summary record)
      expect(stats.processedEntries).toBeGreaterThan(0)
    })

    test('CSR mismatch + startIndex < records.length → full replay restores past entries', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Snapshot is missing inst-1 but cursor points to the middle (not end)
      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            { instanceId: 'inst-2', taskId: 'tc-2', taskTitle: 'Task2', durationSec: 600, stopTime: '10:00',
              entryId: 'dev-pc:2', deviceId: 'dev-pc', recordedAt: '2025-10-01T09:00:00Z' },
          ],
        },
        dailySummary: { '2025-10-01': { totalMinutes: 10, completedTasks: 1, totalTasks: 1, procrastinatedTasks: 0, completionRate: 1 } },
        meta: {
          revision: 5,
          processedCursor: { 'dev-pc': 2 },  // Cursor at 2, records has 3 → startIndex < records.length
          cursorSnapshotRevision: { 'dev-pc': 3 },  // Mismatch
        },
      })

      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-01', 'inst-1', '2025-10-01T08:00:00Z'),
        makeDelta('dev-pc', 'dev-pc:2', '2025-10-01', 'inst-2', '2025-10-01T09:00:00Z'),
        makeDelta('dev-pc', 'dev-pc:3', '2025-10-01', 'inst-3', '2025-10-01T10:00:00Z'),
      ])

      const reconciler = new LogReconciler(plugin)
      await reconciler.reconcilePendingDeltas()

      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      // Full replay should restore inst-1 (past entry) AND add inst-3 (new entry)
      expect(snapshot.taskExecutions['2025-10-01']).toHaveLength(3)
      const instanceIds = snapshot.taskExecutions['2025-10-01'].map((e: { instanceId: string }) => e.instanceId).sort()
      expect(instanceIds).toEqual(['inst-1', 'inst-2', 'inst-3'])
    })

    test('two-device alternating reconcile converges with at most 1 write', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Initial state: PC has written entries, phone is behind
      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            { instanceId: 'inst-1', taskId: 'tc-1', taskTitle: 'Task1', durationSec: 600, stopTime: '09:00',
              entryId: 'dev-pc:1', deviceId: 'dev-pc', recordedAt: '2025-10-01T08:00:00Z' },
          ],
        },
        dailySummary: { '2025-10-01': { totalMinutes: 10, completedTasks: 1, totalTasks: 1, procrastinatedTasks: 0, completionRate: 1 } },
        meta: {
          revision: 3,
          processedCursor: { 'dev-pc': 1 },
          cursorSnapshotRevision: { 'dev-pc': 3 },
        },
      })

      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-01', 'inst-1', '2025-10-01T08:00:00Z'),
      ])

      const reconciler = new LogReconciler(plugin)
      // First reconcile: CSR matches → skip (no write)
      const stats1 = await reconciler.reconcilePendingDeltas()
      expect(stats1.processedEntries).toBe(0)
      const snap1 = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snap1.meta.revision).toBe(3)

      // Second reconcile: same state → still skip
      const stats2 = await reconciler.reconcilePendingDeltas()
      expect(stats2.processedEntries).toBe(0)
    })

    test('cache hit + records.length <= cachedRecordsLength → complete skip', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            { instanceId: 'inst-1', taskId: 'tc-1', taskTitle: 'Task1', durationSec: 600, stopTime: '09:00',
              entryId: 'dev-pc:1', deviceId: 'dev-pc', recordedAt: '2025-10-01T08:00:00Z' },
          ],
        },
        dailySummary: { '2025-10-01': { totalMinutes: 10, completedTasks: 1, totalTasks: 1, procrastinatedTasks: 0, completionRate: 1 } },
        meta: {
          revision: 2,
          processedCursor: { 'dev-pc': 1 },
          // No CSR → triggers bootstrap full replay → no-op → cache
        },
      })

      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-01', 'inst-1', '2025-10-01T08:00:00Z'),
      ])

      const reconciler = new LogReconciler(plugin)
      // 1st: full replay → no-op → cached (recordsLength=1)
      await reconciler.reconcilePendingDeltas()
      // 2nd: cache hit + records.length(1) <= cached.recordsLength(1) → complete skip
      const stats2 = await reconciler.reconcilePendingDeltas()
      expect(stats2.processedEntries).toBe(0)
    })

    test('cache hit + same revision external snapshot overwrite should replay and restore missing entries', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            { instanceId: 'inst-1', taskId: 'tc-inst-1', taskTitle: 'Task inst-1', taskPath: 'TASKS/inst-1.md', durationSec: 600, stopTime: '10:00',
              entryId: 'dev-pc:1', deviceId: 'dev-pc', recordedAt: '2025-10-01T08:00:00Z' },
          ],
        },
        dailySummary: { '2025-10-01': { totalMinutes: 10, completedTasks: 1, totalTasks: 1, procrastinatedTasks: 0, completionRate: 1 } },
        meta: {
          revision: 2,
          processedCursor: { 'dev-pc': 1 },
        },
      })

      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-01', 'inst-1', '2025-10-01T08:00:00Z'),
      ])

      const reconciler = new LogReconciler(plugin)
      // 1st: bootstrap full replay -> no-op -> cache (revision=2)
      const first = await reconciler.reconcilePendingDeltas()
      expect(first.processedEntries).toBe(0)

      // External overwrite: same revision, but snapshot lost the entry.
      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {},
        dailySummary: {},
        meta: {
          revision: 2,
          processedCursor: { 'dev-pc': 1 },
          cursorSnapshotRevision: { 'dev-pc': 2 },
        },
      })

      // 2nd: cache hit exists, but same-revision overwrite must be detected and full replay must restore.
      const second = await reconciler.reconcilePendingDeltas()
      expect(second.processedEntries).toBeGreaterThan(0)

      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snapshot.taskExecutions['2025-10-01']).toHaveLength(1)
      expect(snapshot.taskExecutions['2025-10-01'][0].instanceId).toBe('inst-1')
      expect(snapshot.meta.revision).toBe(3)
    })

    test('cache hit + same revision overwrite should reapply latest update and delete', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            {
              instanceId: 'inst-update',
              taskId: 'tc-inst-update',
              taskTitle: 'Updated title',
              taskPath: 'TASKS/update-new.md',
              durationSec: 900,
              stopTime: '11:00',
              entryId: 'dev-pc:2',
              deviceId: 'dev-pc',
              recordedAt: '2025-10-01T11:00:00Z',
            },
          ],
        },
        dailySummary: {
          '2025-10-01': { totalMinutes: 15, completedTasks: 1, totalTasks: 1, procrastinatedTasks: 0, completionRate: 1 },
        },
        meta: { revision: 9, processedCursor: { 'dev-pc': 4 } },
      })

      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-01', 'inst-update', '2025-10-01T09:00:00Z'),
        {
          schemaVersion: 1,
          op: 'upsert',
          entryId: 'dev-pc:2',
          deviceId: 'dev-pc',
          monthKey: '2025-10',
          dateKey: '2025-10-01',
          recordedAt: '2025-10-01T11:00:00Z',
          payload: {
            instanceId: 'inst-update',
            taskId: 'tc-inst-update',
            taskTitle: 'Updated title',
            taskPath: 'TASKS/update-new.md',
            durationSec: 900,
            stopTime: '11:00',
          },
        },
        makeDelta('dev-pc', 'dev-pc:3', '2025-10-01', 'inst-delete', '2025-10-01T10:00:00Z'),
        {
          schemaVersion: 1,
          op: 'delete',
          entryId: 'dev-pc:4',
          deviceId: 'dev-pc',
          monthKey: '2025-10',
          dateKey: '2025-10-01',
          recordedAt: '2025-10-01T12:00:00Z',
          payload: {
            instanceId: 'inst-delete',
            taskId: 'tc-inst-delete',
          },
        },
      ])

      const reconciler = new LogReconciler(plugin)

      // 1st run: bootstrap full replay -> no-op, cache warm
      const first = await reconciler.reconcilePendingDeltas()
      expect(first.processedEntries).toBe(0)

      // Same-revision external overwrite revives deleted entry and reverts updated entry.
      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            {
              instanceId: 'inst-update',
              taskId: 'tc-inst-update',
              taskTitle: 'Old title',
              taskPath: 'TASKS/update-old.md',
              durationSec: 600,
              stopTime: '09:00',
              entryId: 'dev-pc:1',
              deviceId: 'dev-pc',
              recordedAt: '2025-10-01T09:00:00Z',
            },
            {
              instanceId: 'inst-delete',
              taskId: 'tc-inst-delete',
              taskTitle: 'Revived by overwrite',
              taskPath: 'TASKS/delete.md',
              durationSec: 600,
              stopTime: '10:00',
              entryId: 'dev-pc:3',
              deviceId: 'dev-pc',
              recordedAt: '2025-10-01T10:00:00Z',
            },
          ],
        },
        dailySummary: {
          '2025-10-01': { totalMinutes: 20, completedTasks: 2, totalTasks: 2, procrastinatedTasks: 0, completionRate: 1 },
        },
        meta: { revision: 9, processedCursor: { 'dev-pc': 4 } },
      })

      const second = await reconciler.reconcilePendingDeltas()
      expect(second.processedEntries).toBe(4)

      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      const entries = snapshot.taskExecutions['2025-10-01'] ?? []
      expect(entries).toHaveLength(1)
      expect(entries[0]).toEqual(expect.objectContaining({
        instanceId: 'inst-update',
        taskPath: 'TASKS/update-new.md',
        recordedAt: '2025-10-01T11:00:00Z',
      }))
      expect(entries.some((entry: { instanceId: string }) => entry.instanceId === 'inst-delete')).toBe(false)
    })

    test('cache hit should use current snapshot signature after earlier source mutation in same reconcile', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Create source order: zz-delete -> dev-b
      seedDeltaFile(abstractStore, deltaStore, 'zz-delete', '2025-10', [])
      seedDeltaFile(abstractStore, deltaStore, 'dev-b', '2025-10', [
        {
          schemaVersion: 1,
          op: 'upsert',
          entryId: 'dev-b:1',
          deviceId: 'dev-b',
          monthKey: '2025-10',
          dateKey: '2025-10-01',
          recordedAt: '2025-10-01T09:00:00Z',
          payload: {
            instanceId: 'inst-b',
            taskId: 'tc-inst-b',
            taskTitle: 'Task B',
            taskPath: 'TASKS/inst-b.md',
            durationSec: 600,
            stopTime: '10:00',
          },
        },
      ])

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            {
              instanceId: 'inst-b',
              taskId: 'tc-inst-b',
              taskTitle: 'Task B',
              taskPath: 'TASKS/inst-b.md',
              durationSec: 600,
              stopTime: '10:00',
              entryId: 'dev-b:1',
              deviceId: 'dev-b',
              recordedAt: '2025-10-01T09:00:00Z',
            },
          ],
        },
        dailySummary: {
          '2025-10-01': {
            totalMinutes: 10,
            completedTasks: 1,
            totalTasks: 1,
            procrastinatedTasks: 0,
            completionRate: 1,
          },
        },
        meta: {
          revision: 2,
          processedCursor: { 'zz-delete': 0, 'dev-b': 1 },
        },
      })

      const reconciler = new LogReconciler(plugin)
      // 1st run: dev-b bootstrap full replay -> no-op -> cache warmed
      const first = await reconciler.reconcilePendingDeltas()
      expect(first.processedEntries).toBe(0)

      // 2nd run: first source mutates snapshot by deleting inst-b
      seedDeltaFile(abstractStore, deltaStore, 'zz-delete', '2025-10', [
        {
          schemaVersion: 1,
          op: 'delete',
          entryId: 'zz-delete:1',
          deviceId: 'zz-delete',
          monthKey: '2025-10',
          dateKey: '2025-10-01',
          recordedAt: '2025-10-01T09:00:00Z',
          payload: { instanceId: 'inst-b', taskId: 'tc-inst-b' },
        },
      ])

      const second = await reconciler.reconcilePendingDeltas()
      expect(second.processedEntries).toBeGreaterThan(0)

      // dev-b cache-hit must compare against CURRENT snapshot and trigger replay restore.
      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snapshot.taskExecutions['2025-10-01']).toHaveLength(1)
      expect(snapshot.taskExecutions['2025-10-01'][0].instanceId).toBe('inst-b')
      expect(snapshot.meta.revision).toBe(3)
    })

    test('CSR match + cursor at end + cold start + missing entries should recover by replay', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {},
        dailySummary: {},
        meta: {
          revision: 5,
          processedCursor: { 'dev-pc': 1 },
          cursorSnapshotRevision: { 'dev-pc': 5 },
        },
      })

      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-01', 'inst-1', '2025-10-01T08:00:00Z'),
      ])

      // cold start: no in-memory no-op cache
      const reconciler = new LogReconciler(plugin)
      const stats = await reconciler.reconcilePendingDeltas()

      expect(stats.processedEntries).toBeGreaterThan(0)
      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snapshot.taskExecutions['2025-10-01']).toHaveLength(1)
      expect(snapshot.taskExecutions['2025-10-01'][0].instanceId).toBe('inst-1')
      expect(snapshot.meta.revision).toBe(6)
    })

    test('cache hit + same revision external overwrite + tail append should replay from start', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            { instanceId: 'inst-1', taskId: 'tc-inst-1', taskTitle: 'Task inst-1', taskPath: 'TASKS/inst-1.md', durationSec: 600, stopTime: '10:00',
              entryId: 'dev-pc:1', deviceId: 'dev-pc', recordedAt: '2025-10-01T08:00:00Z' },
          ],
        },
        dailySummary: { '2025-10-01': { totalMinutes: 10, completedTasks: 1, totalTasks: 1, procrastinatedTasks: 0, completionRate: 1 } },
        meta: {
          revision: 2,
          processedCursor: { 'dev-pc': 1 },
        },
      })

      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-01', 'inst-1', '2025-10-01T08:00:00Z'),
      ])

      const reconciler = new LogReconciler(plugin)
      await reconciler.reconcilePendingDeltas() // cache warmed by no-op replay

      // External overwrite with same revision loses existing entry.
      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {},
        dailySummary: {},
        meta: {
          revision: 2,
          processedCursor: { 'dev-pc': 1 },
          cursorSnapshotRevision: { 'dev-pc': 2 },
        },
      })

      // Delta grows with one tail record.
      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-01', 'inst-1', '2025-10-01T08:00:00Z'),
        makeDelta('dev-pc', 'dev-pc:2', '2025-10-01', 'inst-2', '2025-10-01T09:00:00Z'),
      ])

      const stats = await reconciler.reconcilePendingDeltas()
      expect(stats.processedEntries).toBeGreaterThan(1)

      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snapshot.taskExecutions['2025-10-01']).toHaveLength(2)
      const instanceIds = snapshot.taskExecutions['2025-10-01'].map((e: { instanceId: string }) => e.instanceId).sort()
      expect(instanceIds).toEqual(['inst-1', 'inst-2'])
      expect(snapshot.meta.revision).toBe(3)
    })

    test('cache hit + records.length > cachedRecordsLength → applies only new records', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            { instanceId: 'inst-1', taskId: 'tc-1', taskTitle: 'Task1', durationSec: 600, stopTime: '09:00',
              entryId: 'dev-pc:1', deviceId: 'dev-pc', recordedAt: '2025-10-01T08:00:00Z' },
          ],
        },
        dailySummary: { '2025-10-01': { totalMinutes: 10, completedTasks: 1, totalTasks: 1, procrastinatedTasks: 0, completionRate: 1 } },
        meta: {
          revision: 2,
          processedCursor: { 'dev-pc': 1 },
        },
      })

      // Initial: 1 record
      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-01', 'inst-1', '2025-10-01T08:00:00Z'),
      ])

      const reconciler = new LogReconciler(plugin)
      // 1st reconcile: bootstrap full replay → no-op → cached (recordsLength=1)
      await reconciler.reconcilePendingDeltas()

      // Add a new record to the delta file (simulating new task completion)
      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-01', 'inst-1', '2025-10-01T08:00:00Z'),
        makeDelta('dev-pc', 'dev-pc:2', '2025-10-01', 'inst-2', '2025-10-01T09:00:00Z'),
      ])

      // 2nd reconcile: cache hit + records.length(2) > cached.recordsLength(1) → diff apply
      const stats2 = await reconciler.reconcilePendingDeltas()
      expect(stats2.processedEntries).toBe(1) // Only the new record

      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snapshot.taskExecutions['2025-10-01']).toHaveLength(2)
    })

    test('cache hit + same length rewrite should reprocess full records', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            { instanceId: 'inst-1', taskId: 'tc-inst-1', taskTitle: 'Task inst-1', taskPath: 'TASKS/old-path.md', durationSec: 600, stopTime: '10:00',
              entryId: 'dev-pc:1', deviceId: 'dev-pc', recordedAt: '2025-10-01T08:00:00Z' },
          ],
        },
        dailySummary: { '2025-10-01': { totalMinutes: 10, completedTasks: 1, totalTasks: 1, procrastinatedTasks: 0, completionRate: 1 } },
        meta: {
          revision: 2,
          processedCursor: { 'dev-pc': 1 },
        },
      })

      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        {
          schemaVersion: 1, op: 'upsert', entryId: 'dev-pc:1', deviceId: 'dev-pc',
          monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T08:00:00Z',
          payload: { instanceId: 'inst-1', taskId: 'tc-inst-1', taskTitle: 'Task inst-1', taskPath: 'TASKS/old-path.md',
            durationSec: 600, stopTime: '10:00' },
        },
      ])

      const reconciler = new LogReconciler(plugin)
      const first = await reconciler.reconcilePendingDeltas()
      expect(first.processedEntries).toBe(0)

      // Same records.length(1) but content changed in-place.
      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        {
          schemaVersion: 1, op: 'upsert', entryId: 'dev-pc:1', deviceId: 'dev-pc',
          monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T08:00:00Z',
          payload: { instanceId: 'inst-1', taskId: 'tc-inst-1', taskTitle: 'Task inst-1', taskPath: 'TASKS/new-path.md',
            durationSec: 600, stopTime: '10:00' },
        },
      ])

      const second = await reconciler.reconcilePendingDeltas()
      expect(second.processedEntries).toBeGreaterThan(0)

      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snapshot.taskExecutions['2025-10-01'][0].taskPath).toBe('TASKS/new-path.md')
      expect(snapshot.meta.revision).toBe(3)
    })

    test('cache hit + prefix rewrite with tail append should replay from start', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            { instanceId: 'inst-1', taskId: 'tc-inst-1', taskTitle: 'Task inst-1', taskPath: 'TASKS/old-path.md', durationSec: 600, stopTime: '10:00',
              entryId: 'dev-pc:1', deviceId: 'dev-pc', recordedAt: '2025-10-01T08:00:00Z' },
          ],
        },
        dailySummary: { '2025-10-01': { totalMinutes: 10, completedTasks: 1, totalTasks: 1, procrastinatedTasks: 0, completionRate: 1 } },
        meta: {
          revision: 2,
          processedCursor: { 'dev-pc': 1 },
        },
      })

      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        {
          schemaVersion: 1, op: 'upsert', entryId: 'dev-pc:1', deviceId: 'dev-pc',
          monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T08:00:00Z',
          payload: { instanceId: 'inst-1', taskId: 'tc-inst-1', taskTitle: 'Task inst-1', taskPath: 'TASKS/old-path.md',
            durationSec: 600, stopTime: '10:00' },
        },
      ])

      const reconciler = new LogReconciler(plugin)
      await reconciler.reconcilePendingDeltas()

      // Prefix content changed and one new record appended.
      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        {
          schemaVersion: 1, op: 'upsert', entryId: 'dev-pc:1', deviceId: 'dev-pc',
          monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T08:00:00Z',
          payload: { instanceId: 'inst-1', taskId: 'tc-inst-1', taskTitle: 'Task inst-1', taskPath: 'TASKS/new-path.md',
            durationSec: 600, stopTime: '10:00' },
        },
        makeDelta('dev-pc', 'dev-pc:2', '2025-10-01', 'inst-2', '2025-10-01T09:00:00Z'),
      ])

      const stats = await reconciler.reconcilePendingDeltas()
      expect(stats.processedEntries).toBeGreaterThan(0)

      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snapshot.taskExecutions['2025-10-01']).toHaveLength(2)
      expect(snapshot.taskExecutions['2025-10-01'][0].taskPath).toBe('TASKS/new-path.md')
      expect(snapshot.meta.revision).toBe(3)
    })

    test('terminal upsert detection should stay near-linear for large tail-scan path', () => {
      const { plugin } = createPluginStub()
      const reconciler = new LogReconciler(plugin)
      const reconcilerAny = reconciler as unknown as {
        hasMissingTerminalUpsert: (snapshot: unknown, records: unknown[]) => boolean
        recordSupersedesIdentity: (record: unknown, identity: unknown) => boolean
      }
      const original = reconcilerAny.recordSupersedesIdentity.bind(reconcilerAny)
      let supersedeChecks = 0
      reconcilerAny.recordSupersedesIdentity = (record, identity) => {
        supersedeChecks += 1
        return original(record, identity)
      }

      const recordCount = 240
      const records = Array.from({ length: recordCount }, (_, index) => (
        makeDelta(
          'dev-pc',
          `dev-pc:${index + 1}`,
          '2025-10-01',
          `inst-${index + 1}`,
          `2025-10-01T${String((index % 24)).padStart(2, '0')}:00:00Z`,
        )
      ))

      const missing = reconcilerAny.hasMissingTerminalUpsert({ taskExecutions: {}, dailySummary: {}, meta: { revision: 1 } }, records)
      expect(missing).toBe(true)
      expect(supersedeChecks).toBeLessThanOrEqual(recordCount * 4)
    })

    test('terminal upsert detection should ignore records without instanceId', () => {
      const { plugin } = createPluginStub()
      const reconciler = new LogReconciler(plugin)
      const reconcilerAny = reconciler as unknown as {
        hasMissingTerminalUpsert: (snapshot: unknown, records: unknown[]) => boolean
      }

      const legacyDay1 = {
        schemaVersion: 1,
        op: 'upsert' as const,
        entryId: 'legacy:1',
        deviceId: 'legacy',
        monthKey: '2025-10',
        dateKey: '2025-10-01',
        recordedAt: '2025-10-01T09:00:00Z',
        payload: {
          taskId: 'legacy-task',
          taskTitle: 'Legacy Task',
          taskPath: 'TASKS/legacy.md',
          durationSec: 300,
          stopTime: '09:05',
        },
      }
      const legacyDay2 = {
        ...legacyDay1,
        entryId: 'legacy:2',
        dateKey: '2025-10-02',
        recordedAt: '2025-10-02T09:00:00Z',
      }

      const missing = reconcilerAny.hasMissingTerminalUpsert({
        taskExecutions: {
          '2025-10-02': [
            {
              ...legacyDay2.payload,
              entryId: 'legacy:2',
              deviceId: 'legacy',
              recordedAt: '2025-10-02T09:00:00Z',
            },
          ],
        },
        dailySummary: {},
        meta: { revision: 1 },
      }, [legacyDay1, legacyDay2])

      expect(missing).toBe(false)
    })

    test('delta records signature should be bounded-size hash without raw payload retention', () => {
      const { plugin } = createPluginStub()
      const reconciler = new LogReconciler(plugin)
      const reconcilerAny = reconciler as unknown as {
        computeDeltaRecordsSignature: (records: unknown[]) => string
      }

      const hugePath = `TASKS/${'very-long-segment-'.repeat(120)}.md`
      const records = [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-01', 'inst-1', '2025-10-01T08:00:00Z'),
        {
          ...makeDelta('dev-pc', 'dev-pc:2', '2025-10-01', 'inst-2', '2025-10-01T09:00:00Z'),
          payload: {
            ...makeDelta('dev-pc', 'dev-pc:2', '2025-10-01', 'inst-2', '2025-10-01T09:00:00Z').payload,
            taskPath: hugePath,
          },
        },
      ]

      const signature = reconcilerAny.computeDeltaRecordsSignature(records)

      expect(signature).toMatch(/^2:\d+:[0-9a-f]{16}$/)
      expect(signature.length).toBeLessThanOrEqual(32)
      expect(signature).not.toContain('very-long-segment')
      expect(signature).not.toContain('TASKS/')
    })

    test('month-level replay should compact same-identity history to terminal operation', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      const history = Array.from({ length: 12 }, (_, index) => ({
        ...makeDelta(
          'dev-alpha',
          `dev-alpha:${index + 1}`,
          '2025-10-01',
          'inst-compact',
          `2025-10-01T09:${String(index).padStart(2, '0')}:00Z`,
        ),
        payload: {
          ...makeDelta(
            'dev-alpha',
            `dev-alpha:${index + 1}`,
            '2025-10-01',
            'inst-compact',
            `2025-10-01T09:${String(index).padStart(2, '0')}:00Z`,
          ).payload,
          taskPath: `TASKS/compact-${index}.md`,
        },
      }))

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            {
              instanceId: 'inst-compact',
              taskId: 'tc-inst-compact',
              taskTitle: 'Task inst-compact',
              taskPath: 'TASKS/compact-0.md',
              durationSec: 600,
              stopTime: '10:00',
              entryId: 'dev-alpha:1',
              deviceId: 'dev-alpha',
              recordedAt: '2025-10-01T09:00:00Z',
            },
          ],
        },
        dailySummary: {
          '2025-10-01': { totalMinutes: 10, completedTasks: 1, totalTasks: 1, procrastinatedTasks: 0, completionRate: 1 },
        },
        meta: {
          revision: 7,
          processedCursor: { 'dev-alpha': history.length },
          cursorSnapshotRevision: { 'dev-alpha': 6 },
        },
      })
      seedDeltaFile(abstractStore, deltaStore, 'dev-alpha', '2025-10', history)

      const reconciler = new LogReconciler(plugin)
      const reconcilerAny = reconciler as unknown as {
        applyRecordsToSnapshot: (...args: unknown[]) => number
      }
      const originalApply = reconcilerAny.applyRecordsToSnapshot.bind(reconcilerAny)
      let firstReplayBatchSize = -1
      reconcilerAny.applyRecordsToSnapshot = ((records: unknown, ...rest: unknown[]) => {
        if (firstReplayBatchSize < 0 && Array.isArray(records)) {
          firstReplayBatchSize = records.length
        }
        return originalApply(records, ...rest)
      }) as unknown as (...args: unknown[]) => number

      const stats = await reconciler.reconcilePendingDeltas()
      expect(stats.processedEntries).toBeGreaterThan(0)
      expect(firstReplayBatchSize).toBe(1)

      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snapshot.taskExecutions['2025-10-01']).toHaveLength(1)
      expect(snapshot.taskExecutions['2025-10-01'][0].taskPath).toBe('TASKS/compact-11.md')
    })

    test('month-level replay should fold only replay-target identities', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      const peerHistory = Array.from({ length: 18 }, (_, index) => (
        makeDelta(
          'dev-peer',
          `dev-peer:${index + 1}`,
          '2025-10-01',
          'inst-peer',
          `2025-10-01T11:${String(index).padStart(2, '0')}:00Z`,
        )
      ))

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            {
              instanceId: 'inst-target',
              taskId: 'tc-inst-target',
              taskTitle: 'Task inst-target',
              taskPath: 'TASKS/inst-target.md',
              durationSec: 600,
              stopTime: '10:00',
              entryId: 'dev-target:1',
              deviceId: 'dev-target',
              recordedAt: '2025-10-01T09:00:00Z',
            },
            {
              instanceId: 'inst-peer',
              taskId: 'tc-inst-peer',
              taskTitle: 'Task inst-peer',
              taskPath: 'TASKS/inst-peer.md',
              durationSec: 600,
              stopTime: '10:00',
              entryId: 'dev-peer:18',
              deviceId: 'dev-peer',
              recordedAt: '2025-10-01T11:17:00Z',
            },
          ],
        },
        dailySummary: {
          '2025-10-01': { totalMinutes: 20, completedTasks: 2, totalTasks: 2, procrastinatedTasks: 0, completionRate: 1 },
        },
        meta: {
          revision: 9,
          processedCursor: { 'dev-target': 1, 'dev-peer': peerHistory.length },
          cursorSnapshotRevision: { 'dev-target': 8, 'dev-peer': 9 },
        },
      })

      seedDeltaFile(abstractStore, deltaStore, 'dev-target', '2025-10', [
        makeDelta('dev-target', 'dev-target:1', '2025-10-01', 'inst-target', '2025-10-01T09:00:00Z'),
      ])
      seedDeltaFile(abstractStore, deltaStore, 'dev-peer', '2025-10', peerHistory)

      const reconciler = new LogReconciler(plugin)
      const reconcilerAny = reconciler as unknown as {
        applyRecordsToSnapshot: (...args: unknown[]) => number
      }
      const originalApply = reconcilerAny.applyRecordsToSnapshot.bind(reconcilerAny)
      let firstReplayBatchSize = -1
      reconcilerAny.applyRecordsToSnapshot = ((records: unknown, ...rest: unknown[]) => {
        if (firstReplayBatchSize < 0 && Array.isArray(records)) {
          firstReplayBatchSize = records.length
        }
        return originalApply(records, ...rest)
      }) as unknown as (...args: unknown[]) => number

      const stats = await reconciler.reconcilePendingDeltas()
      expect(stats.processedEntries).toBe(0)
      expect(firstReplayBatchSize).toBe(1)

      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snapshot.taskExecutions['2025-10-01']).toHaveLength(2)
      const ids = snapshot.taskExecutions['2025-10-01'].map((e: { instanceId: string }) => e.instanceId).sort()
      expect(ids).toEqual(['inst-peer', 'inst-target'])
    })

    test('month-level replay should also apply non-target source tail in same reconcile cycle', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            {
              instanceId: 'inst-target',
              taskId: 'tc-inst-target',
              taskTitle: 'Task inst-target',
              taskPath: 'TASKS/inst-target-old.md',
              durationSec: 600,
              stopTime: '10:00',
              entryId: 'dev-target:1',
              deviceId: 'dev-target',
              recordedAt: '2025-10-01T09:00:00Z',
            },
            {
              instanceId: 'inst-peer-1',
              taskId: 'tc-inst-peer-1',
              taskTitle: 'Task inst-peer-1',
              taskPath: 'TASKS/inst-peer-1.md',
              durationSec: 600,
              stopTime: '10:00',
              entryId: 'dev-peer:1',
              deviceId: 'dev-peer',
              recordedAt: '2025-10-01T09:10:00Z',
            },
          ],
        },
        dailySummary: {
          '2025-10-01': { totalMinutes: 20, completedTasks: 2, totalTasks: 2, procrastinatedTasks: 0, completionRate: 1 },
        },
        meta: {
          revision: 9,
          processedCursor: { 'dev-target': 1, 'dev-peer': 1 },
          cursorSnapshotRevision: { 'dev-target': 8, 'dev-peer': 9 },
        },
      })

      seedDeltaFile(abstractStore, deltaStore, 'dev-target', '2025-10', [
        {
          schemaVersion: 1,
          op: 'upsert',
          entryId: 'dev-target:1',
          deviceId: 'dev-target',
          monthKey: '2025-10',
          dateKey: '2025-10-01',
          recordedAt: '2025-10-01T10:00:00Z',
          payload: {
            instanceId: 'inst-target',
            taskId: 'tc-inst-target',
            taskTitle: 'Task inst-target',
            taskPath: 'TASKS/inst-target-new.md',
            durationSec: 900,
            stopTime: '10:15',
          },
        },
      ])

      seedDeltaFile(abstractStore, deltaStore, 'dev-peer', '2025-10', [
        {
          schemaVersion: 1,
          op: 'upsert',
          entryId: 'dev-peer:1',
          deviceId: 'dev-peer',
          monthKey: '2025-10',
          dateKey: '2025-10-01',
          recordedAt: '2025-10-01T09:10:00Z',
          payload: {
            instanceId: 'inst-peer-1',
            taskId: 'tc-inst-peer-1',
            taskTitle: 'Task inst-peer-1',
            taskPath: 'TASKS/inst-peer-1.md',
            durationSec: 600,
            stopTime: '10:00',
          },
        },
        {
          schemaVersion: 1,
          op: 'upsert',
          entryId: 'dev-peer:2',
          deviceId: 'dev-peer',
          monthKey: '2025-10',
          dateKey: '2025-10-01',
          recordedAt: '2025-10-01T10:30:00Z',
          payload: {
            instanceId: 'inst-peer-2',
            taskId: 'tc-inst-peer-2',
            taskTitle: 'Task inst-peer-2',
            taskPath: 'TASKS/inst-peer-2.md',
            durationSec: 300,
            stopTime: '10:35',
          },
        },
      ])

      const reconciler = new LogReconciler(plugin)
      const first = await reconciler.reconcilePendingDeltas()
      expect(first.processedEntries).toBeGreaterThan(0)

      let snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snapshot.meta.processedCursor['dev-peer']).toBe(2)
      expect(snapshot.meta.cursorSnapshotRevision['dev-peer']).toBe(snapshot.meta.revision)
      expect(snapshot.taskExecutions['2025-10-01'].map((e: { instanceId: string }) => e.instanceId))
        .toContain('inst-peer-2')

      const second = await reconciler.reconcilePendingDeltas()
      expect(second.processedEntries).toBe(0)

      snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snapshot.meta.processedCursor['dev-peer']).toBe(2)
      expect(snapshot.taskExecutions['2025-10-01'].map((e: { instanceId: string }) => e.instanceId))
        .toContain('inst-peer-2')
    })

    test('month-level no-op replay should align cache-safe non-replay CSR on normalization write', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            {
              instanceId: 'inst-target',
              taskId: 'tc-inst-target',
              taskTitle: 'Task inst-target',
              taskPath: 'TASKS/inst-target.md',
              durationSec: 600,
              stopTime: '10:00',
              entryId: 'dev-target:1',
              deviceId: 'dev-target',
              recordedAt: '2025-10-01T09:00:00Z',
            },
            {
              instanceId: 'inst-cache',
              taskId: 'tc-inst-cache',
              taskTitle: 'Task inst-cache',
              taskPath: 'TASKS/inst-cache.md',
              durationSec: 600,
              stopTime: '10:00',
              entryId: 'dev-cache:1',
              deviceId: 'dev-cache',
              recordedAt: '2025-10-01T09:10:00Z',
            },
          ],
        },
        dailySummary: {
          '2025-10-01': { totalMinutes: 20, completedTasks: 2, totalTasks: 2, procrastinatedTasks: 0, completionRate: 1 },
        },
        meta: {
          revision: 9,
          processedCursor: { 'dev-target': 1, 'dev-cache': 1, 'dev-empty': 2 },
          cursorSnapshotRevision: { 'dev-target': 8, 'dev-cache': 8, 'dev-empty': 9 },
        },
      })

      const targetRecords = [
        makeDelta('dev-target', 'dev-target:1', '2025-10-01', 'inst-target', '2025-10-01T09:00:00Z'),
      ]
      const cacheRecords = [
        makeDelta('dev-cache', 'dev-cache:1', '2025-10-01', 'inst-cache', '2025-10-01T09:10:00Z'),
      ]

      seedDeltaFile(abstractStore, deltaStore, 'dev-target', '2025-10', targetRecords)
      seedDeltaFile(abstractStore, deltaStore, 'dev-cache', '2025-10', cacheRecords)
      seedDeltaFile(abstractStore, deltaStore, 'dev-empty', '2025-10', [])

      const reconciler = new LogReconciler(plugin)
      const reconcilerAny = reconciler as unknown as {
        noOpCsrCache: Map<string, { revision: number; recordsLength: number; recordsSignature: string; snapshotSignature: string }>
        computeDeltaRecordsSignature: (records: unknown[]) => string
        computeSnapshotSignature: (taskExecutions: unknown, dailySummary: unknown) => string
      }
      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      reconcilerAny.noOpCsrCache.set('2025-10:dev-cache', {
        revision: 9,
        recordsLength: cacheRecords.length,
        recordsSignature: reconcilerAny.computeDeltaRecordsSignature(cacheRecords),
        snapshotSignature: reconcilerAny.computeSnapshotSignature(snapshot.taskExecutions, snapshot.dailySummary),
      })

      const stats = await reconciler.reconcilePendingDeltas()
      expect(stats.processedEntries).toBe(0)

      const after = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(after.meta.revision).toBe(10)
      expect(after.meta.processedCursor['dev-empty']).toBe(0)
      expect(after.meta.cursorSnapshotRevision['dev-cache']).toBe(10)
    })

    test('incremental fold should be source-order independent for conflicting upserts', async () => {
      const runScenario = async (deviceOrder: ['dev-new', 'dev-old'] | ['dev-old', 'dev-new']) => {
        const { plugin, store, deltaStore, abstractStore } = createPluginStub()

        seedSnapshot(store, abstractStore, '2025-10', {
          taskExecutions: {},
          dailySummary: {},
          meta: {
            revision: 10,
            processedCursor: { 'dev-new': 0, 'dev-old': 0 },
            cursorSnapshotRevision: { 'dev-new': 10, 'dev-old': 10 },
          },
        })

        const byDevice = {
          'dev-old': [
            {
              schemaVersion: 1,
              op: 'upsert',
              entryId: 'dev-old:1',
              deviceId: 'dev-old',
              monthKey: '2025-10',
              dateKey: '2025-10-01',
              recordedAt: '2025-10-01T09:00:00.000Z',
              payload: {
                instanceId: 'inst-conflict',
                taskId: 'tc-inst-conflict',
                taskTitle: 'Task inst-conflict',
                taskPath: 'TASKS/older.md',
                durationSec: 300,
                stopTime: '09:05',
              },
            },
          ],
          'dev-new': [
            {
              schemaVersion: 1,
              op: 'upsert',
              entryId: 'dev-new:1',
              deviceId: 'dev-new',
              monthKey: '2025-10',
              dateKey: '2025-10-01',
              recordedAt: '2025-10-01T10:00:00.000Z',
              payload: {
                instanceId: 'inst-conflict',
                taskId: 'tc-inst-conflict',
                taskTitle: 'Task inst-conflict',
                taskPath: 'TASKS/newer.md',
                durationSec: 600,
                stopTime: '10:10',
              },
            },
          ],
        } as const

        for (const deviceId of deviceOrder) {
          seedDeltaFile(abstractStore, deltaStore, deviceId, '2025-10', byDevice[deviceId])
        }

        const reconciler = new LogReconciler(plugin)
        await reconciler.reconcilePendingDeltas()
        const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
        return snapshot.taskExecutions['2025-10-01'][0].taskPath
      }

      const newerFirst = await runScenario(['dev-new', 'dev-old'])
      const olderFirst = await runScenario(['dev-old', 'dev-new'])

      expect(newerFirst).toBe('TASKS/newer.md')
      expect(olderFirst).toBe('TASKS/newer.md')
    })

    test('fold should prefer delete when upsert/delete share identical ordering key', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {},
        dailySummary: {},
        meta: {
          revision: 5,
          processedCursor: { 'dev-alpha': 0 },
          cursorSnapshotRevision: { 'dev-alpha': 5 },
        },
      })

      seedDeltaFile(abstractStore, deltaStore, 'dev-alpha', '2025-10', [
        {
          schemaVersion: 1,
          op: 'delete',
          entryId: 'dev-alpha:same',
          deviceId: 'dev-alpha',
          monthKey: '2025-10',
          dateKey: '2025-10-01',
          recordedAt: '2025-10-01T08:30:00.000Z',
          payload: { instanceId: 'inst-same', taskId: 'tc-inst-same' },
        },
        {
          schemaVersion: 1,
          op: 'upsert',
          entryId: 'dev-alpha:same',
          deviceId: 'dev-alpha',
          monthKey: '2025-10',
          dateKey: '2025-10-01',
          recordedAt: '2025-10-01T08:30:00.000Z',
          payload: {
            instanceId: 'inst-same',
            taskId: 'tc-inst-same',
            taskTitle: 'Task inst-same',
            taskPath: 'TASKS/inst-same.md',
            durationSec: 300,
            stopTime: '08:35',
          },
        },
      ])

      const reconciler = new LogReconciler(plugin)
      await reconciler.reconcilePendingDeltas()

      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snapshot.taskExecutions['2025-10-01'] ?? []).toHaveLength(0)
    })

    test('cursor reset on shrunk delta should not roll back newer snapshot entry', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            {
              instanceId: 'inst-e112',
              taskId: 'tc-inst-e112',
              taskTitle: 'Task inst-e112',
              taskPath: 'TASKS/newer-path.md',
              durationSec: 900,
              stopTime: '10:37',
              entryId: 'peer:latest',
              deviceId: 'peer',
              recordedAt: '2025-10-01T10:37:41.999Z',
            },
          ],
        },
        dailySummary: {
          '2025-10-01': { totalMinutes: 15, completedTasks: 1, totalTasks: 1, procrastinatedTasks: 0, completionRate: 1 },
        },
        meta: {
          revision: 531,
          processedCursor: { e112: 1215 },
          cursorSnapshotRevision: { e112: 531 },
        },
      })

      // Simulate shrunk stale delta chain (1215 -> 1)
      seedDeltaFile(abstractStore, deltaStore, 'e112', '2025-10', [
        {
          schemaVersion: 1,
          op: 'upsert',
          entryId: 'e112:1',
          deviceId: 'e112',
          monthKey: '2025-10',
          dateKey: '2025-10-01',
          recordedAt: '2025-10-01T10:30:00.000Z',
          payload: {
            instanceId: 'inst-e112',
            taskId: 'tc-inst-e112',
            taskTitle: 'Task inst-e112',
            taskPath: 'TASKS/older-path.md',
            durationSec: 600,
            stopTime: '10:30',
          },
        },
      ])

      const reconciler = new LogReconciler(plugin)
      await reconciler.reconcilePendingDeltas()

      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snapshot.taskExecutions['2025-10-01']).toHaveLength(1)
      // Older replay record must not overwrite newer snapshot content.
      expect(snapshot.taskExecutions['2025-10-01'][0].taskPath).toBe('TASKS/newer-path.md')
      expect(snapshot.taskExecutions['2025-10-01'][0].recordedAt).toBe('2025-10-01T10:37:41.999Z')
    })

    test('Branch 3 should not replay stale terminal upsert when peer delete is newer', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            {
              instanceId: 'inst-1',
              taskId: 'tc-inst-1',
              taskTitle: 'Task inst-1',
              taskPath: 'TASKS/inst-1.md',
              durationSec: 600,
              stopTime: '10:00',
              entryId: 'zz-upsert:1',
              deviceId: 'zz-upsert',
              recordedAt: '2025-10-01T09:00:00Z',
            },
          ],
        },
        dailySummary: {
          '2025-10-01': { totalMinutes: 10, completedTasks: 1, totalTasks: 1, procrastinatedTasks: 0, completionRate: 1 },
        },
        meta: {
          revision: 2,
          processedCursor: { 'aa-delete': 0, 'zz-upsert': 1 },
          cursorSnapshotRevision: { 'aa-delete': 2, 'zz-upsert': 2 },
        },
      })

      // Ensure source order: aa-delete first, zz-upsert second
      seedDeltaFile(abstractStore, deltaStore, 'aa-delete', '2025-10', [
        {
          schemaVersion: 1,
          op: 'delete',
          entryId: 'aa-delete:1',
          deviceId: 'aa-delete',
          monthKey: '2025-10',
          dateKey: '2025-10-01',
          recordedAt: '2025-10-01T11:00:00Z',
          payload: { instanceId: 'inst-1', taskId: 'tc-inst-1' },
        },
      ])
      seedDeltaFile(abstractStore, deltaStore, 'zz-upsert', '2025-10', [
        makeDelta('zz-upsert', 'zz-upsert:1', '2025-10-01', 'inst-1', '2025-10-01T09:00:00Z'),
      ])

      const reconciler = new LogReconciler(plugin)
      const stats = await reconciler.reconcilePendingDeltas()

      expect(stats.processedEntries).toBe(1)
      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snapshot.taskExecutions['2025-10-01'] ?? []).toHaveLength(0)
      expect(snapshot.meta.revision).toBe(3)
    })

    test('month write should align CSR for EOF-skipped source to avoid stale full replay', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            {
              instanceId: 'inst-1',
              taskId: 'tc-inst-1',
              taskTitle: 'Task inst-1',
              taskPath: 'TASKS/inst-1.md',
              durationSec: 600,
              stopTime: '10:00',
              entryId: 'dev-a:1',
              deviceId: 'dev-a',
              recordedAt: '2025-10-01T09:00:00Z',
            },
          ],
        },
        dailySummary: {
          '2025-10-01': { totalMinutes: 10, completedTasks: 1, totalTasks: 1, procrastinatedTasks: 0, completionRate: 1 },
        },
        meta: {
          revision: 5,
          processedCursor: { 'dev-a': 1, 'dev-b': 0 },
          cursorSnapshotRevision: { 'dev-a': 5, 'dev-b': 5 },
        },
      })

      // dev-a is EOF skip candidate, dev-b writes delete
      seedDeltaFile(abstractStore, deltaStore, 'dev-a', '2025-10', [
        makeDelta('dev-a', 'dev-a:1', '2025-10-01', 'inst-1', '2025-10-01T09:00:00Z'),
      ])
      seedDeltaFile(abstractStore, deltaStore, 'dev-b', '2025-10', [
        {
          schemaVersion: 1,
          op: 'delete',
          entryId: 'dev-b:1',
          deviceId: 'dev-b',
          monthKey: '2025-10',
          dateKey: '2025-10-01',
          recordedAt: '2025-10-01T11:00:00Z',
          payload: { instanceId: 'inst-1', taskId: 'tc-inst-1' },
        },
      ])

      const reconciler = new LogReconciler(plugin)
      const first = await reconciler.reconcilePendingDeltas()
      expect(first.processedEntries).toBe(1)

      const afterFirst = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(afterFirst.taskExecutions['2025-10-01'] ?? []).toHaveLength(0)
      expect(afterFirst.meta.cursorSnapshotRevision['dev-a']).toBe(afterFirst.meta.revision)

      const second = await reconciler.reconcilePendingDeltas()
      expect(second.processedEntries).toBe(0)
      const afterSecond = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(afterSecond.meta.revision).toBe(afterFirst.meta.revision)
      expect(afterSecond.taskExecutions['2025-10-01'] ?? []).toHaveLength(0)
    })

    test('Branch 1 complete skip + another source writes → skip device CSR/cursor aligned', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            { instanceId: 'inst-1', taskId: 'tc-inst-1', taskTitle: 'Task inst-1', taskPath: 'TASKS/inst-1.md', durationSec: 600, stopTime: '10:00',
              entryId: 'dev-pc:1', deviceId: 'dev-pc', recordedAt: '2025-10-01T08:00:00Z' },
          ],
        },
        dailySummary: { '2025-10-01': { totalMinutes: 10, completedTasks: 1, totalTasks: 1, procrastinatedTasks: 0, completionRate: 1 } },
        meta: {
          revision: 2,
          processedCursor: { 'dev-pc': 1 },
        },
      })

      // PC: 1 record (will be no-op)
      seedDeltaFile(abstractStore, deltaStore, 'dev-pc', '2025-10', [
        makeDelta('dev-pc', 'dev-pc:1', '2025-10-01', 'inst-1', '2025-10-01T08:00:00Z'),
      ])

      const reconciler = new LogReconciler(plugin)
      // 1st: bootstrap full replay for PC → no-op → cached
      await reconciler.reconcilePendingDeltas()

      // Add phone delta
      seedDeltaFile(abstractStore, deltaStore, 'dev-phone', '2025-10', [
        makeDelta('dev-phone', 'dev-phone:1', '2025-10-01', 'inst-phone-1', '2025-10-01T11:00:00Z'),
      ])

      // 2nd: PC cache hit → skip; Phone has new record → write
      const stats2 = await reconciler.reconcilePendingDeltas()
      expect(stats2.processedEntries).toBe(1)

      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      // PC CSR should be aligned to the new revision
      expect(snapshot.meta.cursorSnapshotRevision['dev-pc']).toBe(snapshot.meta.revision)
      // PC processedCursor should also be preserved
      expect(snapshot.meta.processedCursor['dev-pc']).toBe(1)
    })

    test('incremental write should align CSR/cursor for pending + cache-skip + EOF-skip devices together', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2025-10', {
        taskExecutions: {
          '2025-10-01': [
            {
              instanceId: 'inst-noop',
              taskId: 'tc-inst-noop',
              taskTitle: 'Task inst-noop',
              taskPath: 'TASKS/inst-noop.md',
              durationSec: 600,
              stopTime: '10:00',
              entryId: 'dev-noop:1',
              deviceId: 'dev-noop',
              recordedAt: '2025-10-01T09:00:00Z',
            },
            {
              instanceId: 'inst-eof',
              taskId: 'tc-inst-eof',
              taskTitle: 'Task inst-eof',
              taskPath: 'TASKS/inst-eof.md',
              durationSec: 600,
              stopTime: '10:00',
              entryId: 'dev-eof:1',
              deviceId: 'dev-eof',
              recordedAt: '2025-10-01T09:10:00Z',
            },
          ],
        },
        dailySummary: {
          '2025-10-01': { totalMinutes: 20, completedTasks: 2, totalTasks: 2, procrastinatedTasks: 0, completionRate: 1 },
        },
        meta: {
          revision: 2,
          processedCursor: { 'dev-noop': 1, 'dev-eof': 1, 'dev-write': 0 },
          cursorSnapshotRevision: { 'dev-noop': 1, 'dev-eof': 2, 'dev-write': 2 },
        },
      })

      // 1st run: dev-noop CSR mismatch -> month replay no-op -> cache warm only
      seedDeltaFile(abstractStore, deltaStore, 'dev-noop', '2025-10', [
        makeDelta('dev-noop', 'dev-noop:1', '2025-10-01', 'inst-noop', '2025-10-01T09:00:00Z'),
      ])

      const reconciler = new LogReconciler(plugin)
      const warmup = await reconciler.reconcilePendingDeltas()
      expect(warmup.processedEntries).toBe(0)

      // 2nd run:
      // - dev-noop: cache-hit complete skip
      // - dev-eof: no cache + cursor at EOF -> EOF skip
      // - dev-write: new record -> pending write
      seedDeltaFile(abstractStore, deltaStore, 'dev-eof', '2025-10', [
        makeDelta('dev-eof', 'dev-eof:1', '2025-10-01', 'inst-eof', '2025-10-01T09:10:00Z'),
      ])
      seedDeltaFile(abstractStore, deltaStore, 'dev-write', '2025-10', [
        makeDelta('dev-write', 'dev-write:1', '2025-10-01', 'inst-write', '2025-10-01T11:00:00Z'),
      ])

      const stats = await reconciler.reconcilePendingDeltas()
      expect(stats.processedEntries).toBe(1)

      const snapshot = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
      expect(snapshot.meta.revision).toBe(3)
      expect(snapshot.meta.cursorSnapshotRevision['dev-noop']).toBe(3)
      expect(snapshot.meta.cursorSnapshotRevision['dev-eof']).toBe(3)
      expect(snapshot.meta.cursorSnapshotRevision['dev-write']).toBe(3)
      expect(snapshot.meta.processedCursor['dev-noop']).toBe(1)
      expect(snapshot.meta.processedCursor['dev-eof']).toBe(1)
      expect(snapshot.meta.processedCursor['dev-write']).toBe(1)
      expect(snapshot.taskExecutions['2025-10-01']).toHaveLength(3)
    })
  })
})

describe('LogReconciler CSR (cursorSnapshotRevision)', () => {
  test('sets cursorSnapshotRevision after successful write', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2025-10', [
      {
        schemaVersion: 1, op: 'upsert', entryId: 'a:1', deviceId: 'device-alpha',
        monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T08:00:00Z',
        payload: { instanceId: 'i1', taskId: 't1', taskTitle: 'T1', durationSec: 600, stopTime: '08:10' },
      },
    ])
    seedSnapshot(store, abstractStore, '2025-10', {
      taskExecutions: {}, dailySummary: {},
      meta: { revision: 0, processedCursor: {} },
    })

    const reconciler = new LogReconciler(plugin)
    await reconciler.reconcilePendingDeltas()

    const snap = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
    expect(snap.meta.cursorSnapshotRevision).toBeDefined()
    expect(snap.meta.cursorSnapshotRevision['device-alpha']).toBe(1) // revision 0 → write → nextRevision=1
  })

  test('CSR match + cursor at end → normal skip (no write)', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2025-10', [
      {
        schemaVersion: 1, op: 'upsert', entryId: 'a:1', deviceId: 'device-alpha',
        monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T08:00:00Z',
        payload: { instanceId: 'i1', taskId: 't1', taskTitle: 'T1', durationSec: 600, stopTime: '08:10' },
      },
    ])
    seedSnapshot(store, abstractStore, '2025-10', {
      taskExecutions: {
        '2025-10-01': [{ instanceId: 'i1', taskId: 't1', taskTitle: 'T1', durationSec: 600, stopTime: '08:10', entryId: 'a:1', deviceId: 'device-alpha', recordedAt: '2025-10-01T08:00:00Z' }],
      },
      dailySummary: { '2025-10-01': { totalMinutes: 10, totalTasks: 1, completedTasks: 1, procrastinatedTasks: 0, completionRate: 1 } },
      meta: { revision: 5, processedCursor: { 'device-alpha': 1 }, cursorSnapshotRevision: { 'device-alpha': 5 } },
    })

    const reconciler = new LogReconciler(plugin)
    const stats = await reconciler.reconcilePendingDeltas()

    expect(stats.processedEntries).toBe(0)
    const snap = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
    expect(snap.meta.revision).toBe(5) // unchanged
  })

  test('CSR mismatch + entries missing → full replay restores entries', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    // Delta has 2 entries
    seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2025-10', [
      {
        schemaVersion: 1, op: 'upsert', entryId: 'a:1', deviceId: 'device-alpha',
        monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T08:00:00Z',
        payload: { instanceId: 'i1', taskId: 't1', taskTitle: 'T1', durationSec: 600, stopTime: '08:10' },
      },
      {
        schemaVersion: 1, op: 'upsert', entryId: 'a:2', deviceId: 'device-alpha',
        monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T09:00:00Z',
        payload: { instanceId: 'i2', taskId: 't2', taskTitle: 'T2', durationSec: 1200, stopTime: '09:20' },
      },
    ])
    // Snapshot has cursor=2 (all processed) but revision mismatch, and only 1 entry (simulating external overwrite)
    seedSnapshot(store, abstractStore, '2025-10', {
      taskExecutions: {
        '2025-10-01': [{ instanceId: 'i1', taskId: 't1', taskTitle: 'T1', durationSec: 600, stopTime: '08:10', entryId: 'a:1', deviceId: 'device-alpha', recordedAt: '2025-10-01T08:00:00Z' }],
      },
      dailySummary: { '2025-10-01': { totalMinutes: 10, totalTasks: 1, completedTasks: 1, procrastinatedTasks: 0, completionRate: 1 } },
      meta: { revision: 3, processedCursor: { 'device-alpha': 2 }, cursorSnapshotRevision: { 'device-alpha': 2 } },
    })

    const reconciler = new LogReconciler(plugin)
    const stats = await reconciler.reconcilePendingDeltas()

    expect(stats.processedEntries).toBeGreaterThan(0)
    const snap = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
    expect(snap.taskExecutions['2025-10-01']).toHaveLength(2)
    expect(snap.meta.revision).toBe(4)
  })

  test('CSR mismatch + all entries present (no-op) → write suppressed', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2025-10', [
      {
        schemaVersion: 1, op: 'upsert', entryId: 'a:1', deviceId: 'device-alpha',
        monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T08:00:00Z',
        payload: { instanceId: 'i1', taskId: 't1', taskTitle: 'T1', durationSec: 600, stopTime: '08:10' },
      },
    ])
    // Snapshot has the same entry but CSR is stale (simulating another device wrote same data)
    seedSnapshot(store, abstractStore, '2025-10', {
      taskExecutions: {
        '2025-10-01': [{ instanceId: 'i1', taskId: 't1', taskTitle: 'T1', durationSec: 600, stopTime: '08:10', entryId: 'a:1', deviceId: 'device-alpha', recordedAt: '2025-10-01T08:00:00Z' }],
      },
      dailySummary: { '2025-10-01': { totalMinutes: 10, totalTasks: 1, completedTasks: 1, procrastinatedTasks: 0, completionRate: 1 } },
      meta: { revision: 5, processedCursor: { 'device-alpha': 1 }, cursorSnapshotRevision: { 'device-alpha': 3 } },
    })

    const reconciler = new LogReconciler(plugin)
    const stats = await reconciler.reconcilePendingDeltas()

    expect(stats.processedEntries).toBe(0) // no-op → suppressed
    const snap = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
    expect(snap.meta.revision).toBe(5) // unchanged, no write
  })

  test('CSR undefined (bootstrap) + entries present → no-op, then cache prevents re-replay', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2025-10', [
      {
        schemaVersion: 1, op: 'upsert', entryId: 'a:1', deviceId: 'device-alpha',
        monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T08:00:00Z',
        payload: { instanceId: 'i1', taskId: 't1', taskTitle: 'T1', durationSec: 600, stopTime: '08:10' },
      },
    ])
    // No cursorSnapshotRevision (old format migration)
    seedSnapshot(store, abstractStore, '2025-10', {
      taskExecutions: {
        '2025-10-01': [{ instanceId: 'i1', taskId: 't1', taskTitle: 'T1', durationSec: 600, stopTime: '08:10', entryId: 'a:1', deviceId: 'device-alpha', recordedAt: '2025-10-01T08:00:00Z' }],
      },
      dailySummary: { '2025-10-01': { totalMinutes: 10, totalTasks: 1, completedTasks: 1, procrastinatedTasks: 0, completionRate: 1 } },
      meta: { revision: 5, processedCursor: { 'device-alpha': 1 } },
    })

    const reconciler = new LogReconciler(plugin)
    // First run: bootstrap full replay → no-op → cache stored
    const stats1 = await reconciler.reconcilePendingDeltas()
    expect(stats1.processedEntries).toBe(0)
    expect(JSON.parse(store.get('LOGS/2025-10-tasks.json')!).meta.revision).toBe(5)

    // Second run: cache hit → skip replay entirely
    const stats2 = await reconciler.reconcilePendingDeltas()
    expect(stats2.processedEntries).toBe(0)
  })

  test('CSR mismatch + superseded records → no-op detected', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    // R1: create entry E1, R2: update E1 with new data (superseded)
    seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2025-10', [
      {
        schemaVersion: 1, op: 'upsert', entryId: 'a:1', deviceId: 'device-alpha',
        monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T08:00:00Z',
        payload: { instanceId: 'i1', taskId: 't1', taskTitle: 'T1-old', durationSec: 600, stopTime: '08:10' },
      },
      {
        schemaVersion: 1, op: 'upsert', entryId: 'a:2', deviceId: 'device-alpha',
        monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T09:00:00Z',
        payload: { instanceId: 'i1', taskId: 't1', taskTitle: 'T1-new', durationSec: 1200, stopTime: '09:20' },
      },
    ])
    // Snapshot already has the final state (T1-new) but CSR mismatch
    seedSnapshot(store, abstractStore, '2025-10', {
      taskExecutions: {
        '2025-10-01': [{ instanceId: 'i1', taskId: 't1', taskTitle: 'T1-new', durationSec: 1200, stopTime: '09:20', entryId: 'a:2', deviceId: 'device-alpha', recordedAt: '2025-10-01T09:00:00Z' }],
      },
      dailySummary: { '2025-10-01': { totalMinutes: 20, totalTasks: 1, completedTasks: 1, procrastinatedTasks: 0, completionRate: 1 } },
      meta: { revision: 5, processedCursor: { 'device-alpha': 2 }, cursorSnapshotRevision: { 'device-alpha': 3 } },
    })

    const reconciler = new LogReconciler(plugin)
    const stats = await reconciler.reconcilePendingDeltas()
    expect(stats.processedEntries).toBe(0) // no-op: same final state
    expect(JSON.parse(store.get('LOGS/2025-10-tasks.json')!).meta.revision).toBe(5)
  })

  test('CSR mismatch + delete record removes externally-revived entry', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2025-10', [
      {
        schemaVersion: 1, op: 'upsert', entryId: 'a:1', deviceId: 'device-alpha',
        monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T08:00:00Z',
        payload: { instanceId: 'i1', taskId: 't1', taskTitle: 'T1', durationSec: 600, stopTime: '08:10' },
      },
      {
        schemaVersion: 1, op: 'delete', entryId: 'a:2', deviceId: 'device-alpha',
        monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T09:00:00Z',
        payload: { instanceId: 'i1', taskId: 't1' },
      },
    ])
    // Snapshot has the entry revived (external overwrite) and CSR mismatch
    seedSnapshot(store, abstractStore, '2025-10', {
      taskExecutions: {
        '2025-10-01': [{ instanceId: 'i1', taskId: 't1', taskTitle: 'T1', durationSec: 600, stopTime: '08:10', entryId: 'a:1', deviceId: 'device-alpha', recordedAt: '2025-10-01T08:00:00Z' }],
      },
      dailySummary: { '2025-10-01': { totalMinutes: 10, totalTasks: 1, completedTasks: 1 } },
      meta: { revision: 3, processedCursor: { 'device-alpha': 2 }, cursorSnapshotRevision: { 'device-alpha': 1 } },
    })

    const reconciler = new LogReconciler(plugin)
    const stats = await reconciler.reconcilePendingDeltas()

    expect(stats.processedEntries).toBeGreaterThan(0)
    const snap = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
    // The entry should be deleted after full replay
    expect(snap.taskExecutions['2025-10-01'] ?? []).toHaveLength(0)
  })

  test('same entryId + content diff (renameTaskPath) → write triggered', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2025-10', [
      {
        schemaVersion: 1, op: 'upsert', entryId: 'a:1', deviceId: 'device-alpha',
        monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T08:00:00Z',
        payload: { instanceId: 'i1', taskId: 't1', taskTitle: 'T1', taskPath: 'TASKS/new-path.md', durationSec: 600, stopTime: '08:10' },
      },
    ])
    // Snapshot has old taskPath but CSR mismatch
    seedSnapshot(store, abstractStore, '2025-10', {
      taskExecutions: {
        '2025-10-01': [{ instanceId: 'i1', taskId: 't1', taskTitle: 'T1', taskPath: 'TASKS/old-path.md', durationSec: 600, stopTime: '08:10', entryId: 'a:1', deviceId: 'device-alpha', recordedAt: '2025-10-01T08:00:00Z' }],
      },
      dailySummary: { '2025-10-01': { totalMinutes: 10, totalTasks: 1, completedTasks: 1 } },
      meta: { revision: 3, processedCursor: { 'device-alpha': 1 }, cursorSnapshotRevision: { 'device-alpha': 2 } },
    })

    const reconciler = new LogReconciler(plugin)
    const stats = await reconciler.reconcilePendingDeltas()

    expect(stats.processedEntries).toBeGreaterThan(0)
    const snap = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
    expect(snap.taskExecutions['2025-10-01'][0].taskPath).toBe('TASKS/new-path.md')
    expect(snap.meta.revision).toBe(4)
  })

  test('no-op source + another source writes → no-op source CSR aligned to nextRevision', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    // Device alpha: all processed, CSR mismatch → will be no-op
    seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2025-10', [
      {
        schemaVersion: 1, op: 'upsert', entryId: 'a:1', deviceId: 'device-alpha',
        monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T08:00:00Z',
        payload: { instanceId: 'i1', taskId: 't1', taskTitle: 'T1', durationSec: 600, stopTime: '08:10' },
      },
    ])
    // Device beta: new entry to write
    seedDeltaFile(abstractStore, deltaStore, 'device-beta', '2025-10', [
      {
        schemaVersion: 1, op: 'upsert', entryId: 'b:1', deviceId: 'device-beta',
        monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T10:00:00Z',
        payload: { instanceId: 'i2', taskId: 't2', taskTitle: 'T2', durationSec: 900, stopTime: '10:15' },
      },
    ])
    seedSnapshot(store, abstractStore, '2025-10', {
      taskExecutions: {
        '2025-10-01': [{ instanceId: 'i1', taskId: 't1', taskTitle: 'T1', durationSec: 600, stopTime: '08:10', entryId: 'a:1', deviceId: 'device-alpha', recordedAt: '2025-10-01T08:00:00Z' }],
      },
      dailySummary: { '2025-10-01': { totalMinutes: 10, totalTasks: 1, completedTasks: 1, procrastinatedTasks: 0, completionRate: 1 } },
      meta: { revision: 3, processedCursor: { 'device-alpha': 1 }, cursorSnapshotRevision: { 'device-alpha': 2 } },
    })

    const reconciler = new LogReconciler(plugin)
    await reconciler.reconcilePendingDeltas()

    const snap = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
    // Both devices' CSR should be aligned to nextRevision (4)
    expect(snap.meta.cursorSnapshotRevision['device-alpha']).toBe(4)
    expect(snap.meta.cursorSnapshotRevision['device-beta']).toBe(4)
    // No-op source's processedCursor should also be aligned
    expect(snap.meta.processedCursor['device-alpha']).toBe(1)
    expect(snap.meta.processedCursor['device-beta']).toBe(1)
  })

  test('CSR mismatch + startIndex < records.length → full replay restores past entries too', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    // 3 records: device has only processed 2, but snapshot is missing entry from record 1
    seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2025-10', [
      {
        schemaVersion: 1, op: 'upsert', entryId: 'a:1', deviceId: 'device-alpha',
        monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T08:00:00Z',
        payload: { instanceId: 'i1', taskId: 't1', taskTitle: 'T1', durationSec: 600, stopTime: '08:10' },
      },
      {
        schemaVersion: 1, op: 'upsert', entryId: 'a:2', deviceId: 'device-alpha',
        monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T09:00:00Z',
        payload: { instanceId: 'i2', taskId: 't2', taskTitle: 'T2', durationSec: 900, stopTime: '09:15' },
      },
      {
        schemaVersion: 1, op: 'upsert', entryId: 'a:3', deviceId: 'device-alpha',
        monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T10:00:00Z',
        payload: { instanceId: 'i3', taskId: 't3', taskTitle: 'T3', durationSec: 300, stopTime: '10:05' },
      },
    ])
    // Cursor=2 (2 processed), but snapshot missing i2 (external overwrite stripped it) + CSR mismatch
    seedSnapshot(store, abstractStore, '2025-10', {
      taskExecutions: {
        '2025-10-01': [
          { instanceId: 'i1', taskId: 't1', taskTitle: 'T1', durationSec: 600, stopTime: '08:10', entryId: 'a:1', deviceId: 'device-alpha', recordedAt: '2025-10-01T08:00:00Z' },
        ],
      },
      dailySummary: { '2025-10-01': { totalMinutes: 10, totalTasks: 1, completedTasks: 1 } },
      meta: { revision: 3, processedCursor: { 'device-alpha': 2 }, cursorSnapshotRevision: { 'device-alpha': 1 } },
    })

    const reconciler = new LogReconciler(plugin)
    await reconciler.reconcilePendingDeltas()

    const snap = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
    // All 3 entries should be present: i1 (past, restored), i2 (past, restored), i3 (new)
    expect(snap.taskExecutions['2025-10-01']).toHaveLength(3)
    expect(snap.taskExecutions['2025-10-01'].map((e: { instanceId: string }) => e.instanceId).sort()).toEqual(['i1', 'i2', 'i3'])
  })

  test('summary-only diff (totalTasks change) triggers write', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2025-10', [
      {
        schemaVersion: 1, op: 'summary', entryId: 'a:s1', deviceId: 'device-alpha',
        monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T10:00:00Z',
        payload: { summary: { totalTasks: 5 } },
      },
    ])
    // Snapshot has totalTasks=3 but CSR mismatch
    seedSnapshot(store, abstractStore, '2025-10', {
      taskExecutions: {},
      dailySummary: { '2025-10-01': { totalTasks: 3, totalTasksRecordedAt: '2025-10-01T08:00:00Z', totalTasksDeviceId: 'device-alpha', totalTasksEntryId: 'a:s0' } },
      meta: { revision: 3, processedCursor: { 'device-alpha': 1 }, cursorSnapshotRevision: { 'device-alpha': 2 } },
    })

    const reconciler = new LogReconciler(plugin)
    const stats = await reconciler.reconcilePendingDeltas()

    expect(stats.processedEntries).toBeGreaterThan(0)
    const snap = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
    expect(snap.dailySummary['2025-10-01'].totalTasks).toBe(5)
    expect(snap.meta.revision).toBe(4)
  })

  test('summary metadata-only diff (same numbers, different LWW meta) triggers write', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2025-10', [
      {
        schemaVersion: 1, op: 'summary', entryId: 'a:s2', deviceId: 'device-alpha',
        monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T12:00:00Z',
        payload: { summary: { totalTasks: 5 } },
      },
    ])
    // Snapshot has same totalTasks=5 but older LWW meta + CSR mismatch
    seedSnapshot(store, abstractStore, '2025-10', {
      taskExecutions: {},
      dailySummary: { '2025-10-01': { totalTasks: 5, totalTasksRecordedAt: '2025-10-01T08:00:00Z', totalTasksDeviceId: 'device-alpha', totalTasksEntryId: 'a:s1' } },
      meta: { revision: 3, processedCursor: { 'device-alpha': 1 }, cursorSnapshotRevision: { 'device-alpha': 2 } },
    })

    const reconciler = new LogReconciler(plugin)
    const stats = await reconciler.reconcilePendingDeltas()

    // LWW meta differs → snapshot signature differs → write
    expect(stats.processedEntries).toBeGreaterThan(0)
    const snap = JSON.parse(store.get('LOGS/2025-10-tasks.json')!)
    expect(snap.dailySummary['2025-10-01'].totalTasksRecordedAt).toBe('2025-10-01T12:00:00Z')
  })

  test('ping-pong convergence: 2 devices settle in at most 1 write', async () => {
    const { plugin, store, deltaStore, abstractStore } = createPluginStub()
    // Two devices, each with a distinct entry (different instanceIds)
    seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2025-10', [
      {
        schemaVersion: 1, op: 'upsert', entryId: 'a:1', deviceId: 'device-alpha',
        monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T08:00:00Z',
        payload: { instanceId: 'i1', taskId: 't1', taskTitle: 'T1', durationSec: 600, stopTime: '08:10' },
      },
    ])
    seedDeltaFile(abstractStore, deltaStore, 'device-beta', '2025-10', [
      {
        schemaVersion: 1, op: 'upsert', entryId: 'b:1', deviceId: 'device-beta',
        monthKey: '2025-10', dateKey: '2025-10-01', recordedAt: '2025-10-01T09:00:00Z',
        payload: { instanceId: 'i2', taskId: 't2', taskTitle: 'T2', durationSec: 900, stopTime: '09:15' },
      },
    ])
    // Snapshot already has both entries, but alpha's CSR is stale (simulating external overwrite)
    seedSnapshot(store, abstractStore, '2025-10', {
      taskExecutions: {
        '2025-10-01': [
          { instanceId: 'i1', taskId: 't1', taskTitle: 'T1', durationSec: 600, stopTime: '08:10', entryId: 'a:1', deviceId: 'device-alpha', recordedAt: '2025-10-01T08:00:00Z' },
          { instanceId: 'i2', taskId: 't2', taskTitle: 'T2', durationSec: 900, stopTime: '09:15', entryId: 'b:1', deviceId: 'device-beta', recordedAt: '2025-10-01T09:00:00Z' },
        ],
      },
      dailySummary: { '2025-10-01': { totalMinutes: 25, totalTasks: 2, completedTasks: 2, procrastinatedTasks: 0, completionRate: 1 } },
      meta: { revision: 3, processedCursor: { 'device-alpha': 1, 'device-beta': 1 }, cursorSnapshotRevision: { 'device-alpha': 2, 'device-beta': 3 } },
    })

    const reconciler = new LogReconciler(plugin)
    // 1st reconcile: alpha CSR mismatch → full replay → no-op (all entries present)
    //                beta CSR match + cursor at end → normal skip
    await reconciler.reconcilePendingDeltas()
    const rev1 = JSON.parse(store.get('LOGS/2025-10-tasks.json')!).meta.revision

    // Second reconcile should be no-op (converged via cache)
    const stats2 = await reconciler.reconcilePendingDeltas()
    const rev2 = JSON.parse(store.get('LOGS/2025-10-tasks.json')!).meta.revision

    expect(rev2).toBe(rev1) // No additional writes
    expect(stats2.processedEntries).toBe(0)
  })
})
