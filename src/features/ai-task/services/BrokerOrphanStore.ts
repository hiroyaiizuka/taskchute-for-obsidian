/**
 * Sessions whose termination still has to reach their broker (LEV-391).
 *
 * A session the client gave up on is reported unavailable and leaves the
 * renderer's session state, but its process may still be alive in a frozen
 * broker. The client keeps retrying the termination. This file keeps that
 * retry list across a renderer reload, so the next renderer carries on.
 *
 * It names a broker only by pid and port. The token stays in the broker's
 * descriptor; a record whose broker no longer matches the descriptor cannot be
 * authenticated, so it is dropped on load.
 *
 * Several clients may share the file: a hot reload keeps the previous client
 * alive (terminal handles hold it) next to the new one. So nobody rewrites it
 * from its own list. Each change reads the file and applies only what that
 * client added or settled, and a record another client added stays.
 */

export interface OrphanRecord {
  sessionId: string
  pid: number
  port: number
}

export interface OrphanStoreFs {
  readFileSync(path: string, encoding: 'utf8'): string
  writeFileSync(
    path: string,
    data: string,
    options: { mode: number; flag: string },
  ): void
  renameSync(from: string, to: string): void
  unlinkSync(path: string): void
  lstatSync(path: string): {
    dev: number
    ino: number
    mode: number
    uid: number
    isFile(): boolean
    isSymbolicLink(): boolean
  }
}

export interface OrphanChange {
  add?: OrphanRecord[]
  /** Session ids whose termination was confirmed, or whose broker is gone. */
  remove?: string[]
}

const MAX_RECORDS = 256
const TEMPORARY_ATTEMPTS = 8

export function orphanStorePath(descriptorPath: string): string {
  return `${descriptorPath}.orphans.json`
}

function isRecord(value: unknown): value is OrphanRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const source = value as Record<string, unknown>
  return (
    typeof source.sessionId === 'string' &&
    source.sessionId.length > 0 &&
    source.sessionId.length <= 256 &&
    typeof source.pid === 'number' &&
    Number.isInteger(source.pid) &&
    source.pid > 0 &&
    typeof source.port === 'number' &&
    Number.isInteger(source.port) &&
    source.port > 0 &&
    source.port <= 65535
  )
}

/** The saved records, or none when the file is missing, foreign or malformed. */
export function readOrphans(
  fs: OrphanStoreFs,
  path: string,
  isTrustedFile: (stats: ReturnType<OrphanStoreFs['lstatSync']>) => boolean,
): OrphanRecord[] {
  try {
    if (!isTrustedFile(fs.lstatSync(path))) return []
    const parsed: unknown = JSON.parse(fs.readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter(isRecord).slice(0, MAX_RECORDS) : []
  } catch {
    return []
  }
}

/**
 * Apply one client's change to the saved records. Node's fs calls are
 * synchronous, so clients in one renderer never interleave inside it.
 */
export function updateOrphans(
  fs: OrphanStoreFs,
  path: string,
  isTrustedFile: (stats: ReturnType<OrphanStoreFs['lstatSync']>) => boolean,
  change: OrphanChange,
): void {
  const remove = new Set(change.remove ?? [])
  const records = new Map<string, OrphanRecord>()
  for (const record of readOrphans(fs, path, isTrustedFile)) {
    if (!remove.has(record.sessionId)) records.set(record.sessionId, record)
  }
  for (const record of change.add ?? []) records.set(record.sessionId, record)
  writeOrphans(fs, path, Array.from(records.values()))
}

/** Replace the saved records; an empty list removes the file. */
function writeOrphans(
  fs: OrphanStoreFs,
  path: string,
  records: OrphanRecord[],
): void {
  if (records.length === 0) {
    try {
      fs.unlinkSync(path)
    } catch {
      // Already gone.
    }
    return
  }
  const data = JSON.stringify(records.slice(0, MAX_RECORDS))
  // The temporary file sits in the shared temporary directory. Create it
  // exclusively ('wx' never follows or truncates an existing entry), under a
  // fresh name on each collision, and rename only the file made here.
  for (let attempt = 0; attempt < TEMPORARY_ATTEMPTS; attempt += 1) {
    const temporary = `${path}.${Date.now().toString(36)}${Math.random().toString(36).slice(2)}.tmp`
    try {
      fs.writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if ((error as { code?: unknown }).code === 'EEXIST') continue
      throw error
    }
    try {
      fs.renameSync(temporary, path)
    } catch (error) {
      try {
        fs.unlinkSync(temporary)
      } catch {
        // Nothing left to remove.
      }
      throw error
    }
    return
  }
  throw new Error('Could not create a temporary file for pending terminations')
}
