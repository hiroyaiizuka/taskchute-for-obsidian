/**
 * DayState 競合解決のテスト
 *
 * OR-Set + Tombstone 方式に基づく同期競合解決をテスト：
 * - 削除と復元はタイムスタンプで勝敗決定
 * - より新しい操作が勝つ
 */
import {
  mergeDeletedInstances,
  mergeHiddenRoutines,
  mergeSlotOverrides,
  getEffectiveDeletedAt,
  isDeleted,
} from '../../src/services/dayState/conflictResolver'
import type { DeletedInstance, HiddenRoutine, SlotOverrideEntry } from '../../src/types'

describe('getEffectiveDeletedAt', () => {
  test('returns deletedAt when present', () => {
    const entry: DeletedInstance = {
      path: 'TASKS/foo.md',
      deletedAt: 1000,
    }
    expect(getEffectiveDeletedAt(entry)).toBe(1000)
  })

  test('falls back to timestamp when deletedAt is missing', () => {
    const entry: DeletedInstance = {
      path: 'TASKS/foo.md',
      timestamp: 500,
    }
    expect(getEffectiveDeletedAt(entry)).toBe(500)
  })

  test('prefers deletedAt over timestamp', () => {
    const entry: DeletedInstance = {
      path: 'TASKS/foo.md',
      deletedAt: 1000,
      timestamp: 500,
    }
    expect(getEffectiveDeletedAt(entry)).toBe(1000)
  })

  test('returns 0 when neither deletedAt nor timestamp is present', () => {
    const entry: DeletedInstance = {
      path: 'TASKS/foo.md',
    }
    expect(getEffectiveDeletedAt(entry)).toBe(0)
  })
})

describe('isDeleted', () => {
  test('returns true when deletedAt is present and no restoredAt', () => {
    const entry: DeletedInstance = {
      path: 'TASKS/foo.md',
      deletedAt: 1000,
    }
    expect(isDeleted(entry)).toBe(true)
  })

  test('returns false when restoredAt is newer than deletedAt', () => {
    const entry: DeletedInstance = {
      path: 'TASKS/foo.md',
      deletedAt: 1000,
      restoredAt: 2000,
    }
    expect(isDeleted(entry)).toBe(false)
  })

  test('returns true when deletedAt is newer than restoredAt', () => {
    const entry: DeletedInstance = {
      path: 'TASKS/foo.md',
      deletedAt: 2000,
      restoredAt: 1000,
    }
    expect(isDeleted(entry)).toBe(true)
  })

  test('returns true when deletedAt equals restoredAt (deletion wins tie)', () => {
    const entry: DeletedInstance = {
      path: 'TASKS/foo.md',
      deletedAt: 1000,
      restoredAt: 1000,
    }
    expect(isDeleted(entry)).toBe(true)
  })

  test('returns false when neither deletedAt nor timestamp is present', () => {
    const entry: DeletedInstance = {
      path: 'TASKS/foo.md',
    }
    expect(isDeleted(entry)).toBe(false)
  })
})

