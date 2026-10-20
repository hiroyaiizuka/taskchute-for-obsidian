/**
 * The inherited-sentinel half of the broker, guard and watchdog programs.
 *
 * An owned process is recorded together with a file descriptor it inherited at
 * spawn — a read handle on the session's own owner record. That descriptor
 * survives reparenting and exec, unlike ppid or argv, so it is what separates
 * "PID 4242, born in this second, is still our session" from "PID 4242 was
 * reused within the same lstart second by something unrelated".
 *
 * Reading it is the ONLY place where the three programs branch on the host OS:
 * Linux answers from `/proc/<pid>/fd/<n>`, macOS only through `lsof`. That made
 * it the one code path a macOS checkout could never execute, and it is where
 * the CI-only reap failures were traced to. The branch is now a single
 * function, `readSentinelFdPath`, that returns data instead of a verdict, so
 * the verdict itself (`sentinelStateFrom`) is reachable from either host and
 * the OS-specific half is small enough to be checked against the live kernel in
 * one assertion.
 *
 * The distinction that function preserves is the whole point:
 *
 * - `missing` — the kernel answered, and the descriptor is not there. Proof
 *   that this PID is not ours.
 * - `unreadable` — the probe itself failed (EACCES under a hardened /proc, no
 *   lsof in the image, an exec failure). Proof of nothing at all.
 *
 * Collapsing those two into one "unknown", which is what every copy of this
 * code did before, is what let a live descendant sit unowned forever: an owner
 * that cannot be proven is neither signalled nor written off, so the broker
 * never confirmed its tree was gone and the watchdog retried until the machine
 * went down, while the process they exist to reap stayed alive.
 *
 * `resolveUnprovenSentinel` is where that stops. Waiting cannot improve the
 * evidence — a /proc that refuses the readlink now will refuse it for the life
 * of the process — so the corroboration that IS available decides, and it
 * decides definitively or the retry loops never end. The birth window already
 * bounds PID reuse to the recorded spawn second; the command hint rules out the
 * one case the descriptor was there to catch, a same-second reuse of the number
 * by an unrelated program.
 *
 * The macOS probe is a synchronous `lsof`, run on the event loop of whichever
 * program asks. lsof stats every mount point before it answers, and a volume
 * that stops responding (an FSKit or network mount after the Mac wakes) can
 * hold it — and with it the broker — indefinitely. `-b` skips those blocking
 * kernel calls (the descriptor name still comes from the process table), `-w`
 * keeps the warnings that `-b` causes off the guard's stderr, which is the
 * user's terminal, and the timeout bounds whatever is left. The bound is the
 * one every synchronous probe shares, posixProbeTimeoutMs() from
 * PosixProcessSnapshotSource — which each of the three programs splices in
 * alongside this fragment. A timed-out probe is a failed probe: 'unreadable',
 * never 'missing'.
 *
 * Comments inside the template below are shipped inside each program's single
 * argv string, which is capped at 128KB on Linux. Rationale belongs up here.
 *
 * Spliced into all three programs verbatim; a composition test asserts they
 * still contain it byte for byte and have not regrown a private copy. Unlike
 * PosixProcessSnapshotSource this fragment does touch `fs`, `cp` and
 * `process` — it is the I/O boundary, not the pure one — so each host program
 * must have those three names in scope.
 *
 * Keep this plain ES2018 — nothing transpiles the contents of this template.
 */
export const OWNER_SENTINEL_PROBE_SOURCE =
  String.raw`function canonicalSentinelPath(value) {
  const clean = String(value || '').replace(/ \(deleted\)$/, '');
  try { return fs.realpathSync(clean); } catch (_) { return clean; }
}
// Evidence, never a verdict: { path } | 'missing' | 'unsupported' |
// 'unreadable'. 'missing' is the kernel answering; 'unreadable' is the probe
// failing, and the two must never collapse into one.
function readSentinelFdPath(pid, fd) {
  // A kernel that will not name another process' descriptor cannot be produced
  // on demand, so the end-to-end reap is testable only by simulating one.
  if (process.env.TASKCHUTE_OWNER_SENTINEL_TEST_UNREADABLE === '1') {
    return 'unreadable';
  }
  if (process.platform === 'linux') {
    try {
      return {
        path: fs.readlinkSync('/proc/' + String(pid) + '/fd/' + String(fd)),
      };
    } catch (error) {
      // ENOENT: the descriptor (or the process) is gone. EACCES under a
      // hardened /proc, and anything else, is the probe being unavailable.
      return error && error.code === 'ENOENT' ? 'missing' : 'unreadable';
    }
  }
  if (process.platform === 'darwin') {
    let output;
    try {
      output = cp.execFileSync(
        sentinelLsofPath(),
        sentinelLsofArgs(pid, fd),
        Object.assign(sentinelLsofOptions(), { stdio: ['ignore', 'pipe', 'ignore'] }),
      );
    } catch (error) {
      return sentinelLsofReading(error);
    }
    return sentinelLsofReading(null, output);
  }
  return 'unsupported';
}
// The lsof call is shared with the broker's non-blocking probe.
function sentinelLsofPath() {
  return '/usr/sbin/lsof';
}
function sentinelLsofArgs(pid, fd) {
  return ['-b', '-w', '-a', '-p', String(pid), '-d', String(fd), '-Fn'];
}
function sentinelLsofOptions() {
  return {
    encoding: 'utf8',
    maxBuffer: 16 * 1024,
    timeout: posixProbeTimeoutMs(),
    killSignal: 'SIGKILL',
    windowsHide: true,
  };
}
function sentinelLsofReading(error, output) {
  if (error) {
    // Exit 1: nothing matched. Any other failure: no answer.
    const exit = typeof error.status === 'number' ? error.status : error.code;
    return exit === 1 ? 'missing' : 'unreadable';
  }
  const nameLine = String(output).split('\n').find(line => line.startsWith('n'));
  return nameLine ? { path: nameLine.slice(1) } : 'missing';
}
function sentinelStateFrom(identity, reading) {
  if (
    !identity ||
    !Number.isInteger(identity.sentinelFd) ||
    !identity.sentinelPath
  ) return 'unknown';
  if (reading === 'missing') return 'mismatch';
  if (reading === 'unreadable') return 'unreadable';
  if (!reading || typeof reading.path !== 'string') return 'unknown';
  return canonicalSentinelPath(reading.path) ===
    canonicalSentinelPath(identity.sentinelPath)
    ? 'match'
    : 'mismatch';
}
function probeSentinelState(pid, identity) {
  if (
    !identity ||
    !Number.isInteger(identity.sentinelFd) ||
    !identity.sentinelPath
  ) return 'unknown';
  return sentinelStateFrom(
    identity,
    readSentinelFdPath(pid, identity.sentinelFd),
  );
}
// Ownership of a process whose birth window matched but whose sentinel could
// not be READ — an unavailable probe, or a record that never carried a
// descriptor. Absence of the probe is not evidence of non-ownership. See the
// module comment.
//
// 'unknown' is a real answer here and must stay one: a record carrying nothing
// but a PID and a birth second — the ambiguous legacy shape — authorizes
// neither killing the process nor discarding the record. Corroboration is what
// upgrades it, and when there is none the evidence is left in place.
function resolveUnprovenSentinel(identity, entry) {
  if (!identity || !identity.commandHint) return 'unknown';
  if (!entry || typeof entry.command !== 'string') return 'unknown';
  return entry.command.includes(identity.commandHint) ? 'match' : 'mismatch';
}`
