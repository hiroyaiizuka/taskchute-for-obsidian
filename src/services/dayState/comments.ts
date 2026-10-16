import type { DayComment } from '@/types'

export interface DayCommentsResolution {
  merged: DayComment[]
  hasConflicts: boolean
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/**
 * One stored comment from untrusted JSON, or null when it cannot be used.
 * Older or hand-edited files may hold anything; keep only the known fields.
 */
export function normalizeDayComment(value: unknown): DayComment | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!id || typeof raw.text !== 'string' || !isFiniteNumber(raw.at)) return null
  const comment: DayComment = {
    id,
    at: raw.at,
    text: raw.text,
    updatedAt: isFiniteNumber(raw.updatedAt) ? raw.updatedAt : raw.at,
  }
  if (typeof raw.instanceId === 'string' && raw.instanceId.trim()) {
    comment.instanceId = raw.instanceId
  }
  if (isFiniteNumber(raw.deletedAt)) {
    comment.deletedAt = raw.deletedAt
  }
  return comment
}

/** Whether `candidate` should replace `current` (newer write wins; ties keep `current`). */
const isNewer = (candidate: DayComment, current: DayComment): boolean =>
  candidate.updatedAt > current.updatedAt

/**
 * The `comments` field of a stored day, or undefined when there is nothing
 * usable (older files have no such field). Duplicate ids keep the newer write.
 */
export function normalizeDayComments(value: unknown): DayComment[] | undefined {
  if (!Array.isArray(value)) return undefined
  const byId = new Map<string, DayComment>()
  for (const item of value) {
    const comment = normalizeDayComment(item)
    if (!comment) continue
    const existing = byId.get(comment.id)
    if (!existing || isNewer(comment, existing)) byId.set(comment.id, comment)
  }
  return byId.size > 0 ? Array.from(byId.values()) : undefined
}

const sameComment = (a: DayComment, b: DayComment): boolean =>
  a.text === b.text &&
  a.at === b.at &&
  a.instanceId === b.instanceId &&
  a.updatedAt === b.updatedAt &&
  a.deletedAt === b.deletedAt

/**
 * Union by id. For an id on both sides the newer write (`updatedAt`) wins, so
 * a deletion (tombstone) and a later restore both travel between devices. On a
 * tie the local entry stays, which keeps the result deterministic.
 */
export function mergeDayComments(
  local: DayComment[] | undefined,
  remote: DayComment[] | undefined,
): DayCommentsResolution {
  const merged = new Map<string, DayComment>()
  let hasConflicts = false
  for (const comment of local ?? []) merged.set(comment.id, comment)
  for (const comment of remote ?? []) {
    const existing = merged.get(comment.id)
    if (!existing) {
      merged.set(comment.id, comment)
      continue
    }
    if (sameComment(existing, comment)) continue
    hasConflicts = true
    if (isNewer(comment, existing)) merged.set(comment.id, comment)
  }
  return { merged: Array.from(merged.values()), hasConflicts }
}

/** Comments not deleted, newest first; only the day's or only one instance's. */
export function visibleComments(comments: DayComment[] | undefined, instanceId?: string): DayComment[] {
  return (comments ?? [])
    .filter((comment) => comment.deletedAt === undefined)
    .filter((comment) => (instanceId ? comment.instanceId === instanceId : !comment.instanceId))
    .sort((a, b) => b.at - a.at || b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1))
}

export function generateCommentId(): string {
  try {
    const cryptoApi = activeWindow.crypto as Crypto | undefined
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
      return `tc-comment-${cryptoApi.randomUUID()}`
    }
  } catch {
    // fall through to the timestamp id
  }
  return `tc-comment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
