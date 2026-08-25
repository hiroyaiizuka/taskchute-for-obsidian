/**
 * The process-table half of the broker, guard and watchdog programs: the part
 * whose result depends only on its arguments.
 *
 * All three run as `node -e <one string>` and cannot require siblings at
 * runtime, so this fragment is spliced into each of them verbatim. It is not a
 * runtime boundary — the composed string is what executes. What the split buys
 * is a testing boundary. Until it existed, every line of `ps` parsing in this
 * codebase existed in triplicate and was reachable only by spawning real
 * processes, which meant the `ps` dialect under test was whichever one the
 * developer's machine happened to speak. A macOS checkout could not execute the
 * Linux branch at all.
 *
 * Composition tests assert that all three programs still contain this string
 * byte for byte, and that none of them has grown a private copy again.
 *
 * Two deliberate properties:
 *
 * - `posixSnapshotPsArgs` takes the platform as an ARGUMENT rather than reading
 *   `process.platform`. That is what lets a test build both dialects from
 *   either host, and it is why nothing here touches `process`.
 * - Everything is a `function` declaration, never a top-level `const`. These
 *   are spliced into three programs that declare their own names around them;
 *   function declarations hoist and tolerate ordering, whereas a duplicated
 *   top-level `const` is a SyntaxError that would kill the program at startup
 *   with no output.
 *
 * Keep this plain ES2018 — nothing transpiles the contents of this template.
 */
export const POSIX_PROCESS_SNAPSHOT_SOURCE =
  String.raw`function posixSnapshotPsArgs(platform) {
  // macOS does not expose another process' environment through ps eww, while
  // the extra environment text makes every startup snapshot substantially
  // larger. Keep the environment-bearing form only on Linux, where it can
  // recover an already reparented cooperative descendant by its owner marker.
  return platform === 'linux'
    ? ['axeww', '-o', 'pid=,ppid=,pgid=,lstart=,command=']
    : ['-axo', 'pid=,ppid=,pgid=,lstart=,command='];
}
function posixSnapshotPsOptions(baseEnv) {
  // LC_ALL/LANG pin lstart to the C-locale "Www Mmm dd HH:MM:SS YYYY" shape the
  // parser below expects; under another locale Date.parse yields NaN and every
  // birth comparison silently degrades to 'unknown'.
  return {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: Object.assign({}, baseEnv, { LC_ALL: 'C', LANG: 'C' }),
  };
}
function parsePosixProcessSnapshot(output) {
  const snapshot = new Map();
  for (const line of String(output).split('\n')) {
    // The command column is optional: a process whose command ps renders empty
    // still has a pid, a ppid and a birth time, and dropping the line would
    // hide it from the descendant walk. It can never be claimed as an owner,
    // because every owner check requires a non-empty command hint.
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})(?:\s+(.*))?\s*$/,
    );
    if (!match) continue;
    const startedAt = Date.parse(match[4]);
    snapshot.set(Number(match[1]), {
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
      command: match[5] || '',
    });
  }
  return snapshot;
}
function posixSnapshotIdentity(entry) {
  if (!entry || !Number.isFinite(entry.startedAt)) return null;
  return {
    lower: entry.startedAt,
    upper: entry.startedAt,
    kind: 'snapshot',
    parentPid: entry.ppid,
    processGroup: entry.pgid,
    commandHint:
      typeof entry.command === 'string'
        ? entry.command.slice(0, 512)
        : '',
  };
}
// POSIX lstart is rounded down to seconds, so a recorded millisecond bound has
// to be floored the same way before it is compared against one.
function posixBirthFloor(ms) {
  return Math.floor(ms / 1000) * 1000;
}
// Linux does not store a process' start time as a wall clock: it derives one,
// as boot time plus the process' start in jiffies, and BOTH of those are
// truncated. The second it reports can therefore be the second BEFORE the one
// the clock showed when spawn() returned. Measured at HZ=100: 7 of 40 spawns
// came back one second early. macOS keeps a real timeval and was 40 of 40 exact,
// which is why nothing here ever failed on a developer machine while CI lost
// roughly one process in six.
//
// The error only ever runs backwards — truncation cannot invent time — so only
// the lower bound is widened.
function posixBirthSlackMs() {
  return 1000;
}
// The one-sided form, for a caller that has a lower bound and no upper one.
// Kept here so that comparison cannot be open-coded against posixBirthFloor
// again: that spelling skips the slack, and a process the kernel reported one
// second early then falls outside a window it belongs to. It is how an unhooked
// background process survived its own session.
function posixBirthAtOrAfter(actualStart, lower) {
  return (
    Number.isFinite(actualStart) &&
    actualStart >= posixBirthFloor(lower) - posixBirthSlackMs()
  );
}
// The owner record stores the interval surrounding spawn(), so both ends are
// floored: a paused or slow syscall stays a match without widening the
// PID-reuse window to several seconds. The slack makes that window ~2s on a
// host that reports an early start; a PID reused inside it is still caught by
// the identity checks the callers layer on top (the inherited sentinel
// descriptor, the guard token, the command hint).
function posixBirthWindowMatches(actualStart, lower, upper) {
  return (
    actualStart >= posixBirthFloor(lower) - posixBirthSlackMs() &&
    actualStart <= posixBirthFloor(upper)
  );
}
// Windows reports sub-second precision, so the recorded interval is used as-is.
function windowsBirthWindowMatches(actualStart, lower, upper) {
  return actualStart >= lower && actualStart <= upper;
}
function windowsBirthReaderArgv(pid, systemRoot) {
  const root = systemRoot || 'C:\\Windows';
  return {
    command:
      String(root).replace(/[\\/]+$/, '') +
      '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "(Get-Process -Id " + String(pid) +
        " -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')",
    ],
  };
}
function posixSnapshotChildren(snapshot) {
  const children = new Map();
  for (const [pid, entry] of snapshot.entries()) {
    const siblings = children.get(entry.ppid) || [];
    siblings.push(pid);
    children.set(entry.ppid, siblings);
  }
  return children;
}
// Transitive descendants of every root, in visit order. The roots themselves
// are never included, and the seen set keeps a ppid cycle (a self-parenting or
// reparented entry) from looping forever. Takes a list because the watchdog
// walks from every owner record it holds, not from a single process.
function posixSnapshotDescendantPids(snapshot, rootPids) {
  const roots = new Set(rootPids);
  const children = posixSnapshotChildren(snapshot);
  const pending = Array.from(roots);
  const seen = new Set();
  const descendants = [];
  while (pending.length > 0) {
    const parentPid = pending.pop();
    if (!parentPid || seen.has(parentPid)) continue;
    seen.add(parentPid);
    const nested = children.get(parentPid);
    if (!nested) continue;
    for (const pid of nested) {
      if (roots.has(pid) || seen.has(pid)) continue;
      descendants.push(pid);
      pending.push(pid);
    }
  }
  return descendants;
}`