describe('mergeDeletedInstances', () => {
  describe('basic merging', () => {
    test('returns local entries when remote is empty', () => {
      const local: DeletedInstance[] = [
        { path: 'TASKS/foo.md', deletedAt: 1000, deletionType: 'permanent' },
      ]
      const remote: DeletedInstance[] = []

      const result = mergeDeletedInstances(local, remote)

      expect(result.merged).toHaveLength(1)
      expect(result.merged[0].path).toBe('TASKS/foo.md')
      expect(result.hasConflicts).toBe(false)
    })

    test('returns remote entries when local is empty', () => {
      const local: DeletedInstance[] = []
      const remote: DeletedInstance[] = [
        { path: 'TASKS/bar.md', deletedAt: 1000, deletionType: 'permanent' },
      ]

      const result = mergeDeletedInstances(local, remote)

      expect(result.merged).toHaveLength(1)
      expect(result.merged[0].path).toBe('TASKS/bar.md')
      expect(result.hasConflicts).toBe(false)
    })

    test('merges entries with different paths', () => {
      const local: DeletedInstance[] = [
        { path: 'TASKS/foo.md', deletedAt: 1000, deletionType: 'permanent' },
      ]
      const remote: DeletedInstance[] = [
        { path: 'TASKS/bar.md', deletedAt: 2000, deletionType: 'permanent' },
      ]

      const result = mergeDeletedInstances(local, remote)

      expect(result.merged).toHaveLength(2)
      expect(result.hasConflicts).toBe(false)
    })
  })

  describe('conflict resolution by path', () => {
    test('local deletion wins when remote has no deletion for same path', () => {
      const local: DeletedInstance[] = [
        { path: 'TASKS/foo.md', deletedAt: 1000, deletionType: 'permanent' },
      ]
      const remote: DeletedInstance[] = [
        { path: 'TASKS/foo.md' }, // no deletedAt means not actually deleted
      ]

      const result = mergeDeletedInstances(local, remote)

      expect(result.merged).toHaveLength(1)
      expect(result.merged[0].deletedAt).toBe(1000)
    })

    test('newer deletion wins when both have deletion', () => {
      const local: DeletedInstance[] = [
        { path: 'TASKS/foo.md', deletedAt: 1000, deletionType: 'permanent' },
      ]
      const remote: DeletedInstance[] = [
        { path: 'TASKS/foo.md', deletedAt: 2000, deletionType: 'permanent' },
      ]

      const result = mergeDeletedInstances(local, remote)

      expect(result.merged).toHaveLength(1)
      expect(result.merged[0].deletedAt).toBe(2000)
      expect(result.hasConflicts).toBe(true)
    })

    test('restoration wins when newer than deletion', () => {
      const local: DeletedInstance[] = [
        { path: 'TASKS/foo.md', deletedAt: 1000, deletionType: 'permanent' },
      ]
      const remote: DeletedInstance[] = [
        { path: 'TASKS/foo.md', deletedAt: 1000, restoredAt: 2000, deletionType: 'permanent' },
      ]

      const result = mergeDeletedInstances(local, remote)

      expect(result.merged).toHaveLength(1)
      expect(result.merged[0].restoredAt).toBe(2000)
      expect(isDeleted(result.merged[0])).toBe(false)
      expect(result.hasConflicts).toBe(true)
    })

    test('deletion wins when newer than restoration', () => {
      const local: DeletedInstance[] = [
        { path: 'TASKS/foo.md', deletedAt: 2000, restoredAt: 1000, deletionType: 'permanent' },
      ]
      const remote: DeletedInstance[] = [
        { path: 'TASKS/foo.md', deletedAt: 1000, restoredAt: 1500, deletionType: 'permanent' },
      ]

      const result = mergeDeletedInstances(local, remote)

      expect(result.merged).toHaveLength(1)
      expect(result.merged[0].deletedAt).toBe(2000)
      expect(result.merged[0].restoredAt).toBe(1500)
      expect(isDeleted(result.merged[0])).toBe(true)
      expect(result.hasConflicts).toBe(true)
    })
  })

  describe('conflict resolution by taskId', () => {
    test('merges by taskId when present', () => {
      const local: DeletedInstance[] = [
        { taskId: 'task-1', path: 'TASKS/old-name.md', deletedAt: 1000, deletionType: 'permanent' },
      ]
      const remote: DeletedInstance[] = [
        { taskId: 'task-1', path: 'TASKS/new-name.md', deletedAt: 2000, deletionType: 'permanent' },
      ]

      const result = mergeDeletedInstances(local, remote)

      expect(result.merged).toHaveLength(1)
      expect(result.merged[0].taskId).toBe('task-1')
      expect(result.merged[0].deletedAt).toBe(2000)
      expect(result.merged[0].path).toBe('TASKS/new-name.md')
    })

    test('keeps latest path and deletionType when remote entry is older', () => {
      const local: DeletedInstance[] = [
        { taskId: 'task-1', path: 'TASKS/renamed.md', deletedAt: 2000, deletionType: 'permanent' },
      ]
      const remote: DeletedInstance[] = [
        { taskId: 'task-1', path: 'TASKS/old.md', deletedAt: 1000, deletionType: 'temporary' },
      ]

      const result = mergeDeletedInstances(local, remote)

      expect(result.merged).toHaveLength(1)
      expect(result.merged[0].deletedAt).toBe(2000)
      expect(result.merged[0].path).toBe('TASKS/renamed.md')
      expect(result.merged[0].deletionType).toBe('permanent')
    })

    test('merges legacy path deletion into taskId entry when path matches', () => {
      const local: DeletedInstance[] = [
        { path: 'TASKS/foo.md', deletedAt: 1000, deletionType: 'permanent' }, // legacy (no taskId)
      ]
      const remote: DeletedInstance[] = [
        {
          taskId: 'task-1',
          path: 'TASKS/foo.md',
          deletedAt: 1000,
          restoredAt: 2000,
          deletionType: 'permanent',
        },
      ]

      const result = mergeDeletedInstances(local, remote)

      expect(result.merged).toHaveLength(1)
      expect(result.merged[0].taskId).toBe('task-1')
      expect(isDeleted(result.merged[0])).toBe(false)
    })
  })

  describe('instance-scoped deletions', () => {
    test('keeps temporary deletions separate when instanceId differs', () => {
      const local: DeletedInstance[] = [
        {
          taskId: 'task-1',
          path: 'TASKS/foo.md',
          instanceId: 'inst-1',
          deletionType: 'temporary',
          deletedAt: 1000,
        },
      ]
      const remote: DeletedInstance[] = [
        {
          taskId: 'task-1',
          path: 'TASKS/foo.md',
          instanceId: 'inst-2',
          deletionType: 'temporary',
          deletedAt: 2000,
        },
      ]

      const result = mergeDeletedInstances(local, remote)

      expect(result.merged).toHaveLength(2)
      const instanceIds = result.merged.map((entry) => entry.instanceId)
      expect(instanceIds).toContain('inst-1')
      expect(instanceIds).toContain('inst-2')
    })
  })

  describe('real-world sync scenario', () => {
    test('PC deletion is preserved when mobile has old state', () => {
      // Scenario:
      // 1. PC deletes task at t=1000
      // 2. Mobile has old state (no deletion)
      // 3. Sync happens, PC should keep deletion

      const pcState: DeletedInstance[] = [
        { path: 'TASKS/foo.md', deletedAt: 1000, deletionType: 'permanent' },
      ]
      const mobileState: DeletedInstance[] = [] // No deletion

      const result = mergeDeletedInstances(pcState, mobileState)

      expect(result.merged).toHaveLength(1)
      expect(isDeleted(result.merged[0])).toBe(true)
    })

    test('restoration propagates from mobile to PC', () => {
      // Scenario:
      // 1. Task was deleted on both devices at t=1000
      // 2. Mobile restores the task at t=2000
      // 3. Sync happens, PC should see restored task

      const pcState: DeletedInstance[] = [
        { path: 'TASKS/foo.md', deletedAt: 1000, deletionType: 'permanent' },
      ]
      const mobileState: DeletedInstance[] = [
        { path: 'TASKS/foo.md', deletedAt: 1000, restoredAt: 2000, deletionType: 'permanent' },
      ]

      const result = mergeDeletedInstances(pcState, mobileState)

      expect(result.merged).toHaveLength(1)
      expect(isDeleted(result.merged[0])).toBe(false)
    })
  })
})

