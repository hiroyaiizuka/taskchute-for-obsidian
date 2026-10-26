/**
 * What runs in the foreground of a shell session's terminal, read from
 * `ps -t <ttys> -o pid=,ppid=,pgid=,tpgid=,stat=,tty=,args=` (the same
 * columns on macOS and Linux procps).
 *
 * The PTY wrapper makes one session per terminal. Its leader (STAT `s`) is
 * the supervisor `sh` that `script` starts, and the user's shell is that
 * leader's child; an interactive shell with job control moves itself into a
 * process group of its own (pid = pgid). The leader and that shell are the
 * session's "home". Every process on the tty reports the terminal's
 * foreground process group (tpgid):
 *
 *   - a home group with nobody else in it: the shell is at its prompt
 *   - a home group with other members: a program the shell started without
 *     job control (a `sh -c` bootstrap) — that member is the program
 *   - any other group: a job the shell started; its leader is the program
 *
 * Idleness is decided by process identity, never by name: `bash ./build.sh`
 * in the foreground is a program like any other.
 */

/** The program in the foreground: its pid (identity) and a display name, if one can be told. */
export interface ForegroundProgram {
  pid: number
  name: string | undefined
  /** When it started (ms since the epoch), where the probe can tell (Windows). */
  startedAt?: number
}

/** `program` is null while the shell is at its prompt. */
export interface ShellForegroundSample {
  program: ForegroundProgram | null
  /**
   * When the answer was last known to be true, if earlier than the probe
   * (a sidecar the ConPTY host refreshes on its own clock). Titles that
   * arrived after this are not judged by it.
   */
  observedAt?: number
}

export interface PsRow {
  pid: number
  ppid: number
  pgid: number
  tpgid: number
  stat: string
  tty: string
  args: string
}

// args is last and may contain spaces.
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(.*?)\s*$/u

export const PS_COLUMNS = 'pid=,ppid=,pgid=,tpgid=,stat=,tty=,args='

export function parsePsRows(output: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of output.split('\n')) {
    const match = line.match(PS_ROW)
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      tpgid: Number(match[4]),
      stat: match[5],
      tty: match[6],
      args: match[7],
    })
  }
  return rows
}

/** Agents TaskChute knows, by executable or package name. */
const AGENT_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude Code',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'cursor-agent': 'Cursor',
  gemini: 'Gemini',
  opencode: 'OpenCode',
}

/** Executables that run something else: the name is the thing they run. */
const LAUNCHERS: ReadonlySet<string> = new Set([
  'node', 'nodejs', 'bun', 'deno', 'npx', 'env', 'exec',
  'python', 'python3', 'ruby', 'perl', 'java',
  'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'mksh', 'tcsh', 'csh',
  'cmd',
])

const SCRIPT_EXTENSION = /\.(?:c?js|mjs|ts|exe|cmd|py|rb|pl)$/iu
const VERSION_LIKE = /^v?\d+(?:\.\d+)+(?:[-+].*)?$/u

function basename(token: string): string {
  const trimmed = token.replace(/\/+$/u, '')
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return base.startsWith('-') ? base.slice(1) : base
}

function agentIn(token: string): string | undefined {
  if (token.includes('@anthropic-ai/claude-code')) return AGENT_NAMES.claude
  if (token.includes('@openai/codex')) return AGENT_NAMES.codex
  return AGENT_NAMES[basename(token).replace(SCRIPT_EXTENSION, '').toLowerCase()]
}

/**
 * A display name for a command line: a known agent wherever it appears in
 * the first few words (npm installs run `node …/codex.js`; native Claude is
 * a versioned file called through a `claude` link), else the first word that
 * is neither a launcher, a flag nor a version number. Undefined when nothing
 * meaningful is left: the tab then says "Terminal".
 */
export function programNameFromArgs(args: string): string | undefined {
  return programNameFromTokens(args.trim().split(/\s+/u))
}

/**
 * The same for a Windows command line, as the ConPTY host reads it: quoted
 * words may hold spaces, paths use backslashes, and `.exe` / `.cmd` / `.bat`
 * are part of the name (`"C:\\Program Files\\nodejs\\node.exe" …\\cli.js`,
 * `cmd.exe /d /s /c "claude.cmd"`).
 */
