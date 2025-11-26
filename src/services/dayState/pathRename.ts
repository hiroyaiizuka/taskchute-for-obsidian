import { DayState, MonthlyDayStateFile } from '../../types'

const isString = (value: unknown): value is string => typeof value === 'string'

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
    state.hiddenRoutines = state.hiddenRoutines.map((entry) => {
      if (!entry) return entry
      if (typeof entry === 'string') {
        if (entry === oldPath) {
          mutated = true
          return newPath
        }
        return entry
      }
      if (entry.path === oldPath) {
        mutated = true
        return { ...entry, path: newPath }
      }
      return entry
    })
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
