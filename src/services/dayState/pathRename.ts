import { DayState, HiddenRoutine, MonthlyDayStateFile, SlotOverrideEntry } from '../../types'

const isString = (value: unknown): value is string => typeof value === 'string'

// Legacy hidden routines may be stored as plain strings (path only)
type LegacyHiddenRoutineEntry = HiddenRoutine | string

const normalizeString = (value: unknown): string | undefined => {
  if (!isString(value)) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export const renamePathsInDayState = (state: DayState, oldPath: string, newPath: string): boolean => {
  if (!state || oldPath === newPath) {
    return false
  }

  let mutated = false

  if (Array.isArray(state.hiddenRoutines)) {
    const legacyEntries = state.hiddenRoutines as LegacyHiddenRoutineEntry[]
    const mapped = legacyEntries.map((entry): HiddenRoutine => {
      if (!entry) return entry as unknown as HiddenRoutine
      if (typeof entry === 'string') {
        const newPath_ = entry === oldPath ? newPath : entry
        if (entry === oldPath) mutated = true
        return { path: newPath_ }
      }
      if (entry.path === oldPath) {
        mutated = true
        return { ...entry, path: newPath }
      }
      return entry
    })
    state.hiddenRoutines = mapped.filter((e): e is HiddenRoutine => e != null)
  }

  if (Array.isArray(state.deletedInstances)) {
    state.deletedInstances = state.deletedInstances.map((entry) => {
      if (!entry) return entry
      if (normalizeString(entry.path) === oldPath) {
        mutated = true
        return { ...entry, path: newPath }
      }
      return entry
    })
  }

  if (Array.isArray(state.duplicatedInstances)) {
    state.duplicatedInstances = state.duplicatedInstances.map((entry) => {
      if (!entry) return entry
      if (normalizeString(entry.originalPath) === oldPath) {
        mutated = true
        return { ...entry, originalPath: newPath }
      }
      return entry
    })
  }

  if (state.slotOverrides && typeof state.slotOverrides === 'object') {
    const updated: Record<string, string> = {}
    for (const [key, value] of Object.entries(state.slotOverrides)) {
      const newKey = key === oldPath ? newPath : key
      if (newKey !== key) {
        mutated = true
      }
      updated[newKey] = value
    }
    state.slotOverrides = updated
  }

  if (state.slotOverridesMeta && typeof state.slotOverridesMeta === 'object') {
    const updated: Record<string, SlotOverrideEntry> = {}
    for (const key of Object.keys(state.slotOverridesMeta)) {
      const value = state.slotOverridesMeta[key]
      if (!value) continue
      const newKey = key === oldPath ? newPath : key
      if (newKey !== key) {
        mutated = true
      }
      updated[newKey] = value
    }
    state.slotOverridesMeta = updated
  }

  if (state.orders && typeof state.orders === 'object') {
    const updated: Record<string, number> = {}
    for (const [key, value] of Object.entries(state.orders)) {
      if (!Number.isFinite(value)) continue
      if (key.startsWith(`${oldPath}::`)) {
        const slot = key.slice(oldPath.length + 2)
        const newKey = `${newPath}::${slot}`
        updated[newKey] = value
        mutated = true
      } else {
        updated[key] = value
      }
    }
    state.orders = updated
  }

  if (state.ordersMeta && typeof state.ordersMeta === 'object') {
    const updated: Record<string, { order: number; updatedAt: number }> = {}
    for (const key of Object.keys(state.ordersMeta)) {
      const value = state.ordersMeta[key]
      if (!value) continue
      if (key.startsWith(`${oldPath}::`)) {
        const slot = key.slice(oldPath.length + 2)
        const newKey = `${newPath}::${slot}`
        updated[newKey] = value
        mutated = true
      } else {
        updated[key] = value
      }
    }
    state.ordersMeta = updated
  }

  return mutated
}

export const renamePathsInMonthlyState = (
  monthly: MonthlyDayStateFile,
  oldPath: string,
  newPath: string,
): boolean => {
  if (!monthly || oldPath === newPath) {
    return false
  }
  let mutated = false
  if (monthly.days && typeof monthly.days === 'object') {
    for (const dayState of Object.values(monthly.days)) {
      if (!dayState) continue
      mutated = renamePathsInDayState(dayState, oldPath, newPath) || mutated
    }
  }
  if (mutated) {
    if (!monthly.metadata) {
      monthly.metadata = { version: '1.0', lastUpdated: new Date().toISOString() }
    } else {
      monthly.metadata.lastUpdated = new Date().toISOString()
    }
  }
  return mutated
}
