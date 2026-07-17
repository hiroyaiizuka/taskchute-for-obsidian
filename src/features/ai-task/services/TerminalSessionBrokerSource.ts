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
const descriptorPath = process.env.TASKCHUTE_BROKER_DESCRIPTOR;
const token = process.env.TASKCHUTE_BROKER_TOKEN;
const idleTtlMs = Number(process.env.TASKCHUTE_BROKER_TTL_MS || 60000);
const replayLimit = 200 * 1024;
const frameLimit = 1024 * 1024;
const stopGraceMs = 1500;
const exitRetentionMs = 5 * 60 * 1000;
const marker = '__TASKCHUTE_AI_EXIT__';
if (!descriptorPath || !/^[a-f0-9]{64}$/.test(token || '')) process.exit(64);
const sessions = new Map();
const clients = new Set();
let idleTimer = null;
let shuttingDown = false;
let shutdownRequested = false;
function send(socket, value) {
  if (!socket || socket.destroyed) return;
  try { socket.write(JSON.stringify(value) + '\n'); } catch (_) {}
}
function appendReplay(session, data) {
  if (!data) return;
  session.replay += data;
  if (session.replay.length > replayLimit) {
    session.replay = session.replay.slice(session.replay.length - replayLimit);
  }
}
function broadcast(session, value) {
  for (const socket of Array.from(session.clients)) send(socket, value);
}
function signalTree(session, signal) {
  const pid = session.child && session.child.pid;
  if (!pid || session.completed) return;
  try {
    if (process.platform === 'win32') session.child.kill(signal);
    else process.kill(-pid, signal);
  } catch (_) {
    try { session.child.kill(signal); } catch (_) {}
  }
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
    const visible = line.replace(new RegExp(marker + '\\d+\\r?\\n?'), '');
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
    const visible = tail.replace(new RegExp(marker + '\\d+'), '');
    if (visible) {
      appendReplay(session, visible);
      broadcast(session, { type: 'data', sessionId: session.id, data: visible });
    }
  }
}
function finish(session, code, signal) {
  if (session.completed) return;
  consumeStderr(session, '', true);
  session.completed = true;
  if (session.killTimer) global.clearTimeout(session.killTimer);
  session.outcome = outcomeFor(session, code, signal);
  broadcast(session, { type: 'exit', sessionId: session.id, outcome: session.outcome });
  global.setTimeout(() => sessions.delete(session.id), exitRetentionMs).unref();
  scheduleIdle();
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
  const request = message.spawn;
  let child;
  try {
    child = cp.spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env || process.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    send(socket, { type: 'error', sessionId: message.sessionId, message: String(error && error.message || error) });
    return;
  }
  const session = {
    id: message.sessionId,
    child,
    clients: new Set([socket]),
    replay: '',
    stderrPending: '',
    sentinelCode: null,
    stopRequested: false,
    completed: false,
    outcome: null,
    killTimer: null,
    transcriptPath: message.transcriptPath,
  };
  sessions.set(session.id, session);
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
  child.on('close', (code, signal) => finish(session, code, signal));
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
  send(socket, {
    type: 'attached',
    sessionId: id,
    status: session.completed ? 'completed' : 'running',
    replay: session.replay,
    pid: session.child && session.child.pid,
    transcriptPath: session.transcriptPath,
    outcome: session.outcome || undefined,
  });
}
function resizeSession(message) {
  const session = sessions.get(message.sessionId);
  if (!session || session.completed) return;
  const cols = Math.max(1, Math.min(999, Math.floor(Number(message.cols))));
  const rows = Math.max(1, Math.min(999, Math.floor(Number(message.rows))));
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
  try {
    const tty = fs.readFileSync(session.transcriptPath + '.tty', 'utf8').trim();
    if (!/^\/dev\/(?:ttys?\d+|pts\/\d+)$/.test(tty)) return;
    const flag = process.platform === 'darwin' ? '-f' : '-F';
    cp.execFileSync('/bin/stty', [flag, tty, 'rows', String(rows), 'cols', String(cols)], { stdio: 'ignore' });
  } catch (_) {}
}
function handle(socket, message) {
  if (!message || message.token !== token || typeof message.op !== 'string') {
    socket.destroy();
    return;
  }
  if (message.op === 'shutdown') {
    if (shutdownRequested) return;
    shutdownRequested = true;
    for (const active of sessions.values()) {
      if (!active.completed) {
        active.stopRequested = true;
        signalTree(active, 'SIGKILL');
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
      shutdown(socket);
    };
    awaitSessionExit();
    return;
  }
  if (shutdownRequested) {
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
    case 'stop':
      if (session && !session.completed) {
        session.stopRequested = true;
        signalTree(session, message.force ? 'SIGKILL' : 'SIGTERM');
        if (!message.force && !session.killTimer) {
          session.killTimer = global.setTimeout(() => signalTree(session, 'SIGKILL'), stopGraceMs);
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
        signalTree(session, 'SIGKILL');
      }
    }
    shutdown();
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
function shutdown(ackSocket) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const session of sessions.values()) {
    if (!session.completed) {
      session.stopRequested = true;
      signalTree(session, 'SIGKILL');
    }
  }
  removeOwnDescriptor();
  if (ackSocket) send(ackSocket, { type: 'shutdown-ack' });
  server.close(() => process.exit(0));
  global.setTimeout(() => process.exit(0), 1000).unref();
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
          if (!authenticated) {
            authenticated = true;
            global.clearTimeout(authTimer);
            clients.add(socket);
            if (idleTimer) { global.clearTimeout(idleTimer); idleTimer = null; }
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
    for (const session of sessions.values()) session.clients.delete(socket);
    scheduleIdle();
  });
  socket.on('error', () => {});
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const descriptor = JSON.stringify({ version: 1, port: address.port, token, pid: process.pid });
  try {
    fs.writeFileSync(descriptorPath, descriptor, { mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(descriptorPath, 0o600); } catch (_) {}
    scheduleIdle();
  } catch (_) { process.exit(65); }
});
server.on('error', () => shutdown());
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`
