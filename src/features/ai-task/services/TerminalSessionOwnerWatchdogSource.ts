import { POSIX_PROCESS_SNAPSHOT_SOURCE } from './broker-source/PosixProcessSnapshotSource'

/**
 * Broker-independent process owner watchdog.
 *
 * The terminal broker starts this program in a separate process group and
 * keeps its stdin pipe open for the broker lifetime. A broker crash closes
 * that pipe in the kernel, so the watchdog can reap detached descendants from
 * the per-session owner records even when both the broker control socket and
 * renderer are unavailable.
 */
export const TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE = String.raw`
'use strict';
const fs = require('fs');
const cp = require('child_process');
const path = require('path');
${POSIX_PROCESS_SNAPSHOT_SOURCE}
const ownerPrefix = process.env.TASKCHUTE_OWNER_WATCH_PREFIX || '';
const descriptorPath = process.env.TASKCHUTE_OWNER_WATCH_DESCRIPTOR || '';
const descriptorToken = process.env.TASKCHUTE_OWNER_WATCH_TOKEN || '';
const brokerPid = Number(process.env.TASKCHUTE_OWNER_WATCH_BROKER_PID);
const hookPath = process.env.TASKCHUTE_OWNER_WATCH_HOOK || '';
const pythonHookDir = process.env.TASKCHUTE_OWNER_WATCH_PYTHON || '';
const forcePsFailure =
  process.env.TASKCHUTE_OWNER_WATCH_TEST_PS_FAILURE === '1';
const ownerReadLimit = 16 * 1024 * 1024;
const ownerRecordLimit = 2048;
let input = '';
let disarmed = false;
let finished = false;

function trustedStats(target, expectedType) {
  try {
    const stats = fs.lstatSync(target);
    if (stats.isSymbolicLink()) return null;
    if (expectedType === 'file' && !stats.isFile()) return null;
    if (expectedType === 'directory' && !stats.isDirectory()) return null;
    if (
      process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      Number.isInteger(stats.uid) &&
      stats.uid !== process.getuid()
    ) return null;
    if (
      process.platform !== 'win32' &&
      (stats.mode & 0o077) !== 0
    ) return null;
    return stats;
  } catch (_) {
    return null;
  }
}

function ownerPaths() {
  const directory = path.dirname(ownerPrefix);
  const prefix = path.basename(ownerPrefix);
  let names = [];
  try {
    names = fs.readdirSync(directory);
  } catch (_) {
    return { paths: [], trustworthy: false };
  }
  return {
    paths: names
      .filter(name => name.startsWith(prefix) && name.endsWith('.jsonl'))
      .map(name => path.join(directory, name)),
    trustworthy: true,
  };
}

function applyRecord(active, record, ownerFile) {
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
    kind: record.kind === 'guard'
      ? (
        typeof record.guardToken === 'string' &&
        /^[a-f0-9]{48}$/.test(record.guardToken)
          ? 'guard'
          : 'unknown'
      )
      : (record.kind === 'unknown' ? 'unknown' : 'process'),
    guardToken:
      typeof record.guardToken === 'string' &&
      /^[a-f0-9]{48}$/.test(record.guardToken)
        ? record.guardToken
        : null,
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

function applyPartialRecord(active, text, ownerFile) {
  const match = String(text).match(
    /^\s*\{\s*"pid"\s*:\s*(\d+)\s*,\s*"startedAt"\s*:\s*(\d+)(?:\s*,\s*"startedAtLower"\s*:\s*(\d+))?/,
  );
  if (!match) return false;
  const startedAt = Number(match[2]);
  // A torn record cannot authenticate its complete process identity.
  const kind = 'unknown';
  const applied = applyRecord(active, {
    pid: Number(match[1]),
    startedAt,
    startedAtLower: match[3] === undefined
      ? startedAt
      : Number(match[3]),
    active: !/"active"\s*:\s*false/.test(text),
    kind,
    guardToken: (
      String(text).match(/"guardToken"\s*:\s*"([a-f0-9]{48})"/) ||
      []
    )[1],
  }, ownerFile);
  return applied && kind !== 'unknown';
}

function readOwnerFile(target, active) {
  const before = trustedStats(target, 'file');
  if (!before || before.size > ownerReadLimit) return false;
  let fd;
  try {
    fd = fs.openSync(target, 'r');
    const opened = fs.fstatSync(fd);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > ownerReadLimit
    ) return false;
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(
        fd,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (read <= 0) break;
      offset += read;
    }
    const after = fs.fstatSync(fd);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      offset !== opened.size
    ) return false;
    const text = buffer.toString('utf8', 0, offset);
    const lines = text.split('\n');
    const tail = lines.pop() || '';
    let valid = true;
    for (const line of lines) {
      if (!line) continue;
      if (line.length > ownerRecordLimit) {
        valid = applyPartialRecord(active, line, target) && valid;
        continue;
      }
      try {
        valid = applyRecord(active, JSON.parse(line), target) && valid;
      } catch (_) {
        valid = applyPartialRecord(active, line, target) && valid;
      }
    }
    if (tail) {
      valid = applyPartialRecord(active, tail, target) && valid;
    }
    return valid;
  } catch (_) {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function readOwnedRecords() {
  const active = new Map();
  const listed = ownerPaths();
  const files = listed.paths;
  let trustworthy = listed.trustworthy;
  for (const target of files) {
    if (!readOwnerFile(target, active)) trustworthy = false;
  }
  return { active, files, trustworthy };
}

function readPosixSnapshot() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return null;
  }
  if (forcePsFailure) return null;
  try {
    return parsePosixProcessSnapshot(cp.execFileSync(
      '/bin/ps',
      posixSnapshotPsArgs(process.platform),
      posixSnapshotPsOptions(process.env),
    ));
  } catch (_) {
    return null;
  }
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
  let alive = true;
  try { process.kill(pid, 0); }
  catch (error) {
    if (error && error.code === 'ESRCH') alive = false;
    else return 'unknown';
  }
  if (!alive) return 'dead';
  let actualStart = null;
  let posixEntry = null;
  if (process.platform === 'win32') {
    actualStart = windowsStartedAt(pid);
  } else {
    if (!snapshot) return 'unknown';
    posixEntry = snapshot && snapshot.get(pid);
    if (!posixEntry) return 'unknown';
    actualStart = posixEntry.startedAt;
    if (
      identity &&
      identity.kind === 'guard' &&
      identity.guardToken &&
      (
        typeof posixEntry.command !== 'string' ||
        !posixEntry.command.includes(identity.guardToken)
      )
    ) return 'mismatch';
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

function expandOwned(active, snapshot) {
  const expanded = new Map(active);
  if (!snapshot) return expanded;
  const descendants = posixSnapshotDescendantPids(
    snapshot,
    Array.from(active.keys()),
  );
  for (const pid of descendants) {
    if (expanded.has(pid)) continue;
    expanded.set(pid, posixSnapshotIdentity(snapshot.get(pid)));
  }
  return expanded;
}

function signalOwned(pid, snapshot) {
  if (pid === process.pid || pid === brokerPid) return;
  if (process.platform === 'win32') {
    try {
      const root = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
      const taskkill =
        root.replace(/[\\/]+$/, '') + '\\System32\\taskkill.exe';
      cp.execFileSync(
        taskkill,
        ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' },
      );
    } catch (_) {}
    return;
  }
  const entry = snapshot && snapshot.get(pid);
  if (entry && entry.pgid === pid) {
    try { process.kill(-pid, 'SIGKILL'); return; } catch (_) {}
  }
  try { process.kill(pid, 'SIGKILL'); } catch (_) {}
}

function removeFile(target) {
  try {
    const stats = fs.lstatSync(target);
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      if (
        process.platform === 'win32' ||
        typeof process.getuid !== 'function' ||
        !Number.isInteger(stats.uid) ||
        stats.uid === process.getuid()
      ) fs.rmSync(target, { recursive: true, force: true });
      return;
    }
    fs.unlinkSync(target);
  } catch (_) {}
}

function cleanupArtifacts(files) {
  for (const target of files) removeFile(target);
  removeFile(hookPath);
  removeFile(pythonHookDir);
  try {
    const stats = trustedStats(descriptorPath, 'file');
    if (!stats) return;
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    if (
      descriptor &&
      descriptor.token === descriptorToken &&
      descriptor.pid === brokerPid
    ) fs.unlinkSync(descriptorPath);
  } catch (_) {}
}

function reapUntilGone(deadline) {
  const records = readOwnedRecords();
  const snapshot = readPosixSnapshot();
  const matchingRoots = new Map();
  let unknown = false;
  let sessionGuardAlive = false;
  for (const [pid, identity] of records.active.entries()) {
    const state = ownershipState(pid, identity, snapshot);
    if (
      identity &&
      identity.kind === 'unknown' &&
      state !== 'dead' &&
      state !== 'mismatch'
    ) {
      unknown = true;
      continue;
    }
    if (state === 'match') {
      if (identity && identity.kind === 'guard') {
        // The guard owns the only race-free raw ChildProcess reference. Never
        // kill it from a reusable PID record; broker-pipe EOF tells it to
        // finish cleanup and exit on its own.
        sessionGuardAlive = true;
      } else {
        matchingRoots.set(pid, identity);
      }
    } else if (state === 'unknown') {
      unknown = true;
    }
  }
  // Never derive ownership from a stale/reused root PID. Only a root whose
  // own birth identity matches may confer ownership on its current children.
  const expanded = expandOwned(matchingRoots, snapshot);
  const signalSnapshot = readPosixSnapshot();
  let matching = 0;
  for (const [pid, identity] of expanded.entries()) {
    // Revalidate immediately before signalling. This closes the gap between
    // the initial root classification and process-tree expansion.
    const state = ownershipState(pid, identity, signalSnapshot);
    if (state === 'match') {
      matching += 1;
      signalOwned(pid, signalSnapshot);
    } else if (state === 'unknown') {
      unknown = true;
    }
  }
  if (
    matching === 0 &&
    !unknown &&
    !sessionGuardAlive &&
    records.trustworthy
  ) {
    cleanupArtifacts(records.files);
    process.exit(0);
    return;
  }
  // This retry is the watchdog's final live handle after the broker pipe
  // closes. Keep it referenced until every birth-validated owner is gone.
  // Transient ps/readdir failures must never turn into "clean" or abandon
  // the only recovery actor. Permanent corruption intentionally preserves
  // both this small guard and the owner evidence for manual diagnosis.
  const elapsed = Math.max(0, Date.now() - deadline);
  const retryMs = Math.min(1000, 50 + Math.floor(elapsed / 20));
  global.setTimeout(() => reapUntilGone(deadline), retryMs);
}

function finishAfterPipeClose() {
  if (finished) return;
  finished = true;
  if (disarmed) {
    try {
      process.stdout.write('DISARMED\n', () => process.exit(0));
    } catch (_) {
      process.exit(71);
    }
    return;
  }
  reapUntilGone(Date.now());
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (input.length > 4096) {
    input = input.slice(-4096);
  }
  if (input.includes('DISARM\n')) disarmed = true;
});
process.stdin.on('end', finishAfterPipeClose);
process.stdin.on('close', finishAfterPipeClose);
process.stdin.on('error', finishAfterPipeClose);
process.stdin.resume();
try { process.stdout.write('READY\n'); } catch (_) { process.exit(70); }
`
