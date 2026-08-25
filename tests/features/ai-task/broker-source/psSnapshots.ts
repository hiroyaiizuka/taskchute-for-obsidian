/**
 * `ps` output the broker, guard and watchdog have to survive.
 *
 * Handwritten rather than captured, so every line states which property it
 * pins and a reviewer can see the difference a change makes. Kept as a .ts
 * module because the column alignment is significant and a plain .txt fixture
 * loses trailing whitespace to editors and formatters.
 *
 * Column layout is `pid=,ppid=,pgid=,lstart=,command=`, which ps renders with
 * the numeric columns right-aligned and lstart in the C locale.
 */

/** `Www Mmm dd HH:MM:SS YYYY` — the only lstart shape the parser accepts. */
export const LSTART = 'Mon Aug 25 09:14:07 2025'

/** Single-digit days are padded to two spaces, not one. */
export const LSTART_SINGLE_DIGIT_DAY = 'Mon Aug  4 09:14:07 2025'

export const LSTART_EPOCH_MS = Date.parse(LSTART)
export const LSTART_SINGLE_DIGIT_DAY_EPOCH_MS = Date.parse(
  LSTART_SINGLE_DIGIT_DAY,
)

/**
 * BSD `ps -axo pid=,ppid=,pgid=,lstart=,command=` as macOS renders it. Also
 * what the guard reads on every platform.
 */
export const DARWIN_PS_AXO_LINES: readonly string[] = [
  // A group leader: pgid equals pid.
  `  501     1   501 ${LSTART} /bin/sh -c while :; do sleep 10; done`,
  // A child of the leader, in the leader's group.
  `  502   501   501 ${LSTART} sleep 10`,
  // A grandchild, so the descendant walk has more than one level to follow.
  `  503   502   501 ${LSTART} sleep 10`,
  // Six-digit pid, and a command carrying runs of whitespace that must survive.
  `123456     1 123456 ${LSTART} /usr/bin/python3   -c   print(1)`,
  // Single-digit day: the classic breaker for `\\S+\\s+\\S+\\s+\\d+`.
  `  601     1   601 ${LSTART_SINGLE_DIGIT_DAY} /usr/bin/tail -f /dev/null`,
  // Empty command column. Keeps its pid/ppid so the walk can see it, but can
  // never be claimed as an owner, because owner checks need a command hint.
  `  602     1   602 ${LSTART} `,
  // Reparented orphan: ppid 1 while its original parent is gone.
  `  701     1   701 ${LSTART} /bin/sh -c orphaned`,
  // Not a process line at all. Must be skipped rather than half-parsed.
  '  PID  PPID  PGID STARTED COMMAND',
  '',
]

export const DARWIN_PS_AXO_TEXT = `${DARWIN_PS_AXO_LINES.join('\n')}\n`

/**
 * Linux `ps axeww -o pid=,ppid=,pgid=,lstart=,command=`. The `e` appends each
 * process's environment to the command column, which is what lets an already
 * reparented cooperative descendant be recovered by its owner marker — and
 * also what makes the column contain `=` signs, spaces and arbitrary text.
 */
export const LINUX_PS_AXEWW_LINES: readonly string[] = [
  `  501     1   501 ${LSTART} /bin/sh -c while :; do sleep 10; done LANG=C PATH=/usr/bin:/bin`,
  `  502   501   501 ${LSTART} sleep 10 LANG=C PATH=/usr/bin:/bin`,
  `  503   502   501 ${LSTART} sleep 10 LANG=C PATH=/usr/bin:/bin`,
  // The environment-marker recovery case: an unrelated process whose command is
  // short but whose environment is long.
  `  801     1   801 ${LSTART} sleep 30 TASKCHUTE_BROKER_OWNER_PID_FILE=/tmp/owner-a.jsonl LANG=C`,
  // A kernel thread: bracketed, no environment.
  `    9     2     0 ${LSTART} [kworker/0:1]`,
  `  601     1   601 ${LSTART_SINGLE_DIGIT_DAY} /usr/bin/tail -f /dev/null LANG=C`,
  `  602     1   602 ${LSTART} `,
  '  PID  PPID  PGID STARTED COMMAND',
  '',
]

export const LINUX_PS_AXEWW_TEXT = `${LINUX_PS_AXEWW_LINES.join('\n')}\n`

export const PS_DIALECTS = [
  ['darwin', DARWIN_PS_AXO_TEXT],
  ['linux', LINUX_PS_AXEWW_TEXT],
] as const

/**
 * A tree with the shapes a descendant walk has to tolerate: a grandchild, a
 * self-parenting entry, a pid whose parent is 0, and an orphan reparented onto
 * pid 1 while the walk root is still alive.
 */
export const DESCENDANT_TREE_TEXT = [
  `  100     1   100 ${LSTART} root`,
  `  101   100   100 ${LSTART} child-a`,
  `  102   100   100 ${LSTART} child-b`,
  `  103   101   100 ${LSTART} grandchild`,
  // Self-parenting. A naive walk loops here forever.
  `  104   104   104 ${LSTART} self-parent`,
  // Parent is pid 0, which is not in the snapshot at all.
  `  105     0   105 ${LSTART} orphan-of-zero`,
  // Unrelated tree that must not be pulled in.
  `  200     1   200 ${LSTART} unrelated`,
  `  201   200   200 ${LSTART} unrelated-child`,
  '',
].join('\n')
