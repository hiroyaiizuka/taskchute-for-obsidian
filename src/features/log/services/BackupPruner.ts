import { normalizePath, TFile, TFolder } from 'obsidian'
import type { TaskChutePluginLike } from '../../../types'

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
      const logBase = this.plugin.pathManager.getLogDataPath()
      const backupRoot = normalizePath(`${logBase}/.backups`)
      const root = this.plugin.app.vault.getAbstractFileByPath(backupRoot)
      if (!root || !(root instanceof TFolder)) {
        return
      }
      await this.pruneFolder(root, cutoff)
    } catch (error) {
      console.warn('[BackupPruner] Failed to prune backups', error)
    }
  }

  private getRetentionDays(): number {
    const value = this.plugin.settings.backupRetentionDays ?? 30
    if (!Number.isFinite(value) || value <= 0) {
      return 0
    }
    return value
  }

  private async pruneFolder(folder: TFolder, cutoff: number): Promise<void> {
    const children = [...folder.children]
    for (const child of children) {
      if (child instanceof TFolder) {
        await this.pruneFolder(child, cutoff)
        if (child.children.length === 0) {
          try {
            const fileManager = this.plugin.app.fileManager
            if (fileManager?.trashFile) {
              await fileManager.trashFile(child, true)
            } else {
              // eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file
              await this.plugin.app.vault.delete(child)
            }
          } catch (error) {
            console.warn('[BackupPruner] Failed to delete empty backup folder', child.path, error)
          }
        }
        continue
      }
      if (child instanceof TFile && child.extension === 'json') {
        const shouldDelete = await this.shouldDeleteFile(child, cutoff)
        if (shouldDelete) {
          try {
            const fileManager = this.plugin.app.fileManager
            if (fileManager?.trashFile) {
              await fileManager.trashFile(child, true)
            } else {
              // eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file
              await this.plugin.app.vault.delete(child)
            }
          } catch (error) {
            console.warn('[BackupPruner] Failed to delete backup file', child.path, error)
          }
        }
      }
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
