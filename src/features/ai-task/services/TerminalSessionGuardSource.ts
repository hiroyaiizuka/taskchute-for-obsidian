import { POSIX_PROCESS_SNAPSHOT_SOURCE } from './broker-source/PosixProcessSnapshotSource'

/**
 * Per-session supervisor used by the renderer-independent terminal broker.
 *
 * The guard, rather than the broker, owns the real PTY wrapper. Its stdin is
 * the broker's terminal-input pipe, so a broker crash produces EOF while the
 * guard is still alive and still has the target PID in memory. This closes
 * the otherwise unavoidable spawn-to-owner-record window.
 */
export const TERMINAL_SESSION_GUARD_SOURCE = String.raw`
'use strict';
const cp = require('child_process');
const fs = require('fs');
const net = require('net');
${POSIX_PROCESS_SNAPSHOT_SOURCE}
const encoded = process.env.TASKCHUTE_SESSION_GUARD_REQUEST || '';
const ownerPidFile =
  process.env.TASKCHUTE_BROKER_OWNER_PID_FILE || '';
let request;
try {
  request = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
} catch (_) {
  process.stderr.write('Invalid terminal session guard request\n');
  process.exit(64);
}
if (
  !request ||
  typeof request.command !== 'string' ||
  !Array.isArray(request.args) ||
  typeof request.guardToken !== 'string' ||
  !/^[a-f0-9]{48}$/.test(request.guardToken) ||
  !process.argv.includes(request.guardToken) ||
  !Number.isInteger(request.controlFd) ||
  request.controlFd < 3 ||
  request.controlFd > 16
) {
  process.stderr.write('Invalid terminal session guard command\n');
  process.exit(64);
}
const targetEnv = Object.assign({}, process.env);
delete targetEnv.TASKCHUTE_SESSION_GUARD_REQUEST;
let target = null;
let cleaning = false;
let targetClosed = false;
let targetExited = false;
let targetExitCode = null;
let targetExitSignal = null;
let targetStartedAtLower = null;
let targetStartedAtUpper = null;
let descendantCleanupTimer = null;
let brokerLossRetryDelay = 50;
let descendantRetryDelay = 50;
let originalGroupCleanupAttempted = false;
let normalExitStarted = false;
let targetCloseCode = null;
let targetCloseSignal = null;
let unknownRecordRetryPasses = 0;
let guardOwnershipFailed = false;
let forcedSnapshotFailures = Math.max(
  0,
  Math.floor(Number(
    process.env.TASKCHUTE_SESSION_GUARD_TEST_PS_FAILURE_COUNT || 0,
  )),
);
const captured = new Map();

function applyOwnerRecord(active, record) {
  if (
    !record ||
    !Number.isInteger(record.pid) ||
    record.pid < 1 ||
    !Number.isFinite(record.startedAt)
  ) return false;
  const identity = {
    lower: Number.isFinite(record.startedAtLower)
      ? record.startedAtLower
      : record.startedAt,
    upper: record.startedAt,
    kind:
      record.kind === 'guard'
        ? (
          typeof record.guardToken === 'string' &&
          /^[a-f0-9]{48}$/.test(record.guardToken)
            ? 'guard'
            : 'unknown'
        )
        : (
          record.kind === 'process' ||
          record.kind === 'unknown'
            ? record.kind
            : 'process'
        ),
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
      record.sentinelPath === ownerPidFile
        ? record.sentinelPath
        : null,
  };
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

function applyPartialOwnerRecord(active, text) {
  const match = String(text).match(
    /^\s*\{\s*"pid"\s*:\s*(\d+)\s*,\s*"startedAt"\s*:\s*(\d+)(?:\s*,\s*"startedAtLower"\s*:\s*(\d+))?/,
  );
  if (!match) return false;
  const startedAt = Number(match[2]);
  // A newline-free/torn record cannot prove all of the discriminator,
  // token, and lineage fields. Preserve only its numeric evidence as
  // explicitly untrusted so cleanup fails closed after bounded retries.
  const kind = 'unknown';
  const applied = applyOwnerRecord(active, {
    pid: Number(match[1]),
    startedAt,
    startedAtLower: match[3] === undefined
      ? startedAt
      : Number(match[3]),
    active: !/"active"\s*:\s*false/.test(text),
    kind,
  });
  return applied && kind !== 'unknown';
}

function captureOwnerRecords() {
  if (!ownerPidFile) return;
  let text;
  try {
    const stats = fs.lstatSync(ownerPidFile);
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      stats.size > 16 * 1024 * 1024
    ) return;
    text = fs.readFileSync(ownerPidFile, 'utf8');
  } catch (_) {
    return;
  }
  const active = new Map();
  const lines = text.split('\n');
  const tail = lines.pop() || '';
  for (const line of lines) {
    if (!line) continue;
    try { applyOwnerRecord(active, JSON.parse(line)); }
    catch (_) { applyPartialOwnerRecord(active, line); }
  }
  if (tail) applyPartialOwnerRecord(active, tail);
  for (const [pid, identity] of active.entries()) {
    if (pid !== process.pid && !captured.has(pid)) {
      captured.set(pid, identity);
    }
  }
}

function readSnapshot() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return null;
  }
  if (forcedSnapshotFailures > 0) {
    forcedSnapshotFailures -= 1;
    return null;
  }
  try {
    // Deliberately the non-environment form on every platform, unlike the
    // broker and watchdog which switch to 'axeww' on Linux. The guard only
    // matches by pid/ppid/pgid and birth time, never by an environment marker,
    // so the extra text would cost snapshot size for nothing. Whether the three
    // should agree is a separate question from sharing the parser.
    const output = cp.execFileSync(
      '/bin/ps',
      posixSnapshotPsArgs('darwin'),
      posixSnapshotPsOptions(process.env),
    );
    return parsePosixProcessSnapshot(output);
  } catch (_) {
    return null;
  }
}

function captureTargetTree(snapshot) {
  if (
    !snapshot ||
    !target ||
    !target.pid ||
    targetExited ||
    targetClosed ||
    !Number.isFinite(targetStartedAtLower) ||
    !Number.isFinite(targetStartedAtUpper)
  ) return;
  const rootEntry = snapshot.get(target.pid);
  if (
    !rootEntry ||
    rootEntry.ppid !== process.pid ||
    !Number.isFinite(rootEntry.startedAt) ||
    !posixBirthWindowMatches(
      rootEntry.startedAt,
      targetStartedAtLower,
      targetStartedAtUpper,
    )
  ) return;
  if (!captured.has(target.pid)) {
    captured.set(target.pid, {
      lower: targetStartedAtLower,
      upper: targetStartedAtUpper,
    });
  }
  for (const pid of posixSnapshotDescendantPids(snapshot, [target.pid])) {
    const identity = posixSnapshotIdentity(snapshot.get(pid));
    const existing = captured.get(pid);
    if (identity && (!existing || existing.kind === 'snapshot')) {
      captured.set(pid, identity);
    }
  }
}

function captureOriginalGroupMembers(snapshot) {
  if (!snapshot || !target || !target.pid) return 0;
  let found = 0;
  for (const [pid, entry] of snapshot.entries()) {
    if (
      pid === target.pid ||
      entry.pgid !== target.pid ||
      !Number.isFinite(entry.startedAt) ||
      entry.startedAt < posixBirthFloor(targetStartedAtLower)
    ) continue;
    found += 1;
    const existing = captured.get(pid);
    if (!existing || existing.kind === 'snapshot') {
      captured.set(pid, posixSnapshotIdentity(entry));
    }
  }
  return found;
}

function verifyDirectTargetIdentity(snapshot) {
  if (
    !snapshot ||
    !target ||
    !target.pid ||
    !Number.isFinite(targetStartedAtLower) ||
    !Number.isFinite(targetStartedAtUpper)
  ) return false;
  const entry = snapshot.get(target.pid);
  return Boolean(
    entry &&
    entry.ppid === process.pid &&
    Number.isFinite(entry.startedAt) &&
    posixBirthWindowMatches(
      entry.startedAt,
      targetStartedAtLower,
      targetStartedAtUpper,
    ),
  );
}

function scheduleTargetIdentityBurst() {
  // A native launcher can fork, detach, and exit before the broker writes its
  // first owner record. Preserve one additional early ancestry snapshot in
  // the guard that already owns the raw ChildProcess handle. This is bounded
  // startup work, not permanent polling.
  const timer = global.setTimeout(() => {
    if (cleaning || targetExited || targetClosed) return;
    captureTargetTree(readSnapshot());
  }, 20);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

function windowsStartedAt(pid) {
  try {
    const reader = windowsBirthReaderArgv(
      pid,
      process.env.SystemRoot || process.env.SYSTEMROOT,
    );
    const value = cp.execFileSync(
      reader.command,
      reader.args,
      {
        encoding: 'utf8',
        maxBuffer: 4096,
        windowsHide: true,
      },
    ).trim();
    const startedAt = Date.parse(value);
    return Number.isFinite(startedAt) ? startedAt : null;
  } catch (_) {
    return null;
  }
}

function canonicalSentinelPath(value) {
  const clean = String(value || '').replace(/ \(deleted\)$/, '');
  try { return fs.realpathSync(clean); } catch (_) { return clean; }
}

function sentinelState(pid, identity) {
  if (
    !identity ||
    !Number.isInteger(identity.sentinelFd) ||
    !identity.sentinelPath
  ) return 'unknown';
  try {
    let actualPath;
    if (process.platform === 'linux') {
      actualPath = fs.readlinkSync(
        '/proc/' + String(pid) + '/fd/' + String(identity.sentinelFd),
      );
    } else if (process.platform === 'darwin') {
      const output = cp.execFileSync(
        '/usr/sbin/lsof',
        [
          '-a',
          '-p',
          String(pid),
          '-d',
          String(identity.sentinelFd),
          '-Fn',
        ],
        { encoding: 'utf8', maxBuffer: 16 * 1024, windowsHide: true },
      );
      const nameLine = String(output).split('\n')
        .find(line => line.startsWith('n'));
      if (!nameLine) return 'mismatch';
      actualPath = nameLine.slice(1);
    } else {
      return 'unknown';
    }
    return canonicalSentinelPath(actualPath) ===
      canonicalSentinelPath(identity.sentinelPath)
      ? 'match'
      : 'mismatch';
  } catch (error) {
    if (
      error &&
      (error.code === 'ENOENT' || error.status === 1)
    ) return 'mismatch';
    return 'unknown';
  }
}

function ownershipState(pid, identity, snapshot) {
  try { process.kill(pid, 0); }
  catch (error) {
    return error && error.code === 'ESRCH' ? 'dead' : 'unknown';
  }
  if (identity && identity.kind === 'unknown') return 'unknown';
  let actualStart = null;
  let posixEntry = null;
  if (process.platform === 'win32') {
    actualStart = windowsStartedAt(pid);
  } else {
    if (!snapshot) return 'unknown';
    posixEntry = snapshot.get(pid);
    if (!posixEntry) return 'unknown';
    actualStart = posixEntry.startedAt;
  }
  if (
    !identity ||
    !Number.isFinite(identity.lower) ||
    !Number.isFinite(identity.upper) ||
    !Number.isFinite(actualStart)
  ) return 'unknown';
  if (process.platform === 'win32') {
    return windowsBirthWindowMatches(actualStart, identity.lower, identity.upper)
      ? 'match'
      : 'mismatch';
  }
  const birthMatches =
    posixBirthWindowMatches(actualStart, identity.lower, identity.upper);
  if (!birthMatches) return 'mismatch';
  if (identity.kind === 'process') {
    const sentinel = sentinelState(pid, identity);
    if (sentinel !== 'match') return sentinel;
  }
  if (identity.kind === 'snapshot') {
    if (
      !Number.isInteger(identity.processGroup) ||
      !identity.commandHint ||
      posixEntry.pgid !== identity.processGroup ||
      typeof posixEntry.command !== 'string' ||
      !posixEntry.command.startsWith(identity.commandHint)
    ) return 'mismatch';
  }
  return 'match';
}

function runWindowsTaskkill(pid, force) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  const root = process.env.SystemRoot ||
    process.env.SYSTEMROOT ||
    'C:\\Windows';
  const executable =
    root.replace(/[\\/]+$/, '') + '\\System32\\taskkill.exe';
  const args = ['/PID', String(pid), '/T'];
  if (force) args.push('/F');
  try {
    cp.execFileSync(executable, args, {
      windowsHide: true,
      stdio: 'ignore',
    });
    return true;
  } catch (_) {
    return false;
  }
}

function signalCaptured(pid, snapshot, signal) {
  // The directly supervised root has a stronger ChildProcess + parent
  // relationship check in signalDirectTarget(). Never downgrade it to a
  // reusable numeric-PID record in this generic descendant path.
  if (pid === process.pid || (target && pid === target.pid)) return;
  const identity = captured.get(pid);
  if (identity && identity.kind === 'unknown') return;
  if (ownershipState(pid, identity, snapshot) !== 'match') return;
  if (process.platform === 'win32') {
    runWindowsTaskkill(pid, signal === 'SIGKILL');
    return;
  }
  const entry = snapshot && snapshot.get(pid);
  if (entry && entry.pgid === pid) {
    try { process.kill(-pid, signal); return; } catch (_) {}
  }
  try { process.kill(pid, signal); } catch (_) {}
}

function directTargetOwnershipState(snapshot) {
  if (!target || !target.pid || targetExited || targetClosed) return 'dead';
  const identity = {
    lower: targetStartedAtLower,
    upper: targetStartedAtUpper,
  };
  const state = ownershipState(target.pid, identity, snapshot);
  if (
    state === 'match' &&
    process.platform !== 'win32' &&
    (
      !snapshot ||
      !snapshot.get(target.pid) ||
      snapshot.get(target.pid).ppid !== process.pid
    )
  ) return 'mismatch';
  return state;
}

function signalDirectTarget(signal, providedSnapshot) {
  if (!target || !target.pid || targetExited || targetClosed) return 'dead';
  if (process.platform === 'win32') {
    const state = directTargetOwnershipState(null);
    // A numeric PID may already have been reused. Never let the direct
    // ChildProcess fallback bypass the same birth-time check used by
    // taskkill.
    if (state !== 'match') return state;
    if (!runWindowsTaskkill(target.pid, signal === 'SIGKILL')) {
      try { target.kill(signal); } catch (_) {}
    }
    return state;
  }
  const snapshot = providedSnapshot || readSnapshot();
  const state = directTargetOwnershipState(snapshot);
  if (state !== 'match') return state;
  captureTargetTree(snapshot);
  try { process.kill(-target.pid, signal); } catch (_) {}
  return state;
}

function stopForwardingOutput() {
  if (!target) return;
  try { target.stdout.unpipe(process.stdout); } catch (_) {}
  try { target.stderr.unpipe(process.stderr); } catch (_) {}
  // A child that is already exiting must not block forever on a full pipe
  // merely because the broker-side destination disappeared.
  try { target.stdout.resume(); } catch (_) {}
  try { target.stderr.resume(); } catch (_) {}
}

function reapAfterBrokerLoss() {
  const firstSnapshot = readSnapshot();
  captureTargetTree(firstSnapshot);
  captureOwnerRecords();
  const signalSnapshot = readSnapshot();
  const directState = signalDirectTarget('SIGKILL', signalSnapshot);
  for (const pid of captured.keys()) {
    if (target && pid === target.pid) continue;
    signalCaptured(pid, signalSnapshot, 'SIGKILL');
  }
  const remainingSnapshot = readSnapshot();
  let remaining =
    directState === 'match' ||
    directState === 'unknown';
  let sawUnknownRecord = false;
  for (const [pid, identity] of captured.entries()) {
    if (target && pid === target.pid) continue;
    if (identity && identity.kind === 'unknown') {
      sawUnknownRecord = true;
      remaining = true;
      continue;
    }
    const state = ownershipState(pid, identity, remainingSnapshot);
    if (state === 'match' || state === 'unknown') {
      remaining = true;
      signalCaptured(pid, remainingSnapshot, 'SIGKILL');
    } else {
      captured.delete(pid);
    }
  }
  if (sawUnknownRecord) {
    unknownRecordRetryPasses += 1;
    if (unknownRecordRetryPasses >= 3) {
      guardOwnershipFailed = true;
      for (const [pid, identity] of captured.entries()) {
        if (identity && identity.kind === 'unknown') captured.delete(pid);
      }
      remaining =
        directState === 'match' ||
        directState === 'unknown';
      for (const identity of captured.values()) {
        if (identity) remaining = true;
      }
    }
  } else {
    unknownRecordRetryPasses = 0;
  }
  if (!remaining) {
    process.exit(137);
    return;
  }
  const retryDelay = brokerLossRetryDelay;
  brokerLossRetryDelay = Math.min(1000, brokerLossRetryDelay * 2);
  global.setTimeout(reapAfterBrokerLoss, retryDelay);
}

function beginBrokerLossCleanup() {
  if (cleaning) return;
  cleaning = true;
  brokerLossRetryDelay = 50;
  try { process.stdin.pause(); } catch (_) {}
  stopForwardingOutput();
  reapAfterBrokerLoss();
}

function beginGracefulStop() {
  if (cleaning || targetExited || targetClosed) return;
  const snapshot = readSnapshot();
  captureTargetTree(snapshot);
  captureOwnerRecords();
  signalDirectTarget('SIGTERM');
  const signalSnapshot = readSnapshot();
  for (const pid of captured.keys()) {
    if (target && pid === target.pid) continue;
    signalCaptured(pid, signalSnapshot, 'SIGTERM');
  }
}

function finishNormalExit() {
  if (normalExitStarted || cleaning) return;
  normalExitStarted = true;
  const resolvedCode = targetExitCode == null
    ? targetCloseCode
    : targetExitCode;
  const resolvedSignal = targetExitSignal || targetCloseSignal;
  let guardExitCode;
  if (guardOwnershipFailed) {
    guardExitCode = 70;
  } else if (Number.isInteger(resolvedCode)) {
    guardExitCode = resolvedCode < 0
      ? 127
      : Math.max(0, Math.min(255, resolvedCode));
  } else {
    guardExitCode = resolvedSignal ? 1 : 0;
  }
  try { process.stdin.pause(); } catch (_) {}
  if (controlInput) {
    const input = controlInput;
    controlInput = null;
    input.removeAllListeners();
    try { input.destroy(); } catch (_) {}
  }
  // ChildProcess.close is the stream-drain barrier from the supervised
  // process into this guard, but the guard can still have bytes queued on its
  // own stdout/stderr pipes to the broker. process.exit() discards those
  // queued bytes under load (including a final sentinel or visible tail).
  // Setting exitCode lets Node drain pending stdio naturally without relying
  // on zero-length write callbacks, which can hang on inherited pipes.
  process.exitCode = guardExitCode;
}

function reapDescendantsAfterTargetExit() {
  descendantCleanupTimer = null;
  if (cleaning) return;
  captureOwnerRecords();
  const snapshot = readSnapshot();
  captureOriginalGroupMembers(snapshot);
  let remaining = false;
  if (
    !originalGroupCleanupAttempted &&
    process.platform !== 'win32' &&
    target &&
    target.pid
  ) {
    if (!snapshot) {
      remaining = true;
    } else {
      // Only signal the old group id while a birth-validated captured member
      // still proves that the original group exists. A past root verification
      // alone is not sufficient after the root PID can be reused.
      let originalGroupMemberAlive = false;
      for (const [pid, identity] of captured.entries()) {
        if (pid === target.pid) continue;
        const entry = snapshot.get(pid);
        if (
          entry &&
          entry.pgid === target.pid &&
          ownershipState(pid, identity, snapshot) === 'match'
        ) {
          originalGroupMemberAlive = true;
          break;
        }
      }
      if (originalGroupMemberAlive) {
        try { process.kill(-target.pid, 'SIGKILL'); } catch (_) {}
      }
      originalGroupCleanupAttempted = true;
    }
  } else if (
    !originalGroupCleanupAttempted &&
    process.platform === 'win32' &&
    target &&
    target.pid
  ) {
    // taskkill may still observe the exiting root and its tree during this
    // event-loop turn. Recorded detached descendants are handled below.
    const state = ownershipState(target.pid, {
      lower: targetStartedAtLower,
      upper: targetStartedAtUpper,
    }, null);
    if (state === 'match') {
      runWindowsTaskkill(target.pid, true);
      originalGroupCleanupAttempted = true;
    } else if (state === 'dead' || state === 'mismatch') {
      originalGroupCleanupAttempted = true;
    } else {
      remaining = true;
    }
  }
  let sawUnknownRecord = false;
  for (const [pid, identity] of captured.entries()) {
    if (target && pid === target.pid) {
      captured.delete(pid);
      continue;
    }
    if (identity && identity.kind === 'unknown') {
      sawUnknownRecord = true;
      remaining = true;
      continue;
    }
    const state = ownershipState(pid, identity, snapshot);
    if (state === 'match' || state === 'unknown') {
      remaining = true;
      signalCaptured(pid, snapshot, 'SIGKILL');
    } else {
      captured.delete(pid);
    }
  }
  if (sawUnknownRecord) {
    unknownRecordRetryPasses += 1;
    if (unknownRecordRetryPasses >= 3) {
      guardOwnershipFailed = true;
      for (const [pid, identity] of captured.entries()) {
        if (identity && identity.kind === 'unknown') captured.delete(pid);
      }
      remaining = false;
      for (const identity of captured.values()) {
        if (identity) remaining = true;
      }
    }
  } else {
    unknownRecordRetryPasses = 0;
  }
  if (remaining || !targetClosed) {
    const retryDelay = descendantRetryDelay;
    descendantRetryDelay = Math.min(1000, descendantRetryDelay * 2);
    descendantCleanupTimer = global.setTimeout(
      reapDescendantsAfterTargetExit,
      retryDelay,
    );
    return;
  }
  finishNormalExit();
}

process.on('SIGTERM', beginGracefulStop);
process.on('SIGINT', beginBrokerLossCleanup);
process.on('SIGHUP', beginBrokerLossCleanup);
process.stdin.on('end', beginBrokerLossCleanup);
process.stdin.on('close', beginBrokerLossCleanup);
process.stdin.on('error', beginBrokerLossCleanup);

let controlInput = null;
let controlBuffer = '';
try {
  // Extra child-process stdio descriptors are libuv pipes, not ordinary
  // files. fs.createReadStream performs a blocking thread-pool read that
  // process.exit() cannot cancel while the broker keeps its writer open,
  // deadlocking normal guard shutdown. net.Socket owns the pipe through
  // libuv and can be destroyed synchronously at the normal-exit barrier.
  controlInput = new net.Socket({
    fd: request.controlFd,
    readable: true,
    writable: false,
  });
  controlInput.setEncoding('utf8');
  controlInput.on('data', chunk => {
    controlBuffer += chunk;
    if (controlBuffer.length > 4096) {
      controlBuffer = controlBuffer.slice(-4096);
    }
    let newline = controlBuffer.indexOf('\n');
    while (newline >= 0) {
      const command = controlBuffer.slice(0, newline);
      controlBuffer = controlBuffer.slice(newline + 1);
      if (command === 'GRACEFUL_STOP') beginGracefulStop();
      else if (command === 'FORCE_STOP') beginBrokerLossCleanup();
      newline = controlBuffer.indexOf('\n');
    }
  });
  controlInput.on('end', beginBrokerLossCleanup);
  controlInput.on('close', beginBrokerLossCleanup);
  controlInput.on('error', beginBrokerLossCleanup);
  controlInput.resume();
} catch (_) {
  beginBrokerLossCleanup();
}

const stdio = process.platform === 'win32'
  ? ['pipe', 'pipe', 'pipe']
  : ['pipe', 'pipe', 'pipe', 3];
try {
  targetStartedAtLower = Date.now();
  target = cp.spawn(request.command, request.args, {
    cwd: typeof request.cwd === 'string' ? request.cwd : undefined,
    env: targetEnv,
    // Keep the guard outside the PTY wrapper's process group. The wrapper's
    // fd3 emergency kill of process group 0 may terminate its full tree without
    // killing the only process that still remembers the target PID.
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio,
  });
  targetStartedAtUpper = Date.now();
  const initialSnapshot = readSnapshot();
  captureTargetTree(initialSnapshot);
  scheduleTargetIdentityBurst();
} catch (error) {
  process.stderr.write(String(error && error.message || error) + '\n');
  process.exit(127);
}
target.stdin.on('error', () => {});
target.stdout.on('error', () => {});
target.stderr.on('error', () => {});
const handleOutputDestinationError = () => beginBrokerLossCleanup();
process.stdout.on('error', handleOutputDestinationError);
process.stderr.on('error', handleOutputDestinationError);
target.stdout.pipe(process.stdout);
target.stderr.pipe(process.stderr);
process.stdin.on('data', data => {
  if (cleaning || !target || targetClosed) return;
  try {
    if (!target.stdin.write(data)) {
      process.stdin.pause();
      target.stdin.once('drain', () => {
        if (!cleaning) process.stdin.resume();
      });
    }
  } catch (_) {}
});
target.on('error', error => {
  try {
    process.stderr.write(String(error && error.message || error) + '\n');
  } catch (_) {}
});
target.on('exit', (code, signal) => {
  targetExited = true;
  targetExitCode = code;
  targetExitSignal = signal;
  if (!cleaning) {
    // A detached descendant can keep the target's inherited stdout/stderr
    // open after the root exit. Capture and terminate that tree immediately
    // so ChildProcess.close remains a finite stream-drain barrier.
    captureOwnerRecords();
    const signalSnapshot = readSnapshot();
    captureOriginalGroupMembers(signalSnapshot);
    for (const pid of captured.keys()) {
      if (!target || pid !== target.pid) {
        signalCaptured(pid, signalSnapshot, 'SIGKILL');
      }
    }
    if (!descendantCleanupTimer) {
      descendantRetryDelay = 50;
      descendantCleanupTimer = global.setTimeout(
        reapDescendantsAfterTargetExit,
        0,
      );
    }
  }
});
target.on('close', (code, signal) => {
  targetClosed = true;
  if (cleaning) return;
  targetCloseCode = code;
  targetCloseSignal = signal;
  captureOwnerRecords();
  if (!descendantCleanupTimer) {
    descendantRetryDelay = 50;
    descendantCleanupTimer = global.setTimeout(
      reapDescendantsAfterTargetExit,
      0,
    );
  }
});
process.stdin.resume();
`
