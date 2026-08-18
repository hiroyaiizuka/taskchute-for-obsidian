/**
 * Device-local working-directory history used by the AI task creation UI.
 *
 * Absolute workspace paths are machine-specific and can contain a local user
 * name, so this service deliberately persists through App#saveLocalStorage
 * instead of plugin settings (which may be synchronized with the vault).
 */

export const WORKING_DIRECTORY_HISTORY_STORAGE_KEY =
  'taskchute-plus.ai-task-working-directory-history'

export const MAX_WORKING_DIRECTORY_HISTORY = 10

const WINDOWS_DRIVE_ROOT_RE = /^[a-z]:\/$/i
const WINDOWS_DRIVE_PATH_RE = /^[a-z]:\//i
const WINDOWS_UNC_ROOT_RE = /^\/\/[^/]+\/[^/]+\/?$/i
const WINDOWS_UNC_PATH_RE = /^\/\/[^/]+\/[^/]+/i

export interface WorkingDirectoryStorageBridge {
  loadLocalStorage?: (key: string) => unknown
  saveLocalStorage?: (key: string, value: unknown) => void
}

export interface WorkingDirectoryChoices {
  /** Normalized vault/default workspace; empty when no desktop base exists. */
  defaultDirectory: string
  /** Normalized, de-duplicated MRU/candidate paths excluding the default. */
  recentDirectories: string[]
}

export interface BuildWorkingDirectoryChoicesOptions {
  defaultDirectory?: string
  /** Device-local MRU paths. These always take priority over candidates. */
  storedDirectories?: readonly unknown[]
  /** Paths discovered from existing AI task notes. */
  candidateDirectories?: readonly unknown[]
}

/**
 * Normalize path separators for stable display and comparison.
 *
 * POSIX root, Windows drive root, and UNC share root keep their root form;
 * other paths lose trailing separators. This is lexical normalization only —
 * filesystem canonicalization remains at the process/workspace boundary.
 */
export function normalizeDirectoryPath(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''

  let normalized = trimmed.replace(/\\/g, '/')
  if (normalized.startsWith('//')) {
    normalized = `//${normalized.slice(2).replace(/\/+/g, '/')}`
  } else {
    normalized = normalized.replace(/\/+/g, '/')
  }

  if (normalized === '/') return normalized
  if (WINDOWS_DRIVE_ROOT_RE.test(normalized)) return normalized
  if (WINDOWS_UNC_ROOT_RE.test(normalized)) {
    return normalized.replace(/\/+$/, '')
  }
  return normalized.replace(/\/+$/, '')
}

/** Windows drive and UNC paths compare case-insensitively; POSIX stays exact. */
export function normalizeDirectoryPathForComparison(value: string): string {
  const normalized = normalizeDirectoryPath(value)
  return WINDOWS_DRIVE_PATH_RE.test(normalized) ||
    WINDOWS_UNC_PATH_RE.test(normalized)
    ? normalized.toLowerCase()
    : normalized
}

function appendUniqueDirectories(
  target: string[],
  seen: Set<string>,
  values: readonly unknown[],
  excludedKey: string,
): void {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const normalized = normalizeDirectoryPath(value)
    if (!normalized) continue
    const key = normalizeDirectoryPathForComparison(normalized)
    if (key === excludedKey || seen.has(key)) continue
    seen.add(key)
    target.push(normalized)
  }
}

/**
 * Pure reference-parity merge: MRU paths first, existing-task candidates
 * second, with the default omitted from the recent list.
 */
export function buildWorkingDirectoryChoices(
  options: BuildWorkingDirectoryChoicesOptions,
): WorkingDirectoryChoices {
  const defaultDirectory = normalizeDirectoryPath(options.defaultDirectory ?? '')
  const defaultKey = normalizeDirectoryPathForComparison(defaultDirectory)
  const seen = new Set<string>()
  const recentDirectories: string[] = []

  appendUniqueDirectories(
    recentDirectories,
    seen,
    options.storedDirectories ?? [],
    defaultKey,
  )
  appendUniqueDirectories(
    recentDirectories,
    seen,
    options.candidateDirectories ?? [],
    defaultKey,
  )

  return {
    defaultDirectory,
    recentDirectories: recentDirectories.slice(
      0,
      MAX_WORKING_DIRECTORY_HISTORY,
    ),
  }
}

/**
 * Small stateful wrapper around the pure merge helpers. Storage failures are
 * intentionally non-fatal: losing a convenience history must never block AI
 * task creation or execution.
 */
export class WorkingDirectoryHistory {
  private storedDirectories: string[]

  constructor(private readonly storage?: WorkingDirectoryStorageBridge) {
    this.storedDirectories = this.loadStoredDirectories()
  }

  getChoices(
    candidateDirectories: readonly unknown[] = [],
    defaultDirectory = '',
  ): WorkingDirectoryChoices {
    return buildWorkingDirectoryChoices({
      defaultDirectory,
      storedDirectories: this.storedDirectories,
      candidateDirectories,
    })
  }

  getStoredDirectories(): string[] {
    return [...this.storedDirectories]
  }

  /**
   * Move a directory to the MRU head. Empty/default paths are ignored.
   * Returns a defensive copy of the stored MRU list.
   */
  add(directory: string, defaultDirectory = ''): string[] {
    const normalized = normalizeDirectoryPath(directory)
    if (!normalized) return this.getStoredDirectories()

    const key = normalizeDirectoryPathForComparison(normalized)
    const defaultKey = normalizeDirectoryPathForComparison(defaultDirectory)
    if (defaultKey && key === defaultKey) return this.getStoredDirectories()

    const next = [
      normalized,
      ...this.storedDirectories.filter(
        (stored) => normalizeDirectoryPathForComparison(stored) !== key,
      ),
    ].slice(0, MAX_WORKING_DIRECTORY_HISTORY)
    this.storedDirectories = next
    this.persist()
    return this.getStoredDirectories()
  }

  private loadStoredDirectories(): string[] {
    let stored: unknown
    try {
      stored = this.storage?.loadLocalStorage?.(
        WORKING_DIRECTORY_HISTORY_STORAGE_KEY,
      )
    } catch {
      return []
    }
    if (!Array.isArray(stored)) return []
    return buildWorkingDirectoryChoices({ storedDirectories: stored })
      .recentDirectories
  }

  private persist(): void {
    try {
      this.storage?.saveLocalStorage?.(
        WORKING_DIRECTORY_HISTORY_STORAGE_KEY,
        this.getStoredDirectories(),
      )
    } catch {
      // History is best-effort and must not block task creation.
    }
  }
}
