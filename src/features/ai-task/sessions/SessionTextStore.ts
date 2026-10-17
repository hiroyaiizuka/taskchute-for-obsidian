/**
 * AI Task - where the extracted conversation texts are kept
 *
 * Extracting a conversation means reading its whole session file, so the
 * text is kept and only extracted again when the file changes (its size or
 * time differs). It is a copy of conversations that live on this device, so
 * it stays on this device too: in Obsidian's IndexedDB, never in the vault
 * (which may be synced). An entry goes when its session file goes.
 */

export interface SessionTextEntry {
  /** The session file the text was extracted from. */
  path: string
  size: number
  mtimeMs: number
  text: string
}

export interface SessionTextStore {
  loadAll(): Promise<SessionTextEntry[]>
  put(entry: SessionTextEntry): Promise<void>
  remove(paths: readonly string[]): Promise<void>
}

/** Kept for the life of the plugin only: tests, and devices without IndexedDB. */
export class MemorySessionTextStore implements SessionTextStore {
  private readonly entries = new Map<string, SessionTextEntry>()

  loadAll(): Promise<SessionTextEntry[]> {
    return Promise.resolve(Array.from(this.entries.values()))
  }

  put(entry: SessionTextEntry): Promise<void> {
    this.entries.set(entry.path, entry)
    return Promise.resolve()
  }

  remove(paths: readonly string[]): Promise<void> {
    for (const path of paths) this.entries.delete(path)
    return Promise.resolve()
  }
}

export const SESSION_TEXT_DATABASE = 'taskchute-plus-session-text'
const STORE = 'texts'

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })
}

function isEntry(value: unknown): value is SessionTextEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry['path'] === 'string' &&
    typeof entry['size'] === 'number' &&
    typeof entry['mtimeMs'] === 'number' &&
    typeof entry['text'] === 'string'
  )
}

/**
 * Obsidian's IndexedDB (per device, per app). Any failure — no IndexedDB,
 * a blocked or full database — falls back to keeping texts in memory for
 * this run: search still works, it just extracts again next time.
 */
export class IndexedDbSessionTextStore implements SessionTextStore {
  private database: Promise<IDBDatabase | null> | null = null
  private readonly fallback = new MemorySessionTextStore()

  constructor(
    private readonly factory: IDBFactory | undefined,
    private readonly name = SESSION_TEXT_DATABASE,
  ) {}

  async loadAll(): Promise<SessionTextEntry[]> {
    const database = await this.open()
    if (!database) return this.fallback.loadAll()
    try {
      const rows: unknown[] = await done(database.transaction(STORE, 'readonly').objectStore(STORE).getAll())
      return rows.filter(isEntry)
    } catch {
      return this.fallback.loadAll()
    }
  }

  async put(entry: SessionTextEntry): Promise<void> {
    await this.fallback.put(entry)
    const database = await this.open()
    if (!database) return
    try {
      const transaction = database.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).put(entry)
      await committed(transaction)
    } catch {
      // Kept in memory for this run; extracted again next time.
    }
  }

  async remove(paths: readonly string[]): Promise<void> {
    await this.fallback.remove(paths)
    if (paths.length === 0) return
    const database = await this.open()
    if (!database) return
    try {
      const transaction = database.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      for (const path of paths) store.delete(path)
      await committed(transaction)
    } catch {
      // A stale entry is harmless: it is matched to no session file.
    }
  }

  private open(): Promise<IDBDatabase | null> {
    if (!this.database) {
      const factory = this.factory
      this.database = factory
        ? new Promise<IDBDatabase | null>((resolve) => {
          try {
            const request = factory.open(this.name, 1)
            request.onupgradeneeded = () => {
              if (!request.result.objectStoreNames.contains(STORE)) {
                request.result.createObjectStore(STORE, { keyPath: 'path' })
              }
            }
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => resolve(null)
            request.onblocked = () => resolve(null)
          } catch {
            resolve(null)
          }
        })
        : Promise.resolve(null)
    }
    return this.database
  }
}
