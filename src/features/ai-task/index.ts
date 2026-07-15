/**
 * AI Task - feature entry point
 *
 * createAiTaskManager wires the whole feature (Node gateway, binary locator,
 * dispatchers, log writer, run manager) and gates it twice: the feature must
 * be enabled in settings AND the runtime must be desktop. When either gate
 * fails it returns undefined and nothing AI-related is instantiated, keeping
 * mobile and opted-out vaults completely inert.
 */

import { Platform } from 'obsidian'
import type { App } from 'obsidian'
import type { PathManagerLike, TaskChuteSettings } from '../../types'
import type { AiRunMode, AiTaskHost } from './types'
import { AiTaskLogWriter } from './services/AiTaskLogWriter'
import { AiTaskManager } from './services/AiTaskManager'
import { BinaryLocator } from './services/BinaryLocator'
import { NodeProcessGateway } from './services/NodeProcessGateway'
import type { AiDispatcher } from './services/dispatchers/Dispatcher'
import { ClaudeCodeDispatcher } from './services/dispatchers/ClaudeCodeDispatcher'
import { CodexDispatcher } from './services/dispatchers/CodexDispatcher'
import { TerminalDispatcher } from './services/dispatchers/TerminalDispatcher'
import { WorkspaceFileService } from './services/WorkspaceFileService'

export interface AiTaskPluginLike {
  app: App
  settings: TaskChuteSettings
  pathManager: PathManagerLike
  _log?: (level?: string, ...args: unknown[]) => void
}

const DEFAULT_LOG_RETENTION_DAYS = 30

/**
 * Create the AiTaskManager for this plugin instance, or undefined when the
 * feature is disabled or the platform is not desktop.
 */
export function createAiTaskManager(plugin: AiTaskPluginLike): AiTaskManager | undefined {
  if (plugin.settings.aiTaskEnabled !== true) return undefined
  if (!Platform?.isDesktop) return undefined

  const pathManager = plugin.pathManager
  if (
    typeof pathManager.getAiLogsPath !== 'function' ||
    typeof pathManager.getAiLogsMonthPath !== 'function'
  ) {
    plugin._log?.('warn', '[AiTask] Path manager lacks AI log paths; feature disabled')
    return undefined
  }
  // Runtime-validated above; the cast makes the optional methods required.
  const logPathManager = pathManager as PathManagerLike & {
    getAiLogsPath: () => string
    getAiLogsMonthPath: (yearMonth: string) => string
  }

  const log = (level: 'warn' | 'error' | 'debug', ...args: unknown[]): void => {
    plugin._log?.(level, ...args)
  }

  const gateway = new NodeProcessGateway()
  const binaryLocator = new BinaryLocator(gateway, () => ({
    aiTaskClaudePath: plugin.settings.aiTaskClaudePath,
    aiTaskCodexPath: plugin.settings.aiTaskCodexPath,
  }))
  const dispatchers: Record<AiTaskHost, AiDispatcher> = {
    claude: new ClaudeCodeDispatcher(gateway),
    codex: new CodexDispatcher(gateway),
  }
  const logWriter = new AiTaskLogWriter({
    app: plugin.app,
    pathManager: {
      getAiLogsPath: () => logPathManager.getAiLogsPath(),
      getAiLogsMonthPath: (yearMonth: string) => logPathManager.getAiLogsMonthPath(yearMonth),
      ensureFolderExists: (path: string) => logPathManager.ensureFolderExists(path),
    },
    getRetentionDays: () => {
      const value = plugin.settings.aiTaskLogRetentionDays
      return typeof value === 'number' && Number.isFinite(value)
        ? value
        : DEFAULT_LOG_RETENTION_DAYS
    },
    log,
  })

  return new AiTaskManager({
    app: plugin.app,
    dispatchers,
    binaryLocator,
    logWriter,
    terminal: {
      dispatcher: new TerminalDispatcher(gateway),
      isSupported: () => gateway.isPtySupported(),
      makeTempFilePath: (prefix: string) => gateway.makeTempFilePath(prefix),
      readAndDeleteFile: (path: string) => gateway.readAndDeleteFile(path),
      // Plain shell sessions (U2 split panels) spawn the user's login shell.
      getShellPath: () => gateway.getShellPath(),
    },
    workspaceFiles: new WorkspaceFileService(gateway),
    // Terminal is the default experience. Without a bundled Windows ConPTY
    // native runtime, win32 uses the cross-platform conversation pipeline.
    getRunMode: (): AiRunMode =>
      plugin.settings.aiTaskRunMode === 'headless' ? 'headless' : 'terminal',
    log,
  })
}
