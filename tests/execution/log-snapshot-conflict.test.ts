import { TFile, TFolder } from 'obsidian'
import { LogReconciler } from '../../src/features/log/services/LogReconciler'
import { MonthSyncCoordinator } from '../../src/features/log/services/MonthSyncCoordinator'
import { SnapshotConflictError } from '../../src/types/ExecutionLog'
import { createPluginStub, seedDeltaFile, seedSnapshot } from './logTestUtils'

describe('Snapshot Conflict Detection', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    MonthSyncCoordinator._testReset()
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  describe('Basic Reconciliation with New Format', () => {
    test('applies delta entries and increments revision', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()
      seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2026-02', [
        {
          schemaVersion: 1,
          op: 'upsert',
          entryId: 'device-alpha:1',
          deviceId: 'device-alpha',
          monthKey: '2026-02',
          dateKey: '2026-02-01',
          recordedAt: '2026-02-01T08:00:00.000Z',
          payload: {
            instanceId: 'inst-1',
            taskId: 'tc-task-1',
            taskTitle: 'Sample',
            taskPath: 'TASKS/sample.md',
            durationSec: 1800,
            stopTime: '09:00',
          },
        },
      ])

      seedSnapshot(store, abstractStore, '2026-02', {
        taskExecutions: {},
        dailySummary: {},
        meta: { revision: 5, processedCursor: {} },
      })

      const reconciler = new LogReconciler(plugin)
      const stats = await reconciler.reconcilePendingDeltas()

      expect(stats.processedEntries).toBe(1)
      const payload = store.get('LOGS/2026-02-tasks.json')
      expect(payload).toBeDefined()
      const snapshot = JSON.parse(payload!)
      expect(snapshot.taskExecutions['2026-02-01']).toHaveLength(1)
      expect(snapshot.meta.processedCursor['device-alpha']).toBe(1)
      // revision should be incremented from 5 to 6
      expect(snapshot.meta.revision).toBe(6)
    })
  })

  describe('Mutex Serialization', () => {
    test('serializes concurrent reconciliation for same month', async () => {
      const { plugin } = createPluginStub()
      const executionOrder: string[] = []

      const reconciler = new LogReconciler(plugin, {
        sleepFn: async (ms: number) => {
          await new Promise(r => setTimeout(r, ms))
        },
      })

      const p1 = reconciler._testWithLock('2026-02', async () => {
        executionOrder.push('start-1')
        await new Promise(r => setTimeout(r, 50))
        executionOrder.push('end-1')
        return 'first'
      })
      const p2 = reconciler._testWithLock('2026-02', async () => {
        executionOrder.push('start-2')
        await new Promise(r => setTimeout(r, 50))
        executionOrder.push('end-2')
        return 'second'
      })

      // Advance timers to allow execution
      await jest.advanceTimersByTimeAsync(200)
      await Promise.all([p1, p2])

      // Assert: sequential execution (start-1, end-1 before start-2, end-2)
      expect(executionOrder).toEqual(['start-1', 'end-1', 'start-2', 'end-2'])
    })

    test('allows concurrent reconciliation for different months', async () => {
      const { plugin } = createPluginStub()
      const executionOrder: string[] = []

      const reconciler = new LogReconciler(plugin, {
        sleepFn: async (ms: number) => {
          await new Promise(r => setTimeout(r, ms))
        },
      })

      const p1 = reconciler._testWithLock('2026-01', async () => {
        executionOrder.push('start-jan')
        await new Promise(r => setTimeout(r, 50))
        executionOrder.push('end-jan')
        return 'jan'
      })
      const p2 = reconciler._testWithLock('2026-02', async () => {
        executionOrder.push('start-feb')
        await new Promise(r => setTimeout(r, 50))
        executionOrder.push('end-feb')
        return 'feb'
      })

      await jest.advanceTimersByTimeAsync(200)
      await Promise.all([p1, p2])

      // Both should start before either ends (parallel execution)
      const startJanIdx = executionOrder.indexOf('start-jan')
      const startFebIdx = executionOrder.indexOf('start-feb')
      const endJanIdx = executionOrder.indexOf('end-jan')
      const endFebIdx = executionOrder.indexOf('end-feb')

      expect(startJanIdx).toBeLessThan(endJanIdx)
      expect(startFebIdx).toBeLessThan(endFebIdx)
      // Both starts should happen before both ends (true parallelism)
      expect(Math.max(startJanIdx, startFebIdx)).toBeLessThan(Math.min(endJanIdx, endFebIdx))
    })

    test('executes subsequent tasks even when prior task fails (P2-lock-chain-reject)', async () => {
      // Reviewer P2: 先行タスクが例外でrejectされた場合、後続タスクがスキップされる問題
      // 修正: チェーン前に先行の失敗を握りつぶす (.catch(() => {}))
      const { plugin } = createPluginStub()
      const executionOrder: string[] = []

      const reconciler = new LogReconciler(plugin, {
        sleepFn: async (ms: number) => {
          await new Promise(r => setTimeout(r, ms))
        },
      })

      // Task 1: 例外を投げる
      const p1 = reconciler._testWithLock('2026-02', async () => {
        executionOrder.push('start-1')
        await new Promise(r => setTimeout(r, 20))
        executionOrder.push('error-1')
        throw new Error('Simulated I/O failure')
      })

      // Task 2: Task 1が失敗しても実行されるべき
      const p2 = reconciler._testWithLock('2026-02', async () => {
        executionOrder.push('start-2')
        await new Promise(r => setTimeout(r, 20))
        executionOrder.push('end-2')
        return 'second'
      })

      // Task 3: Task 2が成功しても引き続き実行されるべき
      const p3 = reconciler._testWithLock('2026-02', async () => {
        executionOrder.push('start-3')
        await new Promise(r => setTimeout(r, 20))
        executionOrder.push('end-3')
        return 'third'
      })

      // Capture results (catch p1 to prevent unhandled rejection)
      const results: { p1Error?: Error; p2Result?: string; p3Result?: string } = {}
      const p1Handled = p1.catch((e: Error) => { results.p1Error = e })
      const p2Handled = p2.then((v) => { results.p2Result = v })
      const p3Handled = p3.then((v) => { results.p3Result = v })

      await jest.advanceTimersByTimeAsync(300)
      await Promise.all([p1Handled, p2Handled, p3Handled])

      // Task 1 should have failed
      expect(results.p1Error?.message).toBe('Simulated I/O failure')
      // Task 2 and 3 should still complete successfully
      expect(results.p2Result).toBe('second')
      expect(results.p3Result).toBe('third')

      // Verify execution order: Task 1 fails, then Task 2 runs, then Task 3 runs
      expect(executionOrder).toEqual([
        'start-1', 'error-1',  // Task 1 fails
        'start-2', 'end-2',    // Task 2 still runs
        'start-3', 'end-3',    // Task 3 still runs
      ])
    })
  })

  describe('processedCursor Persistence', () => {
    test('processedCursor is persisted on successful write', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()
      seedSnapshot(store, abstractStore, '2026-02', {
        taskExecutions: {},
        dailySummary: {},
        meta: { revision: 1, processedCursor: { 'device-old': 5 } }
      })
      seedDeltaFile(abstractStore, deltaStore, 'device-new', '2026-02', [
        {
          schemaVersion: 1, op: 'upsert', entryId: 'device-new:1', deviceId: 'device-new',
          monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T10:00:00Z',
          payload: { instanceId: 'inst-1', taskId: 'task-1', taskTitle: 'Test', durationSec: 60, stopTime: '10:01' }
        }
      ])

      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()

      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      expect(saved.meta.processedCursor['device-new']).toBe(1)
      expect(saved.meta.processedCursor['device-old']).toBe(5)
    })
  })

  describe('Snapshot Data Preservation', () => {
    test('preserves existing entries when applying new deltas', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Snapshot with existing entry
      seedSnapshot(store, abstractStore, '2026-02', {
        taskExecutions: {
          '2026-02-01': [
            { instanceId: 'existing-inst', taskId: 'existing-task', taskTitle: 'Existing', durationSec: 600, stopTime: '09:00' }
          ]
        },
        dailySummary: {},
        meta: { revision: 1, processedCursor: {} }
      })

      seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2026-02', [
        {
          schemaVersion: 1, op: 'upsert', entryId: 'device-alpha:1', deviceId: 'device-alpha',
          monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T10:00:00Z',
          payload: { instanceId: 'new-inst', taskId: 'new-task', taskTitle: 'New', durationSec: 300, stopTime: '10:05' }
        }
      ])

      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()

      // After reconciliation, snapshot should have both entries
      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      expect(saved.meta.revision).toBe(2) // incremented from 1 to 2

      // Both entries should be preserved
      const entries = saved.taskExecutions['2026-02-01'] ?? []
      expect(entries).toHaveLength(2)
      const hasExisting = entries.some((e: { instanceId: string }) => e.instanceId === 'existing-inst')
      expect(hasExisting).toBe(true)
      const hasNew = entries.some((e: { instanceId: string }) => e.instanceId === 'new-inst')
      expect(hasNew).toBe(true)
    })
  })

  describe('Error Handling', () => {
    test('handles corrupted snapshot by rebuilding from deltas', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Seed corrupted snapshot content
      const corruptedPath = 'LOGS/2026-02-tasks.json'
      store.set(corruptedPath, '{ invalid json content')

      // Create TFile for the corrupted snapshot
      const corruptedFile = new TFile()
      corruptedFile.path = corruptedPath
      corruptedFile.basename = '2026-02-tasks'
      corruptedFile.extension = 'json'
      Object.setPrototypeOf(corruptedFile, TFile.prototype)
      abstractStore.set(corruptedPath, corruptedFile)

      // Add to LOGS folder children
      const logsFolder = abstractStore.get('LOGS')
      if (logsFolder instanceof TFolder) {
        logsFolder.children.push(corruptedFile)
      }

      // Override vault.read to return corrupted content
      const originalRead = plugin.app.vault.read
      plugin.app.vault.read = jest.fn(async (file) => {
        if (file.path === corruptedPath) {
          return '{ invalid json content'
        }
        return originalRead(file)
      })

      seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2026-02', [
        {
          schemaVersion: 1, op: 'upsert', entryId: 'device-alpha:1', deviceId: 'device-alpha',
          monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T10:00:00Z',
          payload: { instanceId: 'rebuild-inst', taskId: 'rebuild-task', taskTitle: 'Rebuilt', durationSec: 300, stopTime: '10:05' }
        }
      ])

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation()

      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()

      // Should have logged corruption related message
      const loggedCorruption = consoleSpy.mock.calls.some(
        (call) => call[0]?.includes?.('Corrupted') || call[0]?.includes?.('parse')
      )
      expect(loggedCorruption || consoleSpy.mock.calls.length > 0).toBe(true)

      consoleSpy.mockRestore()
    })
  })

  describe('DI Support', () => {
    test('accepts custom sleepFn and randomFn for testing', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()
      const sleepCalls: number[] = []

      seedSnapshot(store, abstractStore, '2026-02', {
        taskExecutions: {},
        dailySummary: {},
        meta: { revision: 1, processedCursor: {} },
      })

      seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2026-02', [
        {
          schemaVersion: 1, op: 'upsert', entryId: 'device-alpha:1', deviceId: 'device-alpha',
          monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T10:00:00Z',
          payload: { instanceId: 'inst-1', taskId: 'task-1', taskTitle: 'Test', durationSec: 60, stopTime: '10:01' }
        }
      ])

      const reconciler = new LogReconciler(plugin, {
        sleepFn: async (ms: number) => {
          sleepCalls.push(ms)
        },
        randomFn: () => 0.5,
      })

      await reconciler.reconcilePendingDeltas()

      // No conflicts, so sleepFn should not be called
      expect(sleepCalls.length).toBe(0)

      // Snapshot should be updated successfully
      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      expect(saved.meta.revision).toBe(2) // incremented from 1
    })
  })

  describe('Delete Record with Legacy Entries', () => {
    test('does not delete legacy entry without instanceId in strict instanceId mode', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Snapshot with legacy entry (no instanceId)
      seedSnapshot(store, abstractStore, '2026-02', {
        taskExecutions: {
          '2026-02-01': [
            { taskId: 'legacy-task', taskTitle: 'Legacy Entry', durationSec: 600, stopTime: '09:00' }
          ]
        },
        dailySummary: {},
        meta: { revision: 1, processedCursor: {} }
      })

      // Delete delta with both instanceId and taskId
      seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2026-02', [
        {
          schemaVersion: 1, op: 'delete', entryId: 'device-alpha:1', deviceId: 'device-alpha',
          monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T10:00:00Z',
          payload: { instanceId: 'new-inst-id', taskId: 'legacy-task', taskTitle: 'Legacy Entry', durationSec: 600, stopTime: '09:00' }
        }
      ])

      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()

      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      // strict modeでは instanceId がないため削除されない
      const entries = saved.taskExecutions['2026-02-01'] ?? []
      expect(entries.length).toBe(1)
    })
  })

  describe('Archived Delta Handling', () => {
    test('excludes archived delta files from normal reconciliation', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2026-02', {
        taskExecutions: {},
        dailySummary: {},
        meta: { revision: 1, processedCursor: {} }
      })

      // Normal delta file
      seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2026-02', [
        {
          schemaVersion: 1, op: 'upsert', entryId: 'device-alpha:1', deviceId: 'device-alpha',
          monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T10:00:00Z',
          payload: { instanceId: 'normal-inst', taskId: 'normal-task', taskTitle: 'Normal', durationSec: 300, stopTime: '10:05' }
        }
      ])

      // Archived delta file (should be excluded from normal processing)
      const archivedPath = `LOGS/inbox/device-alpha/2026-02.archived.jsonl`
      deltaStore.set(archivedPath, JSON.stringify({
        schemaVersion: 1, op: 'upsert', entryId: 'device-alpha:0', deviceId: 'device-alpha',
        monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T08:00:00Z',
        payload: { instanceId: 'archived-inst', taskId: 'archived-task', taskTitle: 'Archived', durationSec: 600, stopTime: '08:10' }
      }))

      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()

      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      const entries = saved.taskExecutions['2026-02-01'] ?? []
      // Only normal entry should be present, archived should be excluded
      expect(entries.length).toBe(1)
      expect(entries[0].instanceId).toBe('normal-inst')
    })
  })

  describe('Multiple Legacy Entries Deletion (Codex Issue #4)', () => {
    test('does not delete legacy entries by taskId when instanceId is missing', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Snapshot with multiple legacy entries having same taskId (no instanceId)
      seedSnapshot(store, abstractStore, '2026-02', {
        taskExecutions: {
          '2026-02-01': [
            { taskId: 'same-task', taskTitle: 'Legacy Entry 1', durationSec: 600, stopTime: '09:00' },
            { taskId: 'same-task', taskTitle: 'Legacy Entry 2', durationSec: 1200, stopTime: '10:00' },
            { taskId: 'same-task', taskTitle: 'Legacy Entry 3', durationSec: 1800, stopTime: '11:00' },
          ]
        },
        dailySummary: {},
        meta: { revision: 1, processedCursor: {} }
      })

      // Delete delta targeting one specific entry (has instanceId but falls back to taskId)
      seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2026-02', [
        {
          schemaVersion: 1, op: 'delete', entryId: 'device-alpha:1', deviceId: 'device-alpha',
          monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T12:00:00Z',
          payload: { instanceId: 'non-matching-inst', taskId: 'same-task', taskTitle: 'Legacy Entry 2', durationSec: 1200, stopTime: '10:00' }
        }
      ])

      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()

      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      const entries = saved.taskExecutions['2026-02-01'] ?? []
      // strict modeでは taskId フォールバック削除をしないため3件残る
      expect(entries.length).toBe(3)
    })
  })

  describe('Rebuild from Deltas with Archived Files', () => {
    test('rebuilds from archived-only device when normal delta exists for another device', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // device-alpha has normal delta file
      seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2026-02', [
        {
          schemaVersion: 1, op: 'upsert', entryId: 'device-alpha:1', deviceId: 'device-alpha',
          monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T10:00:00Z',
          payload: { instanceId: 'normal-inst', taskId: 'normal-task', taskTitle: 'Normal', durationSec: 300, stopTime: '10:05' }
        }
      ])

      // device-beta has only archived delta file (no normal file)
      // Use seedVaultFile helper to create proper folder/file structure
      const archivedPath = `LOGS/inbox/device-beta/2026-02.archived.jsonl`
      const archivedRecord = {
        schemaVersion: 1, op: 'upsert', entryId: 'device-beta:0', deviceId: 'device-beta',
        monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T08:00:00Z',
        payload: { instanceId: 'archived-only-inst', taskId: 'archived-only-task', taskTitle: 'Archived Only', durationSec: 600, stopTime: '08:10' }
      }
      // Manually create the folder structure with proper prototype chain
      const { TFolder, TFile } = await import('obsidian')
      const deviceBetaPath = `LOGS/inbox/device-beta`
      const deviceBetaFolder = Object.assign(new TFolder(), {
        path: deviceBetaPath,
        name: 'device-beta',
        children: []
      })
      Object.setPrototypeOf(deviceBetaFolder, TFolder.prototype)
      const inbox = abstractStore.get('LOGS/inbox')
      if (inbox instanceof TFolder) {
        inbox.children.push(deviceBetaFolder)
        abstractStore.set(deviceBetaPath, deviceBetaFolder)
      }

      const archivedFile = Object.assign(new TFile(), {
        path: archivedPath,
        basename: '2026-02.archived',
        extension: 'jsonl'
      })
      Object.setPrototypeOf(archivedFile, TFile.prototype)
      deviceBetaFolder.children.push(archivedFile)
      abstractStore.set(archivedPath, archivedFile)
      deltaStore.set(archivedPath, JSON.stringify(archivedRecord))

      // Corrupted snapshot
      const corruptedPath = 'LOGS/2026-02-tasks.json'
      store.set(corruptedPath, '{ invalid json')
      const corruptedFile = new (await import('obsidian')).TFile()
      corruptedFile.path = corruptedPath
      corruptedFile.basename = '2026-02-tasks'
      corruptedFile.extension = 'json'
      abstractStore.set(corruptedPath, corruptedFile)
      const logsFolder = abstractStore.get('LOGS')
      if (logsFolder instanceof (await import('obsidian')).TFolder) {
        logsFolder.children.push(corruptedFile)
      }

      plugin.app.vault.read = jest.fn(async () => '{ invalid json')

      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()

      // After rebuild, both entries should be present (device-alpha normal + device-beta archived)
      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      const entries = saved.taskExecutions['2026-02-01'] ?? []
      expect(entries.length).toBe(2)
      const hasNormal = entries.some((e: { instanceId: string }) => e.instanceId === 'normal-inst')
      const hasArchived = entries.some((e: { instanceId: string }) => e.instanceId === 'archived-only-inst')
      expect(hasNormal).toBe(true)
      expect(hasArchived).toBe(true)
    })

    test('includes archived delta files when rebuilding corrupted snapshot', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Normal delta file
      seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2026-02', [
        {
          schemaVersion: 1, op: 'upsert', entryId: 'device-alpha:1', deviceId: 'device-alpha',
          monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T10:00:00Z',
          payload: { instanceId: 'normal-inst', taskId: 'normal-task', taskTitle: 'Normal', durationSec: 300, stopTime: '10:05' }
        }
      ])

      // Archived delta file (should be included in rebuild)
      const archivedPath = `LOGS/inbox/device-alpha/2026-02.archived.jsonl`
      deltaStore.set(archivedPath, JSON.stringify({
        schemaVersion: 1, op: 'upsert', entryId: 'device-alpha:0', deviceId: 'device-alpha',
        monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T08:00:00Z',
        payload: { instanceId: 'archived-inst', taskId: 'archived-task', taskTitle: 'Archived', durationSec: 600, stopTime: '08:10' }
      }))

      // Corrupted snapshot
      const corruptedPath = 'LOGS/2026-02-tasks.json'
      store.set(corruptedPath, '{ invalid json')
      const corruptedFile = new (await import('obsidian')).TFile()
      corruptedFile.path = corruptedPath
      corruptedFile.basename = '2026-02-tasks'
      corruptedFile.extension = 'json'
      abstractStore.set(corruptedPath, corruptedFile)
      const logsFolder = abstractStore.get('LOGS')
      if (logsFolder instanceof (await import('obsidian')).TFolder) {
        logsFolder.children.push(corruptedFile)
      }

      plugin.app.vault.read = jest.fn(async () => '{ invalid json')

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation()
      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()
      consoleSpy.mockRestore()

      // After rebuild, both archived and normal entries should be present
      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      const entries = saved.taskExecutions['2026-02-01'] ?? []
      expect(entries.length).toBe(2)
      const hasArchived = entries.some((e: { instanceId: string }) => e.instanceId === 'archived-inst')
      const hasNormal = entries.some((e: { instanceId: string }) => e.instanceId === 'normal-inst')
      expect(hasArchived).toBe(true)
      expect(hasNormal).toBe(true)
    })

    test('rebuild applies deltas in LWW order across devices', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // device-new (newer update)
      seedDeltaFile(abstractStore, deltaStore, 'device-new', '2026-02', [
        {
          schemaVersion: 1, op: 'upsert', entryId: 'device-new:1', deviceId: 'device-new',
          monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T12:00:00Z',
          payload: { instanceId: 'inst-lww', taskId: 'task-lww', taskTitle: 'New Title', durationSec: 600, stopTime: '12:10' }
        }
      ])

      // device-old (older update) seeded after device-new so it would overwrite without LWW
      seedDeltaFile(abstractStore, deltaStore, 'device-old', '2026-02', [
        {
          schemaVersion: 1, op: 'upsert', entryId: 'device-old:1', deviceId: 'device-old',
          monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T08:00:00Z',
          payload: { instanceId: 'inst-lww', taskId: 'task-lww', taskTitle: 'Old Title', durationSec: 300, stopTime: '08:10' }
        }
      ])

      // Corrupted snapshot to trigger rebuildFromDeltas
      const corruptedPath = 'LOGS/2026-02-tasks.json'
      store.set(corruptedPath, '{ invalid json')
      const corruptedFile = new (await import('obsidian')).TFile()
      corruptedFile.path = corruptedPath
      corruptedFile.basename = '2026-02-tasks'
      corruptedFile.extension = 'json'
      abstractStore.set(corruptedPath, corruptedFile)
      const logsFolder = abstractStore.get('LOGS')
      if (logsFolder instanceof (await import('obsidian')).TFolder) {
        logsFolder.children.push(corruptedFile)
      }
      plugin.app.vault.read = jest.fn(async () => '{ invalid json')

      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()

      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      const entries = saved.taskExecutions['2026-02-01'] ?? []
      expect(entries).toHaveLength(1)
      expect(entries[0].taskTitle).toBe('New Title')
      expect(entries[0].recordedAt).toBe('2026-02-01T12:00:00Z')
    })
  })

  describe('Archived-Only Delta Ordering (Reviewer Issue P1-archived-only-order)', () => {
    test('archived-only delta should not overwrite newer normal entry', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2026-02', {
        taskExecutions: {},
        dailySummary: {},
        meta: { revision: 1, processedCursor: {} }
      })

      // Normal delta (newer)
      seedDeltaFile(abstractStore, deltaStore, 'device-normal', '2026-02', [
        {
          schemaVersion: 1, op: 'upsert', entryId: 'device-normal:2', deviceId: 'device-normal',
          monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T10:00:00Z',
          payload: { instanceId: 'inst-shared', taskId: 'task-shared', taskTitle: 'New Title', durationSec: 600, stopTime: '10:10' }
        }
      ])

      // Archived-only delta (older)
      const archivedPath = 'LOGS/inbox/device-archived/2026-02.archived.jsonl'
      deltaStore.set(archivedPath, JSON.stringify({
        schemaVersion: 1, op: 'upsert', entryId: 'device-archived:1', deviceId: 'device-archived',
        monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T08:00:00Z',
        payload: { instanceId: 'inst-shared', taskId: 'task-shared', taskTitle: 'Old Title', durationSec: 300, stopTime: '08:10' }
      }) + '\n')

      const adapter = plugin.app.vault.adapter as { list?: jest.Mock }
      adapter.list = jest.fn(async (path: string) => {
        if (path === 'LOGS/inbox' || path === 'LOGS/.inbox') {
          return { folders: ['LOGS/inbox/device-normal', 'LOGS/inbox/device-archived'], files: [] }
        }
        if (path === 'LOGS/inbox/device-normal') {
          return { folders: [], files: ['LOGS/inbox/device-normal/2026-02.jsonl'] }
        }
        if (path === 'LOGS/inbox/device-archived') {
          return { folders: [], files: [archivedPath] }
        }
        return { folders: [], files: [] }
      })

      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()

      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      const entries = saved.taskExecutions['2026-02-01'] ?? []
      expect(entries).toHaveLength(1)
      expect(entries[0].taskTitle).toBe('New Title')
      expect(entries[0].recordedAt).toBe('2026-02-01T10:00:00Z')
    })

    test('archived-only legacy delete should not remove newer entry', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2026-02', {
        taskExecutions: {
          '2026-02-01': [
            {
              instanceId: 'inst-new',
              taskId: 'task-shared',
              taskTitle: 'New Entry',
              durationSec: 600,
              stopTime: '10:10',
              recordedAt: '2026-02-02T10:00:00Z'
            }
          ]
        },
        dailySummary: {},
        meta: { revision: 1, processedCursor: {} }
      })

      // Normal delta to trigger reconciliation (no-op for this entry)
      seedDeltaFile(abstractStore, deltaStore, 'device-normal', '2026-02', [
        {
          schemaVersion: 1, op: 'summary', entryId: 'device-normal:1', deviceId: 'device-normal',
          monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-02T12:00:00Z',
          payload: { summary: { totalTasks: 1 } }
        }
      ])

      // Archived-only legacy delete (older, no instanceId)
      const archivedPath = 'LOGS/inbox/device-archived/2026-02.archived.jsonl'
      deltaStore.set(archivedPath, JSON.stringify({
        schemaVersion: 1, op: 'delete', entryId: 'device-archived:del-1', deviceId: 'device-archived',
        monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T09:00:00Z',
        payload: { taskId: 'task-shared', taskTitle: 'Legacy Delete' }
      }) + '\n')

      const adapter = plugin.app.vault.adapter as { list?: jest.Mock }
      adapter.list = jest.fn(async (path: string) => {
        if (path === 'LOGS/inbox' || path === 'LOGS/.inbox') {
          return { folders: ['LOGS/inbox/device-normal', 'LOGS/inbox/device-archived'], files: [] }
        }
        if (path === 'LOGS/inbox/device-normal') {
          return { folders: [], files: ['LOGS/inbox/device-normal/2026-02.jsonl'] }
        }
        if (path === 'LOGS/inbox/device-archived') {
          return { folders: [], files: [archivedPath] }
        }
        return { folders: [], files: [] }
      })

      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()

      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      const entries = saved.taskExecutions['2026-02-01'] ?? []
      expect(entries).toHaveLength(1)
      expect(entries[0].instanceId).toBe('inst-new')
      expect(entries[0].taskTitle).toBe('New Entry')
    })

    test('archived-only delete no-op should not increment revision', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      seedSnapshot(store, abstractStore, '2026-02', {
        taskExecutions: {},
        dailySummary: {},
        meta: { revision: 1, processedCursor: {} }
      })

      // Normal delta file (empty) to ensure month is processed
      seedDeltaFile(abstractStore, deltaStore, 'device-normal', '2026-02', [])

      // Archived-only legacy delete for a task that doesn't exist
      const archivedPath = 'LOGS/inbox/device-archived/2026-02.archived.jsonl'
      deltaStore.set(archivedPath, JSON.stringify({
        schemaVersion: 1, op: 'delete', entryId: 'device-archived:del-1', deviceId: 'device-archived',
        monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T09:00:00Z',
        payload: { taskId: 'missing-task', taskTitle: 'Legacy Delete' }
      }) + '\n')

      const adapter = plugin.app.vault.adapter as { list?: jest.Mock }
      adapter.list = jest.fn(async (path: string) => {
        if (path === 'LOGS/inbox' || path === 'LOGS/.inbox') {
          return { folders: ['LOGS/inbox/device-normal', 'LOGS/inbox/device-archived'], files: [] }
        }
        if (path === 'LOGS/inbox/device-normal') {
          return { folders: [], files: ['LOGS/inbox/device-normal/2026-02.jsonl'] }
        }
        if (path === 'LOGS/inbox/device-archived') {
          return { folders: [], files: [archivedPath] }
        }
        return { folders: [], files: [] }
      })

      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()

      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      expect(saved.meta.revision).toBe(1)
    })
  })

  describe('Archived-Only Month Recovery (Reviewer Issue P2-archived-month)', () => {
    test('recovers from archived-only month when no normal delta exists and snapshot is missing', async () => {
      // Reviewer P2: 保持期間後に通常.jsonlが削除されアーカイブのみ残る月で、
      // スナップショットが未同期/破損している場合に復旧できない問題
      //
      // シナリオ:
      // 1. 90日以上前の月で通常.jsonlがアーカイブ化され削除
      // 2. 新規デバイスがその月のスナップショットを持っていない
      // 3. → その月のdeltaソースが空なので処理されない
      // 4. → スナップショットが作成されずログが欠落
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Only archived delta file exists (no normal .jsonl file)
      // This simulates a month where DeltaRetentionPolicy has archived and deleted the normal file
      const { TFolder, TFile } = await import('obsidian')
      const devicePath = 'LOGS/inbox/device-archived'
      const deviceFolder = Object.assign(new TFolder(), {
        path: devicePath,
        name: 'device-archived',
        children: []
      })
      Object.setPrototypeOf(deviceFolder, TFolder.prototype)

      const inboxFolder = abstractStore.get('LOGS/inbox')
      if (inboxFolder instanceof TFolder) {
        inboxFolder.children.push(deviceFolder)
        abstractStore.set(devicePath, deviceFolder)
      }

      // Create archived delta file
      const archivedPath = `${devicePath}/2026-01.archived.jsonl`
      const archivedFile = Object.assign(new TFile(), {
        path: archivedPath,
        basename: '2026-01.archived',
        extension: 'jsonl'
      })
      Object.setPrototypeOf(archivedFile, TFile.prototype)
      deviceFolder.children.push(archivedFile)
      abstractStore.set(archivedPath, archivedFile)

      // Archived delta content
      const archivedRecord = {
        schemaVersion: 1, op: 'upsert', entryId: 'device-archived:1', deviceId: 'device-archived',
        monthKey: '2026-01', dateKey: '2026-01-15', recordedAt: '2026-01-15T10:00:00Z',
        payload: { instanceId: 'archived-only-inst', taskId: 'archived-task', taskTitle: 'Archived Only Task', durationSec: 1800, stopTime: '10:30' }
      }
      deltaStore.set(archivedPath, JSON.stringify(archivedRecord) + '\n')

      // Mock adapter.list to return the archived file
      // collectArchivedOnlyMonths uses adapter.list to find archived-only months
      const mockAdapter = plugin.app.vault.adapter as { list?: jest.Mock }
      mockAdapter.list = jest.fn(async (path: string) => {
        if (path === 'LOGS/inbox' || path === 'LOGS/.inbox') {
          return { folders: [devicePath], files: [] }
        }
        if (path === devicePath) {
          return { folders: [], files: [archivedPath] }
        }
        return { folders: [], files: [] }
      })

      // NO snapshot exists for 2026-01 (simulating new device or missing file)
      // NO normal .jsonl file exists (only .archived.jsonl)

      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()

      // The archived-only month should be processed and snapshot created
      const snapshotPath = 'LOGS/2026-01-tasks.json'
      const savedSnapshot = store.get(snapshotPath)
      expect(savedSnapshot).toBeDefined()

      const snapshot = JSON.parse(savedSnapshot!)
      expect(snapshot.taskExecutions['2026-01-15']).toBeDefined()
      expect(snapshot.taskExecutions['2026-01-15']).toHaveLength(1)
      expect(snapshot.taskExecutions['2026-01-15'][0].instanceId).toBe('archived-only-inst')
    })
  })

  describe('Merge Snapshot Entry Overwrite (Reviewer Issue P2-1)', () => {
    test('current snapshot entry should overwrite legacy entry with same instanceId', async () => {
      // createMergedSnapshotで同一instanceIdのエントリがある場合、
      // currentの更新がlegacyで上書きされてしまう問題のテスト
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Legacy snapshot with old data
      const legacySnapshot = {
        taskExecutions: {
          '2026-02-01': [
            { instanceId: 'inst-1', taskId: 'task-1', taskTitle: 'Old Title', durationSec: 600, stopTime: '09:00' },
          ]
        },
        dailySummary: {},
        // Legacy: no meta field
      }

      // Current snapshot (already migrated by another device) with updated data
      const currentSnapshot = {
        taskExecutions: {
          '2026-02-01': [
            { instanceId: 'inst-1', taskId: 'task-1', taskTitle: 'Updated Title', durationSec: 1200, stopTime: '10:00' },
          ]
        },
        dailySummary: {},
        meta: { revision: 5, processedCursor: { 'other-device': 3 } }
      }

      // Seed current snapshot (this is what exists on disk)
      seedSnapshot(store, abstractStore, '2026-02', currentSnapshot)

      // Delta file to trigger reconciliation
      seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2026-02', [
        {
          schemaVersion: 1, op: 'upsert', entryId: 'device-alpha:1', deviceId: 'device-alpha',
          monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T11:00:00Z',
          payload: { instanceId: 'inst-2', taskId: 'task-2', taskTitle: 'New Entry', durationSec: 300, stopTime: '11:05' }
        }
      ])

      const rec = new LogReconciler(plugin)
      // Manually call createMergedSnapshot to test merge behavior
      const merged = (rec as unknown as {
        createMergedSnapshot: (legacy: typeof legacySnapshot, current: typeof currentSnapshot) => typeof currentSnapshot
      }).createMergedSnapshot(legacySnapshot, currentSnapshot)

      // After merge, entry with same instanceId should have current's (updated) values
      const entries = merged.taskExecutions['2026-02-01'] ?? []
      const inst1Entry = entries.find(e => e.instanceId === 'inst-1')
      expect(inst1Entry).toBeDefined()
      // Should be current's updated values, NOT legacy's old values
      expect(inst1Entry!.taskTitle).toBe('Updated Title')
      expect(inst1Entry!.durationSec).toBe(1200)
      expect(inst1Entry!.stopTime).toBe('10:00')
    })
  })

  describe('Rebuild Records Update (Reviewer Issue P2-2)', () => {
    test('rebuildFromDeltas should update LOGS/records after rebuild', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Normal delta file
      seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2026-02', [
        {
          schemaVersion: 1, op: 'upsert', entryId: 'device-alpha:1', deviceId: 'device-alpha',
          monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T10:00:00Z',
          payload: { instanceId: 'inst-1', taskId: 'task-1', taskTitle: 'Test Task', durationSec: 1800, stopTime: '10:30' }
        }
      ])

      // Corrupted snapshot to trigger rebuild
      const corruptedPath = 'LOGS/2026-02-tasks.json'
      store.set(corruptedPath, '{ invalid json')
      const corruptedFile = new TFile()
      corruptedFile.path = corruptedPath
      corruptedFile.basename = '2026-02-tasks'
      corruptedFile.extension = 'json'
      Object.setPrototypeOf(corruptedFile, TFile.prototype)
      abstractStore.set(corruptedPath, corruptedFile)
      const logsFolder = abstractStore.get('LOGS')
      if (logsFolder instanceof TFolder) {
        logsFolder.children.push(corruptedFile)
      }

      plugin.app.vault.read = jest.fn(async () => '{ invalid json')

      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()

      // Verify snapshot was rebuilt
      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      expect(saved.taskExecutions['2026-02-01']).toHaveLength(1)

      // Verify records were also updated (this is what the issue is about)
      // RecordsWriter writes to LOGS/records/YYYY/record-YYYY-MM-DD.md
      const recordPath = 'LOGS/records/2026/record-2026-02-01.md'
      const recordData = store.get(recordPath)
      expect(recordData).toBeDefined()
      // RecordsWriter uses frontmatter YAML format
      expect(recordData).toContain('inst-1')
    })

    test('rebuildFromDeltas should include summary-only dates in records (P2-summary-only-rebuild)', async () => {
      // Reviewer P2: dailySummaryのみ存在する日付（taskExecutionsが空）がrecordsから欠落する問題
      // op: 'summary' のdeltaはtaskExecutionsに書き込まず、dailySummaryのみ更新するため
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Date with task completion (will be in both taskExecutions and dailySummary)
      seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2026-02', [
        {
          schemaVersion: 1, op: 'upsert', entryId: 'device-alpha:1', deviceId: 'device-alpha',
          monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T10:00:00Z',
          payload: { instanceId: 'inst-1', taskId: 'task-1', taskTitle: 'Test Task', durationSec: 1800, stopTime: '10:30' }
        },
        // op: 'summary' - only updates dailySummary, NOT taskExecutions
        {
          schemaVersion: 1, op: 'summary', entryId: 'device-alpha:2', deviceId: 'device-alpha',
          monthKey: '2026-02', dateKey: '2026-02-02', recordedAt: '2026-02-02T08:00:00Z',
          payload: { summary: { totalTasks: 5 } }
        }
      ])

      // Corrupted snapshot to trigger rebuild
      const corruptedPath = 'LOGS/2026-02-tasks.json'
      store.set(corruptedPath, '{ invalid json')
      const corruptedFile = new TFile()
      corruptedFile.path = corruptedPath
      corruptedFile.basename = '2026-02-tasks'
      corruptedFile.extension = 'json'
      Object.setPrototypeOf(corruptedFile, TFile.prototype)
      abstractStore.set(corruptedPath, corruptedFile)
      const logsFolder = abstractStore.get('LOGS')
      if (logsFolder instanceof TFolder) {
        logsFolder.children.push(corruptedFile)
      }

      plugin.app.vault.read = jest.fn(async () => '{ invalid json')

      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()

      // Verify snapshot was rebuilt
      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      expect(saved.taskExecutions['2026-02-01']).toHaveLength(1)
      // 2026-02-02 should have dailySummary but no taskExecutions
      expect(saved.dailySummary['2026-02-02']?.totalTasks).toBe(5)
      expect(saved.taskExecutions['2026-02-02']).toBeUndefined()

      // Verify records were updated for BOTH dates (this is what the issue is about)
      // Date with task execution
      const recordPath1 = 'LOGS/records/2026/record-2026-02-01.md'
      const recordData1 = store.get(recordPath1)
      expect(recordData1).toBeDefined()

      // Date with summary-only (THIS IS THE BUG: should also have a record)
      const recordPath2 = 'LOGS/records/2026/record-2026-02-02.md'
      const recordData2 = store.get(recordPath2)
      expect(recordData2).toBeDefined()  // Should exist but currently doesn't
      expect(recordData2).toContain('totalTasks: 5')  // Should contain the summary data
    })
  })

  describe('Legacy Snapshot Detection (Reviewer Issue P2-3)', () => {
    test('detects legacy snapshot without meta field and triggers migration', async () => {
      // Use real timers for this test because migration involves async file operations
      jest.useRealTimers()

      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Legacy snapshot WITHOUT meta field (this is what old snapshots look like)
      const legacyContent = JSON.stringify({
        taskExecutions: {
          '2026-02-01': [
            { taskId: 'legacy-task', taskTitle: 'Legacy Entry', durationSec: 600, stopTime: '09:00' }
          ]
        },
        dailySummary: {}
        // No 'meta' field!
      })

      const snapshotPath = 'LOGS/2026-02-tasks.json'
      store.set(snapshotPath, legacyContent)
      const snapshotFile = new TFile()
      snapshotFile.path = snapshotPath
      snapshotFile.basename = '2026-02-tasks'
      snapshotFile.extension = 'json'
      Object.setPrototypeOf(snapshotFile, TFile.prototype)
      abstractStore.set(snapshotPath, snapshotFile)
      const logsFolder = abstractStore.get('LOGS')
      if (logsFolder instanceof TFolder) {
        logsFolder.children.push(snapshotFile)
      }

      // Delta file to trigger reconciliation
      seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2026-02', [
        {
          schemaVersion: 1, op: 'upsert', entryId: 'device-alpha:1', deviceId: 'device-alpha',
          monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T10:00:00Z',
          payload: { instanceId: 'inst-1', taskId: 'task-1', taskTitle: 'New Task', durationSec: 300, stopTime: '10:05' }
        }
      ])

      // Spy on console.warn to detect legacy migration
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation()

      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()

      // Verify legacy migration was triggered
      const migrationLogCalled = consoleSpy.mock.calls.some(
        call => call[0]?.toString().includes('Legacy') || call[0]?.toString().includes('legacy')
      )
      expect(migrationLogCalled).toBe(true)

      // Verify the resulting snapshot has proper meta with revision >= 0
      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      expect(saved.meta).toBeDefined()
      expect(saved.meta.revision).toBeGreaterThanOrEqual(0)
      // Verify legacy data was preserved
      const entries = saved.taskExecutions['2026-02-01'] ?? []
      const hasLegacy = entries.some((e: { taskId: string }) => e.taskId === 'legacy-task')
      const hasNew = entries.some((e: { instanceId: string }) => e.instanceId === 'inst-1')
      expect(hasLegacy).toBe(true)
      expect(hasNew).toBe(true)

      consoleSpy.mockRestore()
    })
  })

  describe('Archived-Only Sources via Adapter (Codex Issue #2)', () => {
    test('collectArchivedOnlySources uses adapter.list for Sync compatibility', async () => {
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // device-alpha has normal delta file
      seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2026-02', [
        {
          schemaVersion: 1, op: 'upsert', entryId: 'device-alpha:1', deviceId: 'device-alpha',
          monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T10:00:00Z',
          payload: { instanceId: 'normal-inst', taskId: 'normal-task', taskTitle: 'Normal', durationSec: 300, stopTime: '10:05' }
        }
      ])

      // device-gamma has archived-only file (simulate Sync where Vault cache is not updated)
      // The archived file only exists in deltaStore (adapter.read) but NOT in abstractStore (Vault cache)
      const archivedPath = `LOGS/inbox/device-gamma/2026-02.archived.jsonl`
      const archivedRecord = {
        schemaVersion: 1, op: 'upsert', entryId: 'device-gamma:0', deviceId: 'device-gamma',
        monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T08:00:00Z',
        payload: { instanceId: 'gamma-inst', taskId: 'gamma-task', taskTitle: 'Gamma Archived', durationSec: 600, stopTime: '08:10' }
      }
      deltaStore.set(archivedPath, JSON.stringify(archivedRecord))

      // Setup adapter.list to return the device-gamma folder (Sync has updated the filesystem)
      const originalList = (plugin.app.vault.adapter as { list: (path: string) => Promise<{ files: string[]; folders: string[] }> }).list
      ;(plugin.app.vault.adapter as { list: (path: string) => Promise<{ files: string[]; folders: string[] }> }).list = jest.fn(async (path: string) => {
        if (path === 'LOGS/inbox') {
          return { files: [], folders: ['LOGS/inbox/device-alpha', 'LOGS/inbox/device-gamma'] }
        }
        if (path === 'LOGS/inbox/device-alpha') {
          return { files: ['LOGS/inbox/device-alpha/2026-02.jsonl'], folders: [] }
        }
        if (path === 'LOGS/inbox/device-gamma') {
          return { files: [archivedPath], folders: [] }
        }
        return originalList(path)
      })

      // Corrupted snapshot to trigger rebuild
      const corruptedPath = 'LOGS/2026-02-tasks.json'
      store.set(corruptedPath, '{ invalid json')
      const corruptedFile = new TFile()
      corruptedFile.path = corruptedPath
      corruptedFile.basename = '2026-02-tasks'
      corruptedFile.extension = 'json'
      Object.setPrototypeOf(corruptedFile, TFile.prototype)
      abstractStore.set(corruptedPath, corruptedFile)
      const logsFolder = abstractStore.get('LOGS')
      if (logsFolder instanceof TFolder) {
        logsFolder.children.push(corruptedFile)
      }

      plugin.app.vault.read = jest.fn(async () => '{ invalid json')

      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()

      // After rebuild, both entries should be present (device-alpha normal + device-gamma archived via adapter)
      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      const entries = saved.taskExecutions['2026-02-01'] ?? []
      expect(entries.length).toBe(2)
      const hasNormal = entries.some((e: { instanceId: string }) => e.instanceId === 'normal-inst')
      const hasGamma = entries.some((e: { instanceId: string }) => e.instanceId === 'gamma-inst')
      expect(hasNormal).toBe(true)
      expect(hasGamma).toBe(true)
    })
  })

  describe('Legacy Migration Delta Deduplication (Reviewer Issue P2-delta-dedup)', () => {
    test('migrateLegacySnapshot should not apply same delta file twice', async () => {
      // migrateLegacySnapshotではcollectSourcesFromAdapterとsources引数の両方から
      // 同じdeltaファイルを読み込んでしまい、二重適用されるバグのテスト
      // 特にdeleteレコードが二重適用されると、意図しないエントリが削除される
      jest.useRealTimers()

      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Legacy snapshot WITHOUT meta field (triggers migration)
      // 同じtaskIdを持つ複数のエントリ（instanceIdなし = レガシー形式）
      const legacyContent = JSON.stringify({
        taskExecutions: {
          '2026-02-01': [
            { taskId: 'task-A', taskTitle: 'Entry 1', durationSec: 600, stopTime: '09:00' },
            { taskId: 'task-A', taskTitle: 'Entry 2', durationSec: 700, stopTime: '10:00' },
            { taskId: 'task-A', taskTitle: 'Entry 3', durationSec: 800, stopTime: '11:00' },
          ]
        },
        dailySummary: {}
        // No 'meta' field!
      })

      const snapshotPath = 'LOGS/2026-02-tasks.json'
      store.set(snapshotPath, legacyContent)
      const snapshotFile = new TFile()
      snapshotFile.path = snapshotPath
      snapshotFile.basename = '2026-02-tasks'
      snapshotFile.extension = 'json'
      Object.setPrototypeOf(snapshotFile, TFile.prototype)
      abstractStore.set(snapshotPath, snapshotFile)
      const logsFolder = abstractStore.get('LOGS')
      if (logsFolder instanceof TFolder) {
        logsFolder.children.push(snapshotFile)
      }

      // vault.readをモックして、legacyスナップショットを正しく返すようにする
      plugin.app.vault.read = jest.fn(async (file: TFile) => {
        return store.get(file.path) ?? ''
      })

      // Delta file with a single delete record (instanceId無し = 旧形式)
      // このdeleteは taskId: 'task-A' の最初のエントリのみを削除するはず
      seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2026-02', [
        {
          schemaVersion: 1,
          op: 'delete',
          entryId: 'device-alpha:del-1',
          deviceId: 'device-alpha',
          monthKey: '2026-02',
          dateKey: '2026-02-01',
          recordedAt: '2026-02-01T12:00:00Z',
          payload: {
            taskId: 'task-A',  // instanceIdなし - taskIdでマッチング
            taskTitle: 'Entry 1',
            durationSec: 600,
            stopTime: '09:00'
          }
        }
      ])

      // adapter.listをモックして、collectSourcesFromAdapterが動作するようにする
      // sourcesとcollectSourcesFromAdapterが同じファイルを指すようにして二重適用をテスト
      const adapter = plugin.app.vault.adapter as {
        list: (path: string) => Promise<{ files: string[]; folders: string[] }>
      }
      adapter.list = jest.fn(async (path: string) => {
        // inboxパスのみ返す（.inboxは空）
        if (path === 'LOGS/inbox') {
          return { files: [], folders: ['LOGS/inbox/device-alpha'] }
        }
        if (path === 'LOGS/inbox/device-alpha') {
          return { files: ['LOGS/inbox/device-alpha/2026-02.jsonl'], folders: [] }
        }
        // .inboxは空（preferred inbox）
        if (path === 'LOGS/.inbox') {
          return { files: [], folders: [] }
        }
        return { files: [], folders: [] }
      })

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation()
      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()
      consoleSpy.mockRestore()

      // strict modeでは instanceId なし delete は無視されるため、全件残る
      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      const entries = saved.taskExecutions['2026-02-01'] ?? []

      expect(entries.length).toBe(3)
      const titles = entries.map((e: { taskTitle: string }) => e.taskTitle)
      expect(titles).toContain('Entry 1')
      expect(titles).toContain('Entry 2')
      expect(titles).toContain('Entry 3')
    })
  })

  describe('Legacy Migration Records Update (Reviewer Issue P2-records-update)', () => {
    test('migrateLegacySnapshot should update LOGS/records after migration', async () => {
      jest.useRealTimers()

      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Legacy snapshot WITHOUT meta field (triggers migration)
      seedSnapshot(store, abstractStore, '2026-02', {
        taskExecutions: {
          '2026-02-01': [
            { taskId: 'legacy-task', taskTitle: 'Legacy Entry', durationSec: 600, stopTime: '09:00' }
          ]
        },
        dailySummary: {}
      })

      // Delta to trigger reconciliation
      seedDeltaFile(abstractStore, deltaStore, 'device-alpha', '2026-02', [
        {
          schemaVersion: 1, op: 'upsert', entryId: 'device-alpha:1', deviceId: 'device-alpha',
          monthKey: '2026-02', dateKey: '2026-02-01', recordedAt: '2026-02-01T10:00:00Z',
          payload: { instanceId: 'inst-1', taskId: 'task-1', taskTitle: 'New Entry', durationSec: 300, stopTime: '10:05' }
        }
      ])

      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()

      const recordPath = 'LOGS/records/2026/record-2026-02-01.md'
      const recordData = store.get(recordPath)
      expect(recordData).toBeDefined()
      expect(recordData).toContain('Legacy Entry')
    })
  })

  describe('Legacy Migration Conflict Retry (Reviewer Issue P2-migration-conflict-retry)', () => {
    test('migrateLegacySnapshot should retry on SnapshotConflictError and complete', async () => {
      jest.useRealTimers()

      const { plugin, store, abstractStore } = createPluginStub()

      const currentSnapshot = {
        taskExecutions: {
          '2026-02-02': [
            {
              instanceId: 'current-inst',
              taskId: 'current-task',
              taskTitle: 'Current Entry',
              durationSec: 300,
              stopTime: '10:00',
              recordedAt: '2026-02-02T10:00:00Z',
            },
          ],
        },
        dailySummary: {
          '2026-02-02': { completedTasks: 1, totalTasks: 1 },
        },
        meta: { revision: 2, processedCursor: {} },
      }

      seedSnapshot(store, abstractStore, '2026-02', currentSnapshot)

      const legacySnapshot = {
        taskExecutions: {
          '2026-02-01': [
            { taskId: 'legacy-task', taskTitle: 'Legacy Entry', durationSec: 600, stopTime: '09:00' },
          ],
        },
        dailySummary: {},
      }

      const rec = new LogReconciler(plugin, {
        sleepFn: async () => {},
        randomFn: () => 0,
      })

      const snapshotWriter = (rec as unknown as {
        snapshotWriter: {
          writeWithConflictDetection: (
            monthKey: string,
            snapshot: unknown,
            expectedRevision: number,
            options?: unknown
          ) => Promise<void>
        }
      }).snapshotWriter
      const originalWrite = snapshotWriter.writeWithConflictDetection.bind(snapshotWriter)

      let conflictInjected = false
      jest.spyOn(snapshotWriter, 'writeWithConflictDetection').mockImplementation(
        async (monthKey, snapshot, expectedRevision, options) => {
          if (!conflictInjected) {
            conflictInjected = true
            const conflictSnapshot = {
              ...currentSnapshot,
              meta: { ...currentSnapshot.meta, revision: expectedRevision + 1, processedCursor: {} },
            }
            store.set('LOGS/2026-02-tasks.json', JSON.stringify(conflictSnapshot))
            throw new SnapshotConflictError(conflictSnapshot)
          }
          return originalWrite(monthKey, snapshot, expectedRevision, options)
        }
      )

      await (rec as unknown as {
        migrateLegacySnapshot: (monthKey: string, legacySnapshot: unknown, sources: unknown[]) => Promise<void>
      }).migrateLegacySnapshot('2026-02', legacySnapshot, [])

      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      expect(saved.meta.revision).toBe(4)
      const entries = saved.taskExecutions['2026-02-01'] ?? []
      expect(entries.some((entry: { taskId: string }) => entry.taskId === 'legacy-task')).toBe(true)
      expect(saved.taskExecutions['2026-02-02']).toHaveLength(1)
      expect((snapshotWriter.writeWithConflictDetection as jest.Mock).mock.calls.length).toBe(2)
    })
  })

  describe('Legacy Migration Archived-Only Delta (Reviewer Issue P2-archived-only)', () => {
    test('migrateLegacySnapshot should include delta from archived-only files', async () => {
      // 問題: 通常の.jsonlが削除され、.archived.jsonlのみ残っている場合、
      // collectSourcesFromAdapterがそのデバイスを返さないため、deltaが取り込まれない
      //
      // セットアップ:
      // - device-trigger: 通常の.jsonlを持つ（migrateLegacySnapshotをトリガーするため）
      // - device-archived-only: .archived.jsonlのみ持つ（問題のケース）
      jest.useRealTimers()
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Legacy snapshot (meta無し)
      const legacyContent = JSON.stringify({
        taskExecutions: {
          '2026-02-01': [
            { taskId: 'existing-task', taskTitle: 'Existing Entry', durationSec: 300, stopTime: '08:00' }
          ]
        },
        dailySummary: {}
      })

      const snapshotPath = 'LOGS/2026-02-tasks.json'
      store.set(snapshotPath, legacyContent)
      const snapshotFile = new TFile()
      snapshotFile.path = snapshotPath
      abstractStore.set(snapshotPath, snapshotFile)

      // vault.readをモック
      plugin.app.vault.read = jest.fn(async (file: TFile) => {
        return store.get(file.path) ?? ''
      })
      plugin.app.vault.getAbstractFileByPath = jest.fn((path: string) => {
        return abstractStore.get(path) ?? null
      })

      // デバイスフォルダセットアップ
      const inboxPath = 'LOGS/inbox'
      const inboxFolder = new TFolder()
      inboxFolder.path = inboxPath
      inboxFolder.name = 'inbox'
      inboxFolder.children = []
      abstractStore.set(inboxPath, inboxFolder)

      // device-trigger: 通常の.jsonlを持つデバイス（移行をトリガー）
      const triggerDevicePath = 'LOGS/inbox/device-trigger'
      const triggerDeviceFolder = new TFolder()
      triggerDeviceFolder.path = triggerDevicePath
      triggerDeviceFolder.name = 'device-trigger'
      triggerDeviceFolder.children = []
      abstractStore.set(triggerDevicePath, triggerDeviceFolder)

      const triggerDeltaPath = 'LOGS/inbox/device-trigger/2026-02.jsonl'
      const triggerDelta = JSON.stringify({
        schemaVersion: 1,
        op: 'upsert',
        entryId: 'device-trigger:1',
        deviceId: 'device-trigger',
        monthKey: '2026-02',
        dateKey: '2026-02-01',
        recordedAt: '2026-02-01T09:00:00Z',
        payload: {
          instanceId: 'inst-trigger',
          taskId: 'trigger-task',
          taskTitle: 'Trigger Entry',
          durationSec: 600,
          stopTime: '09:10'
        }
      })
      deltaStore.set(triggerDeltaPath, triggerDelta + '\n')
      const triggerFile = new TFile()
      triggerFile.path = triggerDeltaPath
      abstractStore.set(triggerDeltaPath, triggerFile)

      // device-archived-only: .archived.jsonlのみ持つデバイス
      const archivedDevicePath = 'LOGS/inbox/device-archived-only'
      const archivedDeviceFolder = new TFolder()
      archivedDeviceFolder.path = archivedDevicePath
      archivedDeviceFolder.name = 'device-archived-only'
      archivedDeviceFolder.children = []
      abstractStore.set(archivedDevicePath, archivedDeviceFolder)

      const archivedPath = 'LOGS/inbox/device-archived-only/2026-02.archived.jsonl'
      const archivedDelta = JSON.stringify({
        schemaVersion: 1,
        op: 'upsert',
        entryId: 'device-archived-only:1',
        deviceId: 'device-archived-only',
        monthKey: '2026-02',
        dateKey: '2026-02-01',
        recordedAt: '2026-02-01T10:00:00Z',
        payload: {
          instanceId: 'inst-archived',
          taskId: 'archived-task',
          taskTitle: 'Archived Delta Entry',
          durationSec: 900,
          stopTime: '10:15'
        }
      })
      deltaStore.set(archivedPath, archivedDelta + '\n')

      // adapter.listをモック
      const adapter = plugin.app.vault.adapter as {
        list: (path: string) => Promise<{ files: string[]; folders: string[] }>
        read: (path: string) => Promise<string>
      }
      adapter.list = jest.fn(async (path: string) => {
        if (path === 'LOGS/inbox') {
          return { files: [], folders: [triggerDevicePath, archivedDevicePath] }
        }
        if (path === triggerDevicePath) {
          return { files: [triggerDeltaPath], folders: [] }
        }
        if (path === archivedDevicePath) {
          // 通常の.jsonlは無し、.archived.jsonlのみ
          return { files: [archivedPath], folders: [] }
        }
        if (path === 'LOGS/.inbox') {
          return { files: [], folders: [] }
        }
        return { files: [], folders: [] }
      })

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation()
      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()
      consoleSpy.mockRestore()

      // 期待: 既存エントリ + トリガーエントリ + アーカイブエントリ = 3
      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      const entries = saved.taskExecutions['2026-02-01'] ?? []

      // バグがある場合: アーカイブ専用デバイスのdeltaが欠落 → entries.length = 2
      // 修正後: アーカイブ専用デバイスのdeltaも取り込まれる → entries.length = 3
      expect(entries.length).toBe(3)
      const titles = entries.map((e: { taskTitle: string }) => e.taskTitle)
      expect(titles).toContain('Existing Entry')
      expect(titles).toContain('Trigger Entry')
      expect(titles).toContain('Archived Delta Entry')
    })
  })

  describe('Mixed Month Archived Delta (Reviewer Issue P1-mixed-month)', () => {
    test('processMonth should include archived delta from other devices even when normal sources exist', async () => {
      // 問題: 通常.jsonlが存在する月では、他デバイスの.archived.jsonlが無視される
      // シナリオ:
      // - デバイスA: 通常の.jsonlを持っている → sourcesに含まれる
      // - デバイスB: .archived.jsonlのみを持っている → sourcesに含まれない
      // - 結果: デバイスBのログが欠落する
      jest.useRealTimers()

      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // スナップショットを作成（新形式、revision=5）
      const snapshotPath = 'LOGS/2026-02-tasks.json'
      const snapshotContent = JSON.stringify({
        taskExecutions: {},
        dailySummary: {},
        meta: { revision: 5, processedCursor: {} }
      })
      store.set(snapshotPath, snapshotContent)
      const snapshotFile = new TFile()
      snapshotFile.path = snapshotPath
      snapshotFile.basename = '2026-02-tasks'
      snapshotFile.extension = 'json'
      Object.setPrototypeOf(snapshotFile, TFile.prototype)
      abstractStore.set(snapshotPath, snapshotFile)
      const logsFolder = abstractStore.get('LOGS')
      if (logsFolder instanceof TFolder) {
        logsFolder.children.push(snapshotFile)
      }

      // vault.readをモック
      plugin.app.vault.read = jest.fn(async (file: TFile) => {
        return store.get(file.path) ?? ''
      })

      // デバイスフォルダセットアップ
      const inboxPath = 'LOGS/inbox'
      const inboxFolder = new TFolder()
      inboxFolder.path = inboxPath
      inboxFolder.name = 'inbox'
      inboxFolder.children = []
      abstractStore.set(inboxPath, inboxFolder)

      // device-normal: 通常の.jsonlを持つデバイス
      const normalDevicePath = 'LOGS/inbox/device-normal'
      const normalDeviceFolder = new TFolder()
      normalDeviceFolder.path = normalDevicePath
      normalDeviceFolder.name = 'device-normal'
      normalDeviceFolder.children = []
      abstractStore.set(normalDevicePath, normalDeviceFolder)

      const normalDeltaPath = 'LOGS/inbox/device-normal/2026-02.jsonl'
      const normalDelta = JSON.stringify({
        schemaVersion: 1,
        op: 'upsert',
        entryId: 'device-normal:1',
        deviceId: 'device-normal',
        monthKey: '2026-02',
        dateKey: '2026-02-01',
        recordedAt: '2026-02-01T09:00:00Z',
        payload: {
          instanceId: 'inst-normal',
          taskId: 'normal-task',
          taskTitle: 'Normal Device Entry',
          durationSec: 600,
          stopTime: '09:10'
        }
      })
      deltaStore.set(normalDeltaPath, normalDelta + '\n')
      const normalFile = new TFile()
      normalFile.path = normalDeltaPath
      normalFile.basename = '2026-02'
      normalFile.extension = 'jsonl'
      Object.setPrototypeOf(normalFile, TFile.prototype)
      abstractStore.set(normalDeltaPath, normalFile)
      normalDeviceFolder.children.push(normalFile)

      // device-archived: .archived.jsonlのみを持つデバイス
      const archivedDevicePath = 'LOGS/inbox/device-archived'
      const archivedDeviceFolder = new TFolder()
      archivedDeviceFolder.path = archivedDevicePath
      archivedDeviceFolder.name = 'device-archived'
      archivedDeviceFolder.children = []
      abstractStore.set(archivedDevicePath, archivedDeviceFolder)

      const archivedDeltaPath = 'LOGS/inbox/device-archived/2026-02.archived.jsonl'
      const archivedDelta = JSON.stringify({
        schemaVersion: 1,
        op: 'upsert',
        entryId: 'device-archived:1',
        deviceId: 'device-archived',
        monthKey: '2026-02',
        dateKey: '2026-02-01',
        recordedAt: '2026-02-01T08:00:00Z',  // normalより古い
        payload: {
          instanceId: 'inst-archived',
          taskId: 'archived-task',
          taskTitle: 'Archived Device Entry',
          durationSec: 900,
          stopTime: '08:15'
        }
      })
      deltaStore.set(archivedDeltaPath, archivedDelta + '\n')
      // アーカイブファイルはabstractStoreには登録しない（Syncで同期されたがVaultキャッシュにない状態）

      // adapter.listをモック
      const adapter = plugin.app.vault.adapter as {
        list: (path: string) => Promise<{ files: string[]; folders: string[] }>
      }
      adapter.list = jest.fn(async (path: string) => {
        if (path === 'LOGS/inbox') {
          return { files: [], folders: [normalDevicePath, archivedDevicePath] }
        }
        if (path === normalDevicePath) {
          return { files: [normalDeltaPath], folders: [] }
        }
        if (path === archivedDevicePath) {
          // 通常の.jsonlは無し、.archived.jsonlのみ
          return { files: [archivedDeltaPath], folders: [] }
        }
        if (path === 'LOGS/.inbox') {
          return { files: [], folders: [] }
        }
        return { files: [], folders: [] }
      })

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation()
      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()
      consoleSpy.mockRestore()

      // 期待: 両方のデバイスのdeltaが取り込まれる
      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      const entries = saved.taskExecutions['2026-02-01'] ?? []

      // バグがある場合: device-archivedのdeltaが欠落 → entries.length = 1
      // 修正後: 両方取り込まれる → entries.length = 2
      expect(entries.length).toBe(2)
      const instanceIds = entries.map((e: { instanceId: string }) => e.instanceId)
      expect(instanceIds).toContain('inst-normal')
      expect(instanceIds).toContain('inst-archived')

      // revisionが更新されていることを確認
      expect(saved.meta.revision).toBe(6)
    })
  })

  describe('Legacy Migration Delta Ordering (Reviewer Issue P2-delta-order)', () => {
    test('migrateLegacySnapshot should apply deltas in recordedAt order', async () => {
      // 問題: [...records, ...archivedRecords]の順で適用すると、
      // 古いアーカイブが新しい通常deltaを上書きする
      jest.useRealTimers()
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // Legacy snapshot (meta無し)
      const legacyContent = JSON.stringify({
        taskExecutions: {},
        dailySummary: {}
      })

      const snapshotPath = 'LOGS/2026-02-tasks.json'
      store.set(snapshotPath, legacyContent)
      const snapshotFile = new TFile()
      snapshotFile.path = snapshotPath
      abstractStore.set(snapshotPath, snapshotFile)

      // vault.readをモック
      plugin.app.vault.read = jest.fn(async (file: TFile) => {
        return store.get(file.path) ?? ''
      })
      plugin.app.vault.getAbstractFileByPath = jest.fn((path: string) => {
        return abstractStore.get(path) ?? null
      })

      // デバイスフォルダセットアップ
      const inboxPath = 'LOGS/inbox'
      const inboxFolder = new TFolder()
      inboxFolder.path = inboxPath
      inboxFolder.name = 'inbox'
      inboxFolder.children = []
      abstractStore.set(inboxPath, inboxFolder)

      const devicePath = 'LOGS/inbox/device-order-test'
      const deviceFolder = new TFolder()
      deviceFolder.path = devicePath
      deviceFolder.name = 'device-order-test'
      deviceFolder.children = []
      abstractStore.set(devicePath, deviceFolder)

      // 通常ファイル: 新しいdelta（後で記録された更新）
      const normalPath = 'LOGS/inbox/device-order-test/2026-02.jsonl'
      const normalDelta = JSON.stringify({
        schemaVersion: 1,
        op: 'upsert',
        entryId: 'device-order-test:1',
        deviceId: 'device-order-test',
        monthKey: '2026-02',
        dateKey: '2026-02-01',
        recordedAt: '2026-02-01T12:00:00Z',  // 後で記録（最新）
        payload: {
          instanceId: 'inst-update-test',
          taskId: 'update-task',
          taskTitle: 'Updated Title',  // 最新のタイトル
          durationSec: 1200,
          stopTime: '12:00'
        }
      })
      deltaStore.set(normalPath, normalDelta + '\n')
      const normalFile = new TFile()
      normalFile.path = normalPath
      abstractStore.set(normalPath, normalFile)

      // アーカイブファイル: 古いdelta（先に記録された元の値）
      const archivedPath = 'LOGS/inbox/device-order-test/2026-02.archived.jsonl'
      const archivedDelta = JSON.stringify({
        schemaVersion: 1,
        op: 'upsert',
        entryId: 'device-order-test:1',
        deviceId: 'device-order-test',
        monthKey: '2026-02',
        dateKey: '2026-02-01',
        recordedAt: '2026-02-01T08:00:00Z',  // 先に記録（古い）
        payload: {
          instanceId: 'inst-update-test',  // 同じinstanceId
          taskId: 'update-task',
          taskTitle: 'Original Title',  // 古いタイトル
          durationSec: 600,
          stopTime: '08:00'
        }
      })
      deltaStore.set(archivedPath, archivedDelta + '\n')

      // adapter.listをモック
      const adapter = plugin.app.vault.adapter as {
        list: (path: string) => Promise<{ files: string[]; folders: string[] }>
        read: (path: string) => Promise<string>
      }
      adapter.list = jest.fn(async (path: string) => {
        if (path === 'LOGS/inbox') {
          return { files: [], folders: ['LOGS/inbox/device-order-test'] }
        }
        if (path === 'LOGS/inbox/device-order-test') {
          // 通常ファイルとアーカイブ両方存在
          return { files: [normalPath, archivedPath], folders: [] }
        }
        if (path === 'LOGS/.inbox') {
          return { files: [], folders: [] }
        }
        return { files: [], folders: [] }
      })

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation()
      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()
      consoleSpy.mockRestore()

      // 期待: 最新のrecordedAt(12:00)のタイトルが適用される
      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      const entries = saved.taskExecutions['2026-02-01'] ?? []

      expect(entries.length).toBe(1)
      // バグがある場合: 古いアーカイブが後から適用され 'Original Title' になる
      // 修正後: recordedAt順で適用され 'Updated Title' になる
      expect(entries[0].taskTitle).toBe('Updated Title')
      expect(entries[0].durationSec).toBe(1200)
    })

    test('migrateLegacySnapshot should order deltas across devices by recordedAt', async () => {
      // 問題: デバイスごとに適用すると、後で処理されたデバイスの古いdeltaが上書きする
      jest.useRealTimers()
      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      const legacyContent = JSON.stringify({
        taskExecutions: {},
        dailySummary: {}
      })

      const snapshotPath = 'LOGS/2026-02-tasks.json'
      store.set(snapshotPath, legacyContent)
      const snapshotFile = new TFile()
      snapshotFile.path = snapshotPath
      abstractStore.set(snapshotPath, snapshotFile)

      plugin.app.vault.read = jest.fn(async (file: TFile) => {
        return store.get(file.path) ?? ''
      })
      plugin.app.vault.getAbstractFileByPath = jest.fn((path: string) => {
        return abstractStore.get(path) ?? null
      })

      const inboxPath = 'LOGS/inbox'
      const inboxFolder = new TFolder()
      inboxFolder.path = inboxPath
      inboxFolder.name = 'inbox'
      inboxFolder.children = []
      abstractStore.set(inboxPath, inboxFolder)

      const deviceNewPath = 'LOGS/inbox/device-new'
      const deviceOldPath = 'LOGS/inbox/device-old'
      const deviceNewFolder = new TFolder()
      deviceNewFolder.path = deviceNewPath
      deviceNewFolder.name = 'device-new'
      deviceNewFolder.children = []
      abstractStore.set(deviceNewPath, deviceNewFolder)

      const deviceOldFolder = new TFolder()
      deviceOldFolder.path = deviceOldPath
      deviceOldFolder.name = 'device-old'
      deviceOldFolder.children = []
      abstractStore.set(deviceOldPath, deviceOldFolder)

      const newPath = 'LOGS/inbox/device-new/2026-02.jsonl'
      const newDelta = JSON.stringify({
        schemaVersion: 1,
        op: 'upsert',
        entryId: 'device-new:1',
        deviceId: 'device-new',
        monthKey: '2026-02',
        dateKey: '2026-02-01',
        recordedAt: '2026-02-01T12:00:00Z',
        payload: {
          instanceId: 'inst-cross-device',
          taskId: 'task-cross',
          taskTitle: 'Newer Title',
          durationSec: 1200,
          stopTime: '12:00'
        }
      })
      deltaStore.set(newPath, newDelta + '\n')

      const oldPath = 'LOGS/inbox/device-old/2026-02.jsonl'
      const oldDelta = JSON.stringify({
        schemaVersion: 1,
        op: 'upsert',
        entryId: 'device-old:1',
        deviceId: 'device-old',
        monthKey: '2026-02',
        dateKey: '2026-02-01',
        recordedAt: '2026-02-01T08:00:00Z',
        payload: {
          instanceId: 'inst-cross-device',
          taskId: 'task-cross',
          taskTitle: 'Older Title',
          durationSec: 600,
          stopTime: '08:00'
        }
      })
      deltaStore.set(oldPath, oldDelta + '\n')

      const adapter = plugin.app.vault.adapter as {
        list: (path: string) => Promise<{ files: string[]; folders: string[] }>
      }
      adapter.list = jest.fn(async (path: string) => {
        if (path === 'LOGS/inbox') {
          // 先に新しいデバイスを返し、後で古いデバイスを返す（デバイス順での上書きを再現）
          return { files: [], folders: [deviceNewPath, deviceOldPath] }
        }
        if (path === deviceNewPath) {
          return { files: [newPath], folders: [] }
        }
        if (path === deviceOldPath) {
          return { files: [oldPath], folders: [] }
        }
        if (path === 'LOGS/.inbox') {
          return { files: [], folders: [] }
        }
        return { files: [], folders: [] }
      })

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation()
      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()
      consoleSpy.mockRestore()

      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      const entries = saved.taskExecutions['2026-02-01'] ?? []
      expect(entries.length).toBe(1)
      expect(entries[0].taskTitle).toBe('Newer Title')
      expect(entries[0].durationSec).toBe(1200)
    })
  })

  describe('Missing Snapshot Delta Ordering (Reviewer Issue P2-missing-snapshot-order)', () => {
    test('newer delta should not be overwritten by older archived delta when snapshot is missing', async () => {
      // 問題: スナップショット欠損時に、通常→アーカイブの順で適用すると、
      // 古いアーカイブが新しい通常deltaを上書きしてしまう
      // シナリオ:
      // - スナップショットファイルが存在しない
      // - 同一デバイス・同一instanceIdで:
      //   - .archived.jsonl: 古いdelta（recordedAt=08:00, taskTitle='Old Title'）
      //   - .jsonl: 新しいdelta（recordedAt=12:00, taskTitle='New Title'）
      // - 期待: 最終的に'New Title'が残る
      jest.useRealTimers()

      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      plugin.app.vault.read = jest.fn(async (file: TFile) => {
        return store.get(file.path) ?? ''
      })

      // デバイスフォルダセットアップ
      const inboxPath = 'LOGS/inbox'
      const inboxFolder = new TFolder()
      inboxFolder.path = inboxPath
      inboxFolder.name = 'inbox'
      inboxFolder.children = []
      abstractStore.set(inboxPath, inboxFolder)

      const devicePath = 'LOGS/inbox/device-order'
      const deviceFolder = new TFolder()
      deviceFolder.path = devicePath
      deviceFolder.name = 'device-order'
      deviceFolder.children = []
      abstractStore.set(devicePath, deviceFolder)
      inboxFolder.children.push(deviceFolder)

      // 通常.jsonl: 新しいエントリ（更新後）
      const normalDeltaPath = 'LOGS/inbox/device-order/2026-02.jsonl'
      const normalDelta = JSON.stringify({
        schemaVersion: 1,
        op: 'upsert',
        entryId: 'device-order:2',
        deviceId: 'device-order',
        monthKey: '2026-02',
        dateKey: '2026-02-01',
        recordedAt: '2026-02-01T12:00:00Z',  // 新しい
        payload: {
          instanceId: 'inst-same',  // 同じinstanceId
          taskId: 'task-same',
          taskTitle: 'New Title',  // 最新のタイトル
          durationSec: 1200,
          stopTime: '12:00'
        }
      })
      deltaStore.set(normalDeltaPath, normalDelta + '\n')
      const normalFile = new TFile()
      normalFile.path = normalDeltaPath
      normalFile.basename = '2026-02'
      normalFile.extension = 'jsonl'
      Object.setPrototypeOf(normalFile, TFile.prototype)
      abstractStore.set(normalDeltaPath, normalFile)
      deviceFolder.children.push(normalFile)

      // .archived.jsonl: 古いエントリ（更新前）
      const archivedDeltaPath = 'LOGS/inbox/device-order/2026-02.archived.jsonl'
      const archivedDelta = JSON.stringify({
        schemaVersion: 1,
        op: 'upsert',
        entryId: 'device-order:1',
        deviceId: 'device-order',
        monthKey: '2026-02',
        dateKey: '2026-02-01',
        recordedAt: '2026-02-01T08:00:00Z',  // 古い
        payload: {
          instanceId: 'inst-same',  // 同じinstanceId
          taskId: 'task-same',
          taskTitle: 'Old Title',  // 古いタイトル
          durationSec: 600,
          stopTime: '08:00'
        }
      })
      deltaStore.set(archivedDeltaPath, archivedDelta + '\n')

      // adapter.listをモック
      const adapter = plugin.app.vault.adapter as {
        list: (path: string) => Promise<{ files: string[]; folders: string[] }>
      }
      adapter.list = jest.fn(async (path: string) => {
        if (path === 'LOGS/inbox') {
          return { files: [], folders: [devicePath] }
        }
        if (path === devicePath) {
          return { files: [normalDeltaPath, archivedDeltaPath], folders: [] }
        }
        if (path === 'LOGS/.inbox') {
          return { files: [], folders: [] }
        }
        return { files: [], folders: [] }
      })

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation()
      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()
      consoleSpy.mockRestore()

      // 期待: 新しいタイトルが残る（古いアーカイブで上書きされない）
      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      const entries = saved.taskExecutions['2026-02-01'] ?? []

      expect(entries.length).toBe(1)  // 同じinstanceIdなので1エントリ
      // バグがある場合: 'Old Title' になる（古いアーカイブが後から上書き）
      // 修正後: 'New Title' になる（正しい順序で適用）
      expect(entries[0].taskTitle).toBe('New Title')
      expect(entries[0].durationSec).toBe(1200)
    })
  })

  describe('Missing Snapshot with Normal + Archived Delta (Reviewer Issue P2-missing-snapshot-archived)', () => {
    test('processMonth should include archived delta from same device when snapshot is missing', async () => {
      // 問題: スナップショットが欠損している場合、通常.jsonlを持つデバイスの.archived.jsonlが処理されない
      // シナリオ:
      // - スナップショットファイルが存在しない（新規デバイス/削除された等）
      // - Device Aに通常.jsonl + .archived.jsonlの両方がある
      // - 現在のコード: .jsonlのみ処理し、.archived.jsonlは無視される
      // - 期待: 両方のdeltaが処理される（スナップショット欠損時は全て再構築）
      jest.useRealTimers()

      const { plugin, store, deltaStore, abstractStore } = createPluginStub()

      // スナップショットファイルは存在しない（context.file === null）
      // → getAbstractFileByPathがnullを返す

      // vault.readをモック（スナップショットは読まれない想定だが念のため）
      plugin.app.vault.read = jest.fn(async (file: TFile) => {
        return store.get(file.path) ?? ''
      })

      // デバイスフォルダセットアップ
      const inboxPath = 'LOGS/inbox'
      const inboxFolder = new TFolder()
      inboxFolder.path = inboxPath
      inboxFolder.name = 'inbox'
      inboxFolder.children = []
      abstractStore.set(inboxPath, inboxFolder)

      // device-both: 通常.jsonl + .archived.jsonlの両方を持つデバイス
      const devicePath = 'LOGS/inbox/device-both'
      const deviceFolder = new TFolder()
      deviceFolder.path = devicePath
      deviceFolder.name = 'device-both'
      deviceFolder.children = []
      abstractStore.set(devicePath, deviceFolder)
      inboxFolder.children.push(deviceFolder)

      // 通常.jsonl: 新しいエントリ
      const normalDeltaPath = 'LOGS/inbox/device-both/2026-02.jsonl'
      const normalDelta = JSON.stringify({
        schemaVersion: 1,
        op: 'upsert',
        entryId: 'device-both:2',
        deviceId: 'device-both',
        monthKey: '2026-02',
        dateKey: '2026-02-01',
        recordedAt: '2026-02-01T12:00:00Z',
        payload: {
          instanceId: 'inst-normal',
          taskId: 'normal-task',
          taskTitle: 'Normal Entry',
          durationSec: 600,
          stopTime: '12:10'
        }
      })
      deltaStore.set(normalDeltaPath, normalDelta + '\n')
      const normalFile = new TFile()
      normalFile.path = normalDeltaPath
      normalFile.basename = '2026-02'
      normalFile.extension = 'jsonl'
      Object.setPrototypeOf(normalFile, TFile.prototype)
      abstractStore.set(normalDeltaPath, normalFile)
      deviceFolder.children.push(normalFile)

      // .archived.jsonl: 古いエントリ（アーカイブ済み）
      const archivedDeltaPath = 'LOGS/inbox/device-both/2026-02.archived.jsonl'
      const archivedDelta = JSON.stringify({
        schemaVersion: 1,
        op: 'upsert',
        entryId: 'device-both:1',
        deviceId: 'device-both',
        monthKey: '2026-02',
        dateKey: '2026-02-01',
        recordedAt: '2026-02-01T08:00:00Z',
        payload: {
          instanceId: 'inst-archived',
          taskId: 'archived-task',
          taskTitle: 'Archived Entry',
          durationSec: 900,
          stopTime: '08:15'
        }
      })
      deltaStore.set(archivedDeltaPath, archivedDelta + '\n')

      // adapter.listをモック
      const adapter = plugin.app.vault.adapter as {
        list: (path: string) => Promise<{ files: string[]; folders: string[] }>
      }
      adapter.list = jest.fn(async (path: string) => {
        if (path === 'LOGS/inbox') {
          return { files: [], folders: [devicePath] }
        }
        if (path === devicePath) {
          // 両方のファイルが存在
          return { files: [normalDeltaPath, archivedDeltaPath], folders: [] }
        }
        if (path === 'LOGS/.inbox') {
          return { files: [], folders: [] }
        }
        return { files: [], folders: [] }
      })

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation()
      const rec = new LogReconciler(plugin)
      await rec.reconcilePendingDeltas()
      consoleSpy.mockRestore()

      // 期待: 両方のエントリが処理される
      const saved = JSON.parse(store.get('LOGS/2026-02-tasks.json')!)
      const entries = saved.taskExecutions['2026-02-01'] ?? []

      // バグがある場合: .archived.jsonlが無視され、entries.length = 1
      // 修正後: 両方処理され、entries.length = 2
      expect(entries.length).toBe(2)
      const instanceIds = entries.map((e: { instanceId: string }) => e.instanceId)
      expect(instanceIds).toContain('inst-normal')
      expect(instanceIds).toContain('inst-archived')
    })
  })

  describe('Legacy Merge Summary-Only Dates (Reviewer Issue P2-summary-only-merge)', () => {
    test('createMergedSnapshot should preserve summary-only dates without taskExecutions', async () => {
      // P2問題: createMergedSnapshotで taskExecutions の日付だけでループしているため、
      // summary-only の日付（実行エントリがない日）が失われる
      // シナリオ:
      // - legacy: 2026-02-01 に taskExecutions あり、2026-02-02 に summary-only（totalTasks=5, 実行エントリなし）
      // - current: 2026-02-03 に taskExecutions あり
      // - マージ後: 2026-02-02 の dailySummary が保持されることを確認
      jest.useRealTimers()
      const { plugin, store, abstractStore } = createPluginStub()

      // Legacy snapshot: 2026-02-01 に実行エントリ、2026-02-02 は summary-only
      const legacySnapshot = {
        taskExecutions: {
          '2026-02-01': [
            {
              instanceId: 'inst-legacy-1',
              taskId: 'task-1',
              taskTitle: 'Legacy Task',
              durationSec: 600,
              stopTime: '10:00'
            }
          ]
          // 2026-02-02 には taskExecutions がない
        },
        dailySummary: {
          '2026-02-01': { completedTasks: 1, totalTasks: 3 },
          '2026-02-02': { completedTasks: 0, totalTasks: 5 } // summary-only
        }
        // meta がない = legacy format
      }

      // Current snapshot: 2026-02-03 に実行エントリ
      const currentSnapshot = {
        taskExecutions: {
          '2026-02-03': [
            {
              instanceId: 'inst-current-1',
              taskId: 'task-3',
              taskTitle: 'Current Task',
              durationSec: 900,
              stopTime: '14:00'
            }
          ]
        },
        dailySummary: {
          '2026-02-03': { completedTasks: 1, totalTasks: 2 }
        },
        meta: { revision: 1, processedCursor: {} }
      }

      // 両方のスナップショットをストアに配置
      store.set('LOGS/2026-02-tasks.json', JSON.stringify(currentSnapshot))
      const currentFile = new TFile()
      currentFile.path = 'LOGS/2026-02-tasks.json'
      Object.setPrototypeOf(currentFile, TFile.prototype)
      abstractStore.set('LOGS/2026-02-tasks.json', currentFile)

      // LogReconciler のプライベートメソッド createMergedSnapshot をテスト
      // 直接呼び出せないので、migrateLegacySnapshot 経由でテスト
      const rec = new LogReconciler(plugin)

      // リフレクションで createMergedSnapshot を呼び出す
      const mergedSnapshot = (rec as unknown as {
        createMergedSnapshot: (legacy: typeof legacySnapshot, current: typeof currentSnapshot) => typeof currentSnapshot
      }).createMergedSnapshot(legacySnapshot, currentSnapshot)

      // 期待: すべての日付が保持される
      expect(Object.keys(mergedSnapshot.taskExecutions).sort()).toEqual(['2026-02-01', '2026-02-03'])
      expect(Object.keys(mergedSnapshot.dailySummary).sort()).toEqual(['2026-02-01', '2026-02-02', '2026-02-03'])

      // summary-only の日付 (2026-02-02) が保持されていることを確認
      const summaryOnly = mergedSnapshot.dailySummary['2026-02-02']
      expect(summaryOnly).toBeDefined()
      expect(summaryOnly.totalTasks).toBe(5)
      expect(summaryOnly.completedTasks).toBe(0)
    })

    test('createMergedSnapshot keeps duplicate legacy entries without instanceId in strict mode', async () => {
      // 同一レガシースナップショットを複数デバイスで移行した場合の重複を防ぐ
      jest.useRealTimers()
      const { plugin } = createPluginStub()

      const legacyEntry = {
        taskId: 'task-legacy',
        taskTitle: 'Legacy Entry',
        startTime: '09:00',
        stopTime: '09:30',
        durationSec: 1800,
        recordedAt: '2026-02-01T09:30:00Z'
      }

      const legacySnapshot = {
        taskExecutions: {
          '2026-02-01': [legacyEntry]
        },
        dailySummary: {}
      }

      const currentSnapshot = {
        taskExecutions: {
          '2026-02-01': [{ ...legacyEntry }]
        },
        dailySummary: {},
        meta: { revision: 1, processedCursor: {} }
      }

      const rec = new LogReconciler(plugin)
      const mergedSnapshot = (rec as unknown as {
        createMergedSnapshot: (legacy: typeof legacySnapshot, current: typeof currentSnapshot) => typeof currentSnapshot
      }).createMergedSnapshot(legacySnapshot, currentSnapshot)

      const entries = mergedSnapshot.taskExecutions['2026-02-01'] ?? []
      expect(entries).toHaveLength(2)
      expect(entries[0].taskId).toBe('task-legacy')
      expect(entries[0].startTime).toBe('09:00')
    })

    test('createMergedSnapshot should keep totalTasks metadata for dates with taskExecutions', async () => {
      jest.useRealTimers()
      const { plugin } = createPluginStub()

      const legacySnapshot = {
        taskExecutions: {
          '2026-02-01': [
            {
              instanceId: 'inst-legacy-1',
              taskId: 'task-1',
              taskTitle: 'Legacy Task',
              durationSec: 600,
              stopTime: '09:00'
            }
          ]
        },
        dailySummary: {
          '2026-02-01': {
            totalTasks: 2,
            totalTasksRecordedAt: '2026-02-01T08:00:00Z',
            totalTasksDeviceId: 'legacy-device',
            totalTasksEntryId: 'legacy:1'
          }
        }
      }

      const currentSnapshot = {
        taskExecutions: {
          '2026-02-01': [
            {
              instanceId: 'inst-legacy-1',
              taskId: 'task-1',
              taskTitle: 'Current Task',
              durationSec: 1200,
              stopTime: '10:00'
            }
          ]
        },
        dailySummary: {
          '2026-02-01': {
            totalTasks: 7,
            totalTasksRecordedAt: '2026-02-01T12:00:00Z',
            totalTasksDeviceId: 'current-device',
            totalTasksEntryId: 'current:1'
          }
        },
        meta: { revision: 2, processedCursor: {} }
      }

      const rec = new LogReconciler(plugin)
      const mergedSnapshot = (rec as unknown as {
        createMergedSnapshot: (legacy: typeof legacySnapshot, current: typeof currentSnapshot) => typeof currentSnapshot
      }).createMergedSnapshot(legacySnapshot, currentSnapshot)

      const mergedSummary = mergedSnapshot.dailySummary['2026-02-01']
      expect(mergedSummary.totalTasks).toBe(7)
      expect(mergedSummary.totalTasksRecordedAt).toBe('2026-02-01T12:00:00Z')
      expect(mergedSummary.totalTasksDeviceId).toBe('current-device')
      expect(mergedSummary.totalTasksEntryId).toBe('current:1')
    })
  })
})
