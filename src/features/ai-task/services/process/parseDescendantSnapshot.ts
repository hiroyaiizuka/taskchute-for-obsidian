import type { ProcessIdentitySnapshot } from '../NodeProcessGateway'

/**
 * The `ps` parsing the renderer-side gateway does, separated from the syscall
 * that produces the text so it can be tested without spawning anything.
 *
 * Deliberately NOT shared with `parsePosixProcessSnapshot` in
 * broker-source/PosixProcessSnapshotSource.ts. The two read different `ps`
 * invocations (three columns here, five there), produce different shapes (a
 * raw birth token to compare as a string vs. a parsed millisecond timestamp),
 * and live on opposite sides of the TS / spliced-program-string boundary — the
 * broker cannot import this file at runtime. Unifying them would mean widening
 * one of the two callers' contract to fit the other.
 */

/**
 * Transitive descendants of `rootPid` from `ps -axo pid=,ppid=,lstart=`
 * output, in visit order, each carrying its raw `lstart` text as a birth token.
 *
 * The token is only ever compared as an opaque string against another reading
 * taken on the same machine, so its format does not have to be stable across
 * hosts. Malformed lines are skipped and `rootPid` is never included.
 */
export function parseDescendantSnapshot(
  output: string,
  rootPid: number,
): ProcessIdentitySnapshot[] {
  const childrenByParent = new Map<number, ProcessIdentitySnapshot[]>()
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u)
    if (!match) continue
    const pid = Number(match[1])
    const parentPid = Number(match[2])
    const children = childrenByParent.get(parentPid) ?? []
    children.push({ pid, birthToken: match[3].trim() })
    childrenByParent.set(parentPid, children)
  }

  const descendants: ProcessIdentitySnapshot[] = []
  const pending = [...(childrenByParent.get(rootPid) ?? [])]
  // A ppid cycle — a self-parenting entry, or one reparented back onto the
  // walk — would otherwise loop forever.
  const seen = new Set<number>([rootPid])
  while (pending.length > 0) {
    const identity = pending.pop()
    if (identity === undefined || identity.pid < 1 || seen.has(identity.pid)) {
      continue
    }
    seen.add(identity.pid)
    descendants.push(identity)
    pending.push(...(childrenByParent.get(identity.pid) ?? []))
  }
  return descendants
}
