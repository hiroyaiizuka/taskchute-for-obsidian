/**
 * AI Task - agent definition
 *
 * Everything that differs between the AI CLIs a task can run (Claude Code,
 * Codex, …) lives in one definition per agent. The rest of the feature reads
 * these definitions instead of branching on the agent, so adding an agent is
 * a new definition (plus its strings and icon), registered in `index.ts`.
 */

import type { ScopedKey, TranslationKey } from '@/i18n'
import type { AiTaskHost } from '../types'
import type { AiExecModeId } from '../config/AiTaskArgsCodec'
import type {
  AiModelPreset,
  AiReasoningBudget,
  AiReasoningMode,
} from '../config/AiTaskAdvancedOptions'
import type { AiDispatcher } from '../services/dispatchers/Dispatcher'
import type { ProcessGateway } from '../services/NodeProcessGateway'
import type { AgentSessionSource } from '../sessions/AgentSessionTypes'

/** Settings that hold a manually chosen CLI path, one per agent. */
export type AiCliPathSettingKey = 'aiTaskClaudePath' | 'aiTaskCodexPath' | 'aiTaskCursorPath'

export interface AiAgentLabel<K extends string> {
  key: K
  fallback: string
}

/** Windows folders a CLI is commonly installed under. Missing ones are ''. */
export interface WindowsInstallDirs {
  userProfile: string
  localAppData: string
  appData: string
  programFiles: string
  programFilesX86: string
  /** `PROCESSOR_ARCHITEW6432` / `PROCESSOR_ARCHITECTURE`, lower-cased. */
  architecture: string
}

/**
 * Where the agent's CLI lives on Windows, where `.cmd` shims cannot be run
 * safely. Candidates are tried in order; the first existing one wins. A
 * `.exe` runs as it is, a `.js`/`.cjs` entrypoint runs through node.exe.
 */
export interface AiAgentWindowsInstall {
  /** Standalone installs, tried before any npm-style package. */
  nativeExecutables(dirs: WindowsInstallDirs): string[]
  /** The package payload under an npm-style global folder (also a shim's folder). */
  packageEntrypoints(npmDirectory: string, dirs: WindowsInstallDirs): string[]
  /**
   * An install that carries its own node.exe in version folders (Cursor's
   * `cursor-agent\versions\<version>\`). Its folder is also where its
   * `.cmd` shim sits, so a shim found on PATH leads here too.
   */
  versionedInstall?: {
    /** Install folders to look in. */
    roots(dirs: WindowsInstallDirs): string[]
    /** The folder holding the versions, inside an install folder. */
    versionsFolder(root: string): string
    /** Version folder names worth trying, newest first. */
    newestFirst(names: readonly string[]): string[]
    /** What runs inside one version folder: the executable and its entrypoint. */
    launch(versionFolder: string): { executable: string; entrypoint: string }
  }
}

/** How an agent's CLI takes a reasoning effort, when it has one. */
export interface AiAgentReasoning {
  budgets: readonly AiReasoningBudget[]
  /** The effort value that means the agent's ultra mode (e.g. `ultracode`). */
  ultraValue: string
  ultraLabel: AiAgentLabel<ScopedKey<'taskChuteView'>>
  /** Modes offered for a concrete model; the CLI's default model only gets "automatic". */
  modesFor(modelId: string, isCustomModel: boolean): readonly AiReasoningMode[]
  /** The argv for one effort value: a budget or `ultraValue`. */
  effortArgs(value: string): string[]
  /**
   * Recognizes the agent's effort option at `args[index]`: how many tokens it
   * spans and, when it is well-formed, the effort value. null when the token
   * there is not an effort option.
   */
  effortAt(args: readonly string[], index: number): { length: number; value?: string } | null
}

export interface AiAgentDefinition {
  /** The `ai_task_host` value in task notes. Never change it once released. */
  id: AiTaskHost
  label: AiAgentLabel<ScopedKey<'taskChuteView'>>
  icon: string
  /**
   * The CLI's command name: looked up on PATH (`command -v`, `where.exe`) and
   * run by name in the terminal. A fixed value, never taken from a task.
   */
  command: string
  pathSetting: {
    key: AiCliPathSettingKey
    name: AiAgentLabel<TranslationKey>
    desc: AiAgentLabel<TranslationKey>
  }
  windows: AiAgentWindowsInstall
  /** Where the agent's CLI keeps past sessions, for the session history. */
  sessions?: AgentSessionSource
  /** Runs the agent headlessly (stream of JSON lines) for one task run. */
  createDispatcher(gateway: ProcessGateway): AiDispatcher
  /**
   * The option that trusts the task's folder, so the agent starts without
   * first asking whether to (a new folder asks once). Offered in auto mode
   * as an opt-in, since it also trusts the folder's own config and scripts.
   * Agents without one show a note that they ask once per folder instead.
   */
  trustFolderArgs?: readonly string[]
  /**
   * The arguments for each execution mode (the same three for every agent):
   * manual asks before acting, auto lets the agent act within safe limits on
   * its own, skip-permissions lets it do anything. Written to the task note.
   */
  execModes: Readonly<Record<AiExecModeId, readonly string[]>>
  /** What auto mode does for this agent, when that needs saying (shown in auto mode, dismissible). */
  autoModeNote?: AiAgentLabel<ScopedKey<'taskChuteView'>>
  /** Older spellings still found in notes, read as the mode they stand for and kept as written. */
  legacyExecModes?: readonly { mode: AiExecModeId; tokens: readonly string[] }[]
  /** Built-in model choices; more can be added per device. */
  models: readonly AiModelPreset[]
  reasoning: AiAgentReasoning | null
}
