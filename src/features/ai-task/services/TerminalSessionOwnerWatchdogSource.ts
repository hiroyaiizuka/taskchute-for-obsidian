import { OWNER_REAP_PLAN_SOURCE } from './broker-source/OwnerReapPlanSource'
import { OWNER_SENTINEL_PROBE_SOURCE } from './broker-source/OwnerSentinelProbeSource'
import { POSIX_PROCESS_SNAPSHOT_SOURCE } from './broker-source/PosixProcessSnapshotSource'

/**
 * Broker-independent process owner watchdog.
 *
 * The terminal broker starts this program in a separate process group and
 * keeps its stdin pipe open for the broker lifetime. A broker crash closes
 * that pipe in the kernel, so the watchdog can reap detached descendants from
 * the per-session owner records even when both the broker control socket and
 * renderer are unavailable.
 *
 * What is left in this file is the I/O: it gathers evidence (owner records, a
 * ps snapshot, kill(0) liveness, sentinel descriptors), hands it to the pure
 * planner in OwnerReapPlanSource, and applies the plan it gets back. The
 * reasoning about ownership lives there, where it can be tested without
 * crashing a broker on a real OS.
 */
export const TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE = String.raw`
'use strict';
const fs = require('fs');
const cp = require('child_process');
const path = require('path');
${POSIX_PROCESS_SNAPSHOT_SOURCE}
${OWNER_SENTINEL_PROBE_SOURCE}
${OWNER_REAP_PLAN_SOURCE}
const ownerPrefix = process.env.TASKCHUTE_OWNER_WATCH_PREFIX || '';
const descriptorPath = process.env.TASKCHUTE_OWNER_WATCH_DESCRIPTOR || '';
const descriptorToken = process.env.TASKCHUTE_OWNER_WATCH_TOKEN || '';
const brokerPid = Number(process.env.TASKCHUTE_OWNER_WATCH_BROKER_PID);
const hookPath = process.env.TASKCHUTE_OWNER_WATCH_HOOK || '';
const pythonHookDir = process.env.TASKCHUTE_OWNER_WATCH_PYTHON || '';
const tracePath = process.env.TASKCHUTE_OWNER_WATCH_TRACE || '';
const forcePsFailure =
  process.env.TASKCHUTE_OWNER_WATCH_TEST_PS_FAILURE === '1';
const ownerReadLimit = 16 * 1024 * 1024;
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
    return applyOwnerFileText(
      active,
      buffer.toString('utf8', 0, offset),
      target,
    );
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

// One line per reap round, off unless a path is given. A watchdog that will
// not finish is otherwise silent by construction — it holds no socket and no
// terminal — and the only evidence left is which processes survived, which is
// what made the CI failures unattributable.
function trace(round) {
  if (!tracePath) return;
  try {
    fs.appendFileSync(tracePath, JSON.stringify(round) + '\n');
  } catch (_) {}
}

function tracedStates(states, owned) {
  const rendered = [];
  for (const [pid, verdict] of states.entries()) {
    const identity = owned.get(pid);
    rendered.push({
      pid,
      state: verdict.state,
      reason: verdict.reason,
      kind: identity ? identity.kind : null,
      hint: identity ? identity.commandHint : null,
      fd: identity ? identity.sentinelFd : null,
    });
  }
  return rendered;
}

function pidLiveness(pid) {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return error && error.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

// Gathers the evidence the planner asks for, in the two passes it asks for:
// sentinel descriptors are probed only for the PIDs whose ownership still turns
// on one.
function classifyOwned(owned, snapshot) {
  const entries = Array.from(owned.entries());
  const liveness = new Map();
  const windowsBirths = new Map();
  for (const [pid] of entries) {
    liveness.set(pid, pidLiveness(pid));
    if (process.platform === 'win32') {
      windowsBirths.set(pid, windowsStartedAt(pid));
    }
  }
  const evidence = {
    platform: process.platform,
    entries,
    snapshot,
    liveness,
    windowsStartedAt: windowsBirths,
    sentinel: new Map(),
  };
  let planned = classifyOwnedPids(evidence);
  if (planned.needSentinel.length === 0) return planned.states;
  for (const pid of planned.needSentinel) {
    evidence.sentinel.set(pid, probeSentinelState(pid, owned.get(pid)));
  }
  return classifyOwnedPids(evidence).states;
}

function expandOwned(roots, snapshot) {
  const expanded = new Map(roots);
  if (!snapshot) return expanded;
  const descendants = posixSnapshotDescendantPids(
    snapshot,
    Array.from(roots.keys()),
  );
  for (const pid of descendants) {
    if (expanded.has(pid)) continue;
    expanded.set(pid, posixSnapshotIdentity(snapshot.get(pid)));
  }
  return expanded;
}

function signalOwned(pid, target) {
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
  if (target === 'group') {
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

function reapUntilGone(startedAt) {
  const elapsed = Math.max(0, Date.now() - startedAt);
  const records = readOwnedRecords();
  const snapshot = readPosixSnapshot();
  const rootStates = classifyOwned(records.active, snapshot);
  const rootPlan = planReapRoots(rootStates, records.active);
  const expanded = expandOwned(rootPlan.roots, snapshot);
  // Revalidate against a snapshot taken immediately before signalling.
  const signalSnapshot = readPosixSnapshot();
  const signalStates = classifyOwned(expanded, signalSnapshot);
  const signalPlan = planReapSignals(
    signalStates,
    expanded,
    {
      snapshot: signalSnapshot,
      selfPid: process.pid,
      brokerPid,
    },
  );
  for (const target of signalPlan.kill) {
    signalOwned(target.pid, target.target);
  }
  const outcome = planReapOutcome({
    matching: signalPlan.kill.length,
    unknown: rootPlan.unknown || signalPlan.unknown,
    sessionGuardAlive: rootPlan.sessionGuardAlive,
    trustworthy: records.trustworthy,
  });
  trace({
    elapsed,
    platform: process.platform,
    snapshot: Boolean(snapshot),
    trustworthy: records.trustworthy,
    guard: rootPlan.sessionGuardAlive,
    roots: tracedStates(rootStates, records.active),
    signals: tracedStates(signalStates, expanded),
    kill: signalPlan.kill,
    outcome,
  });
  if (outcome === 'cleanup') {
    cleanupArtifacts(records.files);
    process.exit(0);
    return;
  }
  // Keep this retry referenced until every birth-validated owner is gone: it is
  // the last live handle on the session after the broker pipe closes.
  global.setTimeout(
    () => reapUntilGone(startedAt),
    reapRetryDelayMs(elapsed),
  );
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
