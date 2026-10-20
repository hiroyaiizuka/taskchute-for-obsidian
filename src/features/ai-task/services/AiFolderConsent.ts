import {
  normalizeDirectoryPath,
  normalizeDirectoryPathForComparison,
  WORKING_DIRECTORY_HISTORY_STORAGE_KEY,
} from './WorkingDirectoryHistory'

/**
 * The working folders this device lets AI tasks run in (LEV-390).
 *
 * A task note can come from anyone who can write to a synced or shared vault,
 * so its working folder and its "trust this folder" are requests. A folder
 * runs without asking when this device approved it: picked in the task
 * settings here (the device-local working-directory history), or allowed
 * once when asked. The vault itself needs no approval, unless the task also
 * trusts it. Kept in Obsidian's per-vault local storage, which is never
 * synced.
 */
export const AI_APPROVED_FOLDERS_STORAGE_KEY = 'taskchute-plus-ai-approved-folders'

const MAX_APPROVED_FOLDERS = 200

/** App#loadLocalStorage / App#saveLocalStorage: device-local, not synced. */
export interface FolderConsentStorage {
  loadLocalStorage?(key: string): unknown
  saveLocalStorage?(key: string, value: unknown): void
}

function storedFolders(storage: FolderConsentStorage, key: string): string[] {
  try {
    const stored = storage.loadLocalStorage?.(key)
    return Array.isArray(stored)
      ? stored.filter((entry): entry is string => typeof entry === 'string')
      : []
  } catch {
    return []
  }
}

export function isFolderApprovedOnThisDevice(
  storage: FolderConsentStorage,
  folder: string,
): boolean {
  const key = normalizeDirectoryPathForComparison(folder)
  if (!key) return false
  return [
    ...storedFolders(storage, AI_APPROVED_FOLDERS_STORAGE_KEY),
    ...storedFolders(storage, WORKING_DIRECTORY_HISTORY_STORAGE_KEY),
  ].some((entry) => normalizeDirectoryPathForComparison(entry) === key)
}

export function approveFolderOnThisDevice(
  storage: FolderConsentStorage,
  folder: string,
): void {
  const normalized = normalizeDirectoryPath(folder)
  const key = normalizeDirectoryPathForComparison(normalized)
  if (!key) return
  const others = storedFolders(storage, AI_APPROVED_FOLDERS_STORAGE_KEY).filter(
    (entry) => normalizeDirectoryPathForComparison(entry) !== key,
  )
  try {
    storage.saveLocalStorage?.(
      AI_APPROVED_FOLDERS_STORAGE_KEY,
      [normalized, ...others].slice(0, MAX_APPROVED_FOLDERS),
    )
  } catch {
    // Best effort: without storage the next run asks again.
  }
}

/** A working folder the run needs this device to approve first. */
export interface FolderConsentRequest {
  folder: string
  /** The task also trusts the folder's own settings and scripts. */
  trust: boolean
}

/** What a run needs this device to approve, or null when nothing. */
export function folderConsentNeeded(input: {
  storage: FolderConsentStorage
  cwd: string | undefined
  cwdIsVault: boolean
  trust: boolean
}): FolderConsentRequest | null {
  if (input.cwd === undefined) return null
  if (input.cwdIsVault && !input.trust) return null
  if (isFolderApprovedOnThisDevice(input.storage, input.cwd)) return null
  return { folder: input.cwd, trust: input.trust }
}
