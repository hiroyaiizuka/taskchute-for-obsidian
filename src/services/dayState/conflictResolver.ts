/**
 * DayState 競合解決モジュール
 *
 * OR-Set + Tombstone 方式に基づくクロスデバイス同期の競合解決を提供。
 * 基本原則:
 * - 削除は deletedAt タイムスタンプで記録
 * - 復元は restoredAt タイムスタンプで記録
 * - マージ時は max(deletedAt, restoredAt) で勝敗決定
 */
import type { DeletedInstance, DuplicatedInstance, HiddenRoutine, SlotOverrideEntry } from '../../types'

export interface ConflictResolution<T> {
  merged: T[]
  hasConflicts: boolean
  conflictCount: number
}

export interface SlotOverrideResolution {
  merged: Record<string, string>
  meta: Record<string, SlotOverrideEntry>
  hasConflicts: boolean
  conflictCount: number
}

export interface OrdersResolution {
  merged: Record<string, number>
  meta: Record<string, { order: number; updatedAt: number }>
  hasConflicts: boolean
  conflictCount: number
}

export interface DuplicatedInstancesResolution {
  merged: Array<DuplicatedInstance & { slotKey?: string; originalSlotKey?: string }>
  hasConflicts: boolean
  conflictCount: number
}

/**
 * DeletedInstance から有効な削除時刻を取得
 * deletedAt を優先し、なければ timestamp にフォールバック
 *
 * Note: Legacy data migration - 'timestamp' was renamed to 'deletedAt'.
 * Access via type assertion to avoid deprecated property warning.
 */
export function getEffectiveDeletedAt(entry: DeletedInstance): number {
  const legacyEntry = entry as { deletedAt?: number; timestamp?: number }
  return legacyEntry.deletedAt ?? legacyEntry.timestamp ?? 0
}

/**
 * DeletedInstance がレガシーデータ（有効なタイムスタンプがない）かを判定
 * 復元済みエントリは false を返す
 */
export function isLegacyDeletionEntry(entry: DeletedInstance): boolean {
  const restoredAt = entry.restoredAt ?? 0
  if (restoredAt > 0) {
    return false
  }
  const ts = getEffectiveDeletedAt(entry)
  return !(typeof ts === 'number' && Number.isFinite(ts) && ts > 0)
}

/**
 * DeletedInstance が実際に削除状態かを判定
 * restoredAt > deletedAt なら復元済み（削除されていない）
 */
export function isDeleted(entry: DeletedInstance): boolean {
  const deletedAt = getEffectiveDeletedAt(entry)
  if (deletedAt === 0) {
    return false
  }
  const restoredAt = entry.restoredAt ?? 0
  // deletedAt >= restoredAt なら削除状態（同時刻は削除を優先）
  return deletedAt >= restoredAt
}

/**
 * DeletedInstance のマージキーを生成
 * taskId > path > instanceId の優先順位
 */
function getDeletedInstanceKey(entry: DeletedInstance): string {
  const instanceId = typeof entry.instanceId === 'string' ? entry.instanceId.trim() : ''
  if (entry.deletionType === 'temporary' && instanceId) {
    return `instanceId:${instanceId}`
  }
  if (entry.taskId) {
    return `taskId:${entry.taskId}`
  }
  if (entry.path) {
    return `path:${entry.path}`
  }
  if (instanceId) {
    return `instanceId:${instanceId}`
  }
  return `unknown:${JSON.stringify(entry)}`
}

function normalizeDeletedPath(path: unknown): string {
  if (typeof path !== 'string') return ''
  return path.trim()
}

function isInstanceScopedDeletion(entry: DeletedInstance): boolean {
  const instanceId = typeof entry.instanceId === 'string' ? entry.instanceId.trim() : ''
  return entry.deletionType === 'temporary' && instanceId.length > 0
}

function canMatchByPath(entry: DeletedInstance): boolean {
  if (isInstanceScopedDeletion(entry)) {
    return false
  }
  return normalizeDeletedPath(entry.path).length > 0
}

