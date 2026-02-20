/**
 * Tests for mergeOrders and mergeDuplicatedInstances extracted functions in conflictResolver.
 */
import { mergeOrders, mergeDuplicatedInstances } from '../../src/services/dayState/conflictResolver'

describe('mergeOrders', () => {
  it('returns local orders when remote is empty', () => {
    const result = mergeOrders(
      { a: 1, b: 2 },
      { a: { order: 1, updatedAt: 100 }, b: { order: 2, updatedAt: 200 } },
      {},
      {},
    )
    expect(result.merged).toEqual({ a: 1, b: 2 })
    expect(result.meta).toEqual({
      a: { order: 1, updatedAt: 100 },
      b: { order: 2, updatedAt: 200 },
    })
    expect(result.hasConflicts).toBe(false)
  })

  it('returns remote orders when local is empty', () => {
    const result = mergeOrders(
      {},
      {},
      { a: 5, b: 10 },
      { a: { order: 5, updatedAt: 300 }, b: { order: 10, updatedAt: 400 } },
    )
    expect(result.merged).toEqual({ a: 5, b: 10 })
  })

  it('newer updatedAt wins in conflict', () => {
    const result = mergeOrders(
      { a: 1 },
      { a: { order: 1, updatedAt: 100 } },
      { a: 5 },
      { a: { order: 5, updatedAt: 200 } },
    )
    expect(result.merged.a).toBe(5)
    expect(result.meta.a.updatedAt).toBe(200)
    expect(result.hasConflicts).toBe(true)
    expect(result.conflictCount).toBe(1)
  })

  it('local wins when updatedAt is equal', () => {
    const result = mergeOrders(
      { a: 1 },
      { a: { order: 1, updatedAt: 100 } },
      { a: 5 },
      { a: { order: 5, updatedAt: 100 } },
    )
    expect(result.merged.a).toBe(1)
    expect(result.hasConflicts).toBe(false) // same updatedAt = no conflict
  })

  it('prefers meta-having side when one side has no meta', () => {
    const result = mergeOrders(
      { a: 1 },
      { a: { order: 1, updatedAt: 100 } },
      { a: 5 },
      {},
    )
    expect(result.merged.a).toBe(1) // local has meta, remote doesn't
    expect(result.meta.a.updatedAt).toBe(100)
  })

  it('does not drop local meta-backed key only because remote month is newer', () => {
    const result = mergeOrders(
      { a: 1 },
      { a: { order: 1, updatedAt: 100 } },
      {},
      {},
      { remoteMonthUpdatedAt: 200 },
    )
    expect(result.merged.a).toBe(1)
    expect(result.meta.a.updatedAt).toBe(100)
  })

  it('prefers remote in legacy/no-meta cases', () => {
    const result = mergeOrders(
      { a: 1 },
      {},
      { a: 5 },
      {},
    )
    expect(result.merged.a).toBe(5) // remote preferred in no-meta case
  })

  it('keeps local meta-backed key when local update is newer than remote month', () => {
    const result = mergeOrders(
      { a: 1 },
      { a: { order: 1, updatedAt: 300 } },
      {},
      {},
      { remoteMonthUpdatedAt: 200 },
    )
    expect(result.merged.a).toBe(1)
    expect(result.meta.a.updatedAt).toBe(300)
  })

  it('merges disjoint keys from both sides', () => {
    const result = mergeOrders(
      { a: 1 },
      { a: { order: 1, updatedAt: 100 } },
      { b: 2 },
      { b: { order: 2, updatedAt: 200 } },
    )
    expect(result.merged).toEqual({ a: 1, b: 2 })
    expect(result.hasConflicts).toBe(false)
  })
})

describe('mergeDuplicatedInstances', () => {
  const emptyDeletedInfo = {
    deletedInstanceIds: new Set<string>(),
    deletedPaths: new Set<string>(),
    deletedTaskIds: new Set<string>(),
  }

  it('merges local and remote without duplicates', () => {
    const result = mergeDuplicatedInstances(
      [{ instanceId: 'a', originalPath: 'TASKS/1.md' }],
      [{ instanceId: 'b', originalPath: 'TASKS/2.md' }],
      emptyDeletedInfo,
    )
    expect(result.merged).toHaveLength(2)
    expect(result.merged.map((d) => d.instanceId)).toEqual(['a', 'b'])
    expect(result.hasConflicts).toBe(false)
  })

  it('deduplicates by instanceId, keeping local (first writer)', () => {
    const result = mergeDuplicatedInstances(
      [{ instanceId: 'a', originalPath: 'TASKS/1.md' }],
      [{ instanceId: 'a', originalPath: 'TASKS/1.md' }],
      emptyDeletedInfo,
    )
    expect(result.merged).toHaveLength(1)
    expect(result.hasConflicts).toBe(false)
    expect(result.conflictCount).toBe(0)
  })

  it('counts conflict when duplicate instanceId has different payload', () => {
    const result = mergeDuplicatedInstances(
      [{ instanceId: 'a', originalPath: 'TASKS/1.md', slotKey: '8:00-12:00' }],
      [{ instanceId: 'a', originalPath: 'TASKS/1.md', slotKey: '12:00-16:00' }],
      emptyDeletedInfo,
    )
    expect(result.merged).toHaveLength(1)
    expect(result.hasConflicts).toBe(true)
    expect(result.conflictCount).toBe(1)
  })

  it('suppresses instances with deleted instanceId', () => {
    const result = mergeDuplicatedInstances(
      [{ instanceId: 'a', originalPath: 'TASKS/1.md' }],
      [{ instanceId: 'b', originalPath: 'TASKS/2.md' }],
      {
        deletedInstanceIds: new Set(['a']),
        deletedPaths: new Set(),
        deletedTaskIds: new Set(),
      },
    )
    expect(result.merged).toHaveLength(1)
    expect(result.merged[0].instanceId).toBe('b')
  })

  it('suppresses instances with deleted taskId', () => {
    const result = mergeDuplicatedInstances(
      [{ instanceId: 'a', originalPath: 'TASKS/1.md', originalTaskId: 'task-1' }],
      [],
      {
        deletedInstanceIds: new Set(),
        deletedPaths: new Set(),
        deletedTaskIds: new Set(['task-1']),
      },
    )
    expect(result.merged).toHaveLength(0)
  })

  it('suppresses instances with deleted path', () => {
    const result = mergeDuplicatedInstances(
      [],
      [{ instanceId: 'a', originalPath: 'TASKS/deleted.md' }],
      {
        deletedInstanceIds: new Set(),
        deletedPaths: new Set(['TASKS/deleted.md']),
        deletedTaskIds: new Set(),
      },
    )
    expect(result.merged).toHaveLength(0)
  })
})
