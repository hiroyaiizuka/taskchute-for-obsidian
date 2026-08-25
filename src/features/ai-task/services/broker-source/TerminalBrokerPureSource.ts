import {
  FISH_TERMINAL_BOOTSTRAP,
  POSIX_TERMINAL_BOOTSTRAP,
  TERMINAL_ARGV_BOOTSTRAP_ARG_ZERO,
} from '../dispatchers/TerminalShellBootstrap'

/**
 * Free-standing half of the broker program: functions whose result depends only
 * on their arguments.
 *
 * The broker runs as `node -e <one string>`, so it cannot require sibling files
 * at runtime. This module is therefore not a runtime boundary — it is spliced
 * into the composed broker source verbatim, and that string is what actually
 * executes. What the split buys is a *testing* boundary: tests can evaluate this
 * fragment on its own, because nothing in here touches fs, child_process, net,
 * process, or broker globals. A composition test asserts that the broker source
 * still contains this string byte for byte, so the code under test and the code
 * that ships can never drift apart.
 *
 * Splice it ahead of everything else: the declarations below are read by the
 * rest of the program, and keeping them first means the fragment never depends
 * on a name the broker introduces later.
 *
 * Keep this plain ES2018 — nothing transpiles the contents of this template.
 */
export const TERMINAL_BROKER_PURE_SOURCE = String.raw`const ownerPidFileEnvName = 'TASKCHUTE_BROKER_OWNER_PID_FILE';
const terminalArgvBootstrapProgram = ${JSON.stringify(POSIX_TERMINAL_BOOTSTRAP)};
const fishTerminalArgvBootstrapProgram = ${JSON.stringify(FISH_TERMINAL_BOOTSTRAP)};
const terminalArgvBootstrapArgZero = ${JSON.stringify(TERMINAL_ARGV_BOOTSTRAP_ARG_ZERO)};
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
const stderrPendingLimit = 64 * 1024;
// Drops the front of the newline-free head of stderrPending so it stays within
// stderrPendingLimit, accounting the loss on session.stderrDroppedChars. The
// head is what the next iteration emits as one line, so this has to run before
// that emit: trimming only afterwards bounds the retained buffer but lets a
// single emitted line reach stderrPendingLimit + the length of one pipe read.
function boundStderrHead(session) {
  const newline = session.stderrPending.indexOf('\n');
  const headLength = newline < 0 ? session.stderrPending.length : newline;
  if (headLength <= stderrPendingLimit) return;
  const dropped = headLength - stderrPendingLimit;
  session.stderrDroppedChars += dropped;
  // JSON materialization avoids retaining the oversized concatenation as
  // the parent of a short V8 SlicedString.
  session.stderrPending = JSON.parse(JSON.stringify(session.stderrPending.slice(dropped)));
}
// Splits pending stderr into lines, strips the exit sentinel onto
// session.sentinelCode, and hands every visible chunk to emit. The broker binds
// emit to its replay buffer and its sockets; taking it as an argument is what
// keeps this half free of broker state.
function consumeStderrInto(session, text, flush, marker, emit) {
  session.stderrPending += text;
  boundStderrHead(session);
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
    if (visible) emit(visible);
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
    if (visible) emit(visible);
  }
  // The loop above consumed every newline, so what remains is a newline-free
  // tail that no emit has bounded yet.
  if (!flush) boundStderrHead(session);
}
`