function findDeletedInstanceMatchKey(
  entry: DeletedInstance,
  mergedMap: Map<string, DeletedInstance>,
): string | null {
  const primaryKey = getDeletedInstanceKey(entry)
  if (mergedMap.has(primaryKey)) {
    return primaryKey
  }

  if (!canMatchByPath(entry)) {
    return null
  }

  const path = normalizeDeletedPath(entry.path)
  let fallbackKey: string | null = null
  for (const [key, existing] of mergedMap.entries()) {
    if (!canMatchByPath(existing)) {
      continue
    }
    const existingPath = normalizeDeletedPath(existing.path)
    if (!existingPath || existingPath !== path) {
      continue
    }
    if (existing.taskId) {
      return key
    }
    if (!fallbackKey) {
      fallbackKey = key
    }
  }

  return fallbackKey
}

function mergeDeletedInstanceEntries(
  localEntry: DeletedInstance,
  remoteEntry: DeletedInstance,
): { merged: DeletedInstance; conflict: boolean } {
  const localDeletedAt = getEffectiveDeletedAt(localEntry)
  const localRestoredAt = localEntry.restoredAt ?? 0
  const localLatest = Math.max(localDeletedAt, localRestoredAt)

  const remoteDeletedAt = getEffectiveDeletedAt(remoteEntry)
  const remoteRestoredAt = remoteEntry.restoredAt ?? 0
  const remoteLatest = Math.max(remoteDeletedAt, remoteRestoredAt)

  const conflict =
    localLatest !== remoteLatest || localDeletedAt !== remoteDeletedAt || localRestoredAt !== remoteRestoredAt

  const remoteIsLatest = remoteLatest > localLatest
  const latestEntry = remoteIsLatest ? remoteEntry : localEntry
  const olderEntry = remoteIsLatest ? localEntry : remoteEntry

  const merged: DeletedInstance = {
    ...latestEntry,
    taskId: latestEntry.taskId ?? olderEntry.taskId,
    instanceId: latestEntry.instanceId ?? olderEntry.instanceId,
    path: latestEntry.path ?? olderEntry.path,
    deletionType: latestEntry.deletionType ?? olderEntry.deletionType,
    deletedAt: Math.max(localDeletedAt, remoteDeletedAt) || undefined,
    restoredAt: Math.max(localRestoredAt, remoteRestoredAt) || undefined,
  }

  if (merged.deletedAt === 0) {
    merged.deletedAt = undefined
  }
  if (merged.restoredAt === 0) {
    merged.restoredAt = undefined
  }

  return { merged, conflict }
}

/**
 * DeletedInstance のマージ
 * - キー: taskId > path > instanceId
 * - 勝敗: 最新の操作（deletedAt または restoredAt）が勝つ
 */
export function mergeDeletedInstances(
  local: DeletedInstance[],
  remote: DeletedInstance[],
): ConflictResolution<DeletedInstance> {
  const mergedMap = new Map<string, DeletedInstance>()
  let conflictCount = 0

  const upsertEntry = (entry: DeletedInstance, countConflicts: boolean) => {
    const existingKey = findDeletedInstanceMatchKey(entry, mergedMap)
    const targetKey = existingKey ?? getDeletedInstanceKey(entry)

    if (!existingKey) {
      mergedMap.set(targetKey, { ...entry })
      return
    }

    const existingEntry = mergedMap.get(existingKey)
    if (!existingEntry) {
      mergedMap.set(targetKey, { ...entry })
      return
    }

    const { merged, conflict } = mergeDeletedInstanceEntries(existingEntry, entry)
    if (countConflicts && conflict) {
      conflictCount++
    }

    const canonicalKey = getDeletedInstanceKey(merged)
    if (existingKey !== canonicalKey) {
      mergedMap.delete(existingKey)
    }
    mergedMap.set(canonicalKey, merged)
  }

  // ローカルエントリを追加
  for (const entry of local) {
    upsertEntry(entry, false)
  }

  // リモートエントリをマージ
  for (const remoteEntry of remote) {
    upsertEntry(remoteEntry, true)
  }

  return {
    merged: Array.from(mergedMap.values()),
    hasConflicts: conflictCount > 0,
    conflictCount,
  }
}

