import { TFile, TFolder, normalizePath } from 'obsidian'
import type { TaskChutePluginLike } from '@/types'
import { LOG_BACKUP_FOLDER } from '../constants'

/**
 * A month's backup is a set taken at one moment: the execution log
 * (`<timestamp>.json`, a copy of `YYYY-MM-tasks.json`) and the day state
 * (`<timestamp>.state.json`, a copy of `YYYY-MM-state.json`, which holds the
 * comments among other things). Either half may be missing: a month with no
 * execution log yet still backs up its day state. Restoring a set puts both
 * halves back together.
 */
export const STATE_BACKUP_SUFFIX = '.state.json'

type BackupPlugin = Pick<TaskChutePluginLike, 'app' | 'pathManager' | 'settings'>

export function backupTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

export function monthBackupFolder(plugin: BackupPlugin, monthKey: string): string {
  return normalizePath(`${plugin.pathManager.getLogDataPath()}/${LOG_BACKUP_FOLDER}/${monthKey}`)
}

export function tasksLogPath(plugin: BackupPlugin, monthKey: string): string {
  return normalizePath(`${plugin.pathManager.getLogDataPath()}/${monthKey}-tasks.json`)
}

export function dayStatePath(plugin: BackupPlugin, monthKey: string): string {
  return normalizePath(`${plugin.pathManager.getLogDataPath()}/${monthKey}-state.json`)
}

/** The day-state half that belongs with an execution-log backup at `tasksBackupPath`. */
export function stateBackupPathFor(tasksBackupPath: string): string {
  return tasksBackupPath.replace(/\.json$/u, STATE_BACKUP_SUFFIX)
}

export function isStateBackupPath(path: string): boolean {
  return path.endsWith(STATE_BACKUP_SUFFIX)
}

/** Reads a vault file as text, or null when it does not exist or cannot be read. */
export async function readIfExists(plugin: BackupPlugin, path: string): Promise<string | null> {
  const file = plugin.app.vault.getAbstractFileByPath(path)
  if (!(file instanceof TFile)) return null
  try {
    return await plugin.app.vault.read(file)
  } catch {
    return null
  }
}

/** Writes one backup set. Halves given as null or empty are left out. */
export async function writeMonthBackupSet(
  plugin: BackupPlugin,
  monthKey: string,
  files: { tasks?: string | null; state?: string | null },
  now: Date = new Date(),
): Promise<void> {
  const adapter = plugin.app.vault.adapter as { write?: (path: string, data: string) => Promise<void> } | undefined
  if (!adapter || typeof adapter.write !== 'function') return
  if (!files.tasks && !files.state) return
  const folder = monthBackupFolder(plugin, monthKey)
  await plugin.pathManager.ensureFolderExists(normalizePath(`${plugin.pathManager.getLogDataPath()}/${LOG_BACKUP_FOLDER}`))
  await plugin.pathManager.ensureFolderExists(folder)
  const stamp = backupTimestamp(now)
  if (files.tasks) await adapter.write(normalizePath(`${folder}/${stamp}.json`), files.tasks)
  if (files.state) await adapter.write(normalizePath(`${folder}/${stamp}${STATE_BACKUP_SUFFIX}`), files.state)
}

/** Time of the newest backup file of a month (either half), or null when there is none. */
export function latestBackupTime(plugin: BackupPlugin, monthKey: string): number | null {
  const folder = plugin.app.vault.getAbstractFileByPath(monthBackupFolder(plugin, monthKey))
  if (!(folder instanceof TFolder)) return null
  let latest: number | null = null
  for (const child of folder.children) {
    if (!(child instanceof TFile)) continue
    const time = parseBackupTimestamp(child.name)
    if (time !== null && (latest === null || time > latest)) latest = time
  }
  return latest
}

/** `2025-12-08T14-30-00-000Z.json` or `….state.json` → its time; null for anything else. */
export function parseBackupTimestamp(fileName: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:\.state)?\.json$/u.exec(fileName)
  if (!match) return null
  const time = Date.parse(`${match[1]}:${match[2]}:${match[3]}.${match[4]}Z`)
  return Number.isNaN(time) ? null : time
}

export function backupIntervalMillis(plugin: BackupPlugin): number {
  const hours = plugin.settings.backupIntervalHours ?? 2
  if (!Number.isFinite(hours) || hours <= 0) return 0
  return hours * 60 * 60 * 1000
}
