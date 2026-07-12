/**
 * AI Task - shared domain types
 *
 * Pure type definitions for the AI Task feature (manual-run MVP).
 * No runtime dependencies; safe to import from tests and every layer.
 */

/** Supported headless CLI hosts */
export type AiTaskHost = 'claude' | 'codex'

/**
 * How a run's child process executes: 'terminal' embeds an interactive PTY
 * session (the full CLI TUI, typed into directly), 'headless' runs the
 * legacy stream-json pipeline.
 */
export type AiRunMode = 'terminal' | 'headless'

/** Lifecycle status of a single AI run */
export type AiRunStatus =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'succeeded'
  | 'failed'
  | 'stopped'

/** Emitted when the CLI reports its session bootstrap */
export interface AiInitEvent {
  kind: 'init'
  sessionId?: string
  model?: string
}

/** Plain assistant text output */
export interface AiAssistantTextEvent {
  kind: 'assistant-text'
  text: string
}

/** The assistant invoked a tool */
export interface AiToolUseEvent {
  kind: 'tool-use'
  toolName: string
  input?: unknown
}

/** A tool finished and returned output */
export interface AiToolResultEvent {
  kind: 'tool-result'
  text?: string
  isError?: boolean
}

/** Terminal event of a run as reported by the CLI stream */
export interface AiResultEvent {
  kind: 'result'
  subtype?: string
  isError: boolean
  totalCostUsd?: number
  numTurns?: number
  text?: string
}

/** A follow-up prompt the user sent to a finished run via the composer */
export interface AiUserTextEvent {
  kind: 'user-text'
  text: string
}

/** A line written to the child process stderr */
export interface AiStderrEvent {
  kind: 'stderr'
  text: string
}

/** Unparseable or unknown stream line, preserved verbatim */
export interface AiRawEvent {
  kind: 'raw'
  text: string
}

/**
 * Synthetic marker inserted by the run manager when the middle of the event
 * buffer is dropped (head + tail cap). Never produced by the CLI parsers.
 */
export interface AiElisionEvent {
  kind: 'elision'
  omittedCount: number
}

export type AiStreamEvent =
  | AiInitEvent
  | AiAssistantTextEvent
  | AiToolUseEvent
  | AiToolResultEvent
  | AiResultEvent
  | AiUserTextEvent
  | AiStderrEvent
  | AiRawEvent
  | AiElisionEvent

/** Normalized `ai_task_*` frontmatter configuration for a task note */
export interface AiTaskConfig {
  host: AiTaskHost
  /** Extra CLI arguments appended to the host command */
  args: string[]
  /** Working directory override for the child process */
  cwd?: string
}

/** In-memory record of one AI run (also the source for the run log note) */
export interface AiRunRecord {
  /** Unique run identifier */
  id: string
  /** Vault path of the task note that started the run */
  taskPath: string
  /** Display name of the task */
  taskName: string
  host: AiTaskHost
  status: AiRunStatus
  /** Execution mode of the child process (see AiRunMode) */
  mode: AiRunMode
  /**
   * Task instance that started the run. Lets the row renderer scope the
   * status chip/stop control to the originating instance when a task note
   * has duplicated rows.
   */
  instanceId?: string
  /**
   * Absolute temp-file path of the PTY session transcript while a terminal
   * run is active; the file is consumed (read + deleted) at run end.
   */
  transcriptPath?: string
  /** Epoch milliseconds */
  startedAt: number
  /** Epoch milliseconds of the latest follow-up dispatch (startedAt is kept) */
  resumedAt?: number
  /** Epoch milliseconds; set when the run reaches a terminal status */
  endedAt?: number
  /** CLI session/thread id reported by the stream; enables resume follow-ups */
  sessionId?: string
  /** Vault path of the persisted run log note (rewritten on follow-ups) */
  logNotePath?: string
  /** Bounded event buffer (head + tail with omission marker) */
  events: AiStreamEvent[]
  /** Number of events dropped from the middle of the buffer */
  omittedEventCount?: number
  /** Child process exit code (null when terminated by signal) */
  exitCode?: number | null
  pid?: number
  /** Human-readable failure summary, if any */
  errorMessage?: string
}
