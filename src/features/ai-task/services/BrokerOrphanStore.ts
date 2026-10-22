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
 */

export interface OrphanRecord {
  sessionId: string
  pid: number
  port: number
}

export interface OrphanStoreFs {
  readFileSync(path: string, encoding: 'utf8'): string
  writeFileSync(path: string, data: string, options: { mode: number }): void
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

const MAX_RECORDS = 256

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

/** Replace the saved records; an empty list removes the file. */
export function writeOrphans(
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
  const temporary = `${path}.${String(Date.now())}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(records.slice(0, MAX_RECORDS)), {
    mode: 0o600,
  })
  fs.renameSync(temporary, path)
}
