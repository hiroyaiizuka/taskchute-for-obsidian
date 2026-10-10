/**
 * Sessions archived from the TaskChute list, kept per device (the session
 * files themselves are per device). Archiving only hides a session from the
 * list: the CLI's own files are never touched. Entries whose session file is
 * gone are dropped on refresh, so the record never outgrows what exists.
 */

export const AI_SESSION_ARCHIVE_STORAGE_KEY = 'taskchute-plus.ai-session-archive'

export interface SessionArchiveStorage {
  loadLocalStorage?: (key: string) => unknown
  saveLocalStorage?: (key: string, value: unknown) => void
}

/** `<agent>:<session id>`, so ids of different agents never collide. */
export function sessionArchiveKey(host: string, id: string): string {
  return `${host}:${id}`
}

export class SessionArchiveStore {
  private entries: Map<string, number>

  constructor(private readonly storage: SessionArchiveStorage) {
    this.entries = this.load()
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  archive(key: string, now = Date.now()): void {
    this.entries.set(key, now)
    this.save()
  }

  restore(key: string): void {
    if (this.entries.delete(key)) this.save()
  }

  /** Forget archived sessions whose files no longer exist. */
  prune(existingKeys: ReadonlySet<string>): void {
    let changed = false
    for (const key of Array.from(this.entries.keys())) {
      if (!existingKeys.has(key)) {
        this.entries.delete(key)
        changed = true
      }
    }
    if (changed) this.save()
  }

  private load(): Map<string, number> {
    try {
      const stored = this.storage.loadLocalStorage?.(AI_SESSION_ARCHIVE_STORAGE_KEY)
      const items =
        typeof stored === 'object' && stored !== null && 'items' in stored
          ? stored.items
          : undefined
      if (typeof items !== 'object' || items === null) return new Map()
      return new Map(
        Object.entries(items).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
      )
    } catch {
      return new Map()
    }
  }

  private save(): void {
    try {
      this.storage.saveLocalStorage?.(AI_SESSION_ARCHIVE_STORAGE_KEY, {
        version: 1,
        items: Object.fromEntries(this.entries),
      })
    } catch {
      // Device-local storage is optional; archiving still works until reload.
    }
  }
}
