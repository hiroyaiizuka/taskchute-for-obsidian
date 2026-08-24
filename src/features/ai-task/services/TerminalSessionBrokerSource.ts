import { TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE } from './TerminalSessionOwnerWatchdogSource'
import { TERMINAL_SESSION_GUARD_SOURCE } from './TerminalSessionGuardSource'
import {
  FISH_TERMINAL_BOOTSTRAP,
  POSIX_TERMINAL_BOOTSTRAP,
  TERMINAL_ARGV_BOOTSTRAP_ARG_ZERO,
} from './dispatchers/TerminalShellBootstrap'

/**
 * Renderer-independent Node broker program.
 *
 * Kept plain ES2018 so Electron's `ELECTRON_RUN_AS_NODE` mode can execute it
 * unchanged. The source has no secrets; token/path/TTL arrive through env.
 */
export const TERMINAL_BROKER_SOURCE = String.raw`
'use strict';
const net = require('net');
const fs = require('fs');
const cp = require('child_process');
const crypto = require('crypto');
const path = require('path');
const ownerWatchdogProgram = ${JSON.stringify(TERMINAL_SESSION_OWNER_WATCHDOG_SOURCE)};
const sessionGuardProgram = ${JSON.stringify(TERMINAL_SESSION_GUARD_SOURCE)};
const terminalArgvBootstrapProgram = ${JSON.stringify(POSIX_TERMINAL_BOOTSTRAP)};
const fishTerminalArgvBootstrapProgram = ${JSON.stringify(FISH_TERMINAL_BOOTSTRAP)};
const terminalArgvBootstrapArgZero = ${JSON.stringify(TERMINAL_ARGV_BOOTSTRAP_ARG_ZERO)};
const descriptorPath = process.env.TASKCHUTE_BROKER_DESCRIPTOR;
const token = process.env.TASKCHUTE_BROKER_TOKEN;
const idleTtlMs = Number(process.env.TASKCHUTE_BROKER_TTL_MS || 1800000);
const replayLimit = 200 * 1024;
const frameLimit = 1024 * 1024;
const stderrPendingLimit = 64 * 1024;
// Renderer clients destroy their socket when a frame exceeds 1MB; keep the
// serialized 'attached' frame well under that with headroom for interleaved
// data frames and the envelope.
const attachedFrameBudget = 700 * 1024;
const clientBufferLimit = 4 * 1024 * 1024;
const stuckMsRaw = Number(process.env.TASKCHUTE_BROKER_STUCK_MS);
const stuckClientMs = Number.isFinite(stuckMsRaw) && stuckMsRaw > 0 ? stuckMsRaw : 5000;
// Test hook: lets tests observe resize batching without a real terminal.
const sttyPath = process.env.TASKCHUTE_BROKER_STTY || '/bin/stty';
const ownerSetupFailureForTest =
  process.env.TASKCHUTE_BROKER_TEST_OWNER_SETUP_FAILURE || '';
const stopGraceMs = 1500;
const exitRetentionMs = 5 * 60 * 1000;
const ownershipRetryMs = 100;
const ownershipRetryMaxMs = 1000;
const ownerRecordLimit = 2048;
const ownerReadChunkLimit = 16 * 1024;
const ownerReadScanLimit = 64 * 1024;
const ownerTrackingFailureLimit = 3;
const ownerPidFileEnvName = 'TASKCHUTE_BROKER_OWNER_PID_FILE';
const ownerTokenPrefix = String(token || '').slice(0, 24);
const ownerSessionPrefix =
  descriptorPath + '.owner-session-' + ownerTokenPrefix + '-';
const ownerHookPath =
  descriptorPath + '.owner-hook-' + ownerTokenPrefix + '.cjs';
const ownerPythonHookDir =
  descriptorPath + '.owner-python-' + ownerTokenPrefix;
const ownerPythonHookPath = ownerPythonHookDir + '/sitecustomize.py';
let ownerHookReady = false;
let ownerPythonHookReady = false;
const marker = '__TASKCHUTE_AI_EXIT__';
if (!descriptorPath || !/^[a-f0-9]{64}$/.test(token || '')) process.exit(64);
const sessions = new Map();
const clients = new Set();
let ownerWatchdog = null;
let ownerWatchdogReady = false;
let ownerWatchdogStarted = false;
let ownerWatchdogOutput = '';
let ownerWatchdogReadyTimer = null;
let ownerWatchdogDisarmTimer = null;
let ownerWatchdogDisarmCallback = null;
let idleTimer = null;
let shuttingDown = false;
let shutdownRequested = false;
let shutdownAckReady = false;
let shutdownRetryTimer = null;
let shutdownRetryAcknowledge = false;
let shutdownPendingAfterSessions = false;
const shutdownWaiters = new Set();
let deferredShutdownTimer = null;
let activeRendererLease = null;
const retiredRendererLeaseOwners = new Set();
const rendererLeasePattern = /^[A-Za-z0-9._:-]{1,128}$/;
const canonicalRendererLeaseOwnerId = 'taskchute-plus-ai-terminal';
function cancelDeferredShutdown() {
  if (!deferredShutdownTimer) return;
  global.clearTimeout(deferredShutdownTimer);
  deferredShutdownTimer = null;
}
function rendererLeaseOf(message) {
  const token = (
    message &&
    typeof message.rendererLeaseToken === 'string' &&
    rendererLeasePattern.test(message.rendererLeaseToken)
  )
    ? message.rendererLeaseToken
    : null;
  const ownerId = (
    message &&
    typeof message.rendererLeaseOwnerId === 'string' &&
    rendererLeasePattern.test(message.rendererLeaseOwnerId)
  )
    ? message.rendererLeaseOwnerId
    : null;
  const generation = message && Number(message.rendererLeaseGeneration);
  if (
    !token ||
    !ownerId ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) {
    return null;
  }
  return { token, ownerId, generation };
}
function rendererLeaseIsCurrent(message) {
  const lease = rendererLeaseOf(message);
  if (!activeRendererLease) return true;
  return Boolean(
    lease &&
    lease.token === activeRendererLease.token &&
    lease.ownerId === activeRendererLease.ownerId &&
    lease.generation === activeRendererLease.generation
  );
}
function claimRendererLease(message) {
  const lease = rendererLeaseOf(message);
  if (!lease) return activeRendererLease === null;
  if (retiredRendererLeaseOwners.has(lease.ownerId)) return false;
  if (!activeRendererLease) {
    activeRendererLease = lease;
    return true;
  }
  if (lease.ownerId === activeRendererLease.ownerId) {
    if (lease.generation < activeRendererLease.generation) return false;
    if (lease.generation === activeRendererLease.generation) {
      return lease.token === activeRendererLease.token;
    }
    activeRendererLease = lease;
    return true;
  }
  // Modern renderers share one broker-lineage owner and use a persisted
  // monotonic generation. Permit a one-way migration from older bundles
  // whose owner was random, but once the canonical owner is active no late
  // unseen legacy owner may reclaim the broker.
  if (
    activeRendererLease.ownerId === canonicalRendererLeaseOwnerId &&
    lease.ownerId !== canonicalRendererLeaseOwnerId
  ) return false;
  if (
    lease.ownerId !== canonicalRendererLeaseOwnerId &&
    activeRendererLease.ownerId !== canonicalRendererLeaseOwnerId
  ) {
    // Compatibility for two legacy random-owner renderers. This path
    // disappears after the first modern activation below.
    retiredRendererLeaseOwners.add(activeRendererLease.ownerId);
    activeRendererLease = lease;
    return true;
  }
  retiredRendererLeaseOwners.add(activeRendererLease.ownerId);
  activeRendererLease = lease;
  return true;
}
function finishOwnerWatchdogDisarm(confirmed) {
  if (ownerWatchdogDisarmTimer) {
    global.clearTimeout(ownerWatchdogDisarmTimer);
    ownerWatchdogDisarmTimer = null;
  }
  const callback = ownerWatchdogDisarmCallback;
  ownerWatchdogDisarmCallback = null;
  if (callback) callback(confirmed === true);
}
function disarmOwnerWatchdog(callback) {
  if (!ownerWatchdog || !ownerWatchdogReady) {
    callback(false);
    return;
  }
  ownerWatchdogDisarmCallback = callback;
  try {
    ownerWatchdog.stdin.write('DISARM\n');
    ownerWatchdog.stdin.end();
  } catch (_) {
    finishOwnerWatchdogDisarm(false);
    return;
  }
  ownerWatchdogDisarmTimer = global.setTimeout(() => {
    try { ownerWatchdog.kill('SIGKILL'); } catch (_) {}
    finishOwnerWatchdogDisarm(false);
  }, 1500);
  ownerWatchdogDisarmTimer.unref();
}
function startOwnerWatchdog(onReady) {
  if (ownerWatchdogStarted) return;
  ownerWatchdogStarted = true;
  if (ownerSetupFailureForTest === 'watchdog') process.exit(66);
  const watchdogEnv = Object.assign({}, process.env, {
    NODE_OPTIONS: '',
    TASKCHUTE_OWNER_WATCH_PREFIX: ownerSessionPrefix,
    TASKCHUTE_OWNER_WATCH_DESCRIPTOR: descriptorPath,
    TASKCHUTE_OWNER_WATCH_TOKEN: token,
    TASKCHUTE_OWNER_WATCH_BROKER_PID: String(process.pid),
    TASKCHUTE_OWNER_WATCH_HOOK: ownerHookPath,
    TASKCHUTE_OWNER_WATCH_PYTHON: ownerPythonHookDir,
  });
  try {
    ownerWatchdog = cp.spawn(
      process.execPath,
      ['-e', ownerWatchdogProgram],
      {
        detached: true,
        windowsHide: true,
        env: watchdogEnv,
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    );
  } catch (_) {
    process.exit(66);
    return;
  }
  if (!ownerWatchdog || !ownerWatchdog.pid) {
    process.exit(66);
    return;
  }
  ownerWatchdog.stdin.on('error', () => {});
  ownerWatchdog.stdout.setEncoding('utf8');
  ownerWatchdog.stdout.on('data', chunk => {
    ownerWatchdogOutput += chunk;
    if (ownerWatchdogOutput.length > 4096) {
      ownerWatchdogOutput = ownerWatchdogOutput.slice(-4096);
    }
    if (!ownerWatchdogReady && ownerWatchdogOutput.includes('READY\n')) {
      ownerWatchdogReady = true;
      if (ownerWatchdogReadyTimer) {
        global.clearTimeout(ownerWatchdogReadyTimer);
        ownerWatchdogReadyTimer = null;
      }
      onReady();
    }
    if (ownerWatchdogOutput.includes('DISARMED\n')) {
      finishOwnerWatchdogDisarm(true);
    }
  });
  ownerWatchdog.on('error', () => {
    if (!ownerWatchdogReady) process.exit(66);
  });
  ownerWatchdog.on('exit', () => {
    const wasReady = ownerWatchdogReady;
    ownerWatchdog = null;
    ownerWatchdogReady = false;
    if (ownerWatchdogDisarmCallback) {
      finishOwnerWatchdogDisarm(false);
      return;
    }
    if (!shuttingDown && wasReady) {
      for (const session of sessions.values()) {
        if (!session.completed) {
          session.stopRequested = true;
          requestGuardStop(session, true);
        }
      }
      shutdown(false);
    }
  });
  ownerWatchdog.unref();
  ownerWatchdogReadyTimer = global.setTimeout(() => {
    if (!ownerWatchdogReady) {
      try { ownerWatchdog.kill('SIGKILL'); } catch (_) {}
      process.exit(66);
    }
  }, 2000);
  ownerWatchdogReadyTimer.unref();
}
function sendRaw(socket, frame) {
  if (!socket || socket.destroyed) return true;
  try {
    const flushed = socket.write(frame + '\n');
    if (!flushed) {
      const buffered = typeof socket.writableLength === 'number' ? socket.writableLength : 0;
      if (buffered > clientBufferLimit) {
        // A stuck client must never queue broker memory unboundedly; it can
        // reattach and recover through replay.
        socket.destroy();
        return true;
      }
    }
    return flushed;
  } catch (_) { return true; }
}
function send(socket, value) {
  return sendRaw(socket, JSON.stringify(value));
}
function markPressured(session, socket) {
  if (!session.stdoutPaused && session.child && session.child.stdout) {
    session.stdoutPaused = true;
    try { session.child.stdout.pause(); } catch (_) {}
  }
  if (session.pressured.has(socket)) return;
  session.pressured.add(socket);
  // A client that never drains would keep the PTY paused for everyone.
  const timer = global.setTimeout(() => { try { socket.destroy(); } catch (_) {} }, stuckClientMs);
  timer.unref();
  session.pressureTimers.set(socket, timer);
  socket.once('drain', () => releasePressure(session, socket));
}
function releasePressure(session, socket) {
  const timer = session.pressureTimers.get(socket);
  if (timer) {
    global.clearTimeout(timer);
    session.pressureTimers.delete(socket);
  }
  if (!session.pressured.delete(socket)) return;
  if (session.pressured.size === 0 && session.stdoutPaused) {
    session.stdoutPaused = false;
    if (session.child && session.child.stdout) {
      try { session.child.stdout.resume(); } catch (_) {}
    }
  }
}
function appendReplay(session, data) {
  if (!data) return;
  if (data.length >= replayLimit) {
    session.replayChunks = [
      JSON.parse(JSON.stringify(data.slice(data.length - replayLimit))),
    ];
    session.replayLength = replayLimit;
    return;
  }
  session.replayChunks.push(data);
  session.replayLength += data.length;
  while (
    session.replayChunks.length > 1 &&
    session.replayLength - session.replayChunks[0].length >= replayLimit
  ) {
    session.replayLength -= session.replayChunks.shift().length;
  }
  if (session.replayLength > replayLimit) {
    const drop = session.replayLength - replayLimit;
    session.replayChunks[0] = JSON.parse(
      JSON.stringify(session.replayChunks[0].slice(drop)),
    );
    session.replayLength = replayLimit;
  }
}
function materializeReplay(session) {
  return session.replayChunks.join('');
}
function broadcast(session, value) {
  const frame = JSON.stringify(value);
  for (const socket of Array.from(session.clients)) {
    if (!sendRaw(socket, frame)) markPressured(session, socket);
  }
}
function pidLivenessState(pid) {
  if (!Number.isInteger(pid) || pid < 1) return 'dead';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (error && error.code === 'ESRCH') return 'dead';
    // EPERM/EACCES proves that the numeric PID exists but cannot safely be
    // inspected or signalled by this broker. Never mistake that for exit.
    return 'unknown';
  }
}
function applyOwnerRecord(session, record) {
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
    guardToken:
      typeof record.guardToken === 'string' &&
      /^[a-f0-9]{48}$/.test(record.guardToken)
        ? record.guardToken
        : null,
    sentinelFd:
      Number.isInteger(record.sentinelFd) &&
      record.sentinelFd >= 3 &&
      record.sentinelFd <= 4096
        ? record.sentinelFd
        : null,
    sentinelPath:
      typeof record.sentinelPath === 'string' &&
      record.sentinelPath === session.ownerPidFile
        ? record.sentinelPath
        : null,
  };
  if (record.active === false) {
    const current = session.ownedPids.get(record.pid);
    if (
      current &&
      current.lower === identity.lower &&
      current.upper === identity.upper
    ) {
      session.ownedPids.delete(record.pid);
    }
  } else {
    session.ownedPids.set(record.pid, identity);
  }
  return true;
}
function applyPartialOwnerRecord(session, text) {
  // Both injected hooks serialize pid, startedAt, startedAtLower, active in
  // that order. If the final append is torn, recover the reusable-PID-safe
  // identity from the prefix and conservatively treat it as active unless a
  // complete 'active:false' field is already present.
  const match = String(text).match(
    /^\s*\{\s*"pid"\s*:\s*(\d+)\s*,\s*"startedAt"\s*:\s*(\d+)(?:\s*,\s*"startedAtLower"\s*:\s*(\d+))?/,
  );
  if (!match) return false;
  const pid = Number(match[1]);
  const startedAt = Number(match[2]);
  const startedAtLower = match[3] === undefined
    ? startedAt
    : Number(match[3]);
  // A torn record cannot authenticate its complete process identity.
  const kind = 'unknown';
  const applied = applyOwnerRecord(session, {
    pid,
    startedAt,
    startedAtLower,
    active: !/"active"\s*:\s*false/.test(text),
    kind,
  });
  return applied && kind !== 'unknown';
}
function markOwnerTrackingFailure(session, corruption) {
  if (corruption) session.ownerTrackingCorrupt = true;
  session.ownerTrackingFailures += 1;
  if (session.ownerTrackingFailures >= ownerTrackingFailureLimit) {
    // A broken tracking file must not hold a completed terminal and broker
    // forever. Parsed identities remain in ownedPids and are still reaped;
    // only the unusable channel is abandoned after bounded retries.
    session.ownerTrackingAbandoned = true;
    session.ownerTrackingUnknown = false;
    session.ownerPidReadPending = false;
    session.ownerPidRemainder = '';
    session.ownershipTrackingFailed = true;
    for (const [pid, identity] of session.ownedPids.entries()) {
      if (identity && identity.kind === 'unknown') {
        // A torn record cannot authorize signalling a reusable numeric PID.
        // Drop only that untrusted identity so the session can fail closed
        // instead of hanging forever.
        session.ownedPids.delete(pid);
      }
    }
    return;
  }
  session.ownerTrackingUnknown = true;
}
function readOwnerPidRecords(session) {
  if (session.ownerTrackingAbandoned) {
    session.ownerTrackingUnknown = false;
    session.ownerPidReadPending = false;
    return;
  }
  let budget = ownerReadScanLimit;
  session.ownerPidReadPending = false;
  session.ownerTrackingUnknown = false;
  try {
    const stat = fs.statSync(session.ownerPidFile);
    if (stat.size < session.ownerPidOffset) {
      markOwnerTrackingFailure(session, true);
      return;
    }
  } catch (_) {
    markOwnerTrackingFailure(session, false);
    return;
  }
  while (budget > 0) {
    let fd;
    let bytesRead = 0;
    let text = '';
    try {
      const stat = fs.statSync(session.ownerPidFile);
      const available = stat.size - session.ownerPidOffset;
      if (available <= 0) break;
      const length = Math.min(available, ownerReadChunkLimit, budget);
      fd = fs.openSync(session.ownerPidFile, 'r');
      const buffer = Buffer.allocUnsafe(length);
      bytesRead = fs.readSync(
        fd,
        buffer,
        0,
        length,
        session.ownerPidOffset,
      );
      session.ownerPidOffset += bytesRead;
      budget -= bytesRead;
      text = buffer.toString('utf8', 0, bytesRead);
    } catch (_) {
      markOwnerTrackingFailure(session, false);
      return;
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch (_) {}
      }
    }
    if (bytesRead <= 0) break;
    const lines = text.split('\n');
    if (session.ownerPidDroppingLine) {
      if (lines.length === 1) continue;
      lines.shift();
      session.ownerPidDroppingLine = false;
    } else {
      lines[0] = session.ownerPidRemainder + lines[0];
    }
    session.ownerPidRemainder = lines.pop() || '';
    if (session.ownerPidRemainder.length > ownerRecordLimit) {
      if (!applyPartialOwnerRecord(session, session.ownerPidRemainder)) {
        session.ownerTrackingCorrupt = true;
      }
      session.ownerPidRemainder = '';
      session.ownerPidDroppingLine = true;
    }
    for (const line of lines) {
      if (!line) continue;
      if (line.length > ownerRecordLimit) {
        if (!applyPartialOwnerRecord(session, line)) {
          session.ownerTrackingCorrupt = true;
        }
        continue;
      }
      try {
        const record = JSON.parse(line);
        if (!applyOwnerRecord(session, record)) {
          session.ownerTrackingCorrupt = true;
        }
      } catch (_) {
        if (!applyPartialOwnerRecord(session, line)) {
          session.ownerTrackingCorrupt = true;
        }
      }
    }
  }
  try {
    session.ownerPidReadPending =
      fs.statSync(session.ownerPidFile).size > session.ownerPidOffset;
  } catch (_) {
    markOwnerTrackingFailure(session, false);
    return;
  }
  if (
    session.rootExited &&
    !session.ownerPidReadPending &&
    session.ownerPidRemainder &&
    !applyPartialOwnerRecord(session, session.ownerPidRemainder)
  ) {
    session.ownerTrackingCorrupt = true;
  }
  if (session.ownerTrackingCorrupt) {
    markOwnerTrackingFailure(session, true);
  } else {
    session.ownerTrackingFailures = 0;
    session.ownerTrackingUnknown = false;
  }
}
// macOS does not expose another process' environment through ps eww, while
// the extra environment text makes every startup snapshot substantially
// larger. Keep the environment-bearing form only on Linux, where it can
// recover an already reparented cooperative descendant by its owner marker.
const posixPsArgs = process.platform === 'linux'
  ? ['eww', '-axo', 'pid=,ppid=,pgid=,lstart=,command=']
  : ['-axo', 'pid=,ppid=,pgid=,lstart=,command='];
const posixPsOptions = {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
  env: Object.assign({}, process.env, { LC_ALL: 'C', LANG: 'C' }),
};
function parsePosixProcessSnapshot(output) {
  const snapshot = new Map();
  for (const line of output.split('\n')) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/,
    );
    if (!match) continue;
    const startedAt = Date.parse(match[4]);
    snapshot.set(Number(match[1]), {
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
      command: match[5],
    });
  }
  return snapshot;
}
function snapshotIdentity(entry) {
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
function readPosixProcessSnapshot() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
  try {
    return parsePosixProcessSnapshot(
      cp.execFileSync('/bin/ps', posixPsArgs, posixPsOptions),
    );
  } catch (_) { return null; }
}
function readPosixProcessSnapshotAsync(callback) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    callback(null);
    return;
  }
  try {
    cp.execFile('/bin/ps', posixPsArgs, posixPsOptions, (error, stdout) => {
      if (error || typeof stdout !== 'string') {
        callback(null);
        return;
      }
      callback(parsePosixProcessSnapshot(stdout));
    });
  } catch (_) { callback(null); }
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
function pidOwnershipState(pid, identity, snapshot) {
  const liveness = pidLivenessState(pid);
  if (liveness === 'dead') return 'dead';
  if (liveness === 'unknown') return 'unknown';
  if (identity && identity.kind === 'unknown') return 'unknown';
  // Tree-snapshot entries are consumed immediately, before PID reuse is
  // realistic. Hook-file entries can outlive their parent, so validate their
  // process birth time before signalling a numeric PID.
  if (
    !identity ||
    !Number.isFinite(identity.lower) ||
    !Number.isFinite(identity.upper)
  ) return 'unknown';
  try {
    let actualStart;
    let entry = null;
    if (process.platform === 'win32') {
      const root = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
      const powershell =
        root.replace(/[\\/]+$/, '') +
        '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      const value = cp.execFileSync(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "(Get-Process -Id " + String(pid) +
            " -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')",
        ],
        { encoding: 'utf8', maxBuffer: 4096, windowsHide: true },
      ).trim();
      actualStart = Date.parse(value);
    } else if (snapshot) {
      entry = snapshot.get(pid);
      // kill(0) already proved the numeric PID still exists. A transient ps
      // omission is therefore unknown, never proof of process exit.
      if (!entry) return 'unknown';
      actualStart = entry.startedAt;
    } else {
      const value = cp.execFileSync(
        '/bin/ps',
        ['-p', String(pid), '-o', 'lstart='],
        {
          encoding: 'utf8',
          maxBuffer: 4096,
          env: Object.assign({}, process.env, { LC_ALL: 'C', LANG: 'C' }),
        },
      ).trim();
      actualStart = Date.parse(value);
    }
    if (!Number.isFinite(actualStart)) return 'unknown';
    if (
      process.platform !== 'win32' &&
      identity.kind === 'guard' &&
      (
        !identity.guardToken ||
        !entry ||
        typeof entry.command !== 'string' ||
        !entry.command.includes(identity.guardToken)
      )
    ) return 'mismatch';
    // POSIX lstart is rounded down to seconds. The hook records the interval
    // surrounding spawn(), so a paused/slow syscall remains a match without
    // widening the PID-reuse window to several seconds.
    const matchesBirth = process.platform === 'win32'
      ? (
        actualStart >= identity.lower &&
        actualStart <= identity.upper
      )
      : (
        actualStart >= Math.floor(identity.lower / 1000) * 1000 &&
        actualStart <= Math.floor(identity.upper / 1000) * 1000
      );
    if (!matchesBirth) return 'mismatch';
    if (
      process.platform !== 'win32' &&
      identity.kind === 'process'
    ) {
      // The inherited sentinel FD remains stable across reparenting and exec,
      // unlike ppid/argv, and uniquely identifies this session even when a
      // numeric PID/PGID is reused within the same lstart second.
      const sentinel = sentinelState(pid, identity);
      if (sentinel !== 'match') return sentinel;
    }
    if (
      process.platform !== 'win32' &&
      identity.kind === 'marker' &&
      (
        !entry ||
        !identity.commandHint ||
        typeof entry.command !== 'string' ||
        !entry.command.includes(identity.commandHint)
      )
    ) return 'mismatch';
    if (
      process.platform !== 'win32' &&
      identity.kind === 'snapshot' &&
      (
        !entry ||
        !Number.isInteger(identity.processGroup) ||
        !identity.commandHint ||
        entry.pgid !== identity.processGroup ||
        typeof entry.command !== 'string' ||
        !entry.command.startsWith(identity.commandHint)
      )
    ) return 'mismatch';
    return 'match';
  } catch (_) { return 'unknown'; }
}
function captureSnapshotDescendants(session, snapshot) {
  if (!snapshot || !session.child || !session.child.pid) return;
  const children = new Map();
  for (const [pid, entry] of snapshot.entries()) {
    const siblings = children.get(entry.ppid) || [];
    siblings.push(pid);
    children.set(entry.ppid, siblings);
  }
  const pending = [session.child.pid];
  const seen = new Set();
  while (pending.length > 0) {
    const parentPid = pending.pop();
    if (!parentPid || seen.has(parentPid)) continue;
    seen.add(parentPid);
    const nested = children.get(parentPid);
    if (!nested) continue;
    for (const pid of nested) {
      const entry = snapshot.get(pid);
      const existing = session.ownedPids.get(pid);
      if (entry && (!existing || existing.kind === 'snapshot')) {
        session.ownedPids.set(pid, snapshotIdentity(entry));
      }
      pending.push(pid);
    }
  }
}
function scanOwnedPids(session, providedSnapshot) {
  readOwnerPidRecords(session);
  if (
    (process.platform !== 'darwin' && process.platform !== 'linux')
  ) return;
  const snapshot = providedSnapshot || readPosixProcessSnapshot();
  if (!snapshot) return;
  const children = new Map();
  for (const [pid, entry] of snapshot.entries()) {
    const siblings = children.get(entry.ppid) || [];
    siblings.push({
      pid,
      startedAt: entry.startedAt,
      ppid: entry.ppid,
      pgid: entry.pgid,
      command: entry.command,
    });
    children.set(entry.ppid, siblings);
  }
  const roots = [];
  const ownerMarker = ownerPidFileEnvName + '=' + session.ownerPidFile;
  // sitecustomize/Node hooks cover ordinary intermediaries, but Python -S
  // and native helpers can bypass language hooks. Every cooperative child
  // still inherits this per-session environment marker, including after
  // setsid/double-fork reparenting, so recover those roots from the process
  // snapshot before signalling. A process that deliberately scrubs its
  // environment is outside this local containment contract.
  for (const [pid, entry] of snapshot.entries()) {
    if (
      pid === process.pid ||
      typeof entry.command !== 'string' ||
      !entry.command.includes(ownerMarker)
    ) continue;
    const identity = Number.isFinite(entry.startedAt)
      ? {
        lower: entry.startedAt,
        upper: entry.startedAt,
        kind: 'marker',
        commandHint: ownerMarker,
      }
      : null;
    if (!session.ownedPids.has(pid)) session.ownedPids.set(pid, identity);
  }
  for (const [ownedPid, identity] of Array.from(session.ownedPids.entries())) {
    const ownership = pidOwnershipState(ownedPid, identity, snapshot);
    if (ownership === 'match') roots.push(ownedPid);
    else if (ownership === 'dead' || ownership === 'mismatch') {
      session.ownedPids.delete(ownedPid);
    }
  }
  const pending = [];
  for (const root of roots) {
    const nested = children.get(root);
    if (nested) pending.push.apply(pending, nested);
  }
  const seen = new Set();
  while (pending.length > 0) {
    const entry = pending.pop();
    const pid = entry && entry.pid;
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    // A parse failure is represented as null. pidOwnershipState then keeps
    // shutdown unconfirmed instead of trusting a reusable numeric PID.
    const existing = session.ownedPids.get(pid);
    if (!existing || existing.kind === 'snapshot') {
      session.ownedPids.set(pid, snapshotIdentity(entry));
    }
    const nested = children.get(pid);
    if (nested) pending.push.apply(pending, nested);
  }
}
function scheduleInitialOwnershipBurst(session) {
  // A short-lived intermediary can create a new session/process group and
  // exit before the user stops the AI run. Sample the fresh ancestry a few
  // times at startup so that ordinary immediate daemonization is recorded
  // with a birth identity. This is bounded startup work, not a per-output or
  // permanent polling loop.
  const delays = [10, 40];
  session.ownershipBurstPending += delays.length;
  for (const delay of delays) {
    const timer = global.setTimeout(() => {
      if (session.completed || !sessions.has(session.id)) {
        session.ownershipBurstPending = Math.max(
          0,
          session.ownershipBurstPending - 1,
        );
        return;
      }
      const consumeSnapshot = snapshot => {
        try {
          if (
            !snapshot ||
            session.completed ||
            !sessions.has(session.id)
          ) return;
          // Preserve the ancestry as it existed when ps took the snapshot.
          // By the time this async callback runs, a short-lived intermediary
          // may already have exited and its detached child may be reparented.
          captureSnapshotDescendants(session, snapshot);
          scanOwnedPids(session, snapshot);
        } finally {
          session.ownershipBurstPending = Math.max(
            0,
            session.ownershipBurstPending - 1,
          );
        }
      };
      readPosixProcessSnapshotAsync(consumeSnapshot);
    }, delay);
    timer.unref();
  }
}
function writeOwnerHook() {
  if (ownerHookReady) return true;
  const source = [
    "'use strict';",
    "const cp = require('child_process');",
    "const fs = require('fs');",
    "const path = require('path');",
    "const customPromisify = require('util').promisify.custom;",
    "function commandHint(name, args) {",
    "  const raw = name === 'exec'",
    "    ? (process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh')",
    "    : args[0];",
    "  if (typeof raw !== 'string' || raw.length === 0) return '';",
    "  return path.basename(raw).slice(0, 256);",
    "}",
    "function detachedProcessGroup(name, args, child) {",
    "  if (process.platform === 'win32') return null;",
    "  const options = name === 'exec'",
    "    ? args[1]",
    "    : (Array.isArray(args[1]) ? args[2] : args[1]);",
    "  return options && options.detached === true ? child.pid : null;",
    "}",
    "function stdioArray(value) {",
    "  if (Array.isArray(value)) return value.slice();",
    "  if (value === 'ignore') return ['ignore', 'ignore', 'ignore'];",
    "  if (value === 'inherit') return ['inherit', 'inherit', 'inherit'];",
    "  return ['pipe', 'pipe', 'pipe'];",
    "}",
    "function prepareSentinel(name, args) {",
    "  const file = process.env." + ownerPidFileEnvName + ";",
    "  const prepared = { args: args.slice(), parentFd: null, sentinelFd: null, sentinelPath: null };",
    "  if (process.platform === 'win32' || !file) return prepared;",
    "  if (name === 'exec') {",
    "    // child_process.exec runs through /bin/sh, and POSIX sh only guarantees",
    "    // single-digit descriptors in redirections. dash (Debian/Ubuntu /bin/sh)",
    "    // reads a two-digit fd as a command name, so keep this to one digit.",
    "    const sentinelFd = 9;",
    "    const quoted = \"'\" + file.replace(/'/g, \"'\\\\''\") + \"'\";",
    "    prepared.args[0] = 'exec ' + String(sentinelFd) + '<' + quoted + '; ' + String(prepared.args[0]);",
    "    prepared.sentinelFd = sentinelFd;",
    "    prepared.sentinelPath = file;",
    "    return prepared;",
    "  }",
    "  try {",
    "    const parentFd = fs.openSync(file, 'r');",
    "    const optionIndex = Array.isArray(prepared.args[1]) ? 2 : 1;",
    "    const current = prepared.args[optionIndex];",
    "    const options = current && typeof current === 'object' && !Array.isArray(current)",
    "      ? Object.assign({}, current)",
    "      : {};",
    "    const stdio = stdioArray(options.stdio);",
    "    if (name === 'fork' && !stdio.includes('ipc')) stdio.push('ipc');",
    "    const sentinelFd = Math.max(3, stdio.length);",
    "    while (stdio.length < sentinelFd) stdio.push('ignore');",
    "    stdio.push(parentFd);",
    "    options.stdio = stdio;",
    "    if (typeof current === 'function') prepared.args.splice(optionIndex, 0, options);",
    "    else prepared.args[optionIndex] = options;",
    "    prepared.parentFd = parentFd;",
    "    prepared.sentinelFd = sentinelFd;",
    "    prepared.sentinelPath = file;",
    "  } catch (_) {}",
    "  return prepared;",
    "}",
    "function closePreparedSentinel(prepared) {",
    "  if (prepared && Number.isInteger(prepared.parentFd)) {",
    "    try { fs.closeSync(prepared.parentFd); } catch (_) {}",
    "  }",
    "}",
    "function track(child, startedBefore, startedAfter, hint, processGroup, sentinel) {",
    "  if (!child || !Number.isInteger(child.pid) || child.pid < 1 || child.__taskchuteOwnerTracked) return child;",
    "  child.__taskchuteOwnerTracked = true;",
    "  const file = process.env." + ownerPidFileEnvName + ";",
    "  if (!file) return child;",
    "  const startedAt = Number.isFinite(startedAfter) ? startedAfter : Date.now();",
    "  const startedAtLower = Number.isFinite(startedBefore) ? startedBefore : startedAt;",
    "  const append = active => { try { fs.appendFileSync(file, JSON.stringify({ pid: child.pid, startedAt, startedAtLower, active, kind: 'process', parentPid: process.pid, processGroup, commandHint: hint, sentinelFd: sentinel && sentinel.sentinelFd, sentinelPath: sentinel && sentinel.sentinelPath }) + '\\n'); } catch (_) {} };",
    "  append(true);",
    "  child.once('close', () => append(false));",
    "  return child;",
    "}",
    "for (const name of ['spawn', 'fork', 'execFile', 'exec']) {",
    "  const original = cp[name];",
    "  if (typeof original !== 'function') continue;",
    "  const wrapped = function(...args) {",
    "      const startedBefore = Date.now();",
    "      const sentinel = prepareSentinel(name, args);",
    "      let child;",
    "      try { child = Reflect.apply(original, this, sentinel.args); }",
    "      finally { closePreparedSentinel(sentinel); }",
    "      return track(child, startedBefore, Date.now(), commandHint(name, args), detachedProcessGroup(name, args, child), sentinel);",
    "  };",
    "  for (const property of Reflect.ownKeys(original)) {",
    "    if (property === 'length' || property === 'name' || property === 'prototype' || property === customPromisify) continue;",
    "    try { Object.defineProperty(wrapped, property, Object.getOwnPropertyDescriptor(original, property)); } catch (_) {}",
    "  }",
    "  const custom = original[customPromisify];",
    "  if (typeof custom === 'function') {",
    "    const descriptor = Object.getOwnPropertyDescriptor(original, customPromisify) || {};",
    "    Object.defineProperty(wrapped, customPromisify, Object.assign({}, descriptor, {",
    "      value: function(...args) {",
    "        const startedBefore = Date.now();",
    "        const sentinel = prepareSentinel(name, args);",
    "        let result;",
    "        try { result = Reflect.apply(custom, original, sentinel.args); }",
    "        finally { closePreparedSentinel(sentinel); }",
    "        if (result && result.child) track(result.child, startedBefore, Date.now(), commandHint(name, args), detachedProcessGroup(name, args, result.child), sentinel);",
    "        return result;",
    "      },",
    "    }));",
    "  }",
    "  try { Object.defineProperty(wrapped, 'name', { value: original.name, configurable: true }); } catch (_) {}",
    "  cp[name] = wrapped;",
    "}",
  ].join('\n');
  try {
    fs.writeFileSync(ownerHookPath, source, { mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(ownerHookPath, 0o600); } catch (_) {}
    ownerHookReady = true;
    return true;
  } catch (_) { return false; }
}
function writeOwnerPythonHook() {
  if (ownerPythonHookReady) return true;
  const source = [
    "import functools",
    "import importlib.machinery",
    "import json",
    "import os",
    "import runpy",
    "import subprocess",
    "import sys",
    "import time",
    "_taskchute_hook_dir = os.path.realpath(os.path.dirname(__file__))",
    "_taskchute_search_path = [p for p in sys.path if os.path.realpath(p or os.curdir) != _taskchute_hook_dir]",
    "try:",
    "    _taskchute_existing = importlib.machinery.PathFinder.find_spec('sitecustomize', _taskchute_search_path)",
    "    if _taskchute_existing and _taskchute_existing.origin and os.path.realpath(_taskchute_existing.origin) != os.path.realpath(__file__):",
    "        runpy.run_path(_taskchute_existing.origin, run_name='sitecustomize')",
    "except Exception:",
    "    pass",
    "_taskchute_original_popen_init = subprocess.Popen.__init__",
    "def _taskchute_command_hint(value):",
    "    try:",
    "        raw = value[0] if isinstance(value, (list, tuple)) and value else str(value).strip().split()[0]",
    "        return os.path.basename(str(raw))[:256]",
    "    except Exception:",
    "        return ''",
    "@functools.wraps(_taskchute_original_popen_init)",
    "def _taskchute_popen_init(self, *args, **kwargs):",
    "    started_before = int(time.time() * 1000)",
    "    path = os.environ.get('" + ownerPidFileEnvName + "')",
    "    sentinel_fd = None",
    "    if os.name != 'nt' and path:",
    "        try:",
    "            sentinel_fd = os.open(path, os.O_RDONLY)",
    "            inherited = tuple(kwargs.get('pass_fds', ()))",
    "            kwargs['pass_fds'] = inherited + (sentinel_fd,)",
    "            kwargs['close_fds'] = True",
    "        except Exception:",
    "            sentinel_fd = None",
    "    try:",
    "        _taskchute_original_popen_init(self, *args, **kwargs)",
    "    finally:",
    "        if sentinel_fd is not None:",
    "            try:",
    "                os.close(sentinel_fd)",
    "            except Exception:",
    "                pass",
    "    if not path or not isinstance(getattr(self, 'pid', None), int):",
    "        return",
    "    record = {'pid': self.pid, 'startedAt': int(time.time() * 1000), 'startedAtLower': started_before, 'active': True, 'kind': 'process', 'parentPid': os.getpid(), 'processGroup': self.pid if kwargs.get('start_new_session') else None, 'commandHint': _taskchute_command_hint(getattr(self, 'args', '')), 'sentinelFd': sentinel_fd, 'sentinelPath': path if sentinel_fd is not None else None}",
    "    try:",
    "        fd = os.open(path, os.O_WRONLY | os.O_APPEND)",
    "        try:",
    "            os.write(fd, (json.dumps(record, separators=(',', ':')) + '\\n').encode('utf-8'))",
    "        finally:",
    "            os.close(fd)",
    "    except Exception:",
    "        pass",
    "subprocess.Popen.__init__ = _taskchute_popen_init",
  ].join('\n');
  try {
    fs.mkdirSync(ownerPythonHookDir, { mode: 0o700 });
    try { fs.chmodSync(ownerPythonHookDir, 0o700); } catch (_) {}
    fs.writeFileSync(ownerPythonHookPath, source, { mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(ownerPythonHookPath, 0o600); } catch (_) {}
    ownerPythonHookReady = true;
    return true;
  } catch (_) { return false; }
}
function findEnvKey(env, name) {
  const expected = String(name).toLowerCase();
  return Object.keys(env).find(key => key.toLowerCase() === expected);
}
function mergeEnvValue(env, name, addition, separator, prepend) {
  const existingKey = findEnvKey(env, name);
  const existingValue = existingKey ? env[existingKey] : '';
  if (existingKey && existingKey !== name) delete env[existingKey];
  const values = prepend
    ? [addition, existingValue]
    : [existingValue, addition];
  env[name] = values.filter(Boolean).join(separator);
}
function runWindowsTaskkill(pid, force) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  const root = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
  const executable = root.replace(/[\\/]+$/, '') + '\\System32\\taskkill.exe';
  const args = ['/PID', String(pid), '/T'];
  if (force) args.push('/F');
  try {
    cp.execFileSync(executable, args, {
      windowsHide: true,
      stdio: 'ignore',
    });
    return true;
  } catch (_) { return false; }
}
function signalTree(session, signal, providedSnapshot) {
  const pid = session.child && session.child.pid;
  if (session.completed) return;
  const snapshot = providedSnapshot || readPosixProcessSnapshot();
  scanOwnedPids(session, snapshot);
  if (pid && !session.rootExited) {
    const rootIdentity = session.ownedPids.get(pid);
    const rootOwnership = pidOwnershipState(pid, rootIdentity, snapshot);
    if (
      rootOwnership === 'dead' ||
      rootOwnership === 'mismatch'
    ) {
      session.ownedPids.delete(pid);
    } else if (rootOwnership === 'match') {
      if (process.platform === 'win32') {
        // Do not let the ChildProcess fallback bypass birth-time validation:
        // on Windows the numeric PID may already belong to another process.
        if (
        !runWindowsTaskkill(pid, signal === 'SIGKILL')
        ) {
          try { session.child.kill(signal); } catch (_) {}
        }
      } else {
        try { process.kill(-pid, signal); }
        catch (_) { try { session.child.kill(signal); } catch (_) {} }
      }
    }
  }
  for (const [ownedPid, identity] of Array.from(session.ownedPids.entries())) {
    if (ownedPid === process.pid || ownedPid === pid) continue;
    const ownership = pidOwnershipState(ownedPid, identity, snapshot);
    if (ownership === 'dead' || ownership === 'mismatch') {
      session.ownedPids.delete(ownedPid);
      continue;
    }
    if (ownership === 'unknown') continue;
    if (process.platform === 'win32') {
      if (!runWindowsTaskkill(ownedPid, signal === 'SIGKILL')) {
        try { process.kill(ownedPid, signal); } catch (_) {}
      }
    } else {
      const entry = snapshot && snapshot.get(ownedPid);
      if (entry && entry.pgid === ownedPid) {
        try { process.kill(-ownedPid, signal); continue; } catch (_) {}
      }
      try { process.kill(ownedPid, signal); } catch (_) {}
    }
  }
}
function requestGuardStop(session, force) {
  if (!session || session.completed) return;
  let delivered = false;
  const control = session.guardControl;
  if (control && !control.destroyed) {
    try {
      control.write(force ? 'FORCE_STOP\n' : 'GRACEFUL_STOP\n');
      delivered = true;
    } catch (_) {}
  }
  if (!delivered) {
    signalTree(session, force ? 'SIGKILL' : 'SIGTERM');
    return;
  }
  if (force) {
    if (session.killTimer) global.clearTimeout(session.killTimer);
    session.killTimer = null;
    if (session.forceKillTimer) return;
    session.forceKillTimer = global.setTimeout(() => {
      session.forceKillTimer = null;
      signalTree(session, 'SIGKILL');
    }, 250);
    session.forceKillTimer.unref();
  }
}
function ownedProcessesStatus(session) {
  const snapshot = readPosixProcessSnapshot();
  scanOwnedPids(session, snapshot);
  if (
    session.ownershipBurstPending > 0 ||
    session.ownerTrackingUnknown ||
    session.ownerPidReadPending
  ) {
    return { gone: false, snapshot };
  }
  const rootPid = session.child && session.child.pid;
  for (const [pid, identity] of Array.from(session.ownedPids.entries())) {
    if (pid === rootPid && session.rootExited) continue;
    const ownership = pidOwnershipState(pid, identity, snapshot);
    if (ownership === 'match' || ownership === 'unknown') {
      return { gone: false, snapshot };
    }
    session.ownedPids.delete(pid);
  }
  return { gone: true, snapshot };
}
function outcomeFor(session, code, signal) {
  const resolvedCode = session.sentinelCode == null ? code : session.sentinelCode;
  if (session.stopRequested) {
    return { status: 'stopped', exitCode: resolvedCode == null ? null : resolvedCode, signal: signal || null };
  }
  if (resolvedCode === 0) {
    return { status: 'succeeded', exitCode: 0, signal: signal || null };
  }
  return {
    status: 'failed',
    exitCode: resolvedCode == null ? null : resolvedCode,
    signal: signal || null,
    errorMessage: resolvedCode == null
      ? 'Process terminated by signal ' + (signal || 'unknown')
      : 'Process exited with code ' + resolvedCode,
  };
}
function consumeStderr(session, text, flush) {
  session.stderrPending += text;
  let newline = session.stderrPending.indexOf('\n');
  while (newline >= 0) {
    const line = session.stderrPending.slice(0, newline + 1);
    session.stderrPending = session.stderrPending.slice(newline + 1);
    const match = line.match(new RegExp(marker + '(\\d+)'));
    if (match) session.sentinelCode = Number(match[1]);
    let visible = line.replace(new RegExp(marker + '\\d+\\r?\\n?'), '');
    if (session.stderrDroppedChars > 0) {
      visible = '…[+' + session.stderrDroppedChars + ' stderr chars truncated]\n' + visible;
      session.stderrDroppedChars = 0;
    }
    if (visible) {
      appendReplay(session, visible);
      broadcast(session, { type: 'data', sessionId: session.id, data: visible });
    }
    newline = session.stderrPending.indexOf('\n');
  }
  if (flush && session.stderrPending) {
    const tail = session.stderrPending;
    session.stderrPending = '';
    const match = tail.match(new RegExp(marker + '(\\d+)'));
    if (match) session.sentinelCode = Number(match[1]);
    let visible = tail.replace(new RegExp(marker + '\\d+'), '');
    if (session.stderrDroppedChars > 0) {
      visible = '…[+' + session.stderrDroppedChars + ' stderr chars truncated]\n' + visible;
      session.stderrDroppedChars = 0;
    }
    if (visible) {
      appendReplay(session, visible);
      broadcast(session, { type: 'data', sessionId: session.id, data: visible });
    }
  }
  if (!flush && session.stderrPending.length > stderrPendingLimit) {
    const dropped = session.stderrPending.length - stderrPendingLimit;
    session.stderrDroppedChars += dropped;
    // JSON materialization avoids retaining the oversized concatenation as
    // the parent of a short V8 SlicedString.
    session.stderrPending = JSON.parse(JSON.stringify(session.stderrPending.slice(-stderrPendingLimit)));
  }
}
function finalizeSession(session) {
  if (session.completed) return;
  if (session.ownershipTrackingFailed) {
    session.outcome = {
      status: 'failed',
      exitCode: null,
      signal: null,
      errorMessage:
        'Terminal process ownership tracking became unavailable during cleanup',
    };
  }
  session.completed = true;
  session.finishing = false;
  if (session.killTimer) global.clearTimeout(session.killTimer);
  if (session.forceKillTimer) global.clearTimeout(session.forceKillTimer);
  try { fs.unlinkSync(session.ownerPidFile); } catch (_) {}
  broadcast(session, { type: 'exit', sessionId: session.id, outcome: session.outcome });
  for (const [socket, interrupted] of Array.from(session.terminationClients.entries())) {
    send(socket, {
      type: 'terminated-unavailable',
      sessionId: session.id,
      interrupted,
      transcriptPath: session.transcriptPath,
      outcome: session.outcome,
    });
  }
  session.terminationClients.clear();
  global.setTimeout(() => sessions.delete(session.id), exitRetentionMs).unref();
  if (
    shutdownPendingAfterSessions &&
    !Array.from(sessions.values()).some(candidate => !candidate.completed)
  ) {
    shutdownPendingAfterSessions = false;
    shutdown(true);
    return;
  }
  scheduleIdle();
}
function finish(session, code, signal, streamsClosed) {
  if (session.completed) return;
  if (streamsClosed) {
    session.childClosed = true;
    consumeStderr(session, '', true);
    // The wrapper sentinel can arrive after ChildProcess.exit but before
    // stdio close. Recompute after the final stderr drain so non-zero CLI
    // outcomes cannot be frozen as a successful root exit.
    session.outcome = outcomeFor(session, code, signal);
  }
  if (session.finishing) return;
  session.finishing = true;
  session.rootExited = true;
  session.outcome = outcomeFor(session, code, signal);
  // A CLI can spawn a setsid/detached tool outside the wrapper's process
  // group. Node-based agents inherit a tiny spawn hook that records PID birth
  // identity synchronously; the ordinary ancestry snapshot covers other
  // tools that remain attached. Do not emit exit/termination ACK until every
  // tracked identity disappears.
  scanOwnedPids(session);
  signalTree(session, 'SIGKILL');
  session.ownershipRetryDelay = 20;
  const awaitOwnedExit = () => {
    const status = ownedProcessesStatus(session);
    if (status.gone && session.childClosed) {
      finalizeSession(session);
      return;
    }
    signalTree(session, 'SIGKILL', status.snapshot);
    session.ownershipRetryDelay = Math.min(
      ownershipRetryMaxMs,
      Math.max(ownershipRetryMs, session.ownershipRetryDelay * 2),
    );
    const timer = global.setTimeout(
      awaitOwnedExit,
      session.ownershipRetryDelay,
    );
    timer.unref();
  };
  awaitOwnedExit();
}
function executableName(value) {
  return String(value || '').split(/[\\/]/).pop().toLowerCase();
}
function isPythonExecutable(value) {
  return /^python(?:\d+(?:\.\d+)*)?$/.test(executableName(value));
}
function pythonArgsDisableOwnershipHook(args) {
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index]);
    if (token === '--') return false;
    if (!token.startsWith('-') || token === '-') return false;
    if (token === '-c' || token === '-m') return false;
    if (/^-[^-]*[EIS]/.test(token)) return true;
    // These interpreter options consume the next token. None disables the
    // hook itself, and the consumed value must not be mistaken for a flag.
    if (token === '-W' || token === '-X') index += 1;
  }
  return false;
}
function protectedOwnershipEnvName(value) {
  const name = String(value || '').split('=', 1)[0].toUpperCase();
  return (
    name === 'NODE_OPTIONS' ||
    name === 'PYTHONPATH' ||
    name === ownerPidFileEnvName
  );
}
function envLaunchDisablesPythonOwnershipHook(args) {
  let commandIndex = 0;
  while (commandIndex < args.length) {
    const token = String(args[commandIndex]);
    if (token === '--') {
      commandIndex += 1;
      break;
    }
    if (token === '-i' || token === '--ignore-environment') return true;
    if (token === '-u' || token === '--unset') {
      const name = args[commandIndex + 1];
      if (protectedOwnershipEnvName(name)) return true;
      commandIndex += 2;
      continue;
    }
    if (token.startsWith('--unset=')) {
      if (protectedOwnershipEnvName(token.slice('--unset='.length))) {
        return true;
      }
      commandIndex += 1;
      continue;
    }
    if (/^-u.+/.test(token)) {
      if (protectedOwnershipEnvName(token.slice(2))) return true;
      commandIndex += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      if (protectedOwnershipEnvName(token)) return true;
      commandIndex += 1;
      continue;
    }
    if (token.startsWith('-')) {
      commandIndex += 1;
      continue;
    }
    break;
  }
  return (
    isPythonExecutable(args[commandIndex]) &&
    pythonArgsDisableOwnershipHook(args.slice(commandIndex + 1))
  );
}
function splitShellCommandSegments(source) {
  const segments = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = '';
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    const next = source[index + 1];
    if (
      character === ';' ||
      character === '\n' ||
      character === '|' ||
      character === '&'
    ) {
      if (current.trim()) segments.push(current);
      current = '';
      if (
        (character === '|' || character === '&') &&
        next === character
      ) index += 1;
      continue;
    }
    current += character;
  }
  if (current.trim()) segments.push(current);
  return segments;
}
function tokenizeShellWords(source) {
  const words = [];
  let current = '';
  let quote = '';
  let escaped = false;
  const flush = () => {
    if (!current) return;
    words.push(current);
    current = '';
  };
  for (const character of source) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      continue;
    }
    current += character;
  }
  flush();
  return words;
}
function shellSegmentDisablesPythonOwnershipHook(segment) {
  const words = tokenizeShellWords(segment);
  while (
    words[0] === 'exec' ||
    words[0] === 'command' ||
    words[0] === 'then' ||
    words[0] === 'do' ||
    words[0] === 'else'
  ) words.shift();
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] || '')) {
    if (protectedOwnershipEnvName(words[0])) return true;
    words.shift();
  }
  if (
    (words[0] === 'unset' || words[0] === 'export') &&
    words.slice(1).some(protectedOwnershipEnvName)
  ) return true;
  if (executableName(words[0]) === 'env') {
    return envLaunchDisablesPythonOwnershipHook(words.slice(1));
  }
  return (
    isPythonExecutable(words[0]) &&
    pythonArgsDisableOwnershipHook(words.slice(1))
  );
}
function executableLaunchDisablesPythonOwnershipHook(binary, args) {
  const name = executableName(binary);
  if (
    isPythonExecutable(name) &&
    pythonArgsDisableOwnershipHook(args)
  ) return true;
  return (
    name === 'env' &&
    envLaunchDisablesPythonOwnershipHook(args)
  );
}
function terminalArgvBootstrapDisablesPythonHook(binary, binaryArgs) {
  const name = executableName(binary);
  const commandIndex = binaryArgs.indexOf('-c');
  if (commandIndex < 0) return false;
  const program = binaryArgs[commandIndex + 1];
  let positionals;
  if (name === 'fish') {
    if (
      program !== fishTerminalArgvBootstrapProgram ||
      binaryArgs[commandIndex + 2] !== terminalArgvBootstrapProgram
    ) return false;
    positionals = binaryArgs.slice(commandIndex + 3);
  } else {
    if (
      !/^(?:a|ba|da|k|mk|z)?sh$/.test(name) ||
      program !== terminalArgvBootstrapProgram ||
      binaryArgs[commandIndex + 2] !== terminalArgvBootstrapArgZero
    ) return false;
    positionals = binaryArgs.slice(commandIndex + 3);
  }
  // shell, resolved, command, fallback, prefixCount
  if (positionals.length < 5) return true;
  const resolved = positionals[1];
  const command = positionals[2];
  const fallback = positionals[3];
  const prefixCountText = positionals[4];
  const payload = positionals.slice(5);
  if (
    typeof resolved !== 'string' ||
    typeof command !== 'string' ||
    typeof fallback !== 'string' ||
    typeof prefixCountText !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/.test(prefixCountText)
  ) return true;
  const prefixCount = Number(prefixCountText);
  if (
    !Number.isSafeInteger(prefixCount) ||
    prefixCount < 0 ||
    prefixCount > payload.length
  ) return true;
  const commandArgs = payload.slice(prefixCount);
  return (
    executableLaunchDisablesPythonOwnershipHook(resolved, payload) ||
    executableLaunchDisablesPythonOwnershipHook(command, commandArgs) ||
    executableLaunchDisablesPythonOwnershipHook(fallback, commandArgs)
  );
}
function taskChutePtyPositionalLaunchDisablesPythonHook(
  request,
  commandIndex,
  shellProgram,
) {
  // The injection-safe PTY wrappers carry the transcript as outer shell $0
  // and append the real binary/argv as unused validation positionals.
  // Looking only at the fixed '-c' program therefore misses a direct Python
  // -S launch even though the production request is statically identifiable.
  if (
    !shellProgram.includes('TASKCHUTE_AI_TTY_PATH="$0.tty"') ||
    !shellProgram.includes('/usr/bin/script')
  ) return false;
  const binaryIndex = commandIndex + 3;
  const binary = request.args[binaryIndex];
  if (typeof binary !== 'string') return false;
  const binaryArgs = request.args.slice(binaryIndex + 1);
  return (
    executableLaunchDisablesPythonOwnershipHook(binary, binaryArgs) ||
    terminalArgvBootstrapDisablesPythonHook(binary, binaryArgs)
  );
}
function launchDisablesPythonOwnershipHook(request, initialInput) {
  const commandName = executableName(request.command);
  if (
    isPythonExecutable(commandName) &&
    pythonArgsDisableOwnershipHook(request.args)
  ) return true;
  if (
    commandName === 'env' &&
    envLaunchDisablesPythonOwnershipHook(request.args)
  ) return true;
  if (!/^(?:ba|z|k)?sh$/.test(commandName)) return false;
  const commandIndex = request.args.indexOf('-c');
  if (commandIndex < 0 || typeof request.args[commandIndex + 1] !== 'string') {
    return typeof initialInput === 'string' &&
      splitShellCommandSegments(initialInput).some(
        shellSegmentDisablesPythonOwnershipHook,
      );
  }
  const shellProgram = request.args[commandIndex + 1];
  return (
    splitShellCommandSegments(shellProgram).some(
      shellSegmentDisablesPythonOwnershipHook,
    ) ||
    taskChutePtyPositionalLaunchDisablesPythonHook(
      request,
      commandIndex,
      shellProgram,
    ) ||
    (
      typeof initialInput === 'string' &&
      splitShellCommandSegments(initialInput).some(
        shellSegmentDisablesPythonOwnershipHook,
      )
    )
  );
}
function spawnSession(message, socket) {
  if (
    !message.spawn ||
    typeof message.spawn.command !== 'string' ||
    !Array.isArray(message.spawn.args) ||
    typeof message.transcriptPath !== 'string' ||
    message.transcriptPath.length === 0 ||
    message.transcriptPath.length > 8192
  ) {
    send(socket, { type: 'error', sessionId: message.sessionId, message: 'Invalid spawn request' });
    return;
  }
  if (sessions.has(message.sessionId)) {
    attachSession(message.sessionId, socket);
    return;
  }
  if (!ownerWatchdogReady) {
    send(socket, {
      type: 'error',
      sessionId: message.sessionId,
      message: 'Terminal process owner watchdog is unavailable',
    });
    return;
  }
  const request = message.spawn;
  if (launchDisablesPythonOwnershipHook(request, message.initialInput)) {
    send(socket, {
      type: 'error',
      sessionId: message.sessionId,
      message:
        'Ownership-disabling environment options or Python interpreter flags -E, -I, and -S are not supported because they disable safe descendant-process tracking',
    });
    return;
  }
  const ownerToken = crypto.randomBytes(24).toString('hex');
  const guardToken = crypto.randomBytes(24).toString('hex');
  const ownerPidFile = ownerSessionPrefix + ownerToken + '.jsonl';
  const spawnEnv = Object.assign({}, request.env || process.env);
  // fd 3 is a broker-lifetime pipe. The PTY wrapper blocks a tiny watchdog
  // on it; a broker crash/SIGKILL closes the parent end in the kernel and the
  // watchdog tears down its own process group without trusting a reusable PID.
  if (process.platform !== 'win32') {
    spawnEnv.TASKCHUTE_BROKER_WATCH_FD = '3';
  }
  let ownerPidFileReady = false;
  if (ownerSetupFailureForTest !== 'file') {
    try {
      fs.writeFileSync(ownerPidFile, '', { mode: 0o600, flag: 'wx' });
      try { fs.chmodSync(ownerPidFile, 0o600); } catch (_) {}
      ownerPidFileReady = true;
    } catch (_) {}
  }
  if (!ownerPidFileReady) {
    send(socket, {
      type: 'error',
      sessionId: message.sessionId,
      message: 'Terminal process ownership tracking could not be initialized',
    });
    return;
  }
  const nodeOwnerHookReady =
    ownerSetupFailureForTest !== 'hooks' && writeOwnerHook();
  const pythonOwnerHookReady =
    ownerSetupFailureForTest !== 'hooks' && writeOwnerPythonHook();
  if (!nodeOwnerHookReady || !pythonOwnerHookReady) {
    try { fs.unlinkSync(ownerPidFile); } catch (_) {}
    send(socket, {
      type: 'error',
      sessionId: message.sessionId,
      message: 'Terminal process ownership hooks could not be initialized',
    });
    return;
  }
  spawnEnv[ownerPidFileEnvName] = ownerPidFile;
  const hookOption = '--require=' + JSON.stringify(ownerHookPath);
  mergeEnvValue(spawnEnv, 'NODE_OPTIONS', hookOption, ' ', false);
  mergeEnvValue(
    spawnEnv,
    'PYTHONPATH',
    ownerPythonHookDir,
    process.platform === 'win32' ? ';' : ':',
    true,
  );
  const guardControlFd = process.platform === 'win32' ? 3 : 4;
  spawnEnv.TASKCHUTE_SESSION_GUARD_REQUEST = Buffer.from(
    JSON.stringify({
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      guardToken,
      controlFd: guardControlFd,
    }),
    'utf8',
  ).toString('base64');
  let child;
  const rootStartedAtLower = Date.now();
  try {
    child = cp.spawn(
      process.execPath,
      ['-e', sessionGuardProgram, guardToken],
      {
        cwd: request.cwd,
        env: spawnEnv,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: process.platform === 'win32'
          ? ['pipe', 'pipe', 'pipe', 'pipe']
          : ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    try { fs.unlinkSync(ownerPidFile); } catch (_) {}
    send(socket, { type: 'error', sessionId: message.sessionId, message: String(error && error.message || error) });
    return;
  }
  // POSIX ENOENT and similar launch failures are emitted asynchronously
  // rather than thrown from cp.spawn(). Install an error listener before
  // inspecting pid so a failed pending spawn cannot crash the broker.
  child.once('error', () => {});
  const guardControl =
    child.stdio && child.stdio[guardControlFd]
      ? child.stdio[guardControlFd]
      : null;
  if (guardControl) guardControl.on('error', () => {});
  const rootRecordDelayMs = Number(
    process.env.TASKCHUTE_BROKER_TEST_ROOT_RECORD_DELAY_MS,
  );
  if (Number.isFinite(rootRecordDelayMs) && rootRecordDelayMs > 0) {
    // Deterministic crash-window test hook. The session guard remains
    // responsive while the broker is deliberately blocked here.
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      Math.min(5000, rootRecordDelayMs),
    );
  }
  const rootStartedAt = Date.now();
  let rootIdentityReady = false;
  if (child && Number.isInteger(child.pid) && child.pid > 0) {
    try {
      fs.appendFileSync(
        ownerPidFile,
        JSON.stringify({
          pid: child.pid,
          startedAt: rootStartedAt,
          startedAtLower: rootStartedAtLower,
          active: true,
          kind: 'guard',
          guardToken,
        }) + '\n',
      );
      rootIdentityReady = true;
    } catch (_) {}
  }
  if (!rootIdentityReady) {
    if (child && child.pid) {
      if (process.platform === 'win32') {
        runWindowsTaskkill(child.pid, true);
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (_) { try { child.kill('SIGKILL'); } catch (_) {} }
      }
    }
    if (!child || !child.pid) {
      try { fs.unlinkSync(ownerPidFile); } catch (_) {}
    } else {
      child.once('close', () => {
        try { fs.unlinkSync(ownerPidFile); } catch (_) {}
      });
    }
    send(socket, {
      type: 'error',
      sessionId: message.sessionId,
      message: 'Terminal root ownership identity could not be recorded',
    });
    return;
  }
  const session = {
    id: message.sessionId,
    child,
    clients: new Set([socket]),
    replayChunks: [],
    replayLength: 0,
    stderrPending: '',
    stderrDroppedChars: 0,
    sentinelCode: null,
    stopRequested: false,
    completed: false,
    finishing: false,
    childClosed: false,
    outcome: null,
    killTimer: null,
    forceKillTimer: null,
    guardControl,
    transcriptPath: message.transcriptPath,
    pressured: new Set(),
    pressureTimers: new Map(),
    stdoutPaused: false,
    terminationClients: new Map(),
    pendingResize: null,
    resizeInFlight: false,
    appliedResize: null,
    ttyPath: null,
    ownerPidFile,
    ownerPidOffset: 0,
    ownerPidRemainder: '',
    ownerPidDroppingLine: false,
    ownerPidReadPending: false,
    ownerTrackingUnknown: false,
    ownerTrackingFailures: 0,
    ownerTrackingCorrupt: false,
    ownerTrackingAbandoned: false,
    ownershipTrackingFailed: false,
    ownedPids: new Map([[
      child.pid,
      {
        lower: rootStartedAtLower,
        upper: rootStartedAt,
        kind: 'guard',
        guardToken,
      },
    ]]),
    ownershipBurstPending: 0,
    rootExited: false,
    ownershipRetryDelay: 20,
  };
  sessions.set(session.id, session);
  scheduleInitialOwnershipBurst(session);
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => {
    appendReplay(session, data);
    broadcast(session, { type: 'data', sessionId: session.id, data });
  });
  child.stderr.on('data', data => consumeStderr(session, data, false));
  child.on('error', error => {
    const text = String(error && error.message || error) + '\n';
    appendReplay(session, text);
    broadcast(session, { type: 'data', sessionId: session.id, data: text });
  });
  child.on('exit', (code, signal) => {
    // The per-session guard owns target-tree cleanup. Numeric group signalling
    // here would race guard-PID reuse after the OS reports exit.
    finish(session, code, signal, false);
  });
  child.on('close', (code, signal) => finish(session, code, signal, true));
  send(socket, {
    type: 'attached',
    sessionId: session.id,
    status: 'running',
    replay: '',
    pid: child.pid,
    transcriptPath: session.transcriptPath,
  });
  if (typeof message.initialInput === 'string' && message.initialInput.length > 0) {
    try { child.stdin.write(message.initialInput); } catch (_) {}
  }
}
function attachSession(id, socket) {
  const session = sessions.get(id);
  if (!session) {
    send(socket, { type: 'missing', sessionId: id });
    return;
  }
  session.clients.add(socket);
  const payload = {
    type: 'attached',
    sessionId: id,
    status: session.completed ? 'completed' : 'running',
    replay: materializeReplay(session),
    pid: session.child && session.child.pid,
    transcriptPath: session.transcriptPath,
    outcome: session.outcome || undefined,
  };
  // JSON escaping can expand control-char-heavy replay up to 6x, so the raw
  // replay cap alone cannot keep the serialized frame under the client's
  // frame limit. Trim from the head: the newest tail redraws the TUI.
  let frame = JSON.stringify(payload);
  let optimistic = true;
  while (frame.length > attachedFrameBudget && payload.replay.length > 0) {
    const excess = frame.length - attachedFrameBudget;
    // First pass assumes worst-case 6-byte escapes; the fallback drops one
    // raw char per excess byte, which always fits on the next pass.
    const drop = optimistic ? Math.ceil(excess / 6) : excess;
    optimistic = false;
    payload.replay = payload.replay.slice(Math.min(drop, payload.replay.length));
    frame = JSON.stringify(payload);
  }
  if (!sendRaw(socket, frame)) markPressured(session, socket);
}
function pumpResize(session) {
  if (session.resizeInFlight || !session.pendingResize || session.completed) return;
  const next = session.pendingResize;
  session.pendingResize = null;
  if (
    session.appliedResize &&
    session.appliedResize.cols === next.cols &&
    session.appliedResize.rows === next.rows
  ) return;
  if (!session.ttyPath) {
    try {
      const tty = fs.readFileSync(session.transcriptPath + '.tty', 'utf8').trim();
      if (!/^\/dev\/(?:ttys?\d+|pts\/\d+)$/.test(tty)) return;
      session.ttyPath = tty;
    } catch (_) { return; }
  }
  const flag = process.platform === 'darwin' ? '-f' : '-F';
  session.resizeInFlight = true;
  cp.execFile(sttyPath, [flag, session.ttyPath, 'rows', String(next.rows), 'cols', String(next.cols)], error => {
    session.resizeInFlight = false;
    if (!error) session.appliedResize = next;
    // Sizes queued while stty ran collapse into one trailing application.
    pumpResize(session);
  });
}
function resizeSession(message) {
  const session = sessions.get(message.sessionId);
  if (!session || session.completed) return;
  const cols = Math.max(1, Math.min(999, Math.floor(Number(message.cols))));
  const rows = Math.max(1, Math.min(999, Math.floor(Number(message.rows))));
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
  session.pendingResize = { cols: cols, rows: rows };
  pumpResize(session);
}
function terminateUnavailableSession(id, socket) {
  const session = sessions.get(id);
  if (!session) {
    send(socket, { type: 'missing', sessionId: id });
    return;
  }
  if (session.completed) {
    send(socket, {
      type: 'terminated-unavailable',
      sessionId: id,
      interrupted: false,
      transcriptPath: session.transcriptPath,
      outcome: session.outcome || undefined,
    });
    return;
  }
  // If a user stop was already in progress, preserve its normal stopped
  // outcome. Otherwise this transport failure owns the forced termination
  // and the renderer must surface it as interrupted.
  const interrupted = !session.stopRequested;
  session.terminationClients.set(socket, interrupted);
  session.stopRequested = true;
  requestGuardStop(session, true);
}
function handle(socket, message) {
  if (!message || message.token !== token || typeof message.op !== 'string') {
    socket.destroy();
    return;
  }
  if (message.op === 'shutdown') {
    if (!rendererLeaseIsCurrent(message)) {
      socket.destroy();
      return;
    }
    // Shutdown is idempotent across renderer generations. Every authenticated
    // client receives the same completion ACK after all live children close;
    // a second request must not sit until its local timeout.
    if (shuttingDown) {
      // The first waiter may already have triggered the ACK fan-out and
      // server.close(). Existing authenticated sockets can still deliver a
      // shutdown request in that window, so acknowledge it immediately.
      if (shutdownAckReady) send(socket, { type: 'shutdown-ack' });
      else socket.destroy();
      return;
    }
    shutdownWaiters.add(socket);
    if (shutdownRequested) return;
    shutdownRequested = true;
    for (const active of sessions.values()) {
      if (!active.completed) {
        active.stopRequested = true;
        requestGuardStop(active, true);
      }
    }
    const deadline = Date.now() + 1500;
    const awaitSessionExit = () => {
      const hasLiveSession = Array.from(sessions.values()).some(session => !session.completed);
      if (hasLiveSession && Date.now() < deadline) {
        const timer = global.setTimeout(awaitSessionExit, 20);
        timer.unref();
        return;
      }
      // ACK is a child-close confirmation, not merely an indication that a
      // kill signal was attempted. If a child failed to close by the hard
      // deadline, close the current waiters without ACK but keep the broker
      // and ownership records alive for a later authenticated retry.
      if (hasLiveSession) {
        for (const waiter of Array.from(shutdownWaiters)) waiter.destroy();
        shutdownWaiters.clear();
        shutdownPendingAfterSessions = true;
        shutdownRequested = false;
        return;
      }
      shutdown(true);
    };
    awaitSessionExit();
    return;
  }
  if (message.op === 'activate-renderer-lease') {
    if (!claimRendererLease(message)) {
      socket.destroy();
      return;
    }
    cancelDeferredShutdown();
    send(socket, { type: 'renderer-lease-activated' });
    return;
  }
  if (message.op === 'schedule-shutdown') {
    const graceMs = Number(message.graceMs);
    if (
      !Number.isFinite(graceMs) ||
      !Number.isInteger(graceMs) ||
      graceMs < 100 ||
      graceMs > 120000
    ) {
      send(socket, { type: 'error', message: 'Invalid shutdown grace' });
      return;
    }
    if (!rendererLeaseIsCurrent(message)) {
      // ACK stale requests so an old renderer can finish tearing down, but
      // never let its delayed control socket re-arm the current renderer's
      // deadline.
      send(socket, { type: 'shutdown-scheduled' });
      return;
    }
    cancelDeferredShutdown();
    deferredShutdownTimer = global.setTimeout(() => {
      deferredShutdownTimer = null;
      // Only an authenticated command received AFTER this deadline was armed
      // cancels it (see the connection handler below). The old renderer's
      // socket can remain open until the timer boundary during true app exit;
      // treating mere socket presence as a renewal would skip cleanup and
      // fall back to the much longer clientless TTL.
      for (const active of sessions.values()) {
        if (!active.completed) {
          active.stopRequested = true;
          requestGuardStop(active, true);
        }
      }
      shutdown(false);
    }, graceMs);
    deferredShutdownTimer.unref();
    send(socket, { type: 'shutdown-scheduled' });
    return;
  }
  if (message.op === 'cancel-deferred-shutdown') {
    if (rendererLeaseIsCurrent(message)) cancelDeferredShutdown();
    send(socket, { type: 'shutdown-canceled' });
    return;
  }
  if (shutdownRequested) {
    socket.destroy();
    return;
  }
  if (!rendererLeaseIsCurrent(message)) {
    // An old renderer socket may remain authenticated after a replacement.
    // Authentication proves only the vault broker secret; the monotonic
    // renderer lease is what prevents its delayed input/stop/resize from
    // controlling the newly adopted session.
    socket.destroy();
    return;
  }
  const id = typeof message.sessionId === 'string' ? message.sessionId : '';
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(id)) {
    send(socket, { type: 'error', message: 'Invalid session id' });
    return;
  }
  const session = sessions.get(id);
  switch (message.op) {
    case 'spawn': spawnSession(message, socket); break;
    case 'attach': attachSession(id, socket); break;
    case 'input':
      if (session && !session.completed && typeof message.data === 'string' && message.data.length <= frameLimit) {
        try { session.child.stdin.write(message.data); } catch (_) {}
      }
      break;
    case 'resize': resizeSession(message); break;
    case 'terminate-unavailable': terminateUnavailableSession(id, socket); break;
    case 'stop':
      if (session && !session.completed) {
        session.stopRequested = true;
        requestGuardStop(session, message.force === true);
        if (!message.force && !session.killTimer) {
          session.killTimer = global.setTimeout(() => {
            session.killTimer = null;
            requestGuardStop(session, true);
          }, stopGraceMs);
          session.killTimer.unref();
        }
      }
      break;
  }
}
function scheduleIdle() {
  if (idleTimer) global.clearTimeout(idleTimer);
  if (clients.size > 0) return;
  idleTimer = global.setTimeout(() => {
    for (const session of sessions.values()) {
      if (!session.completed) {
        session.stopRequested = true;
        requestGuardStop(session, true);
      }
    }
    shutdown(false);
  }, Math.max(5000, idleTtlMs));
  idleTimer.unref();
}
function removeOwnDescriptor() {
  try {
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    if (descriptor && descriptor.token === token && descriptor.pid === process.pid) {
      fs.unlinkSync(descriptorPath);
    }
  } catch (_) {}
}
function shutdown(acknowledge) {
  if (shuttingDown) return;
  cancelDeferredShutdown();
  shutdownRetryAcknowledge = shutdownRetryAcknowledge || acknowledge === true;
  const unconfirmed = Array.from(sessions.values()).filter(session => !session.completed);
  if (unconfirmed.length > 0) {
    for (const session of unconfirmed) {
      session.stopRequested = true;
      requestGuardStop(session, true);
    }
    if (!shutdownRetryTimer) {
      shutdownRetryTimer = global.setTimeout(() => {
        shutdownRetryTimer = null;
        shutdown(shutdownRetryAcknowledge);
      }, ownershipRetryMs);
      shutdownRetryTimer.unref();
    }
    return;
  }
  shuttingDown = true;
  acknowledge = shutdownRetryAcknowledge;
  if (shutdownRetryTimer) {
    global.clearTimeout(shutdownRetryTimer);
    shutdownRetryTimer = null;
  }
  const acknowledgeAfterDisarm = acknowledge === true;
  disarmOwnerWatchdog(disarmConfirmed => {
    shutdownAckReady = acknowledgeAfterDisarm && disarmConfirmed;
    for (const session of sessions.values()) {
      if (!session.completed) {
        session.stopRequested = true;
        signalTree(session, 'SIGKILL');
      }
    }
    removeOwnDescriptor();
    for (const socket of Array.from(shutdownWaiters)) {
      if (shutdownAckReady) send(socket, { type: 'shutdown-ack' });
      else socket.destroy();
    }
    shutdownWaiters.clear();
    try { fs.unlinkSync(ownerHookPath); } catch (_) {}
    try { fs.rmSync(ownerPythonHookDir, { recursive: true, force: true }); } catch (_) {}
    try {
      server.close(() => process.exit(0));
    } catch (_) {
      process.exit(0);
    }
    global.setTimeout(() => process.exit(0), 1000).unref();
  });
}
const server = net.createServer(socket => {
  socket.setEncoding('utf8');
  let buffer = '';
  let authenticated = false;
  const authTimer = global.setTimeout(() => {
    if (!authenticated) socket.destroy();
  }, 1000);
  authTimer.unref();
  socket.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > frameLimit) { socket.destroy(); return; }
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          const message = JSON.parse(line);
          if (!message || message.token !== token) { socket.destroy(); return; }
          if (
            message.rendererLeaseToken !== undefined &&
            rendererLeaseOf(message) === null
          ) {
            socket.destroy();
            return;
          }
          if (!authenticated) {
            authenticated = true;
            global.clearTimeout(authTimer);
            clients.add(socket);
            if (idleTimer) { global.clearTimeout(idleTimer); idleTimer = null; }
          }
          if (
            (message.op === 'spawn' || message.op === 'attach') &&
            !claimRendererLease(message)
          ) {
            socket.destroy();
            return;
          }
          if (message.op === 'spawn' || message.op === 'attach') {
            cancelDeferredShutdown();
          }
          handle(socket, message);
        } catch (_) { socket.destroy(); return; }
      }
      newline = buffer.indexOf('\n');
    }
  });
  socket.on('close', () => {
    global.clearTimeout(authTimer);
    if (authenticated) clients.delete(socket);
    shutdownWaiters.delete(socket);
    for (const session of sessions.values()) {
      session.clients.delete(socket);
      session.terminationClients.delete(socket);
      releasePressure(session, socket);
    }
    scheduleIdle();
  });
  socket.on('error', () => {});
});
startOwnerWatchdog(() => {
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const descriptor = JSON.stringify({ version: 1, port: address.port, token, pid: process.pid });
    try {
      fs.writeFileSync(descriptorPath, descriptor, { mode: 0o600, flag: 'wx' });
      try { fs.chmodSync(descriptorPath, 0o600); } catch (_) {}
      scheduleIdle();
    } catch (_) { process.exit(65); }
  });
});
server.on('error', () => shutdown(false));
process.on('SIGTERM', () => shutdown(false));
process.on('SIGINT', () => shutdown(false));
`