/**
 * HiddenRoutine のマージキーを生成
 */
function getHiddenRoutineKey(entry: HiddenRoutine): string {
  const instancePart = entry.instanceId ? `::${entry.instanceId}` : ''
  return `${entry.path}${instancePart}`
}

type HiddenRoutineEntry = HiddenRoutine | string | null | undefined

function normalizeHiddenRoutineEntry(entry: HiddenRoutineEntry): HiddenRoutine | null {
  if (!entry) return null
  if (typeof entry === 'string') {
    const path = entry.trim()
    return path ? { path, instanceId: null } : null
  }
  const path = typeof entry.path === 'string' ? entry.path.trim() : ''
  if (!path) {
    return null
  }
  return { ...entry, path }
}

/**
 * HiddenRoutine が実際に非表示状態かを判定
 */
export function isHidden(entry: HiddenRoutine): boolean {
  const hiddenAt = entry.hiddenAt ?? 0
  const restoredAt = entry.restoredAt ?? 0
  if (hiddenAt === 0) {
    // hiddenAt がなければ、復元情報がある場合のみ非表示解除とみなす（後方互換性）
    return restoredAt === 0
  }
  return hiddenAt >= restoredAt
}

/**
 * HiddenRoutine のマージ
 */
export function mergeHiddenRoutines(
  local: Array<HiddenRoutine | string>,
  remote: Array<HiddenRoutine | string>,
): ConflictResolution<HiddenRoutine> {
  const mergedMap = new Map<string, HiddenRoutine>()
  let conflictCount = 0

  const localEntries = local
    .map(normalizeHiddenRoutineEntry)
    .filter((entry): entry is HiddenRoutine => entry != null)
  const remoteEntries = remote
    .map(normalizeHiddenRoutineEntry)
    .filter((entry): entry is HiddenRoutine => entry != null)

  // ローカルエントリを追加
  for (const entry of localEntries) {
    const key = getHiddenRoutineKey(entry)
    mergedMap.set(key, { ...entry })
  }

  // リモートエントリをマージ
  for (const remoteEntry of remoteEntries) {
    const key = getHiddenRoutineKey(remoteEntry)
    const localEntry = mergedMap.get(key)

    if (!localEntry) {
      mergedMap.set(key, { ...remoteEntry })
      continue
    }

    // 競合
    const localHiddenAt = localEntry.hiddenAt ?? 0
    const localRestoredAt = localEntry.restoredAt ?? 0
    const localLatest = Math.max(localHiddenAt, localRestoredAt)

    const remoteHiddenAt = remoteEntry.hiddenAt ?? 0
    const remoteRestoredAt = remoteEntry.restoredAt ?? 0
    const remoteLatest = Math.max(remoteHiddenAt, remoteRestoredAt)

    if (localLatest !== remoteLatest || localHiddenAt !== remoteHiddenAt || localRestoredAt !== remoteRestoredAt) {
      conflictCount++
    }

    const merged: HiddenRoutine = {
      ...localEntry,
      ...remoteEntry,
      hiddenAt: Math.max(localHiddenAt, remoteHiddenAt) || undefined,
      restoredAt: Math.max(localRestoredAt, remoteRestoredAt) || undefined,
    }

    mergedMap.set(key, merged)
  }

  return {
    merged: Array.from(mergedMap.values()),
    hasConflicts: conflictCount > 0,
    conflictCount,
  }
}

/**
 * slotOverrides のマージ
 * メタデータの updatedAt で勝敗を決定
 */
