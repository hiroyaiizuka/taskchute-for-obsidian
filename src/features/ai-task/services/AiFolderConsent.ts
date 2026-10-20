/**
 * The working folders this device lets AI tasks run in (LEV-390).
 *
 * A task note can come from anyone who can write to a synced or shared vault,
 * so its working folder and its "trust this folder" are requests. A folder
 * runs without asking only when this device approved it: chosen by the user
 * in the task settings here, or allowed when asked on ▶. Trusting a folder
 * (its own settings and scripts run too) is approved separately. The vault
 * needs no approval unless the task trusts it. Approvals are kept in
 * Obsidian's per-vault local storage, which is never synced.
 */
export const AI_APPROVED_FOLDERS_STORAGE_KEY = 'taskchute-plus-ai-approved-folders'
export const AI_TRUSTED_FOLDERS_STORAGE_KEY = 'taskchute-plus-ai-trusted-folders'

const MAX_APPROVED_FOLDERS = 200

/** App#loadLocalStorage / App#saveLocalStorage: device-local, not synced. */
export interface FolderConsentStorage {
  loadLocalStorage?(key: string): unknown
  saveLocalStorage?(key: string, value: unknown): void
}

/** A drive (C:\, C:/) or backslash UNC (\\server\share) path. */
function isWindowsPath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path)
}

export function isAbsolutePathLike(path: string): boolean {
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return true

  // A Windows UNC path is absolute only after both the server and share
  // components are present. Keeping incomplete UNC, device namespaces, dot
  // segments, and drive-relative forms out of this branch prevents them from
  // bypassing vault-relative handling.
  const unc = path.match(/^\\\\([^\\/:*?"<>|]+)[\\/]([^\\/:*?"<>|]+)(?:[\\/]|$)/)
  if (unc === null) return false
  return unc[1] !== '.' && unc[1] !== '..' && unc[2] !== '.' && unc[2] !== '..'
}

function joinCwd(basePath: string, relative: string): string {
  const base = basePath.replace(/[\\/]+$/, '')
  const rest = relative.replace(/^\.\//, '')
  return `${base}/${rest}`
}

/** The folder a task note's `ai_task_cwd` runs in: absolute, or under the vault. */
export function resolveTaskFolder(
  folder: string | undefined,
  vaultPath: string | undefined,
): string | undefined {
  if (folder === undefined) return vaultPath
  if (isAbsolutePathLike(folder)) return folder
  if (vaultPath === undefined) return undefined
  return joinCwd(vaultPath, folder)
}

/**
 * The path without `.` segments, repeated separators, or a trailing one.
 * `..` stays: the OS resolves it after following symlinks, so `/a/link/..`
 * need not be `/a`, and only the exact path a user approved matches.
 */
function tidyFolder(path: string): string {
  const windows = isWindowsPath(path)
  const text = windows ? path.replace(/\\/g, '/') : path
  // A leading // stays: on Windows //host/share is a share, /host/share is not.
  const lead = text.startsWith('//') ? '//' : text.startsWith('/') ? '/' : ''
  const tidy = lead + text.split('/').filter((s) => s !== '' && s !== '.').join('/')
  // A drive root keeps its separator: `C:` alone is drive-relative.
  return windows && /^[A-Za-z]:$/.test(tidy) ? `${tidy}/` : tidy
}

/**
 * The folder a path names, for comparison. Exact on POSIX, where `site` and
 * `site ` or `a\b` are different folders; Windows paths compare with `\` as
 * `/` and case folded.
 */
export function folderKey(path: string): string {
  const tidy = tidyFolder(path)
  return isWindowsPath(path) ? tidy.toLowerCase() : tidy
}

/**
 * The folder as a dialog or notice shows it: control, format (bidi, zero
 * width) and line-separator characters, which could hide what it names,
 * shown as U+FFFD.
 */
export function displayFolder(path: string): string {
  return tidyFolder(path).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '\ufffd')
}

/** A task name in the same texts: control and direction characters only, so emoji stay whole. */
export function displayName(name: string): string {
  return name.replace(
    /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/gu,
    '\ufffd',
  )
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

function addFolder(storage: FolderConsentStorage, key: string, folder: string): void {
  const own = folderKey(folder)
  if (!own) return
  const others = storedFolders(storage, key).filter((entry) => folderKey(entry) !== own)
  try {
    storage.saveLocalStorage?.(key, [folder, ...others].slice(0, MAX_APPROVED_FOLDERS))
  } catch {
    // Best effort: without storage the next run asks again.
  }
}

/** A trusted folder is approved too; a plain approval does not trust. */
export function isFolderApprovedOnThisDevice(
  storage: FolderConsentStorage,
  folder: string,
  trust: boolean,
): boolean {
  const own = folderKey(folder)
  if (!own) return false
  const trusted = storedFolders(storage, AI_TRUSTED_FOLDERS_STORAGE_KEY)
  const pool = trust
    ? trusted
    : [...storedFolders(storage, AI_APPROVED_FOLDERS_STORAGE_KEY), ...trusted]
  return pool.some((entry) => folderKey(entry) === own)
}

/** Approve running in the folder, and trusting it when `trust`. */
export function approveFolderOnThisDevice(
  storage: FolderConsentStorage,
  folder: string,
  trust: boolean,
): void {
  addFolder(storage, AI_APPROVED_FOLDERS_STORAGE_KEY, folder)
  if (trust) addFolder(storage, AI_TRUSTED_FOLDERS_STORAGE_KEY, folder)
}

/** Where a run works, and whether it trusts that folder. */
export interface RunFolder {
  cwd: string | undefined
  cwdIsVault: boolean
  trust: boolean
}

/** A working folder the run needs this device to approve first. */
export interface FolderConsentRequest {
  folder: string
  /** The task also trusts the folder's own settings and scripts. */
  trust: boolean
}

/** What a run needs this device to approve, or null when nothing. */
export function folderConsentNeeded(
  storage: FolderConsentStorage,
  run: RunFolder,
): FolderConsentRequest | null {
  if (run.cwd === undefined) return null
  if (run.cwdIsVault && !run.trust) return null
  if (isFolderApprovedOnThisDevice(storage, run.cwd, run.trust)) return null
  return { folder: run.cwd, trust: run.trust }
}
