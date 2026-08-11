import { normalizePath, TFile, TFolder } from 'obsidian'
import type { TaskChutePluginLike } from '../../../types'
import { LOG_BACKUP_FOLDER, LOG_BACKUP_LEGACY_FOLDER } from '../constants'

const DAY_IN_MS = 24 * 60 * 60 * 1000

export class BackupPruner {
  constructor(private readonly plugin: TaskChutePluginLike) {}

  async prune(): Promise<void> {
    try {
      const retentionDays = this.getRetentionDays()
      if (retentionDays <= 0) {
        return
      }
      const cutoff = Date.now() - retentionDays * DAY_IN_MS
      for (const root of this.getBackupRoots()) {
        await this.pruneRoot(root, cutoff)
      }
    } catch (error) {
      console.warn('[BackupPruner] Failed to prune backups', error)
    }
  }

  private getBackupRoots(): TFolder[] {
    const roots: TFolder[] = []
    const base = this.plugin.pathManager.getLogDataPath()
    const paths = new Set<string>([
      normalizePath(`${base}/${LOG_BACKUP_FOLDER}`),
      normalizePath(`${base}/${LOG_BACKUP_LEGACY_FOLDER}`),
    ])
    for (const path of paths) {
      const file = this.plugin.app.vault.getAbstractFileByPath(path)
      if (file && file instanceof TFolder) {
        roots.push(file)
      }
    }
    return roots
  }

  private getRetentionDays(): number {
    const value = this.plugin.settings.backupRetentionDays ?? 30
    if (!Number.isFinite(value) || value <= 0) {
      return 0
    }
    return value
  }

  private async pruneRoot(folder: TFolder, cutoff: number): Promise<void> {
    const children = [...folder.children]
    for (const child of children) {
      if (child instanceof TFolder) {
        await this.pruneRoot(child, cutoff)
        if (child.children.length === 0) {
          await this.deleteEntry(child)
        }
        continue
      }
      if (child instanceof TFile && child.extension === 'json') {
        const shouldDelete = await this.shouldDeleteFile(child, cutoff)
        if (shouldDelete) {
          await this.deleteEntry(child)
        }
      }
    }
  }

  private async deleteEntry(entry: TFolder | TFile): Promise<void> {
    try {
      await this.plugin.app.fileManager.trashFile(entry)
    } catch (error) {
      console.warn('[BackupPruner] Failed to delete backup entry', entry.path, error)
    }
  }

  private async shouldDeleteFile(file: TFile, cutoff: number): Promise<boolean> {
    let mtime = typeof file.stat?.mtime === 'number' ? file.stat.mtime : null
    if (typeof mtime !== 'number') {
      const adapter = this.plugin.app.vault.adapter as {
        stat?: (path: string) => Promise<{ mtime?: number }>
      }
      if (adapter?.stat) {
        try {
          const stat = await adapter.stat(file.path)
          if (stat && typeof stat.mtime === 'number') {
            mtime = stat.mtime
          }
        } catch (error) {
          console.warn('[BackupPruner] Failed to stat backup file', file.path, error)
        }
      }
    }
    if (typeof mtime !== 'number') {
      return false
    }
    return mtime < cutoff
  }
}