export function mergeSlotOverrides(
  local: Record<string, string>,
  localMeta: Record<string, SlotOverrideEntry>,
  remote: Record<string, string>,
  remoteMeta: Record<string, SlotOverrideEntry>,
): SlotOverrideResolution {
  const merged: Record<string, string> = {}
  const meta: Record<string, SlotOverrideEntry> = {}
  let conflictCount = 0

  const allKeys = new Set([
    ...Object.keys(local),
    ...Object.keys(remote),
    ...Object.keys(localMeta),
    ...Object.keys(remoteMeta),
  ])

  for (const key of allKeys) {
    const localValue = local[key]
    const localUpdatedAt = localMeta[key]?.updatedAt ?? 0

    const remoteValue = remote[key]
    const remoteUpdatedAt = remoteMeta[key]?.updatedAt ?? 0

    if (localValue === undefined && remoteValue === undefined) {
      // 値がどちらにもない場合は最新のメタ情報のみ保持（削除トゥームストーン）
      if (localUpdatedAt === 0 && remoteUpdatedAt === 0) {
        continue
      }
      if (localUpdatedAt >= remoteUpdatedAt) {
        if (localMeta[key]) {
          meta[key] = localMeta[key]
        }
      } else if (remoteMeta[key]) {
        meta[key] = remoteMeta[key]
      }
      continue
    }

    if (localValue !== undefined && remoteValue === undefined) {
      // リモートが削除トゥームストーンとして新しい場合は削除を優先
      if (remoteUpdatedAt > localUpdatedAt && remoteMeta[key]) {
        conflictCount++
        meta[key] = remoteMeta[key]
        continue
      }
      merged[key] = localValue
      meta[key] = localMeta[key] ?? { slotKey: localValue, updatedAt: localUpdatedAt }
      continue
    }

    if (localValue === undefined && remoteValue !== undefined) {
      // ローカルが削除トゥームストーンとして新しい場合は削除を優先
      if (localUpdatedAt > remoteUpdatedAt && localMeta[key]) {
        conflictCount++
        meta[key] = localMeta[key]
        continue
      }
      merged[key] = remoteValue
      meta[key] = remoteMeta[key] ?? { slotKey: remoteValue, updatedAt: remoteUpdatedAt }
      continue
    }

    // 両方に存在
    if (localValue !== remoteValue) {
      conflictCount++
    }

    // メタデータがない衝突はリモートを優先（外部変更の反映を優先）
    if (localUpdatedAt === 0 && remoteUpdatedAt === 0 && localValue !== remoteValue) {
      merged[key] = remoteValue
      meta[key] = remoteMeta[key] ?? { slotKey: remoteValue, updatedAt: remoteUpdatedAt }
      continue
    }

    // メタデータがある方、または新しい方を採用
    if (localUpdatedAt >= remoteUpdatedAt) {
      merged[key] = localValue
      meta[key] = localMeta[key] ?? { slotKey: localValue, updatedAt: localUpdatedAt }
    } else {
      merged[key] = remoteValue
      meta[key] = remoteMeta[key] ?? { slotKey: remoteValue, updatedAt: remoteUpdatedAt }
    }
  }

  return {
    merged,
    meta,
    hasConflicts: conflictCount > 0,
    conflictCount,
  }
}

/**
 * Orders のマージ
 * ordersMeta の updatedAt で勝敗を決定
 * メタデータがない場合はリモート優先（削除伝播のため）
 */