describe('mergeHiddenRoutines', () => {
  describe('basic merging', () => {
    test('returns local entries when remote is empty', () => {
      const local: HiddenRoutine[] = [
        { path: 'TASKS/routine.md', hiddenAt: 1000 },
      ]
      const remote: HiddenRoutine[] = []

      const result = mergeHiddenRoutines(local, remote)

      expect(result.merged).toHaveLength(1)
    })

    test('merges entries with different paths', () => {
      const local: HiddenRoutine[] = [
        { path: 'TASKS/routine1.md', hiddenAt: 1000 },
      ]
      const remote: HiddenRoutine[] = [
        { path: 'TASKS/routine2.md', hiddenAt: 2000 },
      ]

      const result = mergeHiddenRoutines(local, remote)

      expect(result.merged).toHaveLength(2)
    })

    test('normalizes legacy string entries before merge', () => {
      const local: Array<HiddenRoutine | string> = ['TASKS/legacy-a.md']
      const remote: Array<HiddenRoutine | string> = ['TASKS/legacy-b.md']

      const result = mergeHiddenRoutines(local, remote)

      expect(result.merged).toHaveLength(2)
      const paths = result.merged.map((entry) => entry.path)
      expect(paths).toContain('TASKS/legacy-a.md')
      expect(paths).toContain('TASKS/legacy-b.md')
    })
  })

  describe('conflict resolution', () => {
    test('newer hide wins over older hide', () => {
      const local: HiddenRoutine[] = [
        { path: 'TASKS/routine.md', hiddenAt: 1000 },
      ]
      const remote: HiddenRoutine[] = [
        { path: 'TASKS/routine.md', hiddenAt: 2000 },
      ]

      const result = mergeHiddenRoutines(local, remote)

      expect(result.merged).toHaveLength(1)
      expect(result.merged[0].hiddenAt).toBe(2000)
    })

    test('restoration wins when newer than hide', () => {
      const local: HiddenRoutine[] = [
        { path: 'TASKS/routine.md', hiddenAt: 1000 },
      ]
      const remote: HiddenRoutine[] = [
        { path: 'TASKS/routine.md', hiddenAt: 1000, restoredAt: 2000 },
      ]

      const result = mergeHiddenRoutines(local, remote)

      expect(result.merged).toHaveLength(1)
      expect(result.merged[0].restoredAt).toBe(2000)
    })

    test('handles entries with instanceId', () => {
      const local: HiddenRoutine[] = [
        { path: 'TASKS/routine.md', instanceId: 'inst-1', hiddenAt: 1000 },
      ]
      const remote: HiddenRoutine[] = [
        { path: 'TASKS/routine.md', instanceId: 'inst-1', hiddenAt: 2000 },
        { path: 'TASKS/routine.md', instanceId: 'inst-2', hiddenAt: 3000 },
      ]

      const result = mergeHiddenRoutines(local, remote)

      expect(result.merged).toHaveLength(2)
      const inst1 = result.merged.find(e => e.instanceId === 'inst-1')
      expect(inst1?.hiddenAt).toBe(2000)
    })
  })
})

