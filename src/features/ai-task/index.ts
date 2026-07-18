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
import type { PathManagerLike, TaskChutePluginLike, TaskChuteSettings } from '../../types'
import type { AiRunMode, AiTaskHost } from './types'
import { AiTaskLogWriter } from './services/AiTaskLogWriter'
import {
  AiTaskManager,
  type AiTaskManagerDeps,
} from './services/AiTaskManager'
import { BinaryLocator } from './services/BinaryLocator'
import { NodeProcessGateway } from './services/NodeProcessGateway'
import type { AiDispatcher } from './services/dispatchers/Dispatcher'
import { ClaudeCodeDispatcher } from './services/dispatchers/ClaudeCodeDispatcher'
import { CodexDispatcher } from './services/dispatchers/CodexDispatcher'
import { TerminalDispatcher } from './services/dispatchers/TerminalDispatcher'
import { BrokerTerminalDispatcher } from './services/dispatchers/BrokerTerminalDispatcher'
import { TerminalSessionBrokerClient } from './services/TerminalSessionBroker'
import { WorkspaceFileService } from './services/WorkspaceFileService'
import { RecipeService } from '../recipe/services/RecipeService'
import { RecipeContextProvider } from '../recipe/services/RecipeContextProvider'
import { AiRunSessionStateStore } from './services/AiRunSessionStateStore'
import {
  acquireRetainedAiTaskManager,
  getAiTaskRuntimeLeaseGeneration,
  retainAiTaskManager,
} from './services/AiTaskRuntimeLease'

export interface AiTaskPluginLike {
  app: App
  settings: TaskChuteSettings
  pathManager: PathManagerLike
  /** Ownership token used to reject stale old-plugin unload callbacks. */
  aiTaskRuntimeLeaseGeneration?: number
  _log?: (level?: string, ...args: unknown[]) => void
}

const DEFAULT_LOG_RETENTION_DAYS = 30

function getVaultBrokerIdentity(app: App): string | undefined {
  const adapter = app.vault.adapter as unknown as
    | { getBasePath?: () => unknown }
    | undefined
  const basePath = adapter?.getBasePath?.()
  if (typeof basePath !== 'string' || basePath.trim().length === 0) {
    return undefined
  }
  return `taskchute-plus:${basePath}`
}

/**
 * Create the AiTaskManager for this plugin instance, or undefined when the
 * feature is disabled or the platform is not desktop.
 */
export function createAiTaskManager(plugin: AiTaskPluginLike): AiTaskManager | undefined {
  plugin.aiTaskRuntimeLeaseGeneration = undefined
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
  const recipeService = new RecipeService(
    plugin as unknown as TaskChutePluginLike,
  )
  const localStorageApp = plugin.app as unknown as {
    loadLocalStorage?: (key: string) => unknown
    saveLocalStorage?: (key: string, value: unknown) => void
  }
  const sessionState =
    typeof localStorageApp.loadLocalStorage === 'function' &&
    typeof localStorageApp.saveLocalStorage === 'function'
      ? new AiRunSessionStateStore(
          {
            loadLocalStorage: (key) => localStorageApp.loadLocalStorage?.(key),
            saveLocalStorage: (key, value) => {
              localStorageApp.saveLocalStorage?.(key, value)
            },
          },
          { log },
        )
      : undefined
  const brokerIdentity = getVaultBrokerIdentity(plugin.app)
  const terminalDispatcher =
    gateway.isPtySupported() && brokerIdentity !== undefined
      ? new BrokerTerminalDispatcher(
          gateway,
          new TerminalSessionBrokerClient({
            identity: brokerIdentity,
            getEnv: () => gateway.getBaseEnv(),
            log: (level, ...args) => log(level, ...args),
          }),
        )
      : new TerminalDispatcher(gateway)

  const deps: AiTaskManagerDeps = {
    app: plugin.app,
    dispatchers,
    binaryLocator,
    logWriter,
    terminal: {
      dispatcher: terminalDispatcher,
      isSupported: () => gateway.isPtySupported(),
      makeTempFilePath: (prefix: string) => gateway.makeTempFilePath(prefix),
      readAndDeleteFile: (path: string) => gateway.readAndDeleteFile(path),
      // Plain shell sessions (U2 split panels) spawn the user's login shell.
      getShellPath: () => gateway.getShellPath(),
    },
    workspaceFiles: new WorkspaceFileService(gateway),
    recipeContextProvider: new RecipeContextProvider({
      isFeatureEnabled: () => plugin.settings.recipeFeatureEnabled === true,
      getRecipeFolderPath: () => recipeService.getRecipeFolderPath(),
      loadRecipe: (path) => recipeService.loadRecipe(path),
    }),
    // Terminal is the default experience. Without a bundled Windows ConPTY
    // native runtime, win32 uses the cross-platform conversation pipeline.
    getRunMode: (): AiRunMode =>
      plugin.settings.aiTaskRunMode === 'headless' ? 'headless' : 'terminal',
    sessionState,
    log,
  }

  const retained = acquireRetainedAiTaskManager(plugin.app, deps)
  if (retained) {
    plugin.aiTaskRuntimeLeaseGeneration =
      getAiTaskRuntimeLeaseGeneration(retained)
    log('debug', '[AiTask] Adopted live runtime after plugin reload')
    return retained
  }

  const manager = new AiTaskManager(deps)
  retainAiTaskManager(plugin.app, manager)
  plugin.aiTaskRuntimeLeaseGeneration =
    getAiTaskRuntimeLeaseGeneration(manager)
  return manager
}