export function mergeOrders(
  localOrders: Record<string, number>,
  localMeta: Record<string, { order: number; updatedAt: number }>,
  remoteOrders: Record<string, number>,
  remoteMeta: Record<string, { order: number; updatedAt: number }>,
  options: { preferRemoteWithoutMeta?: boolean; remoteMonthUpdatedAt?: number } = {},
): OrdersResolution {
  const merged: Record<string, number> = {}
  const meta: Record<string, { order: number; updatedAt: number }> = {}
  let conflictCount = 0
  const preferRemoteWithoutMeta = options.preferRemoteWithoutMeta ?? true

  const orderKeys = new Set([
    ...Object.keys(localOrders),
    ...Object.keys(remoteOrders),
    ...Object.keys(localMeta),
    ...Object.keys(remoteMeta),
  ])

  for (const key of orderKeys) {
    const localMetaEntry = localMeta[key]
    const remoteMetaEntry = remoteMeta[key]
    const localOrder = localOrders[key]
    const remoteOrder = remoteOrders[key]

    if (localMetaEntry && remoteMetaEntry) {
      if (localMetaEntry.updatedAt !== remoteMetaEntry.updatedAt) {
        conflictCount++
      }
      const useLocal = localMetaEntry.updatedAt >= remoteMetaEntry.updatedAt
      const selectedMeta = useLocal ? localMetaEntry : remoteMetaEntry
      const selectedOrder = useLocal ? localOrder : remoteOrder
      const fallbackOrder = selectedOrder ?? (useLocal ? remoteOrder : localOrder)
      if (typeof fallbackOrder === 'number') {
        merged[key] = fallbackOrder
      }
      meta[key] = selectedMeta
      continue
    }

    if (localMetaEntry || remoteMetaEntry) {
      const selectedMeta = localMetaEntry ?? remoteMetaEntry
      const selectedOrder = localMetaEntry ? localOrder : remoteOrder
      const fallbackOrder = selectedOrder ?? (localMetaEntry ? remoteOrder : localOrder)
      if (typeof fallbackOrder === 'number') {
        merged[key] = fallbackOrder
      }
      if (selectedMeta) {
        meta[key] = selectedMeta
      }
      continue
    }

    if (preferRemoteWithoutMeta) {
      if (typeof remoteOrder === 'number') {
        // Prefer remote in legacy/no-meta cases to allow deletions to propagate.
        merged[key] = remoteOrder
      }
      continue
    }

    // In local-flush mode, preserve local deletions for no-meta keys.
    // Only keep the local order when it still exists.
    if (typeof localOrder === 'number') {
      merged[key] = localOrder
    }
  }

  return {
    merged,
    meta,
    hasConflicts: conflictCount > 0,
    conflictCount,
  }
}

/**
 * DuplicatedInstances のマージ
 * instanceId ベースで重複排除し、削除済みインスタンスを抑制
 */
export function mergeDuplicatedInstances(
  local: Array<DuplicatedInstance & { slotKey?: string; originalSlotKey?: string }>,
  remote: Array<DuplicatedInstance & { slotKey?: string; originalSlotKey?: string }>,
  deletedInfo: {
    deletedInstanceIds: Set<string>
    deletedPaths: Set<string>
    deletedTaskIds: Set<string>
  },
): DuplicatedInstancesResolution {
  const duplicatedMap = new Map<
    string,
    DuplicatedInstance & { slotKey?: string; originalSlotKey?: string }
  >()
  let conflictCount = 0

  const isSuppressed = (
    item: DuplicatedInstance & { slotKey?: string; originalSlotKey?: string },
  ): boolean =>
    deletedInfo.deletedInstanceIds.has(item.instanceId) ||
    (item.originalTaskId != null && deletedInfo.deletedTaskIds.has(item.originalTaskId)) ||
    (item.originalPath != null && deletedInfo.deletedPaths.has(item.originalPath))

  const isSameDuplicate = (
    a: DuplicatedInstance & { slotKey?: string; originalSlotKey?: string },
    b: DuplicatedInstance & { slotKey?: string; originalSlotKey?: string },
  ): boolean =>
    a.instanceId === b.instanceId &&
    a.originalPath === b.originalPath &&
    a.originalTaskId === b.originalTaskId &&
    a.timestamp === b.timestamp &&
    a.createdMillis === b.createdMillis &&
    a.restoredAt === b.restoredAt &&
    a.slotKey === b.slotKey &&
    a.originalSlotKey === b.originalSlotKey

  for (const item of local) {
    if (item?.instanceId) {
      if (isSuppressed(item)) {
        continue
      }
      duplicatedMap.set(item.instanceId, item)
    }
  }

  for (const item of remote) {
    if (item?.instanceId) {
      if (isSuppressed(item)) {
        continue
      }
      if (duplicatedMap.has(item.instanceId)) {
        // Keep first writer. Count conflict only when payload differs.
        const existing = duplicatedMap.get(item.instanceId)
        if (existing && !isSameDuplicate(existing, item)) {
          conflictCount++
        }
      } else {
        duplicatedMap.set(item.instanceId, item)
      }
    }
  }

  return {
    merged: Array.from(duplicatedMap.values()),
    hasConflicts: conflictCount > 0,
    conflictCount,
  }
}