describe('mergeSlotOverrides', () => {
  test('returns local when remote is empty', () => {
    const local: Record<string, string> = { 'task-1': 'slot-a' }
    const localMeta: Record<string, SlotOverrideEntry> = {
      'task-1': { slotKey: 'slot-a', updatedAt: 1000 },
    }
    const remote: Record<string, string> = {}
    const remoteMeta: Record<string, SlotOverrideEntry> = {}

    const result = mergeSlotOverrides(local, localMeta, remote, remoteMeta)

    expect(result.merged['task-1']).toBe('slot-a')
  })

  test('merges entries with different keys', () => {
    const local: Record<string, string> = { 'task-1': 'slot-a' }
    const localMeta: Record<string, SlotOverrideEntry> = {
      'task-1': { slotKey: 'slot-a', updatedAt: 1000 },
    }
    const remote: Record<string, string> = { 'task-2': 'slot-b' }
    const remoteMeta: Record<string, SlotOverrideEntry> = {
      'task-2': { slotKey: 'slot-b', updatedAt: 2000 },
    }

    const result = mergeSlotOverrides(local, localMeta, remote, remoteMeta)

    expect(result.merged['task-1']).toBe('slot-a')
    expect(result.merged['task-2']).toBe('slot-b')
  })

  test('newer update wins for same key', () => {
    const local: Record<string, string> = { 'task-1': 'slot-a' }
    const localMeta: Record<string, SlotOverrideEntry> = {
      'task-1': { slotKey: 'slot-a', updatedAt: 1000 },
    }
    const remote: Record<string, string> = { 'task-1': 'slot-b' }
    const remoteMeta: Record<string, SlotOverrideEntry> = {
      'task-1': { slotKey: 'slot-b', updatedAt: 2000 },
    }

    const result = mergeSlotOverrides(local, localMeta, remote, remoteMeta)

    expect(result.merged['task-1']).toBe('slot-b')
    expect(result.meta['task-1'].updatedAt).toBe(2000)
  })

  test('local wins when remote has no metadata', () => {
    const local: Record<string, string> = { 'task-1': 'slot-a' }
    const localMeta: Record<string, SlotOverrideEntry> = {
      'task-1': { slotKey: 'slot-a', updatedAt: 1000 },
    }
    const remote: Record<string, string> = { 'task-1': 'slot-b' }
    const remoteMeta: Record<string, SlotOverrideEntry> = {} // No metadata

    const result = mergeSlotOverrides(local, localMeta, remote, remoteMeta)

    expect(result.merged['task-1']).toBe('slot-a')
  })

  test('remote wins when both updates lack metadata', () => {
    const local: Record<string, string> = { 'task-1': 'slot-a' }
    const localMeta: Record<string, SlotOverrideEntry> = {}
    const remote: Record<string, string> = { 'task-1': 'slot-b' }
    const remoteMeta: Record<string, SlotOverrideEntry> = {}

    const result = mergeSlotOverrides(local, localMeta, remote, remoteMeta)

    expect(result.merged['task-1']).toBe('slot-b')
  })

  test('deletion tombstone wins over older remote value', () => {
    const local: Record<string, string> = {}
    const localMeta: Record<string, SlotOverrideEntry> = {
      'task-1': { slotKey: 'slot-a', updatedAt: 3000 },
    }
    const remote: Record<string, string> = { 'task-1': 'slot-b' }
    const remoteMeta: Record<string, SlotOverrideEntry> = {
      'task-1': { slotKey: 'slot-b', updatedAt: 2000 },
    }

    const result = mergeSlotOverrides(local, localMeta, remote, remoteMeta)

    expect(result.merged['task-1']).toBeUndefined()
    expect(result.meta['task-1'].updatedAt).toBe(3000)
  })
})
