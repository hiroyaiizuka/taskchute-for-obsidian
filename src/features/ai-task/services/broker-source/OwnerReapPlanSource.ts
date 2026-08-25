/**
 * The decision half of the owner watchdog: which recorded PIDs the watchdog
 * still owns, which of them it must signal, and whether it may stop.
 *
 * The watchdog is the last actor alive after a broker crash. It reads the
 * per-session owner records, proves that each recorded PID is still the process
 * that was recorded (and not a reused PID), expands the proven roots across the
 * process tree, and SIGKILLs what it owns. Every one of those steps used to sit
 * inside one function interleaved with the syscalls that fed it — readdir, ps,
 * kill(0), readlink, unlink — so the only way to reach any of the reasoning was
 * to crash a real broker on a real OS and watch what survived. That is why four
 * integration tests that spawn processes and wait on SIGKILL were the entire
 * coverage of this logic, and why they failed only on Linux and only in CI.
 *
 * Nothing here touches fs, child_process or process. The host program gathers
 * evidence and applies the plan; this fragment turns one into the other, and a
 * test can hand it any evidence either platform could produce.
 *
 * The shape is deliberately two-phase. `classifyOwnedPids` reports which PIDs
 * it needs a sentinel reading for instead of reading one, so the caller probes
 * exactly those and calls again with the answers. That keeps the one
 * OS-specific syscall out of the reasoning without hiding the dependency.
 *
 * The policy the two-phase shape exists to make testable: an owner whose
 * sentinel cannot be read is resolved from the evidence that is available
 * rather than left unproven. It is resolved IMMEDIATELY, on the first round.
 * A grace period was tried and measured to be actively harmful: the session
 * guard removes the owner records within ~100ms of the broker's death, so a
 * watchdog that waits loses the only evidence naming the process it has to
 * reap, and then exits reporting the session clean. Liveness already separates
 * "on its way out" from "still here" without waiting. The resolution itself
 * lives with the probe it interprets, in OwnerSentinelProbeSource, because the
 * broker and the guard reach the same conclusion the same way.
 *
 * Comments inside the template below ship inside the program's single argv
 * string, which Linux caps at 128KB. Rationale belongs up here.
 *
 * Spliced into the watchdog only; a composition test asserts it is embedded
 * verbatim. Every declaration is a `function` for the reason
 * PosixProcessSnapshotSource gives: these names are spliced beside a program
 * that declares its own, and a duplicated top-level `const` is a SyntaxError
 * that kills the program before it can report anything.
 *
 * Keep this plain ES2018 — nothing transpiles the contents of this template.
 */