export function programNameFromWindowsCommandLine(commandLine: string): string | undefined {
  const tokens = windowsTokens(commandLine)
  // cmd.exe /c runs the rest of the line. Like cmd, take off the quotes
  // around it — `cmd.exe /d /s /c ""C:\\…\\npm.cmd" run build"` — unless
  // there is no /s and they are the only pair, around one path:
  // `cmd.exe /c "C:\\Program Files\\Example\\server.exe"` keeps them.
  const command = /^(.*?)\s\/[ck]\s+(.*)$/iu.exec(commandLine)
  if (tokens[0] !== undefined && basename(tokens[0]).toLowerCase() === 'cmd' && command) {
    const switches = command[1]
    const rest = command[2].trim()
    const wrapped = rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')
    // cmd also checks the quoted words name a file; one path ending in an
    // executable's extension, with nothing after it, stands in for that.
    const onePath =
      !/\s\/s(?:\s|$)/iu.test(switches) &&
      (rest.match(/"/gu) ?? []).length === 2 &&
      /^"[^"&|<>]*[\\/][^"&|<>]*\.(?:exe|com|bat|cmd)"$/iu.test(rest)
    return programNameFromTokens(windowsTokens(wrapped && !onePath ? rest.slice(1, -1) : rest))
  }
  return programNameFromTokens(tokens)
}

function windowsTokens(commandLine: string): string[] {
  const tokens: string[] = []
  for (const match of commandLine.matchAll(/(?:"[^"]*"|[^\s"])+/gu)) {
    const token = match[0]
      .replace(/"/gu, '')
      .trim()
      .replace(/\\/gu, '/')
      .replace(/\.(?:exe|cmd|bat)$/iu, '')
      // A switch (`/c`, `/d`) is a flag, like `-c`.
      .replace(/^\/(?=[^/]*$)/u, '-')
    if (token.length > 0) tokens.push(token)
  }
  return tokens
}

function programNameFromTokens(allTokens: readonly string[]): string | undefined {
  const tokens = allTokens.slice(0, 8)
  for (const token of tokens) {
    const agent = agentIn(token)
    if (agent) return agent
  }
  for (const [index, token] of tokens.entries()) {
    if (index > 0 && token.startsWith('-')) continue
    const base = basename(token)
    if (base.length === 0 || LAUNCHERS.has(base.toLowerCase()) || VERSION_LIKE.test(base)) continue
    return base
  }
  return undefined
}

function oldest(rows: PsRow[]): PsRow {
  return rows.reduce((first, row) => (row.pid < first.pid ? row : first))
}

/**
 * The foreground of one tty from its rows, or null when they do not say (no
 * session leader, no foreground group, or nobody left in it).
 */
export function parseForegroundSnapshot(rows: PsRow[]): ShellForegroundSample | null {
  const leaders = rows.filter((row) => row.stat.includes('s'))
  if (leaders.length === 0) return null
  const leader = oldest(leaders)
  // The user's shell: a child of the leader that leads a group of its own
  // (job control). A program the leader runs without job control stays in
  // the leader's group and is not home.
  const home = new Set<number>([leader.pid])
  for (const row of rows) {
    if (row.ppid === leader.pid && row.pid === row.pgid) home.add(row.pid)
  }
  const homeGroups = new Set(rows.filter((row) => home.has(row.pid)).map((row) => row.pgid))

  const tpgid = rows.find((row) => row.tpgid > 0)?.tpgid
  if (tpgid === undefined) return null
  const group = rows.filter((row) => row.pgid === tpgid)
  if (group.length === 0) return null

  let program: PsRow
  if (homeGroups.has(tpgid)) {
    const others = group.filter((row) => !home.has(row.pid))
    if (others.length === 0) return { program: null }
    // Started by a home process directly, if one was (not one of its helpers).
    const started = others.filter((row) => home.has(row.ppid))
    program = oldest(started.length > 0 ? started : others)
  } else {
    program = group.find((row) => row.pid === tpgid) ?? oldest(group)
  }
  return { program: { pid: program.pid, name: programNameFromArgs(program.args) } }
}