export const OWNER_REAP_PLAN_SOURCE =
  String.raw`function ownerRecordLimitBytes() {
  return 2048;
}
function ownerRecordIdentity(record, ownerFile) {
  const guardToken =
    typeof record.guardToken === 'string' &&
    /^[a-f0-9]{48}$/.test(record.guardToken)
      ? record.guardToken
      : null;
  return {
    lower: Number.isFinite(record.startedAtLower)
      ? record.startedAtLower
      : record.startedAt,
    upper: record.startedAt,
    kind: record.kind === 'guard'
      ? (guardToken ? 'guard' : 'unknown')
      : (record.kind === 'unknown' ? 'unknown' : 'process'),
    guardToken: guardToken,
    parentPid:
      Number.isInteger(record.parentPid) && record.parentPid > 0
        ? record.parentPid
        : null,
    processGroup:
      Number.isInteger(record.processGroup) && record.processGroup > 0
        ? record.processGroup
        : null,
    commandHint:
      typeof record.commandHint === 'string' &&
      record.commandHint.length > 0 &&
      record.commandHint.length <= 256
        ? record.commandHint
        : null,
    sentinelFd:
      Number.isInteger(record.sentinelFd) &&
      record.sentinelFd >= 3 &&
      record.sentinelFd <= 4096
        ? record.sentinelFd
        : null,
    sentinelPath:
      typeof record.sentinelPath === 'string' &&
      record.sentinelPath === ownerFile
        ? record.sentinelPath
        : null,
  };
}
function applyOwnerRecord(active, record, ownerFile) {
  if (
    !record ||
    !Number.isInteger(record.pid) ||
    record.pid < 1 ||
    !Number.isFinite(record.startedAt)
  ) return false;
  const identity = ownerRecordIdentity(record, ownerFile);
  if (record.active === false) {
    const current = active.get(record.pid);
    if (
      current &&
      current.lower === identity.lower &&
      current.upper === identity.upper
    ) active.delete(record.pid);
  } else {
    active.set(record.pid, identity);
  }
  return true;
}
function applyPartialOwnerRecord(active, text, ownerFile) {
  const match = String(text).match(
    /^\s*\{\s*"pid"\s*:\s*(\d+)\s*,\s*"startedAt"\s*:\s*(\d+)(?:\s*,\s*"startedAtLower"\s*:\s*(\d+))?/,
  );
  if (!match) return false;
  const startedAt = Number(match[2]);
  // A torn record cannot authenticate its complete process identity.
  const kind = 'unknown';
  const applied = applyOwnerRecord(active, {
    pid: Number(match[1]),
    startedAt: startedAt,
    startedAtLower: match[3] === undefined
      ? startedAt
      : Number(match[3]),
    active: !/"active"\s*:\s*false/.test(text),
    kind: kind,
    guardToken: (
      String(text).match(/"guardToken"\s*:\s*"([a-f0-9]{48})"/) ||
      []
    )[1],
  }, ownerFile);
  return applied && kind !== 'unknown';
}
// False when any line failed to authenticate: the session is then not
// accounted for, because the evidence could not be read.
function applyOwnerFileText(active, text, ownerFile) {
  const lines = String(text).split('\n');
  const tail = lines.pop() || '';
  let valid = true;
  for (const line of lines) {
    if (!line) continue;
    if (line.length > ownerRecordLimitBytes()) {
      valid = applyPartialOwnerRecord(active, line, ownerFile) && valid;
      continue;
    }
    let record = null;
    try {
      record = JSON.parse(line);
    } catch (_) {
      valid = applyPartialOwnerRecord(active, line, ownerFile) && valid;
      continue;
    }
    valid = applyOwnerRecord(active, record, ownerFile) && valid;
  }
  if (tail) {
    valid = applyPartialOwnerRecord(active, tail, ownerFile) && valid;
  }
  return valid;
}
// 'dead' | 'match' | 'mismatch' | 'unknown' | 'needs-sentinel', with the reason
// alongside, so a stalled watchdog can name the evidence it is missing.
function classifyOwnedPid(input) {
  const identity = input && input.identity;
  const liveness = input && input.liveness;
  if (liveness === 'unknown') return { state: 'unknown', reason: 'liveness' };
  if (liveness !== 'alive') return { state: 'dead', reason: 'exited' };
  let actualStart = null;
  let entry = null;
  if (input.platform === 'win32') {
    actualStart = input.windowsStartedAt;
  } else {
    if (!input.snapshotAvailable) {
      return { state: 'unknown', reason: 'no-snapshot' };
    }
    entry = input.entry || null;
    // kill(0) already proved the numeric PID exists, so a ps omission is a
    // gap in the snapshot, never proof of exit.
    if (!entry) return { state: 'unknown', reason: 'not-in-snapshot' };
    actualStart = entry.startedAt;
    if (
      identity &&
      identity.kind === 'guard' &&
      identity.guardToken &&
      (
        typeof entry.command !== 'string' ||
        !entry.command.includes(identity.guardToken)
      )
    ) return { state: 'mismatch', reason: 'guard-token' };
  }
  if (
    !identity ||
    !Number.isFinite(identity.lower) ||
    !Number.isFinite(identity.upper) ||
    !Number.isFinite(actualStart)
  ) return { state: 'unknown', reason: 'no-birth' };
  if (input.platform === 'win32') {
    return windowsBirthWindowMatches(actualStart, identity.lower, identity.upper)
      ? { state: 'match', reason: 'birth' }
      : { state: 'mismatch', reason: 'birth' };
  }
  if (!posixBirthWindowMatches(actualStart, identity.lower, identity.upper)) {
    return { state: 'mismatch', reason: 'birth' };
  }
  if (identity.kind === 'process') {
    const sentinel = input.sentinel;
    if (sentinel === undefined) {
      return { state: 'needs-sentinel', reason: 'sentinel' };
    }
    if (sentinel === 'mismatch') {
      return { state: 'mismatch', reason: 'sentinel' };
    }
    if (sentinel !== 'match') {
      // Resolved on this round: waiting cannot make an unreadable descriptor
      // readable, and the records this decision is made from do not survive
      // the wait. An unresolvable record stays unknown, which leaves both the
      // process and the evidence untouched.
      const resolved = resolveUnprovenSentinel(identity, entry);
      return {
        state: resolved,
        reason: (sentinel === 'unreadable' ? 'sentinel-unreadable' : 'sentinel-unavailable') +
          (resolved === 'unknown' ? '' : '-resolved'),
      };
    }
  }
  if (identity.kind === 'snapshot') {
    if (
      !Number.isInteger(identity.processGroup) ||
      !identity.commandHint ||
      !entry ||
      entry.pgid !== identity.processGroup ||
      typeof entry.command !== 'string' ||
      !entry.command.startsWith(identity.commandHint)
    ) return { state: 'mismatch', reason: 'snapshot-identity' };
  }
  return { state: 'match', reason: 'verified' };
}
// entries: [[pid, identity], ...]. Idempotent: call it, probe what it puts in
// needSentinel, call it again with those readings in input.sentinel.
function classifyOwnedPids(input) {
  const states = new Map();
  const needSentinel = [];
  for (const pair of input.entries) {
    const pid = pair[0];
    const identity = pair[1];
    const verdict = classifyOwnedPid({
      platform: input.platform,
      identity: identity,
      liveness: input.liveness.get(pid) || 'unknown',
      entry: input.snapshot ? input.snapshot.get(pid) : null,
      snapshotAvailable: Boolean(input.snapshot),
      windowsStartedAt: input.windowsStartedAt
        ? input.windowsStartedAt.get(pid)
        : null,
      sentinel: input.sentinel ? input.sentinel.get(pid) : undefined,
    });
    if (verdict.state === 'needs-sentinel') needSentinel.push(pid);
    states.set(pid, verdict);
  }
  return { states: states, needSentinel: needSentinel };
}
// Only a root whose own birth identity matches may confer ownership on its
// current children, so ownership is never derived from a stale or reused PID.
function planReapRoots(states, active) {
  const roots = new Map();
  let unknown = false;
  let sessionGuardAlive = false;
  for (const pair of active.entries()) {
    const pid = pair[0];
    const identity = pair[1];
    const verdict = states.get(pid) || { state: 'unknown', reason: 'unclassified' };
    if (
      identity &&
      identity.kind === 'unknown' &&
      verdict.state !== 'dead' &&
      verdict.state !== 'mismatch'
    ) {
      unknown = true;
      continue;
    }
    if (verdict.state === 'match') {
      if (identity && identity.kind === 'guard') {
        // The guard owns the only race-free raw ChildProcess reference. Never
        // kill it from a reusable PID record; broker-pipe EOF tells it to
        // finish cleanup and exit on its own.
        sessionGuardAlive = true;
      } else {
        roots.set(pid, identity);
      }
    } else if (verdict.state === 'unknown') {
      unknown = true;
    }
  }
  return { roots: roots, unknown: unknown, sessionGuardAlive: sessionGuardAlive };
}
// Signalling the group reaps a detached child's own descendants, and is only
// correct for a group leader. Self and the broker are never targets.
function signalTargetFor(pid, entry, selfPid, brokerPid) {
  if (pid === selfPid || pid === brokerPid) return 'skip';
  if (entry && entry.pgid === pid) return 'group';
  return 'process';
}
// states must come from a snapshot taken immediately before signalling: it
// closes the gap between root classification and the expansion below it.
function planReapSignals(states, expanded, context) {
  const kill = [];
  let unknown = false;
  for (const pid of expanded.keys()) {
    const verdict = states.get(pid) || { state: 'unknown', reason: 'unclassified' };
    if (verdict.state === 'match') {
      const target = signalTargetFor(
        pid,
        context.snapshot ? context.snapshot.get(pid) : null,
        context.selfPid,
        context.brokerPid,
      );
      if (target !== 'skip') kill.push({ pid: pid, target: target });
    } else if (verdict.state === 'unknown') {
      unknown = true;
    }
  }
  return { kill: kill, unknown: unknown };
}
// Anything short of proven-and-gone retries: a transient ps/readdir failure
// must never read as "clean" or abandon the last recovery actor. Permanent
// corruption preserves this guard and the owner evidence for diagnosis.
function planReapOutcome(summary) {
  return (
    summary.matching === 0 &&
    !summary.unknown &&
    !summary.sessionGuardAlive &&
    summary.trustworthy
  ) ? 'cleanup' : 'retry';
}
function reapRetryDelayMs(elapsedMs) {
  const elapsed = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
  return Math.min(1000, 50 + Math.floor(elapsed / 20));
}`
